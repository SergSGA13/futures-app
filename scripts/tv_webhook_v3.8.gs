// ============================================================
// TradingView Signal Webhook → Telegram + Google Sheets  v3.8
// ОДИН скрипт на ОБА актива (ETH + BTC), запись в ОДНУ вкладку.
// ============================================================
// v3.8: новая схема лимитов по итогам реплея 7 917 сигналов
//   (Signals_Log, 359 дней) через симулятор фильтров:
//   - окно пер-актив лимитов сокращено 11 → 5 минут
//     (кластеры сигналов плотные: половина идёт с гэпом <2 мин;
//     короткое окно режет хвост пачки, но быстро пускает
//     следующий независимый заход);
//   - лимиты: ETH 3 → 2, BTC 2 → 1 сигнал в окне;
//   - НОВЫЙ фильтр F8: глобальный кап - суммарно не больше
//     5 принятых сигналов (ETH+BTC вместе) за скользящие
//     11 минут. Отражает биржевой лимит 5 ставок в моменте:
//     без него окно 5 мин может пропустить до 7 позиций.
//   На бэктесте (последние 120 дней): PNL на уровне старой
//   схемы, EV/сигнал +9.3 → +11.1, сумма убытков -16%,
//   худший месяц -5875 → -2900.
// v3.7: фильтр F7 переведён на ПРОИЗВОЛЬНЫЕ минутные окна
//   (CONFIG.WEEKDAY_BLOCK.WINDOWS: список {from:"HH:MM", to:"HH:MM"}),
//   вместо целых часов HOUR_FROM/HOUR_TO. Границы включительны.
// v3.6: фильтр F7 - блокировка сигналов Пн-Чт 14:00-16:59 (Варшава);
//   удалён устаревший блэклист F0 (его роль полностью закрывает
//   авто-карантин DEV_BADLIST - список обновляется сам каждое утро,
//   а не редактируется руками в коде).
// v3.5: авто-карантин по DEV_BADLIST (фильтр F6).
//   Вкладку DEV_BADLIST строит GitHub Actions каждое утро (~05:00
//   Варшавы): активные конфигурации, у которых WR за последние
//   4 дня упал ниже безубытка 55.6% (= отрицательный EV).
//   Сигналы таких конфигураций НЕ идут в Telegram и партнёру,
//   а пишутся в BLOCKEDsignal с причиной "F6: авто-карантин".
//   Статистика по ним продолжает копиться (результаты BLOCKED
//   учитываются в анализе) - если конфигурация реабилитируется,
//   она выпадает из DEV_BADLIST и карантин снимается САМ.
//   Список кэшируется на BADLIST.CACHE_TTL_SEC (час) через
//   CacheService - чтение вкладки НЕ происходит на каждый сигнал
//   и НЕ попадает в критическую секцию под локом.
//   Сбой чтения списка = fail-open (карантин пропускается,
//   основной поток не страдает).
// v3.4: добавлен partner webhook (sendPartnerWebhook).
//   Шлём только сигналы, прошедшие фильтры (ALLsignal).
//   secret и Settings партнёру НЕ передаются.
//   Ошибка на стороне партнёра не влияет на основной поток.
// ============================================================
// ЗАЧЕМ возврат к одному скрипту:
//   Потеря сигналов после 16.06 была НЕ из-за одной вкладки, а
//   из-за ДВУХ скриптов. LockService.getScriptLock() сериализует
//   вызовы только ВНУТРИ своего проекта; два проекта писали в один
//   диапазон без общего лока → их appendRow гонялись и затирали
//   друг друга (терялся менее частотный поток — BTC, ~32%).
//   Один скрипт = один лок = все записи в очередь = потерь нет.
//   Именно так всё и работало ДО разделения.
//
//   При этом ETH и BTC сохраняют РАЗДЕЛЬНЫЕ лимиты (как у двух
//   скриптов): см. CONFIG.LIMITS. Лимиты окна/цены теперь считаются
//   ПО КАЖДОМУ активу отдельно. Конфликт направлений и дедуп уже
//   были по активу.
//
//   Запись в одну вкладку ALLsignal / BLOCKEDsignal — другие сервисы,
//   которые тянут данные оттуда, продолжают работать без изменений.
//
//   Надёжность из v3.2 сохранена: appendRowSafe_ (ретрай + flush),
//   резервная вкладка FAILED, честный флаг записи в ответе.
// ============================================================
// МИГРАЦИЯ v3.7 → v3.8: просто заменить код (Script Properties и
//   состояние signal_state_v2 совместимы). Откат к старой схеме:
//   WINDOW_MINUTES: 11, LIMITS ETH {3,2} / BTC {2,1},
//   GLOBAL_CAP.ENABLED = false.
// МИГРАЦИЯ v3.6 → v3.7: просто заменить код. Окна фильтра F7
//   правятся в CONFIG.WEEKDAY_BLOCK.WINDOWS (время "HH:MM", Варшава).
// МИГРАЦИЯ v3.5 → v3.6: просто заменить код. Выключатель нового
//   фильтра: CONFIG.WEEKDAY_BLOCK.ENABLED = false.
// МИГРАЦИЯ v3.4 → v3.5:
//   1) Заменить код проекта этим файлом (Script Properties не меняются).
//   2) Запустить selfTest() один раз - убедиться, что DEV_BADLIST
//      читается (строка "badlist:" в логе).
//   3) Всё. Отключить карантин без удаления кода:
//      CONFIG.BADLIST.ENABLED = false.
// ============================================================
// Script Properties:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SPREADSHEET_ID, WEBHOOK_SECRET
// Алерт TradingView: "secret":"<строка>", "bartime":"{{timenow}}"
// ============================================================

const CONFIG = {
  SHEET_NAME:         "ALLsignal",       // одна вкладка на оба актива
  BLOCKED_SHEET_NAME: "BLOCKEDsignal",
  FAILED_SHEET_NAME:  "FAILEDsignal",    // резерв для несостоявшихся записей

  WINDOW_MINUTES: 5,      // v3.8: было 11 - окно пер-актив лимитов
  CONFLICT_MINUTES: 10,

  // ─── РАЗДЕЛЬНЫЕ лимиты по активам (v3.8: ETH 3→2, BTC 2→1) ───
  LIMITS: {
    ETH: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 2 },
    BTC: { MAX_SIGNALS_PER_WINDOW: 1, MAX_SAME_PRICE: 1 },
  },

  // ─── F8: глобальный кап (v3.8) - суммарно по ОБОИМ активам ───
  // Не больше MAX_OPEN принятых сигналов за скользящие WINDOW_MINUTES.
  // Отражает биржевой лимит 5 ставок в моменте: пер-актив окна по
  // 5 минут без него могут выпустить до 7 позиций за 11 минут.
  GLOBAL_CAP: {
    ENABLED: true,
    MAX_OPEN: 5,
    WINDOW_MINUTES: 11,
  },

  // ─── Переключатели фильтров (общие для обоих активов) ───
  ENABLE_UP_0514:        false,  // F2: UP 05-14 мин
  ENABLE_UP_5054:        false,  // F2b: UP 50-54 мин
  ENABLE_DOWN_0207H:     false,  // F1: СНЯТ
  ENABLE_DOWN_5054:      false,  // F3: СНЯТ
  ENABLE_CONFLICT:       true,   // FC: конфликт направлений
  ENABLE_DEDUP:          false,  // FD: СНЯТ
  DEDUP_SECONDS: 90,

  // ─── F7: блокировка по дням недели и минутным окнам (Варшава) ───
  // Границы включительны (from..to). Окно может быть любой длины и
  // пересекать полночь (from > to, напр. "23:30"-"00:30").
  WEEKDAY_BLOCK: {
    ENABLED: true,
    DAYS: ["Mon", "Tue", "Wed", "Thu"],  // Пн-Чт включительно
    WINDOWS: [
      { from: "14:20", to: "14:59" },
      { from: "15:20", to: "15:59" },
    ],
  },

  // ─── F6: авто-карантин по DEV_BADLIST ───
  BADLIST: {
    ENABLED: true,                 // false - отключить карантин без удаления кода
    SHEET_NAME: "DEV_BADLIST",     // вкладку строит GitHub Actions ежедневно
    CACHE_KEY: "dev_badlist_v1",
    CACHE_TTL_SEC: 3600,           // перечитывать вкладку не чаще раза в час
  },

  // ─── Надёжность записи ───
  WRITE_RETRIES: 3,
  WRITE_RETRY_SLEEP_MS: 350,

  // ─── Partner webhook ───
  PARTNER_WEBHOOK_URL: "https://signalapiwebhook1312.win/webhook/signal/74f9addb559e663d75047ed9d250edf6e526510cd47440be",
  PARTNER_WEBHOOK_ENABLED: true,  // false — отключить без удаления кода
  PARTNER_WEBHOOK_TIMEOUT: 10,    // секунд

};

function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error("Script property missing: " + key);
  return v;
}

// ─── DEV_BADLIST: загрузка списка карантина ──────────────────
// Вызывается ДО лока. Обычный путь - мгновенный (CacheService);
// чтение вкладки происходит максимум раз в CACHE_TTL_SEC.
// Любой сбой = пустой список (fail-open): карантин тихо пропускается,
// сигналы идут как обычно - основной поток важнее фильтра.
function loadBadlist_() {
  if (!CONFIG.BADLIST.ENABLED) return [];
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CONFIG.BADLIST.CACHE_KEY);
    if (cached != null) return JSON.parse(cached);

    const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
    const sh = ss.getSheetByName(CONFIG.BADLIST.SHEET_NAME);
    let list = [];
    if (sh && sh.getLastRow() > 1) {
      const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      list = vals.map(function (r) { return String(r[0] || "").trim(); })
                 .filter(function (s) { return s && s !== "OK"; });
    }
    cache.put(CONFIG.BADLIST.CACHE_KEY, JSON.stringify(list), CONFIG.BADLIST.CACHE_TTL_SEC);
    console.log("DEV_BADLIST загружен из вкладки:", list.length, "конфигураций (кэш на " + CONFIG.BADLIST.CACHE_TTL_SEC + "с)");
    return list;
  } catch (err) {
    console.error("loadBadlist_ failed (fail-open, карантин пропущен):", err);
    return [];
  }
}

// Сброс кэша списка (запустить руками, если нужно применить свежий
// DEV_BADLIST немедленно, не дожидаясь истечения часа).
function resetBadlistCache() {
  CacheService.getScriptCache().remove(CONFIG.BADLIST.CACHE_KEY);
  console.log("Badlist cache reset OK");
}

// ─── WEBHOOK HANDLER ─────────────────────────────────────────
function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return buildResponse("error", "bad json");
  }

  if (data.secret !== getProp_("WEBHOOK_SECRET")) {
    return buildResponse("error", "unauthorized");
  }
  delete data.secret;

  // ── Фаза 0: карантинный список (кэш; сеть/таблица - максимум раз в час) ──
  const badlist = loadBadlist_();

  // ── Фаза 1: критическая секция (только состояние, без IO) ──
  let decision;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    try { logFailed_(data, "LOCK TIMEOUT — не удалось войти в критическую секцию"); }
    catch (e2) { console.error("FAILED-log на LOCK TIMEOUT не удался:", e2); }
    return buildResponse("error", "Lock timeout (записано в FAILED)");
  }
  try {
    decision = decideSignal_(data, badlist);
  } catch (err) {
    console.error("decideSignal error:", err);
    lock.releaseLock();
    try { logFailed_(data, "decideSignal exception: " + err.message); } catch (e2) { console.error(e2); }
    return buildResponse("error", err.message);
  }
  lock.releaseLock();

  // ── Фаза 2: медленный IO (ВНЕ лока) ──
  let ss;
  try {
    ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  } catch (err) {
    console.error("openById failed:", err);
    console.error("LOST PAYLOAD:", JSON.stringify(data), "decision:", JSON.stringify(decision));
    return buildResponse("error", "spreadsheet open failed");
  }

  if (decision.status === "sent") {
    let tgOK = true, sheetOK = false, partnerOK = true;
    try { sendTelegram(data); } catch (e2) { tgOK = false; console.error("TG fail:", e2); }
    try { sendPartnerWebhook(data); } catch (e2) { partnerOK = false; console.error("Partner fail:", e2); }
    sheetOK = writeToSheets_(ss, data);
    if (!sheetOK) logFailed_safe_(ss, data, "ALLsignal write failed после " + CONFIG.WRITE_RETRIES + " попыток");
    return buildResponse("sent", decision.message + " (tg:" + tgOK + ", sheet:" + sheetOK + ", partner:" + partnerOK + ")");
  } else {
    const okB = logBlocked_(ss, data, decision.message);
    if (!okB) logFailed_safe_(ss, data, "BLOCKED write failed: " + decision.message);
    return buildResponse("blocked", decision.message + " (sheet:" + okB + ")");
  }
}

// ─── РЕШЕНИЕ (под локом, без сетевого IO) ───────────────────
function decideSignal_(data, badlist) {
  const now = data.bartime ? new Date(data.bartime) : new Date();
  const props = PropertiesService.getScriptProperties();

  const stateRaw = props.getProperty("signal_state_v2");
  let state = stateRaw ? JSON.parse(stateRaw) : { sent: [] };
  if (!state.sent) state.sent = [];

  // v3.8: стейт храним на МАКСИМАЛЬНЫЙ из горизонтов фильтров
  // (кап 11 мин > конфликт 10 мин > окно лимитов 5 мин);
  // каждый фильтр ниже режет список по своему сроку сам.
  const windowMs = CONFIG.WINDOW_MINUTES * 60 * 1000;
  const capMs = CONFIG.GLOBAL_CAP.WINDOW_MINUTES * 60 * 1000;
  const keepMs = Math.max(windowMs, CONFIG.CONFLICT_MINUTES * 60 * 1000,
                          CONFIG.GLOBAL_CAP.ENABLED ? capMs : 0);
  state.sent = state.sent.filter(s => now.getTime() - s.t < keepMs);

  const direction = (data.direction || "").toUpperCase();
  const isUp = (direction === "UP" || direction === "BUY");
  const isDown = (direction === "DOWN" || direction === "SELL");
  const dir = isUp ? "UP" : (isDown ? "DOWN" : "?");
  const asset = (data.ticker || "").indexOf("BTC") >= 0 ? "BTC" : "ETH";
  const settings = data.Settings || "";

  // лимиты выбираются ПО АКТИВУ
  const lim = CONFIG.LIMITS[asset] || CONFIG.LIMITS.ETH;

  const currentHour = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "H"));
  const currentMinute = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "m"));

  const priceNum = parseFloat(data.price) || 0;
  data.price = priceNum.toFixed(2);
  data.volume = (parseFloat(data.volume) || 0).toFixed(2);
  const price = data.price;

  const blocked = (msg) => {
    props.setProperty("signal_state_v2", JSON.stringify(state));
    return { status: "blocked", message: msg };
  };

  // F6: авто-карантин DEV_BADLIST - конфигурации, у которых WR за последние
  // 4 дня ниже безубытка (список строит GitHub Actions каждое утро).
  // Точное совпадение строки Settings: список формируется из этой же колонки.
  // Карантинный сигнал уходит в BLOCKEDsignal и продолжает набирать
  // статистику - реабилитация снимает карантин автоматически.
  if (badlist && badlist.length && settings) {
    if (badlist.indexOf(settings.trim()) >= 0) {
      return blocked("F6: авто-карантин DEV_BADLIST (WR 4д ниже безубытка)");
    }
  }

  // F7: блокировка по дням недели и минутным окнам (Варшава) - оба направления
  if (CONFIG.WEEKDAY_BLOCK.ENABLED) {
    const wb = CONFIG.WEEKDAY_BLOCK;
    const dow = Utilities.formatDate(now, "Europe/Warsaw", "EEE");   // Mon..Sun
    if (wb.DAYS.indexOf(dow) >= 0) {
      const nowMin = currentHour * 60 + currentMinute;               // минут от полуночи
      const toMin = (hhmm) => { const p = String(hhmm).split(":"); return (+p[0]) * 60 + (+p[1]); };
      for (const win of (wb.WINDOWS || [])) {
        const a = toMin(win.from), b = toMin(win.to);
        // обычное окно (a<=b) ИЛИ окно через полночь (a>b)
        const inWin = (a <= b) ? (nowMin >= a && nowMin <= b) : (nowMin >= a || nowMin <= b);
        if (inWin)
          return blocked("F7: " + dow + " " + pad_(currentHour) + ":" + pad_(currentMinute) +
                         " (окно " + win.from + "-" + win.to + ")");
      }
    }
  }

  // F1: DOWN 02-07
  if (CONFIG.ENABLE_DOWN_0207H && isDown && currentHour >= 2 && currentHour <= 7)
    return blocked("F1: DOWN " + pad_(currentHour) + "h (02-07)");
  // F2: UP минутные зоны
  if (isUp) {
    if (CONFIG.ENABLE_UP_0514 && currentMinute >= 5 && currentMinute <= 14)
      return blocked("F2: UP мин " + pad_(currentMinute) + " (05-14)");
    if (CONFIG.ENABLE_UP_5054 && currentMinute >= 50 && currentMinute <= 54)
      return blocked("F2b: UP мин " + pad_(currentMinute) + " (50-54)");
  }
  // F3: DOWN 50-54
  if (CONFIG.ENABLE_DOWN_5054 && isDown && currentMinute >= 50 && currentMinute <= 54)
    return blocked("F3: DOWN мин " + pad_(currentMinute) + " (50-54)");

  // ── дальше — счётчики ПО ТЕКУЩЕМУ АКТИВУ ──
  // sameAsset - весь хранимый горизонт (для FD/FC с их сроками),
  // sameAssetWin - только окно лимитов WINDOW_MINUTES (для F4/F5).
  const sameAsset = state.sent.filter(s => s.asset === asset);
  const sameAssetWin = sameAsset.filter(s => now.getTime() - s.t < windowMs);

  // FD: дедуп (по активу)
  if (CONFIG.ENABLE_DEDUP) {
    const dedupMs = CONFIG.DEDUP_SECONDS * 1000;
    if (sameAsset.some(s => s.dir === dir && s.price === price &&
        (now.getTime() - s.t) < dedupMs))
      return blocked("FD: дубликат " + asset + " (" + price + ")");
  }
  // FC: конфликт (по активу)
  if (CONFIG.ENABLE_CONFLICT) {
    const conflictMs = CONFIG.CONFLICT_MINUTES * 60 * 1000;
    if (sameAsset.some(s => s.dir !== dir && (now.getTime() - s.t) < conflictMs))
      return blocked("FC: конфликт по " + asset + " за " + CONFIG.CONFLICT_MINUTES + " мин");
  }
  // F8: глобальный кап (v3.8) - суммарно по ОБОИМ активам за 11 мин
  if (CONFIG.GLOBAL_CAP.ENABLED) {
    const inCap = state.sent.filter(s => now.getTime() - s.t < capMs).length;
    if (inCap >= CONFIG.GLOBAL_CAP.MAX_OPEN)
      return blocked("F8: глобальный кап " + inCap + "/" + CONFIG.GLOBAL_CAP.MAX_OPEN +
                     " за " + CONFIG.GLOBAL_CAP.WINDOW_MINUTES + " мин");
  }
  // F4: лимит окна (по активу)
  if (sameAssetWin.length >= lim.MAX_SIGNALS_PER_WINDOW)
    return blocked("F4: лимит окна " + asset + " (" + sameAssetWin.length + "/" + lim.MAX_SIGNALS_PER_WINDOW + ")");
  // F5: лимит цены (по активу)
  const samePriceCount = sameAssetWin.filter(s => s.price === price).length;
  if (samePriceCount >= lim.MAX_SAME_PRICE)
    return blocked("F5: лимит цены " + asset + " " + price + " (" + samePriceCount + "/" + lim.MAX_SAME_PRICE + ")");

  // Пропускаем
  state.sent.push({ t: now.getTime(), price: price, dir: dir, asset: asset });
  props.setProperty("signal_state_v2", JSON.stringify(state));
  const cntAsset = sameAssetWin.length + 1;
  return { status: "sent", message: "Signal " + asset + " #" + cntAsset + " (price: " + price + ")" };
}

function pad_(n) { return (n < 10 ? "0" : "") + n; }

// ─── TELEGRAM ────────────────────────────────────────────────
function sendTelegram(data) {
  const url = "https://api.telegram.org/bot" + getProp_("TELEGRAM_BOT_TOKEN") + "/sendMessage";
  const payload = {
    chat_id: getProp_("TELEGRAM_CHAT_ID"),
    text: data.text || "Signal received",
    parse_mode: "HTML"
  };
  const response = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    console.error("Telegram error:", result.description);
    throw new Error("Telegram: " + result.description);
  }
}

// ─── PARTNER WEBHOOK ─────────────────────────────────────────
// Шлём только прошедшие фильтры (вызов только при status==="sent").
// secret и Settings партнёру НЕ передаются.
// Ошибка на их стороне не влияет на основной поток.
function sendPartnerWebhook(data) {
  if (!CONFIG.PARTNER_WEBHOOK_ENABLED) return;
  const payload = {
    ticker:    data.ticker    || "",
    direction: data.direction || "",
    price:     data.price     || "",
    volume:    data.volume    || "",
    text:      data.text      || "",
    bartime:   data.bartime   || "",
  };
  try {
    const response = UrlFetchApp.fetch(CONFIG.PARTNER_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      deadline: CONFIG.PARTNER_WEBHOOK_TIMEOUT,
    });
    console.log("Partner webhook:", response.getResponseCode(), response.getContentText());
  } catch (err) {
    console.error("Partner webhook failed:", err);
    throw err; // пробрасываем чтобы partnerOK стал false в логе
  }
}

// ─── НАДЁЖНАЯ ЗАПИСЬ ─────────────────────────────────────────
function appendRowSafe_(sheet, row) {
  for (let i = 0; i < CONFIG.WRITE_RETRIES; i++) {
    try {
      sheet.appendRow(row);
      SpreadsheetApp.flush();
      return true;
    } catch (err) {
      console.error("appendRow попытка " + (i + 1) + "/" + CONFIG.WRITE_RETRIES + " не удалась:", err);
      Utilities.sleep(CONFIG.WRITE_RETRY_SLEEP_MS * (i + 1));
    }
  }
  return false;
}

function getOrCreateSheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  try {
    sh = ss.insertSheet(name);
    if (header && header.length) sh.appendRow(header);
    SpreadsheetApp.flush();
    return sh;
  } catch (err) {
    SpreadsheetApp.flush();
    sh = ss.getSheetByName(name);
    if (sh) return sh;
    throw err;
  }
}

const HDR_ALL    = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Direction1","Direction2"];
const HDR_BLOCK  = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Reason","Direction1"];
const HDR_FAILED = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Context"];

function writeToSheets_(ss, data) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME, HDR_ALL);
    return appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      data.direction1 || "", data.direction2 || ""
    ]);
  } catch (err) {
    console.error("writeToSheets_ fatal:", err);
    return false;
  }
}

function logBlocked_(ss, data, reason) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
    return appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "", reason,
      data.direction1 || ""
    ]);
  } catch (err) {
    console.error("logBlocked_ fatal:", err);
    return false;
  }
}

function logFailed_safe_(ss, data, context) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.FAILED_SHEET_NAME, HDR_FAILED);
    const ok = appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "", context
    ]);
    if (!ok) console.error("LOST PAYLOAD [" + context + "]:", JSON.stringify(data));
    return ok;
  } catch (err) {
    console.error("logFailed_safe_ fatal:", err, "LOST PAYLOAD [" + context + "]:", JSON.stringify(data));
    return false;
  }
}

function logFailed_(data, context) {
  const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  return logFailed_safe_(ss, data, context);
}

// ─── ОТВЕТ ───────────────────────────────────────────────────
function buildResponse(status, message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: status, message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── СБРОС СОСТОЯНИЯ ─────────────────────────────────────────
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty("signal_state_v2");
  console.log("State reset OK");
}

// ─── САМОПРОВЕРКА (запусти руками один раз после деплоя) ─────
function selfTest() {
  const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  const a = getOrCreateSheet_(ss, CONFIG.SHEET_NAME, HDR_ALL);
  const b = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
  const f = getOrCreateSheet_(ss, CONFIG.FAILED_SHEET_NAME, HDR_FAILED);
  resetBadlistCache();
  const bl = loadBadlist_();
  console.log("OK → вкладки:", a.getName(), "/", b.getName(), "/", f.getName(),
    "| лимиты ETH:", JSON.stringify(CONFIG.LIMITS.ETH), "BTC:", JSON.stringify(CONFIG.LIMITS.BTC),
    "| окно:", CONFIG.WINDOW_MINUTES + " мин",
    "| глобальный кап:", CONFIG.GLOBAL_CAP.ENABLED
      ? (CONFIG.GLOBAL_CAP.MAX_OPEN + " за " + CONFIG.GLOBAL_CAP.WINDOW_MINUTES + " мин") : "DISABLED",
    "| TG token:", !!getProp_("TELEGRAM_BOT_TOKEN"), "| chat:", !!getProp_("TELEGRAM_CHAT_ID"),
    "| partner webhook:", CONFIG.PARTNER_WEBHOOK_ENABLED ? CONFIG.PARTNER_WEBHOOK_URL : "DISABLED",
    "| badlist:", CONFIG.BADLIST.ENABLED ? (bl.length + " конфигураций в карантине") : "DISABLED");
}
