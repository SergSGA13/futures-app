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
