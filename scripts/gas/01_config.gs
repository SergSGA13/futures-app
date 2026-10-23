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
