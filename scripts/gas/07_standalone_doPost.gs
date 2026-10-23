/**
 * doPost ДЛЯ ОТДЕЛЬНОГО ПРОЕКТА.
 *
 * ВНИМАНИЕ. Этот файл нужен ТОЛЬКО если код доступа к каналам живёт в своём
 * проекте Apps Script, отдельно от кода сигналов.
 *
 * Если вы добавляете код в СУЩЕСТВУЮЩИЙ проект с сигналами - этого файла
 * быть не должно. В Apps Script все файлы в одном пространстве имён, и второе
 * объявление doPost молча затирает первое: приём алертов TradingView просто
 * перестанет работать. Там вместо этого добавляют четыре строки в начало
 * существующего doPost (README, шаг 5).
 */

function doPost(e) {
  var mini = miniAppTryHandle_(e);
  if (mini) return mini;

  var join = tgJoinTryHandle_(e);
  if (join) return join;

  // Сюда попадает всё остальное. В отдельном проекте ничего другого прийти не
  // должно, но отвечаем 200, чтобы Telegram не копил повторы.
  return ContentService.createTextOutput('ok');
}

function doGet() {
  return ContentService.createTextOutput('ok');
}
