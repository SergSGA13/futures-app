/**
 * ЭНДПОИНТ МИНИ-ПРИЛОЖЕНИЯ: персональный список каналов.
 *
 * Запрос приходит на тот же /exec, что и алерты TradingView, поэтому точка
 * входа - «пробник»: miniAppTryHandle_ разбирает тело и, если это НЕ запрос
 * мини-приложения, возвращает null. Тогда управление идёт дальше, к коду
 * сигналов, и он ничего не замечает.
 *
 * Клиент шлёт Content-Type: text/plain - не из экономии, а потому что на
 * application/json браузер отправляет preflight OPTIONS, а веб-приложения
 * Apps Script его не обслуживают.
 */

var MINIAPP_ACTIONS = ['getMyChannels'];

function miniAppTryHandle_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body) return null;

  var req;
  try { req = JSON.parse(body); } catch (err) { return null; }
  if (!req || typeof req.action !== 'string') return null;
  if (MINIAPP_ACTIONS.indexOf(req.action) < 0) return null;

  var out;
  try {
    var v = validateInitData_(req.initData);
    if (!v.ok) {
      // Без действительной подписи не отдаём ничего, даже названий каналов.
      // Причину пишем в журнал: с телефона ответ сервера не посмотришь, а
      // «Выполнения» в Apps Script открываются в два клика.
      Logger.log('getMyChannels: отказ по подписи - ' + v.error);
      out = { ok: false, error: 'auth: ' + v.error };
    } else if (req.action === 'getMyChannels') {
      out = getMyChannels_(v.user, req.lang);
    } else {
      out = { ok: false, error: 'unknown action' };
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return jsonOut_(out);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== ДАННЫЕ =====

function loadChannels_() {
  return sheetRows_(CH_SHEET).map(function (r) {
    return {
      key: str_(r['key']).toLowerCase(),
      titles: { ru: str_(r['title_ru']), en: str_(r['title_en']), uk: str_(r['title_uk']) },
      descs: { ru: str_(r['description_ru']), en: str_(r['description_en']), uk: str_(r['description_uk']) },
      chatId: str_(r['chat_id']),
      joinLink: str_(r['join_link']),
      tier: str_(r['tier']),
      sort: Number(r['sort_order']) || 0,
      active: isActive_(r['active']),
    };
  }).filter(function (c) { return c.key && c.active; })
    .sort(function (a, b) { return a.sort - b.sort; });
}

/**
 * Что разрешено пользователю. Строк на один user_id может быть несколько -
 * тогда права складываются, это удобнее, чем переписывать одну длинную ячейку.
 */
function grantsFor_(userId) {
  var uid = String(userId);
  var g = { found: false, all: false, keys: {}, tiers: {} };
  sheetRows_(AC_SHEET).forEach(function (r) {
    if (str_(r['user_id']) !== uid) return;
    if (!isActive_(r['active'])) return;
    g.found = true;
    var keys = splitKeys_(r['channel_keys']);
    if (keys.indexOf('*') >= 0 || keys.indexOf('all') >= 0) g.all = true;
    keys.forEach(function (k) { g.keys[k] = true; });
    splitKeys_(r['tier']).forEach(function (tr) { g.tiers[tr] = true; });
  });
  return g;
}

function channelGranted_(ch, g) {
  if (isFreeTier_(ch.tier)) return true;      // основной канал и прочее публичное - всем
  if (!g.found) return false;
  if (g.all) return true;
  if (ch.key && g.keys[ch.key]) return true;
  var tier = str_(ch.tier).toLowerCase();
  return !!(tier && g.tiers[tier]);
}

function pick_(bag, lang) {
  var l = ['ru', 'en', 'uk'].indexOf(String(lang || '')) >= 0 ? lang : 'ru';
  return bag[l] || bag.ru || bag.en || bag.uk || '';
}

function memberIn_(m) {
  var s = m && m.status;
  if (s === 'creator' || s === 'administrator' || s === 'member') return true;
  if (s === 'restricted') return m.is_member === true;
  return false;
}

/**
 * Кто уже в канале. Спрашиваем пачкой через fetchAll: десять
 * последовательных getChatMember заметно тормозят открытие экрана.
 *
 * «Внутри» кешируем на MEMBER_CACHE_SEC - это состояние устойчивое.
 * «Снаружи» - всего на полминуты: человек уходит вступать и сразу
 * возвращается, и ему нужна актуальная отметка, а не пятиминутная.
 */
function membershipMap_(userId, channels) {
  var cache = CacheService.getScriptCache();
  var out = {}, need = [], reqs = [];

  channels.forEach(function (c) {
    if (!c.chatId) { out[c.key] = 'unknown'; return; }
    var hit = cache.get('cm_' + c.chatId + '_' + userId);
    if (hit) { out[c.key] = hit; return; }
    need.push(c);
    reqs.push({
      url: 'https://api.telegram.org/bot' + botToken_() + '/getChatMember',
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: c.chatId, user_id: Number(userId) }),
      muteHttpExceptions: true,
    });
  });

  if (reqs.length) {
    var res = [];
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { res = []; }
    need.forEach(function (c, i) {
      var st = 'unknown';
      try {
        var j = JSON.parse(res[i].getContentText());
        if (j.ok && j.result) st = memberIn_(j.result) ? 'in' : 'out';
      } catch (e) { /* бот не админ в канале или chat_id неверный - считаем «неизвестно» */ }
      out[c.key] = st;
      if (st === 'in') cache.put('cm_' + c.chatId + '_' + userId, st, MEMBER_CACHE_SEC);
      else if (st === 'out') cache.put('cm_' + c.chatId + '_' + userId, st, 30);
    });
  }
  return out;
}

function folderFor_(g, chans) {
  var rows;
  try { rows = sheetRows_(FD_SHEET); } catch (e) { return ''; }  // лист Folders необязателен
  if (!rows.length) return '';

  var have = {};
  Object.keys(g.tiers).forEach(function (k) { have[k] = true; });
  chans.forEach(function (c) {
    if (!isFreeTier_(c.tier) && channelGranted_(c, g)) have[str_(c.tier).toLowerCase()] = true;
  });

  for (var i = 0; i < rows.length; i++) {
    var tier = str_(rows[i]['tier']).toLowerCase();
    var link = str_(rows[i]['folder_link']);
    if (!link) continue;
    if (tier === '*' || tier === 'all') { if (g.found) return link; continue; }
    if (have[tier]) return link;
  }
  return '';
}

function getMyChannels_(user, lang) {
  var chans = loadChannels_();
  var g = grantsFor_(user.id);

  // Про закрытые каналы Telegram не спрашиваем: лишние запросы и лишний повод
  // засветить chat_id в логах API.
  var granted = chans.filter(function (c) { return channelGranted_(c, g); });
  var mem = membershipMap_(user.id, granted);

  return {
    ok: true,
    user_id: user.id,
    channels: chans.map(function (c) {
      var ok = channelGranted_(c, g);
      var state = !ok ? 'locked' : (mem[c.key] === 'in' ? 'joined' : 'open');
      return {
        key: c.key,
        title: pick_(c.titles, lang) || c.key,
        description: pick_(c.descs, lang),
        state: state,
        // Ссылку отдаём только тому, кому можно вступать: иначе закрытый
        // тариф утекал бы вместе со списком.
        join_link: state === 'open' ? c.joinLink : '',
      };
    }),
    folder_link: folderFor_(g, chans),
  };
}
