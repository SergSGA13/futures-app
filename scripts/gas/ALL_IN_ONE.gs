/**
 * ДОСТУП К КАНАЛАМ - для ДОБАВЛЕНИЯ В ПРОЕКТ С СИГНАЛАМИ.
 *
 * Здесь НЕТ своего doPost - он у вас уже есть. В него добавляются четыре
 * строки (README, шаг 5), и логика сигналов не меняется.
 *
 * Если код доступа живёт в ОТДЕЛЬНОМ проекте - берите
 * ALL_IN_ONE_STANDALONE.gs вместо этого файла.
 *
 * ЭТО СОБРАННЫЙ ФАЙЛ, РУКАМИ ЕГО НЕ ПРАВЯТ. Исходники лежат рядом,
 * пересобрать оба файла:
 *     python3 scripts/gas/build_all_in_one.py
 *
 * Дальше следуйте README.md в этой же папке.
 */


// ========================================================================
// 01_config.gs
// ========================================================================

/**
 * ДОСТУП К КАНАЛАМ - общая конфигурация.
 *
 * Эти файлы добавляются в СУЩЕСТВУЮЩИЙ проект Apps Script рядом с кодом,
 * который принимает алерты TradingView и рассылает сигналы. Ни одна функция
 * здесь не трогает цепочку сигналов: всё новое живёт в своих файлах, а в
 * существующий doPost добавляются только две строки-переключателя
 * (см. scripts/gas/README.md, шаг 5).
 *
 * Ни токена, ни id таблицы в коде нет - всё в Script Properties
 * (Настройки проекта -> Свойства скрипта):
 *
 *   BOT_TOKEN         - токен бота (тот же, которым рассылаются сигналы)
 *   ACCESS_SHEET_ID   - id ОТДЕЛЬНОЙ приватной таблицы с листами
 *                       Channels / Access / Folders / JoinLog
 *   TG_HOOK_QS        - (необязательно) секрет в query-строке вебхука,
 *                       см. README, раздел «Почему адрес /exec публичный»
 *   TG_SECRET_TOKEN   - (необязательно) если на вебхуке уже стоит secret_token,
 *                       положите его здесь, иначе переустановка вебхука его сбросит
 *   SUPPORT_URL       - (необязательно) куда писать за доступом
 */

// Листы в приватной таблице доступа.
var CH_SHEET = 'Channels';
var AC_SHEET = 'Access';
var FD_SHEET = 'Folders';
var LG_SHEET = 'JoinLog';

// initData старше этого возраста не принимаем: подпись верна вечно, и без
// проверки времени перехваченная один раз строка работала бы годами.
var INITDATA_MAX_AGE_SEC = 24 * 60 * 60;

// На сколько кешируем ответ getChatMember. Десять каналов - это десять
// запросов к API на каждый заход; минуты кеша убирают почти все из них.
var MEMBER_CACHE_SEC = 300;

function prop_(name, optional) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v && !optional) throw new Error('Не задано свойство скрипта: ' + name);
  return v || '';
}

function botToken_() { return prop_('BOT_TOKEN'); }

function tgApi_(method, payload) {
  var opt = { method: 'post', contentType: 'application/json', muteHttpExceptions: true };
  if (payload) opt.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + botToken_() + '/' + method, opt);
  var j;
  try { j = JSON.parse(res.getContentText()); } catch (e) { throw new Error(method + ': ' + res.getContentText()); }
  if (!j.ok) throw new Error(method + ': ' + (j.description || res.getContentText()));
  return j.result;
}

function accessSS_() { return SpreadsheetApp.openById(prop_('ACCESS_SHEET_ID')); }

/**
 * Лист -> массив объектов по ИМЕНАМ столбцов из первой строки.
 * Специально не по номерам: вставленный однажды слева столбец не должен
 * молча сдвинуть весь разбор.
 */
function sheetRows_(name) {
  var sh = accessSS_().getSheetByName(name);
  if (!sh) throw new Error('В таблице доступа нет листа «' + name + '»');
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0].map(function (h) { return String(h).trim().toLowerCase(); });
  return v.slice(1).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[h] = row[i]; });
    return o;
  });
}

function str_(v) { return String(v == null ? '' : v).trim(); }

// Пустое значение считаем включённым: только что заполненный лист должен
// работать сразу, без возни с галочками. Выключаем явным false/0/no/нет/-.
function isActive_(v) {
  var s = str_(v).toLowerCase();
  if (!s) return true;
  return ['false', '0', 'no', 'нет', 'off', '-', 'ні'].indexOf(s) < 0;
}

// Тариф, который получают все без строки в Access: основной канал и прочее
// публичное. Пишется в столбец tier листа Channels.
function isFreeTier_(tier) {
  var s = str_(tier).toLowerCase();
  return s === 'free' || s === 'public' || s === 'all' || s === 'всем' || s === 'открытый';
}

function splitKeys_(v) {
  return str_(v).split(/[\s,;]+/).filter(function (x) { return !!x; }).map(function (x) { return x.toLowerCase(); });
}


// ========================================================================
// 02_initdata.gs
// ========================================================================

/**
 * ПРОВЕРКА ПОДПИСИ Telegram.WebApp.initData.
 *
 * Мини-приложение - обычная веб-страница, и её код открыт. Если принимать
 * user_id из тела запроса на веру, любой желающий пришлёт чужой id и получит
 * его персональный список каналов вместе с инвайт-ссылками. Поэтому клиент
 * присылает initData целиком, а мы пересчитываем HMAC и сравниваем с hash.
 *
 * Алгоритм Telegram:
 *   secret_key       = HMAC_SHA256(ключ = bot_token, данные = "WebAppData")
 *   data_check_string = пары "ключ=значение" (значения РАСКОДИРОВАНЫ),
 *                       кроме hash и signature, отсортированные по ключу
 *                       и склеенные через \n
 *   hash             = HMAC_SHA256(ключ = secret_key, данные = data_check_string), hex
 */

function validateInitData_(initData) {
  var raw = String(initData || '');
  if (!raw) return { ok: false, error: 'no initData' };

  var pairs = raw.split('&');
  var hash = '';
  var parts = [];
  var map = {};
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    var k = pairs[i].slice(0, eq);
    var vRaw = pairs[i].slice(eq + 1);
    var v;
    try { v = decodeURIComponent(vRaw); } catch (e) { return { ok: false, error: 'bad encoding' }; }
    if (k === 'hash') { hash = v; continue; }
    map[k] = v;
    // signature - подпись сторонней проверки (Ed25519), в расчёт hash не входит.
    if (k === 'signature') continue;
    parts.push(k + '=' + v);
  }
  if (!hash || !parts.length) return { ok: false, error: 'no hash' };

  parts.sort();
  var secret = Utilities.computeHmacSha256Signature('WebAppData', botToken_());
  var sig = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(parts.join('\n')).getBytes(), secret);

  if (!eqConst_(bytesToHex_(sig), String(hash).toLowerCase())) {
    return { ok: false, error: 'bad signature' };
  }

  var age = Math.floor(Date.now() / 1000) - Number(map.auth_date || 0);
  if (!map.auth_date || age < -60 || age > INITDATA_MAX_AGE_SEC) {
    return { ok: false, error: 'stale auth_date' };
  }

  var user;
  try { user = JSON.parse(map.user || 'null'); } catch (e) { user = null; }
  if (!user || !user.id) return { ok: false, error: 'no user' };

  return { ok: true, user: user, authDate: Number(map.auth_date), startParam: map.start_param || '' };
}

function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    // В Apps Script байты знаковые (-128..127) - приводим к 0..255.
    var b = (bytes[i] + 256) % 256;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// Сравнение без ранних выходов: по времени ответа нельзя угадывать hash по байтам.
function eqConst_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Разовая самопроверка. Открыть мини-приложение, в консоли взять
 * Telegram.WebApp.initData, вставить сюда и запустить - в логе должен
 * появиться ваш user.id.
 */
function testInitData() {
  var sample = '';  // <- вставить строку initData
  if (!sample) { Logger.log('Вставьте initData в переменную sample'); return; }
  Logger.log(JSON.stringify(validateInitData_(sample), null, 2));
}


// ========================================================================
// 03_miniapp_api.gs
// ========================================================================

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


// ========================================================================
// 04_join_request.gs
// ========================================================================

/**
 * ВЕТКА chat_join_request.
 *
 * Пользователь жмёт «Вступить» в мини-приложении, открывается ссылка с
 * creates_join_request=true, Telegram присылает сюда заявку, а мы сверяем её
 * с листом Access и одобряем или отклоняем. Доступ не отзывается: кто вступил,
 * остаётся в канале навсегда - эта ветка срабатывает только на заявку.
 *
 * Как и API мини-приложения, это «пробник»: если тело запроса - не апдейт с
 * chat_join_request, функция возвращает null и запрос идёт дальше, к коду
 * сигналов. Его логика не меняется.
 */

function tgJoinTryHandle_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body) return null;

  var upd;
  try { upd = JSON.parse(body); } catch (err) { return null; }
  if (!upd || !upd.chat_join_request) return null;

  // Адрес /exec публичный, а заголовки веб-приложению Apps Script недоступны,
  // поэтому secret_token проверить нельзя - вместо него секрет в query-строке
  // вебхука (см. README). Если он задан и не совпал, тихо отвечаем 200: такой
  // запрос не от Telegram, и пускать его дальше, к обработчику сигналов, тоже
  // незачем.
  var want = prop_('TG_HOOK_QS', true);
  if (want && (!e.parameter || e.parameter.s !== want)) {
    return ContentService.createTextOutput('ok');
  }

  try {
    handleJoinRequest_(upd.chat_join_request);
  } catch (err) {
    var r = upd.chat_join_request;
    logJoin_((r.from && r.from.id) || '', (r.from && r.from.username) || '',
             (r.chat && r.chat.id) || '', '', 'error', String((err && err.message) || err));
  }
  // Telegram повторяет апдейт, пока не получит 200. Ошибка внутри не должна
  // превращаться в бесконечный поток повторов.
  return ContentService.createTextOutput('ok');
}

function handleJoinRequest_(req) {
  var user = req.from || {};
  var chatId = String((req.chat && req.chat.id) || '');
  var uid = String(user.id || '');
  if (!chatId || !uid) return;

  // Защита от повторной доставки одного и того же апдейта.
  var cache = CacheService.getScriptCache();
  var mark = 'jr_' + chatId + '_' + uid;
  if (cache.get(mark)) return;
  cache.put(mark, '1', 600);

  var chans = loadChannels_();
  var ch = null;
  for (var i = 0; i < chans.length; i++) {
    if (String(chans[i].chatId) === chatId) { ch = chans[i]; break; }
  }

  if (!ch) {
    // Канала нет в Channels - значит он не управляется этим экраном. Заявку
    // не трогаем вовсе: пусть владелец решит вручную, это честнее, чем
    // отклонить живого клиента из-за незаполненной строки.
    logJoin_(uid, user.username, chatId, '', 'skipped', 'chat_id не найден в Channels');
    return;
  }

  var granted = channelGranted_(ch, grantsFor_(uid));

  if (granted) {
    tgApi_('approveChatJoinRequest', { chat_id: chatId, user_id: Number(uid) });
    logJoin_(uid, user.username, chatId, ch.key, 'approved', '');
    return;
  }

  // Сообщение отправляем ДО отклонения: user_chat_id действует, пока заявка
  // не обработана. После decline писать уже некуда.
  if (req.user_chat_id) {
    try {
      tgApi_('sendMessage', {
        chat_id: req.user_chat_id,
        text: declineText_(user.language_code, ch),
        disable_web_page_preview: true,
      });
    } catch (e) { /* человек мог закрыть личку боту - на решение это не влияет */ }
  }
  tgApi_('declineChatJoinRequest', { chat_id: chatId, user_id: Number(uid) });
  logJoin_(uid, user.username, chatId, ch.key, 'declined', 'нет доступа к тарифу ' + (ch.tier || '-'));
}

function declineText_(langCode, ch) {
  var l = String(langCode || '').slice(0, 2).toLowerCase();
  var support = prop_('SUPPORT_URL', true);
  var tail = support ? ' ' + support : '';
  var title = pick_(ch.titles, l === 'uk' ? 'uk' : (l === 'ru' ? 'ru' : 'en')) || ch.key;

  if (l === 'uk') {
    return 'Заявку на «' + title + '» відхилено: цей канал не входить до вашого тарифу. ' +
           'Щодо підключення напишіть у підтримку.' + tail;
  }
  if (l === 'ru' || l === 'be' || l === 'kk') {
    return 'Заявка на «' + title + '» отклонена: этот канал не входит в ваш тариф. ' +
           'За подключением напишите в поддержку.' + tail;
  }
  return 'Your request to join "' + title + '" was declined: this channel is not part of your plan. ' +
         'Please contact support to get access.' + tail;
}

function logJoin_(userId, username, chatId, key, decision, reason) {
  try {
    var sh = accessSS_().getSheetByName(LG_SHEET);
    if (!sh) return;
    sh.appendRow([new Date(), String(userId || ''), String(username || ''),
                  String(chatId || ''), String(key || ''), decision, reason || '']);
  } catch (e) {
    // Журнал - не причина не пустить человека в канал.
    Logger.log('JoinLog: ' + e);
  }
}


// ========================================================================
// 05_setup.gs
// ========================================================================

/**
 * РАЗОВЫЕ УТИЛИТЫ. Запускаются руками из редактора Apps Script, в обычной
 * работе не участвуют. Порядок запуска - в README.
 */

/** Проверка токена: в логе должно появиться имя вашего бота. */
function whoAmI() {
  Logger.log(JSON.stringify(tgApi_('getMe'), null, 2));
}

/** Создаёт в приватной таблице доступа все четыре листа с заголовками. */
function setupSheets() {
  var ss = accessSS_();
  var plan = {};
  plan[CH_SHEET] = ['key', 'title_ru', 'title_en', 'title_uk',
                    'description_ru', 'description_en', 'description_uk',
                    'chat_id', 'join_link', 'tier', 'sort_order', 'active'];
  plan[AC_SHEET] = ['user_id', 'username', 'channel_keys', 'tier', 'note', 'updated_at'];
  plan[FD_SHEET] = ['tier', 'folder_link'];
  plan[LG_SHEET] = ['timestamp', 'user_id', 'username', 'chat_id', 'channel_key', 'decision', 'reason'];

  Object.keys(plan).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); }
    if (str_(sh.getRange(1, 1).getValue())) { Logger.log(name + ': заголовки уже есть, не трогаю'); return; }
    sh.getRange(1, 1, 1, plan[name].length).setValues([plan[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    Logger.log(name + ': заголовки записаны');
  });
}

/**
 * Выпускает инвайт-ссылки с заявкой на вступление для строк Channels, где
 * join_link пуст, и записывает их в лист. Уже заполненные строки не трогает:
 * перевыпуск сломал бы ссылки, которые могли разойтись по людям.
 *
 * Требует, чтобы бот был админом канала с правом «приглашать пользователей».
 */
function setupInviteLinks() {
  var sh = accessSS_().getSheetByName(CH_SHEET);
  if (!sh) throw new Error('Нет листа ' + CH_SHEET);
  var v = sh.getDataRange().getValues();
  var head = v[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var cKey = head.indexOf('key'), cChat = head.indexOf('chat_id'), cLink = head.indexOf('join_link');
  if (cKey < 0 || cChat < 0 || cLink < 0) {
    throw new Error('В листе Channels нужны столбцы key, chat_id, join_link');
  }

  var made = 0, kept = 0, failed = [];
  for (var r = 1; r < v.length; r++) {
    var key = str_(v[r][cKey]), chat = str_(v[r][cChat]), link = str_(v[r][cLink]);
    if (!key || !chat) continue;
    if (link) { kept++; continue; }
    try {
      // member_limit тут недопустим: ссылка не впускает, а создаёт заявку.
      var res = tgApi_('createChatInviteLink', {
        chat_id: chat, creates_join_request: true, name: 'MiniApp access',
      });
      sh.getRange(r + 1, cLink + 1).setValue(res.invite_link);
      made++;
      Utilities.sleep(300);
    } catch (e) {
      failed.push(key + ': ' + ((e && e.message) || e));
    }
  }
  Logger.log('Выпущено: ' + made + ', оставлено как было: ' + kept);
  if (failed.length) Logger.log('НЕ УДАЛОСЬ (чаще всего бот не админ или неверный chat_id):\n' + failed.join('\n'));
}

/** Разовая генерация секрета для query-строки вебхука. */
function setupHookSecret() {
  var cur = prop_('TG_HOOK_QS', true);
  if (cur) { Logger.log('TG_HOOK_QS уже задан, оставляю как есть'); return; }
  var s = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      String(Date.now()) + Math.random() + Session.getTemporaryActiveUserKey())
  ).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  PropertiesService.getScriptProperties().setProperty('TG_HOOK_QS', s);
  Logger.log('TG_HOOK_QS записан. Теперь запустите webhookCheckJoinRequests().');
}

/**
 * РАЗОВОЕ ЗАПОЛНЕНИЕ ЛИСТА Channels.
 *
 * Набивать десяток каналов по двенадцати столбцам руками долго и легко
 * промахнуться. Опишите их в массиве ниже и запустите функцию один раз.
 *
 * Строки с уже существующим key не трогаются - функцию можно запускать
 * повторно, чтобы дописать новые каналы.
 *
 * join_link не указывайте: его выпустит install().
 */
function seedChannels() {
  var rows = [
    // { key: 'pro10', tier: 'pro', sort: 2, chat: '-1001234567890',
    //   ru: 'PRO 10m',  en: 'PRO 10m',  uk: 'PRO 10m',
    //   dru: 'Сигналы на 10 минут.', den: '10-minute signals.', duk: 'Сигнали на 10 хвилин.' },
  ];
  if (!rows.length) {
    Logger.log('Опишите каналы в массиве rows внутри seedChannels().');
    return;
  }

  var sh = accessSS_().getSheetByName(CH_SHEET);
  if (!sh) throw new Error('Нет листа ' + CH_SHEET);
  var v = sh.getDataRange().getValues();
  var head = v[0].map(function (h) { return String(h).trim().toLowerCase(); });

  var idx = {};
  ['key','title_ru','title_en','title_uk','description_ru','description_en','description_uk',
   'chat_id','join_link','tier','sort_order','active'].forEach(function (name) {
    idx[name] = head.indexOf(name);
    if (idx[name] < 0) throw new Error('В листе Channels нет столбца ' + name);
  });

  var have = {};
  for (var r = 1; r < v.length; r++) {
    var k = str_(v[r][idx.key]).toLowerCase();
    if (k) have[k] = true;
  }

  var added = 0, skipped = [];
  rows.forEach(function (c) {
    var key = str_(c.key).toLowerCase();
    if (!key) return;
    if (have[key]) { skipped.push(key); return; }

    var line = new Array(head.length).fill('');
    line[idx.key] = key;
    line[idx.title_ru] = c.ru || key;
    line[idx.title_en] = c.en || c.ru || key;
    line[idx.title_uk] = c.uk || c.ru || key;
    line[idx.description_ru] = c.dru || '';
    line[idx.description_en] = c.den || '';
    line[idx.description_uk] = c.duk || '';
    line[idx.chat_id] = c.chat || '';
    line[idx.join_link] = '';
    line[idx.tier] = c.tier || '';
    line[idx.sort_order] = c.sort || '';
    line[idx.active] = 'TRUE';
    sh.appendRow(line);
    have[key] = true;
    added++;
  });

  Logger.log('Добавлено каналов: ' + added +
             (skipped.length ? ', уже были и не тронуты: ' + skipped.join(', ') : ''));
  Logger.log('Дальше: install() - он проверит права бота и выпустит ссылки.');
}

/**
 * ПОИСК chat_id ПО ССЫЛКАМ НА СООБЩЕНИЯ.
 *
 * Самая долгая часть заполнения Channels - собрать десяток chat_id. Быстрый
 * способ: в канале правый клик по любому посту -> «Копировать ссылку».
 *   приватный канал -> t.me/c/2809766098/5608  -> chat_id = -1002809766098
 *   публичный канал -> t.me/mychannel/12       -> подойдёт @mychannel
 *
 * Вставьте ссылки в массив ниже и запустите. Функция не только пересчитает
 * id, но и спросит у Telegram название канала - по нему сразу видно, тот ли
 * это канал, и добавлен ли бот. Готовые строки печатаются в лог.
 */
function chatIdsFromLinks() {
  var links = [
    // 'https://t.me/c/2809766098/5608',
    // 'https://t.me/mychannel/12',
  ];
  if (!links.length) {
    Logger.log('Вставьте ссылки на сообщения в массив links внутри chatIdsFromLinks().');
    return;
  }
  var out = ['', 'ссылка -> chat_id -> название', ''];
  links.forEach(function (link) {
    var id = chatIdFromLink_(link);
    if (!id) { out.push(link + '  -> не разобрал ссылку'); return; }
    var title = '';
    try {
      var chat = tgApi_('getChat', { chat_id: id });
      title = '«' + (chat.title || chat.username || '?') + '»';
    } catch (e) {
      title = 'НЕ ВИДНО боту (' + String(e.message).replace(/^getChat: /, '') + ')';
    }
    out.push(id + '   ' + title);
  });
  out.push('', 'Значения из первого столбца - в Channels, столбец chat_id.');
  Logger.log(out.join('\n'));
}

function chatIdFromLink_(link) {
  var s = String(link || '').trim();
  var mPriv = s.match(/t\.me\/c\/(\d+)/i);
  if (mPriv) return '-100' + mPriv[1];
  var mPub = s.match(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (mPub && mPub[1].toLowerCase() !== 'c') return '@' + mPub[1];
  return '';
}

/**
 * Адрес веб-приложения этого проекта без хвоста /exec или /dev и без query.
 * В редакторе getUrl() иногда отдаёт /dev, поэтому сравниваем только основу.
 */
function hookBase_(u) {
  return String(u || '').split('?')[0].replace(/\/(exec|dev)\/?$/, '');
}

/**
 * Адрес веб-приложения этого проекта.
 *
 * ScriptApp.getService().getUrl() при запуске из редактора отдаёт ЧЕРНОВОЙ
 * адрес /dev: он открывается только владельцу после входа в Google, и ни
 * Telegram, ни мини-приложение по нему ничего не получат - вместо ответа
 * придёт html страницы логина. Боевой адрес /exec лежит в «Управление
 * развёртываниями» и имеет ДРУГОЙ идентификатор, подменой хвоста его не
 * получить.
 *
 * Поэтому главный источник - свойство скрипта WEB_APP_URL. getUrl() остаётся
 * запасным: если он отдал /exec, всё в порядке.
 */
function myWebAppUrl_() {
  var p = prop_('WEB_APP_URL', true);
  if (p) return str_(p);
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/** Черновой адрес .../dev - рабочим он не бывает никогда. */
function isDevUrl_(u) {
  return /\/dev\/?$/.test(String(u || '').split('?')[0]);
}

/** Общая жалоба на черновой адрес - её печатают три функции. */
function devUrlComplaint_(url) {
  return [
    'СТОП. Это ЧЕРНОВОЙ адрес веб-приложения:',
    '  ' + url,
    'Он открывается только вам после входа в Google - ни Telegram, ни',
    'мини-приложение по нему ничего не получат.',
    '',
    'Возьмите боевой адрес: Развёртывание -> Управление развёртываниями ->',
    'строка «Веб-приложение» -> «URL веб-приложения», он оканчивается на /exec.',
    'Положите его в Настройки проекта -> Свойства скрипта -> WEB_APP_URL',
    'и повторите запуск.',
  ].join('\n');
}

/**
 * Ставит вебхук бота на ЭТОТ проект. Нужно, когда код доступа живёт отдельно
 * от кода сигналов и у бота вебхука ещё нет.
 *
 * У бота может быть ровно один адрес вебхука. Если он уже занят, функция
 * останавливается и показывает занятый адрес: перебить его вслепую - верный
 * способ оборвать то, что по нему работает.
 */
function webhookSetHere() { webhookHere_(false); }

/** То же, но перезаписывает уже стоящий вебхук. Только осознанно. */
function webhookSetHereForce() { webhookHere_(true); }

function webhookHere_(force) {
  var url = myWebAppUrl_();
  if (!url) throw new Error('Веб-приложение не развёрнуто. Сначала Развёртывание -> Веб-приложение.');
  if (isDevUrl_(url)) { Logger.log(devUrlComplaint_(url)); return; }

  var secret = prop_('TG_HOOK_QS', true);
  var full = secret ? url + '?s=' + encodeURIComponent(secret) : url;

  var info = tgApi_('getWebhookInfo');
  if (info.url && hookBase_(info.url) !== hookBase_(url) && !force && !isDevUrl_(info.url)) {
    Logger.log('СТОП. У бота уже стоит вебхук:');
    Logger.log('  ' + info.url);
    Logger.log('');
    Logger.log('Адрес у бота один. Если по этому адресу работает ваш проект сигналов,');
    Logger.log('правильнее добавить код доступа ТУДА (README, шаг 5), а не менять адрес:');
    Logger.log('тогда один вебхук обслуживает и сигналы, и заявки.');
    Logger.log('Если точно хотите заменить адрес: webhookSetHereForce().');
    return;
  }

  var payload = { url: full, allowed_updates: ['chat_join_request'], drop_pending_updates: false };
  var token = prop_('TG_SECRET_TOKEN', true);
  if (token) payload.secret_token = token;
  tgApi_('setWebhook', payload);

  Logger.log('Вебхук установлен на этот проект:');
  Logger.log('  ' + full);
  Logger.log('Подписка сужена до chat_join_request - ничего другого сюда не придёт.');
  Logger.log('Учтите: пока стоит вебхук, опрос getUpdates для этого бота не работает.');
}

/** Показывает текущее состояние вебхука и говорит, нужно ли его менять. */
function webhookInfo() {
  var i = tgApi_('getWebhookInfo');
  Logger.log(JSON.stringify(i, null, 2));
  if (!i.allowed_updates || !i.allowed_updates.length) {
    Logger.log('allowed_updates НЕ задан -> действует подписка по умолчанию, ' +
               'а в неё chat_join_request уже входит. Переустанавливать вебхук ради заявок не нужно.');
  } else if (i.allowed_updates.indexOf('chat_join_request') < 0) {
    Logger.log('allowed_updates задан и chat_join_request в нём НЕТ -> нужен webhookApplyJoinRequests().');
  } else {
    Logger.log('chat_join_request уже в списке - всё в порядке.');
  }
}

/** Проверка без изменений: печатает, что именно будет отправлено. */
function webhookCheckJoinRequests() { webhookFix_(false); }

/** Применяет изменение вебхука. Запускать только после проверки. */
function webhookApplyJoinRequests() { webhookFix_(true); }

/**
 * Добавляет chat_join_request к allowed_updates, НЕ теряя остальные типы, и
 * при необходимости дописывает в адрес секрет query-строки.
 *
 * Два подводных камня, из-за которых тут всё так аккуратно:
 *  - setWebhook перезаписывает allowed_updates целиком. Отправить один
 *    chat_join_request = отписаться от всего остального, то есть оборвать
 *    приём апдейтов, на которых живёт бот.
 *  - getWebhookInfo НЕ возвращает secret_token. Если он на вебхуке стоит,
 *    переустановка его сбросит - поэтому положите его в TG_SECRET_TOKEN.
 */
function webhookFix_(apply) {
  var info = tgApi_('getWebhookInfo');
  if (!info.url) throw new Error('Вебхук не установлен. Сначала выясните, как сейчас приходят апдейты.');

  var cur = (info.allowed_updates && info.allowed_updates.length) ? info.allowed_updates.slice() : null;
  var secret = prop_('TG_HOOK_QS', true);
  var url = info.url;
  var urlFix = false;
  if (secret && url.indexOf('s=' + secret) < 0) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 's=' + encodeURIComponent(secret);
    urlFix = true;
  }

  // cur пустой - это подписка по умолчанию, в ней chat_join_request уже есть,
  // и подменять её явным списком не нужно.
  var send = null;
  if (cur) {
    send = cur.indexOf('chat_join_request') < 0 ? cur.concat(['chat_join_request']) : cur;
  }
  var updatesFix = !!(cur && send.length !== cur.length);

  if (!updatesFix && !urlFix) {
    Logger.log('Менять нечего: заявки уже приходят, адрес в порядке.');
    return;
  }

  var payload = { url: url, drop_pending_updates: false };
  if (send) payload.allowed_updates = send;
  if (info.max_connections) payload.max_connections = info.max_connections;
  var token = prop_('TG_SECRET_TOKEN', true);
  if (token) payload.secret_token = token;

  Logger.log('Было:  url=' + info.url + '\n       allowed_updates=' + JSON.stringify(info.allowed_updates || null));
  Logger.log('Будет: url=' + url + '\n       allowed_updates=' + JSON.stringify(send || null));
  if (!token) {
    Logger.log('ВНИМАНИЕ: TG_SECRET_TOKEN не задан. Если на вебхуке стоял secret_token, ' +
               'переустановка его сбросит. Проверьте и при необходимости заполните свойство.');
  }
  if (!apply) { Logger.log('Это ПРОВЕРКА, ничего не отправлено. Применить: webhookApplyJoinRequests().'); return; }

  tgApi_('setWebhook', payload);
  Logger.log('Вебхук обновлён. Проверьте: webhookInfo().');
}


// ========================================================================
// 06_install.gs
// ========================================================================

/**
 * УСТАНОВКА В ОДИН ЗАПУСК.
 *
 * install() делает всё, что может сделать сам: проверяет токен, заводит листы,
 * сверяет права бота в каждом канале, выпускает недостающие инвайт-ссылки,
 * смотрит вебхук - и печатает список того, что осталось сделать руками.
 *
 * Функция idempotent: запускайте сколько угодно раз. Ничего уже сделанного она
 * не переделывает и готовых ссылок не перевыпускает.
 */

function install() {
  var out = ['', '=== ДОСТУП К КАНАЛАМ: УСТАНОВКА ==='];
  var todo = [];
  var bad = [];
  var notes = [];
  var say = function (s) { out.push(s); };
  var done = function () { Logger.log(out.concat(tail_(todo, bad, notes)).join('\n')); };

  // --- свойства ---
  var missing = [];
  ['BOT_TOKEN', 'ACCESS_SHEET_ID'].forEach(function (k) { if (!prop_(k, true)) missing.push(k); });
  if (missing.length) {
    say('СТОП. Не заданы свойства скрипта: ' + missing.join(', '));
    say('Настройки проекта -> Свойства скрипта -> Добавить. Потом запустите install() снова.');
    Logger.log(out.join('\n'));
    return;
  }

  // --- бот ---
  var me;
  try {
    me = tgApi_('getMe');
    say('[1/5] Бот: @' + me.username + ' (id ' + me.id + ')');
  } catch (e) {
    say('СТОП. BOT_TOKEN не работает: ' + e.message);
    Logger.log(out.join('\n'));
    return;
  }

  // --- листы ---
  try {
    setupSheets();
    say('[2/5] Листы в таблице доступа: на месте');
  } catch (e) {
    say('СТОП. Таблица недоступна: ' + e.message);
    say('Проверьте ACCESS_SHEET_ID: это id ОТДЕЛЬНОЙ приватной таблицы.');
    Logger.log(out.join('\n'));
    return;
  }

  // --- каналы: права бота и ссылки ---
  var sh = accessSS_().getSheetByName(CH_SHEET);
  var v = sh.getDataRange().getValues();
  var head = v[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var cKey = head.indexOf('key'), cChat = head.indexOf('chat_id'), cLink = head.indexOf('join_link');

  var okCount = 0, made = 0, rows = 0;
  for (var r = 1; r < v.length; r++) {
    var key = str_(v[r][cKey]);
    if (!key) continue;
    rows++;
    var chat = str_(v[r][cChat]);
    if (!chat) {
      // Канал без chat_id, но с готовой ссылкой - не поломка: карточка работает,
      // просто заявки в него бот не разбирает. Так настроен основной канал.
      if (str_(v[r][cLink])) {
        notes.push(key + ': без chat_id - карточка работает по готовой ссылке, ' +
                   'но заявки в этот канал бот не обрабатывает');
      } else {
        bad.push(key + ': пустой chat_id (быстро собрать: chatIdsFromLinks())');
      }
      continue;
    }

    var st;
    try {
      st = tgApi_('getChatMember', { chat_id: chat, user_id: me.id });
    } catch (e) {
      bad.push(key + ': канал не отвечает (' + e.message.replace(/^getChatMember: /, '') + ')');
      continue;
    }
    if (st.status !== 'administrator') {
      bad.push(key + ': бот не админ канала (сейчас «' + st.status + '»)');
      continue;
    }
    if (st.can_invite_users === false) {
      bad.push(key + ': у бота нет права «Пригласительные ссылки»');
      continue;
    }
    okCount++;

    if (!str_(v[r][cLink])) {
      try {
        var res = tgApi_('createChatInviteLink', { chat_id: chat, creates_join_request: true, name: 'MiniApp access' });
        sh.getRange(r + 1, cLink + 1).setValue(res.invite_link);
        made++;
        Utilities.sleep(300);
      } catch (e) {
        bad.push(key + ': не удалось выпустить ссылку (' + e.message + ')');
      }
    }
  }

  if (!rows) {
    say('[3/5] Лист Channels пуст');
    todo.push('Заполните лист Channels: по строке на канал. chat_id быстрее всего ' +
              'собрать функцией chatIdsFromLinks() - по ссылкам на посты в каналах. ' +
              'Они же есть в коде, которым вы рассылаете сигналы.');
  } else {
    say('[3/5] Каналов в листе: ' + rows + ', готовых к работе: ' + okCount +
        (made ? ', выпущено новых ссылок: ' + made : ''));
  }

  // --- доступы ---
  var acc = 0;
  try { acc = sheetRows_(AC_SHEET).filter(function (x) { return str_(x['user_id']); }).length; } catch (e) {}
  say('[4/5] Строк в Access: ' + acc);
  if (!acc) todo.push('Добавьте себя в Access: user_id = ваш telegram-id, channel_keys = *');

  // --- вебхук ---
  try {
    var info = tgApi_('getWebhookInfo');
    var mine = myWebAppUrl_();
    if (!info.url) {
      say('[5/5] Вебхук у бота НЕ установлен - заявки сейчас никуда не приходят');
      todo.push(mine
        ? 'Запустите webhookSetHere() - вебхук встанет на этот проект.'
        : 'Разверните веб-приложение, затем запустите webhookSetHere().');
    } else if (isDevUrl_(info.url)) {
      say('[5/5] Вебхук стоит на ЧЕРНОВОЙ адрес /dev - Telegram по нему не достучится');
      todo.push('Заявки сейчас НЕ обрабатываются. Положите боевой адрес /exec в свойство ' +
                'WEB_APP_URL и запустите webhookSetHere() заново.');
    } else if (mine && hookBase_(info.url) !== hookBase_(mine)) {
      say('[5/5] Вебхук стоит на ДРУГОЙ адрес: ' + info.url);
      todo.push('Заявки уходят не в этот проект. Либо добавьте код доступа в тот проект, ' +
                'что стоит на вебхуке (README, шаг 5), либо перенесите вебхук сюда: ' +
                'webhookSetHere(). Адрес у бота только один.');
    } else if (!info.allowed_updates || !info.allowed_updates.length) {
      say('[5/5] Вебхук: allowed_updates не задан -> chat_join_request уже приходит, менять нечего');
    } else if (info.allowed_updates.indexOf('chat_join_request') < 0) {
      say('[5/5] Вебхук: chat_join_request НЕ подписан');
      todo.push('Запустите webhookCheckJoinRequests(), посмотрите «Было/Будет», ' +
                'затем webhookApplyJoinRequests().');
    } else {
      say('[5/5] Вебхук: chat_join_request подписан');
    }
  } catch (e) {
    say('[5/5] Вебхук проверить не удалось: ' + e.message);
  }

  // В отдельном проекте doPost приходит из 07_standalone_doPost.gs и уже всё
  // вызывает; четыре строки нужны только тем, кто добавил код к сигналам.
  todo.push('Если код доступа добавлен в проект с сигналами - добавьте четыре строки ' +
            'в начало вашего doPost (README, шаг 5). В отдельном проекте doPost уже готов.');
  todo.push('Разверните НОВУЮ ВЕРСИЮ существующего развёртывания, потом запустите checkDeployment().');

  done();
}

function tail_(todo, bad, notes) {
  var out = [];
  if (notes && notes.length) {
    out.push('', '--- ЗАМЕТКИ ---');
    notes.forEach(function (s, i) { out.push((i + 1) + '. ' + s); });
  }
  if (bad.length) {
    out.push('', '--- ПРОБЛЕМЫ ПО КАНАЛАМ ---');
    bad.forEach(function (s, i) { out.push((i + 1) + '. ' + s); });
    out.push('Почти всегда это одно из двух: бот не добавлен админом в канал ' +
             'или chat_id не от этого канала.');
  }
  out.push('', '--- ОСТАЛОСЬ СДЕЛАТЬ РУКАМИ ---');
  if (!todo.length) out.push('Ничего. Можно тестировать.');
  todo.forEach(function (s, i) { out.push((i + 1) + '. ' + s); });
  return out;
}

/**
 * Проверка после развёртывания: действительно ли запросы мини-приложения
 * доходят до новой ветки.
 *
 * Отправляет один запрос на собственный адрес /exec. Запускать ПОСЛЕ того, как
 * четыре строки добавлены в doPost: тогда запрос перехватывает новая ветка и до
 * кода сигналов он не доходит.
 */
function checkDeployment() {
  var url = myWebAppUrl_();
  if (!url) { Logger.log('Веб-приложение не развёрнуто.'); return; }
  if (isDevUrl_(url)) { Logger.log(devUrlComplaint_(url)); return; }
  Logger.log('Адрес: ' + url);

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/plain;charset=utf-8',
    payload: JSON.stringify({ action: 'getMyChannels', initData: '' }),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  var body = res.getContentText();

  var j = null;
  try { j = JSON.parse(body); } catch (e) {}

  if (j && j.ok === false && /auth/.test(String(j.error))) {
    Logger.log('ГОТОВО. Ветка мини-приложения отвечает и без подписи данные не отдаёт.');
    Logger.log('Этот адрес впишите в app.js: const CHAN_API = \'' + url + '\';');
    return;
  }
  if (j && j.ok === true) {
    Logger.log('ТРЕВОГА: сервер отдал данные на запрос БЕЗ подписи. Проверьте 02_initdata.gs.');
    return;
  }
  if (/<!DOCTYPE html|<html/i.test(body)) {
    Logger.log('Пришла html-страница Google, а не ответ скрипта. Обычно это значит, что');
    Logger.log('адрес требует входа: проверьте, что в WEB_APP_URL боевой /exec, а в');
    Logger.log('настройках развёртывания «У кого есть доступ» стоит «Все».');
    return;
  }
  Logger.log('Ответ не от новой ветки - значит развёрнута старая версия кода ' +
             '(или, в общем проекте, не добавлены четыре строки в doPost). Получено:\n' +
             body.slice(0, 300));
}

