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
  var say = function (s) { out.push(s); };
  var done = function () { Logger.log(out.concat(tail_(todo, bad)).join('\n')); };

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
    if (!chat) { bad.push(key + ': пустой chat_id'); continue; }

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
    todo.push('Заполните лист Channels: по строке на канал. chat_id можно взять из кода, ' +
              'которым вы уже рассылаете сигналы, - он там есть.');
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

function tail_(todo, bad) {
  var out = [];
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
  var url;
  try { url = ScriptApp.getService().getUrl(); } catch (e) { url = ''; }
  if (!url) { Logger.log('Веб-приложение не развёрнуто.'); return; }
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
  Logger.log('Ответ не от новой ветки - значит четыре строки в doPost не добавлены ' +
             'или развёрнута старая версия. Получено:\n' + body.slice(0, 500));
}
