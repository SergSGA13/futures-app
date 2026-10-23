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
