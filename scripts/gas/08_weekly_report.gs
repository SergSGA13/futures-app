/**
 * НЕДЕЛЬНЫЙ ОТЧЁТ: картинка и PDF - владельцу в личный чат с ботом.
 *
 * Мини-приложение рисует слайд итогов недели у себя и присылает сюда JPEG
 * и PDF в base64 (действие sendWeeklyReport, см. 03_miniapp_api.gs). Скачать
 * файл из мини-приложения в Telegram на телефоне нельзя, а из чата с ботом
 * его можно переслать в канал.
 *
 * Отправлять разрешено только владельцу. Список id - в свойстве скрипта
 * REPORT_OWNER_IDS (через запятую); без него - id владельца мини-приложения
 * (тот же, что DEV_ADMIN_TG_ID в app.js). Подпись initData проверяется
 * до этого, в miniAppTryHandle_.
 *
 * Шлём от имени бота мини-приложения: владелец его открывал, значит чат с
 * ним есть, и бот вправе написать первым.
 */

var REPORT_OWNER_DEFAULT = '431358856';
// Base64 на ~10 МБ файла: больше Telegram не примет фото, а настоящий
// слайд весит около мегабайта.
var REPORT_MAX_B64 = 14 * 1024 * 1024;

function reportOwnerIds_() {
  return (prop_('REPORT_OWNER_IDS', true) || REPORT_OWNER_DEFAULT)
    .split(/[\s,;]+/).filter(function (x) { return !!x; });
}

function sendWeeklyReport_(user, req) {
  if (reportOwnerIds_().indexOf(String(user.id)) < 0) return { ok: false, error: 'forbidden' };
  var jpg = String(req.jpg || ''), pdf = String(req.pdf || '');
  if (!jpg || !pdf) return { ok: false, error: 'no files' };
  if (jpg.length > REPORT_MAX_B64 || pdf.length > REPORT_MAX_B64) return { ok: false, error: 'file too large' };

  var name = String(req.name || 'weekly').replace(/[^\w.-]/g, '_').slice(0, 60);
  var week = String(req.week || '').replace(/[^\d.\s–-]/g, '').slice(0, 40);
  var base = 'https://api.telegram.org/bot' + miniAppBotToken_() + '/';
  var chat = String(user.id);

  var photo = Utilities.newBlob(Utilities.base64Decode(jpg), 'image/jpeg', name + '.jpg');
  var r1 = tgMultipart_(base + 'sendPhoto', { chat_id: chat, caption: 'Weekly Report · ' + week, photo: photo });
  if (!r1.ok) return { ok: false, error: 'sendPhoto: ' + (r1.description || 'error') };

  var doc = Utilities.newBlob(Utilities.base64Decode(pdf), 'application/pdf', name + '.pdf');
  var r2 = tgMultipart_(base + 'sendDocument', { chat_id: chat, document: doc });
  if (!r2.ok) return { ok: false, error: 'sendDocument: ' + (r2.description || 'error') };

  return { ok: true };
}

// Payload с Blob внутри UrlFetchApp сам отправляет как multipart/form-data -
// так Telegram и принимает файлы.
function tgMultipart_(url, payload) {
  var res = UrlFetchApp.fetch(url, { method: 'post', payload: payload, muteHttpExceptions: true });
  try { return JSON.parse(res.getContentText()); }
  catch (e) { return { ok: false, description: res.getContentText().slice(0, 200) }; }
}
