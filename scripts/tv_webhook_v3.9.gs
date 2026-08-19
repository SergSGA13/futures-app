// ============================================================
// TradingView Signal Webhook → Telegram + Google Sheets  v3.9.13
// ОДИН скрипт на ОБА актива (ETH + BTC), запись в ОДНУ вкладку.
// ============================================================
// v3.9.13: ХУК TOOBIT - PRO-ветка уходит локальному исполнителю.
//   - CONFIG.TOOBIT: свой выключатель, адрес общий с MEXC-хуком.
//     Шлём ПРИНЯТЫЕ основной (PRO) веткой сигналы - те же, что идут
//     в основную ТГ-группу и партнёру с тегом "10m". Тело - в
//     точности партнёрское, с меткой потока "timing":"10m": по ней
//     исполнитель понимает, что ставить надо на Toobit. Ветка MEXC
//     шлёт свои метки ("MEXC _10m"/"MEXC _30m"), ветка ALT - свою,
//     поэтому потоки не путаются и отдельного поля с биржей не надо.
//   - Payout НЕ шлём: у Toobit его читает сам исполнитель со
//     страницы (порог строго больше 75%), здесь он неизвестен.
//   - Адрес исполнителя вынесен в константу EXECUTOR_HOOK: туннель
//     меняет адрес при каждом перезапуске, и править его в двух
//     местах - лишний повод забыть одно из них.
//   - Сбой хука не влияет ни на Telegram, ни на записи в листы, ни
//     на партнёрскую доставку: в ответе просто будет toobit:error.
//   - ОТКАТ: CONFIG.TOOBIT.ENABLED = false.
//
// v3.9.12: ТОРГОВАЯ СЕССИЯ ПО АКТИВУ (белый список часов).
//   SPCX - токенизированная акция, торгуется только в часы работы
//   фондовой биржи. Добавлен отдельный гейт CONFIG.ASSET_SESSION:
//   для перечисленных активов сигнал пропускается ТОЛЬКО внутри
//   окна сессии, вне его - блок с причиной "SES: ..." и записью в
//   BLOCKEDsignal (как у временного гейта).
//   Для SPCX: 09:30-16:00 America/New_York, Пн-Пт. Часы считаются
//   СРАЗУ в биржевом поясе - DST США/ЕС не расходятся.
//   Механика отличается от TIME_BLOCK: TIME_BLOCK - чёрный список
//   (когда НЕ пускать), ASSET_SESSION - белый список (когда пускать),
//   и он привязан к активу. Активы без записи в ASSET_SESSION
//   (ETH, BTC) не ограничиваются вообще.
//   Гейт стоит в doPost ДО всех веток и работает независимо от
//   TIME_BLOCK.GLOBAL, поэтому его не обойдёт ни одна ветка
//   (основная, MEXC, MEXC_ALT, ALT10m, Premium).
//   Приём идёт до самого закрытия (TO=16:00) - 30-минутная ставка,
//   открытая под конец, может отработать после звонка; если это
//   нежелательно, сдвинь TO раньше (напр. "15:30").
//   ОТКАТ: CONFIG.ASSET_SESSION.SPCX.ENABLED = false.
//
// v3.9.11: ПОЧИНЕНО ОПРЕДЕЛЕНИЕ АКТИВА (баг SPCX → ETH).
//   По всему скрипту актив определялся бинарно строкой
//     (data.ticker||"").indexOf("BTC") >= 0 ? "BTC" : "ETH"
//   Любой тикер без "BTC" молча становился ETH. После добавления
//   SPCX (SYMBOLS.SPCX) сигнал SPCX DOWN на 30 минут уходил в
//   группу как "30 MIN | ETH DOWN" - шапка mexcDeliver_ берёт
//   актив из этой же переменной.
//   Теперь актив определяет ОДНА функция assetOf_(data): BTC / ETH /
//   SPCX по подстроке тикера, фолбэк ETH. Все шесть прежних
//   инлайн-детекторов заменены на её вызов.
//   Плюс payout-циклы refreshPayoutIfStale_ и fetchEventPayouts_
//   расширены на SPCX - иначе payout SPCX оставался неизвестным и
//   проходил только за счёт FAIL_OPEN (фильтр MIN_PAYOUT для SPCX
//   фактически не работал).
//   Лимиты SPCX намеренно НЕ заведены: срабатывает фолбэк на
//   LIMITS.ETH. isBtcDown_ и setMexcPayoutManual не менялись.
//   ОТКАТ: вернуть в assetOf_ только BTC/ETH-ветки не требуется -
//   функция обратно совместима; для полного отката заменить вызовы
//   assetOf_(data) прежней тернарной строкой.
//
// v3.9.10: особые правила для BTC DOWN + починен формат ReceivedAt.
//
//   1) ИСПРАВЛЕНА ОШИБКА В stampIso_. В развёрнутой копии условие
//      проверяло "utc", а возвращало формат со смещением, из-за
//      чего при настройке RECEIVED_AT_FORMAT = "utc" и в листы, и
//      партнёру уходило "2026-08-05T07:30:07.526+02:00" вместо
//      "...Z". Ветки переписаны так, что перепутать их нельзя:
//      ветка со словом "utc" сразу возвращает toISOString().
//      Уже записанные строки чинит normalizeReceivedAtUtc(true).
//
//   2) BTC DOWN ОСВОБОЖДЁН ОТ ОКОН ВРЕМЕНИ, КРОМЕ ЧАСА 14.
//      BTC DOWN - самая устойчивая пара за год: WR 59.78%,
//      Wilson LB 56.9%, и единственная, где ни один из 4 отрезков
//      не ушёл ниже брейк-ивена (61.9/59.7/58.9/59.4).
//      Но ВНУТРИ окон он плох: WR 50.46%, -2 500 за год, ниже
//      брейк-ивена во ВСЕХ 4 отрезках. Разбор по окнам показал,
//      что вся потеря сидит в часе 14 (WR 42.47%, -2 150), а три
//      остальных окна почти нейтральны (54.48%, -350).
//      Поэтому окно 14:00-14:59 помечено strict:true и продолжает
//      резать BTC DOWN, а из остальных он выпущен.
//      Реплей на свежих данных (2 месяца, посекундная точность):
//        как было                        PnL +23 975 | BTC DOWN 65.5%, +5 125
//        только новый лимит              PnL +24 575 | BTC DOWN 65.5%, +5 850
//        освободить из ВСЕХ окон         PnL +24 000 | BTC DOWN 63.0%, +5 275
//        освободить, кроме часа 14       PnL +24 975 | BTC DOWN 65.1%, +6 250
//      Освободить и час 14: убрать strict у окна 14:00-14:59.
//
//   3) СВОЙ ЛИМИТ ДЛЯ BTC DOWN вместо F4/F5: не больше
//      MAX_CONCURRENT (=2) ставок одновременно в отработке, окно
//      равно реальной экспирации (10 мин). Раньше действовало
//      общее правило BTC - 1 сигнал за 4 минуты.
//      Общий кап F8 (5 ставок) проверяется РАНЬШЕ и остаётся
//      главным ограничителем: суммарно по всем активам и
//      направлениям больше 5 не откроется.
//      Проверено реплеем: максимум одновременных BTC DOWN = 2,
//      максимум одновременных всего = 5.
//      Поток BTC DOWN: 3.7 -> 4.7 сигнала в день.
//
//   Правила BTC DOWN действуют в основной ветке и в ветке MEXC
//   (обе идут через decideSignal_). Ветку Premium не затрагивают:
//   у неё своё расписание, с окнами почти не пересекающееся.
// ============================================================
// v3.9.9: ОДИН МОМЕНТ ВРЕМЕНИ НА ВЕСЬ СИГНАЛ + колонка ReceivedAt
//   вернулась в листы. (см. историю в предыдущих версиях)
// v3.9.8: ГЛОБАЛЬНЫЙ ВРЕМЕННОЙ ГЕЙТ (CONFIG.TIME_BLOCK.GLOBAL).
// v3.9.7: итоги анализа ГОДОВЫХ данных + ветка PREMIUM.
// v3.9.6: правки по итогам реплея 2 611 сигналов.
// v3.9.5: мягкий fallback MEXC_ALT (см. CONFIG.MEXC_ALT).
// v3.9.4: партнёрские потоки по тегам + ветка ALT10m с фильтрами.
// v3.9.3: скорость доставки - PRO-группа и партнёрский хук.
// v3.9.2: MEXC-хук (CONFIG.MEXC.WEBHOOK_URL).
// v3.9.1: метки timing в вебхуках и листах MEXC.
// v3.9: отдельная ветка MEXC + фильтр FM по payout.
// v3.8: окно пер-актив лимитов 11 → 5 мин, фильтр F8.
// v3.7: фильтр F7 переведён на произвольные минутные окна.
// v3.6: фильтр F7 (блокировка по дням недели и часам).
// v3.5: авто-карантин по DEV_BADLIST (фильтр F6).
// v3.4: добавлен partner webhook.
// ============================================================
// Script Properties:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SPREADSHEET_ID, WEBHOOK_SECRET
//   MEXC_TELEGRAM_CHAT_ID, ALT_TELEGRAM_CHAT_ID, ALT_TELEGRAM_BOT_TOKEN
// Алерт TradingView: "secret":"<строка>", "bartime":"{{timenow}}"
// ============================================================

// Короткие имена дней в том виде, в каком их отдаёт
// Utilities.formatDate(..., "EEE") для локали скрипта.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const WEEKEND  = ["Sat", "Sun"];
const ALLDAYS  = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── АДРЕС ЛОКАЛЬНОГО ИСПОЛНИТЕЛЯ (v3.9.13) ──────────────────
// Один и тот же для обеих бирж: исполнитель различает их по метке
// потока в поле "timing". Туннель cloudflared меняет адрес при
// каждом перезапуске - меняй ЗДЕСЬ одну строку, а не в двух местах.
const EXECUTOR_HOOK = "https://communities-thumbzilla-than-treated.trycloudflare.com/signal?secret=qmbhtz1op6jg8ei7ky4sv5wc9fr0dnlxa3u2";

const CONFIG = {
  SHEET_NAME:         "ALLsignal",       // одна вкладка на оба актива
  BLOCKED_SHEET_NAME: "BLOCKEDsignal",
  FAILED_SHEET_NAME:  "FAILEDsignal",    // резерв для несостоявшихся записей

  WINDOW_MINUTES: 1,      // окно пер-актив лимитов F4/F5
  CONFLICT_MINUTES: 10,

  // ─── РАЗДЕЛЬНЫЕ лимиты по активам ───
  // v3.9.6: ETH ослаблен 2/2 → 6/4, BTC не тронут.
  //   MAX_SIGNALS_PER_WINDOW - фильтр F4 (сигналов в окне)
  //   MAX_SAME_PRICE         - фильтр F5 (сигналов с той же ценой)
  // ВАЖНО: поднимать F4, не подняв F5, нельзя.
  LIMITS: {
    ETH: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 3 },
    BTC: { MAX_SIGNALS_PER_WINDOW: 1, MAX_SAME_PRICE: 2 },
  },

  // ─── F8: глобальный кап - суммарно по ОБОИМ активам ───
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

  // ─── F7: блокировка по времени (Варшава) ───
  TIME_BLOCK: {
    ENABLED: true,
    GLOBAL: true,
    DAYS: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    WINDOWS: [
      // единственный час, устойчиво убыточный в обеих половинах периода
      { from: "07:00", to: "07:59", days: WEEKDAYS, strict: true },
      // новый: 41.4% за месяц, ниже безубытка и в июле, и в августе
      { from: "13:00", to: "13:59", days: ALLDAYS, strict: true },
      // УБРАНЫ: 14:00-14:59 (в августе 76%), 15:20-15:59 (63.7%), 16:00-16:59 (60.6%)
    ],
  },

  // ─── Торговые сессии по активу (v3.9.12) ───
  // Белый список часов: сигнал по активу пропускается ТОЛЬКО внутри
  // окна сессии. Активы, которых здесь НЕТ (ETH, BTC), не
  // ограничиваются вовсе. Часы и дни считаются в поясе TZ актива
  // (для акций - биржевой пояс, чтобы DST США/ЕС не расходились).
  //   FROM/TO   - границы включительно, "HH:MM"; окно через полночь
  //               (FROM > TO) поддерживается.
  //   DAYS      - дни недели В ПОЯСЕ TZ (Mon..Sun).
  // Гейт стоит в doPost до всех веток - см. assetSessionReason_.
  ASSET_SESSION: {
    // SPCX - токенизированная акция: только основная сессия биржи США
    SPCX: {
      ENABLED: true,
      TZ:   "America/New_York",
      DAYS: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      FROM: "09:30",
      TO:   "16:00",   // приём до самого закрытия
    },
  },

  // ─── F6: авто-карантин по DEV_BADLIST ───
  BADLIST: {
    ENABLED: false,
    SHEET_NAME: "DEV_BADLIST",
    CACHE_KEY: "dev_badlist_v1",
    CACHE_TTL_SEC: 3600,
  },

  // ─── Ветка MEXC: независимое решение + payout-фильтр ───
  MEXC: {
    ENABLED: true,
    STATE_KEY: "signal_state_mexc_v1",
    SHEET_NAME:         "MEXCsignal",
    BLOCKED_SHEET_NAME: "MEXCblocked",
    PAYOUT_SHEET_NAME:  "MEXC_PAYOUT",
    CHAT_ID_PROP: "MEXC_TELEGRAM_CHAT_ID",

    MIN_PAYOUT: 80,
    PAYOUT_STALE_MIN: 15,
    FAIL_OPEN: true,

    PAYOUT_PROP: "mexc_payout_v1",
    CACHE_KEY: "mexc_payout_cache_v1",
    CACHE_TTL_SEC: 25,

    PAYOUT_FRESH_SEC: 30,
    PAYOUT_FETCH_TIMEOUT: 5,

    PAYOUT_URL: "https://www.mexc.com/api/platform/futures/api/v1/event_contract/detail",
    SYMBOLS: { ETH: "ETH_USDT", BTC: "BTC_USDT", SPCX: "SPCX_USDT" },
    TIME_UNIT: "MINUTE",
    TIMINGS: [10, 30],
    DEFAULT_TIMING: 10,
    // Шапка сообщения в группу MEXC: "<эмодзи> <тайминг> MIN | ACTIVE UP/DOWN"
    TIMING_EMOJI: { 10: "⚡️", 30: "🕒🕒🕒" },
    ASSET_EMOJI: { BTC: "", ETH: "", SPCX: "" },
    DIR_EMOJI: { UP: "🟢", DOWN: "🔴" },
    BTC_FRAME: "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬",
    MEXC_ONLY_TIMINGS: [30],

    ALERTS_ENABLED: false,

    WEBHOOK_URL: EXECUTOR_HOOK,
    WEBHOOK_ENABLED: true,
    WEBHOOK_TIMEOUT: 5,
  },

  // ─── Хук Toobit (v3.9.13): PRO-ветка → локальный исполнитель ───
  // Шлётся то же, что уходит в основную ТГ-группу и партнёру с тегом
  // "10m", то есть ПРИНЯТЫЕ основной веткой сигналы, и тем же телом.
  // Куда ставить, исполнитель решает по метке "timing":"10m" - у ветки
  // MEXC свои метки ("MEXC _10m"/"MEXC _30m"), у ALT своя.
  // 30-минутки сюда не попадают: они эксклюзив MEXC
  // (MEXC_ONLY_TIMINGS) и основную ветку не проходят.
  // Payout не передаём - на Toobit его читает сам исполнитель со
  // страницы, здесь он неизвестен. Пустой URL = выключено.
  TOOBIT: {
    ENABLED: true,
    WEBHOOK_URL: EXECUTOR_HOOK,
    WEBHOOK_TIMEOUT: 5,
  },

  // ─── MEXC: мягкий fallback-фильтр ───────────────────────────
  MEXC_ALT: {
    ENABLED: true,
    STATE_KEY: "signal_state_mexc_alt_v1",
    WINDOW_MINUTES: 2,
    APPLY_TIME_BLOCK: true,
    LIMITS: {
      ETH: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 3 },
      BTC: { MAX_SIGNALS_PER_WINDOW: 1, MAX_SAME_PRICE: 2 },
    },
  },

  // ─── ВЕТКА PREMIUM (v3.9.7) ─────────────────────────────────
  PREMIUM: {
    ENABLED: true,
    STATE_KEY: "signal_state_premium_v1",
    CHAT_ID_PROP: "PREMIUM_TELEGRAM_CHAT_ID",
    BOT_TOKEN_PROP: "PREMIUM_TELEGRAM_BOT_TOKEN",

    ALL_DAY_DAYS:   WEEKEND,
    EVENING_DAYS:   ["Mon", "Tue", "Wed"],
    EVENING_HOURS:  [17, 18, 20, 21],

    APPLY_TIME_BLOCK: true,

    WINDOW_MINUTES: 1,
    CONFLICT_MINUTES: 10,
    ENABLE_CONFLICT: true,
    LIMITS: {
      ETH: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 3 },
      BTC: { MAX_SIGNALS_PER_WINDOW: 1, MAX_SAME_PRICE: 2 },
    },
    GLOBAL_CAP: { ENABLED: true, MAX_OPEN: 5, WINDOW_MINUTES: 11 },

    PARTNER_TAG: "Premium",
    HEADER: "",
  },

  // ─── BTC DOWN: особые правила (v3.9.10) ─────────────────────
  BTC_DOWN: {
    ENABLED: false,
    EXEMPT_FROM_TIME_BLOCK: false,
    MAX_CONCURRENT: 2,
    EXPIRY_MINUTES: 10,
  },

  // ─── Формат ReceivedAt (v3.9.9) ─────────────────────────────
  RECEIVED_AT_FORMAT: "utc",

  // ─── Надёжность записи ───
  WRITE_RETRIES: 3,
  WRITE_RETRY_SLEEP_MS: 350,

  // ─── Partner webhook: один хук, разные теги ───
  PARTNER_WEBHOOK_URL: "https://signalapiwebhook1312.win/webhook/signal/74f9addb559e663d75047ed9d250edf6e526510cd47440be",
  PARTNER_WEBHOOK_ENABLED: true,
  PARTNER_WEBHOOK_TIMEOUT: 10,
  PARTNER_STREAMS: {
    "10m":      true,
    "ALT10m":   true,
    "MEXC_10m": true,
    "MEXC_30m": true,
    "Premium":  false,
  },

  // ─── Ветка ALT10m: фильтрованный поток из BLOCKEDsignal ───
  ALT10M: {
    ENABLED: true,
    STATE_KEY: "signal_state_alt10m_v1",
    WINDOW_MINUTES: 2,
    APPLY_TIME_BLOCK: true,
    LIMITS: {
      ETH: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 4 },
      BTC: { MAX_SIGNALS_PER_WINDOW: 1, MAX_SAME_PRICE: 2 },
    },
    BOT_TOKEN_PROP: "ALT_TELEGRAM_BOT_TOKEN",
    CHAT_ID_PROP: "ALT_TELEGRAM_CHAT_ID",
  },

};

function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error("Script property missing: " + key);
  return v;
}

// ─── ОПРЕДЕЛЕНИЕ АКТИВА (v3.9.11) ────────────────────────────
// Единая точка распознавания актива по тикеру. Раньше это делала
// бинарная тернарная строка (indexOf("BTC") ? BTC : ETH), из-за
// которой любой тикер без "BTC" (в т.ч. SPCX) молча становился ETH.
// Фолбэк по-прежнему ETH, чтобы поведение для старых тикеров
// не менялось.
function assetOf_(data) {
  const t = String((data && data.ticker) || "").toUpperCase();
  if (t.indexOf("BTC")  >= 0) return "BTC";
  if (t.indexOf("ETH")  >= 0) return "ETH";
  if (t.indexOf("SPCX") >= 0) return "SPCX";
  return "ETH";   // фолбэк для неизвестного тикера
}

// ─── ВРЕМЯ (v3.9.9) ──────────────────────────────────────────
function stampIso_(d) {
  const dt = d || new Date();
  if (CONFIG.RECEIVED_AT_FORMAT === "utc") {
    return dt.toISOString();                    // 2026-08-05T07:30:07.526Z
  }
  const base = Utilities.formatDate(dt, "Europe/Warsaw", "yyyy-MM-dd'T'HH:mm:ss.SSS");
  const off = Utilities.formatDate(dt, "Europe/Warsaw", "Z");      // "+0200"
  return base + off.slice(0, 3) + ":" + off.slice(3);              // "+02:00"
}

function rowTime_(data) {
  return (data && data._rowTime) ? data._rowTime : new Date();
}

// ─── ОКНА ВРЕМЕНИ (F7) ───────────────────────────────────────
function isBtcDown_(data) {
  if (!data) return false;
  const asset = assetOf_(data);
  if (asset !== "BTC") return false;
  const d = String(data.direction || "").toUpperCase();
  return d === "DOWN" || d === "SELL";
}

function timeBlockReason_(now, data) {
  const wb = CONFIG.TIME_BLOCK;
  if (!wb || !wb.ENABLED) return null;
  const bd = CONFIG.BTC_DOWN;
  const exemptBtcDown = !!(bd && bd.ENABLED && bd.EXEMPT_FROM_TIME_BLOCK &&
                           isBtcDown_(data));
  const dow = Utilities.formatDate(now, "Europe/Warsaw", "EEE");   // Mon..Sun
  const h = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "H"), 10);
  const m = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "m"), 10);
  const nowMin = h * 60 + m;
  const toMin = (hhmm) => { const p = String(hhmm).split(":"); return (+p[0]) * 60 + (+p[1]); };
  for (const win of (wb.WINDOWS || [])) {
    if (exemptBtcDown && !win.strict) continue;
    const days = win.days || wb.DAYS || [];
    if (days.indexOf(dow) < 0) continue;
    const a = toMin(win.from), b = toMin(win.to);
    const inWin = (a <= b) ? (nowMin >= a && nowMin <= b) : (nowMin >= a || nowMin <= b);
    if (inWin)
      return "F7: " + dow + " " + pad_(h) + ":" + pad_(m) +
             " (окно " + win.from + "-" + win.to + ")";
  }
  return null;
}

// ─── ТОРГОВАЯ СЕССИЯ АКТИВА (F-SES, v3.9.12) ─────────────────
// Белый список часов, привязанный к активу. Возвращает строку-
// причину, если сигнал ВНЕ сессии (нужно блокировать), иначе null.
// Активы без записи в CONFIG.ASSET_SESSION не ограничиваются.
// Время и дни считаются в поясе актива (cfg.TZ), а не в Варшаве, -
// иначе окно "плавало" бы из-за разницы DST США/ЕС.
function assetSessionReason_(now, data) {
  const asset = assetOf_(data);
  const cfg = CONFIG.ASSET_SESSION && CONFIG.ASSET_SESSION[asset];
  if (!cfg || !cfg.ENABLED) return null;      // актив без ограничения
  const tz = cfg.TZ || "America/New_York";
  const dow = Utilities.formatDate(now, tz, "EEE");         // Mon..Sun в поясе биржи
  const days = cfg.DAYS || WEEKDAYS;
  if (days.indexOf(dow) < 0)
    return "SES: " + asset + " вне торговых дней (" + dow + " " + tz + ")";
  const h = parseInt(Utilities.formatDate(now, tz, "H"), 10);
  const m = parseInt(Utilities.formatDate(now, tz, "m"), 10);
  const nowMin = h * 60 + m;
  const toMin = (hhmm) => { const p = String(hhmm).split(":"); return (+p[0]) * 60 + (+p[1]); };
  const a = toMin(cfg.FROM), b = toMin(cfg.TO);
  const inSession = (a <= b) ? (nowMin >= a && nowMin <= b) : (nowMin >= a || nowMin <= b);
  if (!inSession)
    return "SES: " + asset + " вне сессии " + cfg.FROM + "-" + cfg.TO + " " + tz +
           " (сейчас " + pad_(h) + ":" + pad_(m) + ")";
  return null;
}

// ─── DEV_BADLIST: загрузка списка карантина ──────────────────
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

function resetBadlistCache() {
  CacheService.getScriptCache().remove(CONFIG.BADLIST.CACHE_KEY);
  console.log("Badlist cache reset OK");
}

// ─── MEXC PAYOUT ─────────────────────────────────────────────
function getMexcPayout_() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CONFIG.MEXC.CACHE_KEY);
    let val;
    if (cached != null) val = JSON.parse(cached);
    else {
      const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.PAYOUT_PROP);
      val = raw ? JSON.parse(raw) : {};
      cache.put(CONFIG.MEXC.CACHE_KEY, JSON.stringify(val), CONFIG.MEXC.CACHE_TTL_SEC);
    }
    const refreshed = refreshPayoutIfStale_(val);
    return refreshed || val;
  } catch (err) {
    console.error("getMexcPayout_ failed (fail-open):", err);
    return {};
  }
}

function refreshPayoutIfStale_(val) {
  if (!CONFIG.MEXC.PAYOUT_URL) return null;
  const nowMs = Date.now();
  let stale = false;
  for (const asset of ["ETH", "BTC", "SPCX"]) {
    for (const tf of CONFIG.MEXC.TIMINGS) {
      const rec = val && val[asset + "@" + tf];
      if (!rec || nowMs - (rec.t || 0) > CONFIG.MEXC.PAYOUT_FRESH_SEC * 1000) { stale = true; break; }
    }
    if (stale) break;
  }
  if (!stale) return null;
  let got = null;
  try { got = fetchEventPayouts_(); }
  catch (err) { console.error("payout refresh failed:", err); return null; }
  if (!got || !Object.keys(got).length) return null;
  savePayout_(got, "monitor");
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.PAYOUT_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}

function mexcTiming_(data) {
  const s = String((data && (data.timing || data.mexc_tf)) || "");
  return /30/.test(s) ? 30 : 10;
}

function mexcTimingLabel_(tf) { return "MEXC _" + tf + "m"; }

function sendMexcWebhook_(data, label, payoutVal) {
  if (!CONFIG.MEXC.WEBHOOK_ENABLED || !CONFIG.MEXC.WEBHOOK_URL) return "off";
  const payload = {
    ticker:     data.ticker     || "",
    direction:  data.direction  || "",
    price:      data.price      || "",
    volume:     data.volume     || "",
    text:       data.text       || "",
    bartime:    data.bartime    || "",
    timing:     label,
    payout:     payoutVal,
    receivedAt: data.receivedAt || stampIso_(),
  };
  const resp = UrlFetchApp.fetch(CONFIG.MEXC.WEBHOOK_URL, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, deadline: CONFIG.MEXC.WEBHOOK_TIMEOUT,
  });
  return "http " + resp.getResponseCode();
}

// ─── Хук Toobit (v3.9.13): как sendMexcWebhook_, но для PRO-ветки ──
// Вызывается только для ПРИНЯТЫХ основной веткой сигналов. Тело - в
// точности партнёрское, с меткой потока "10m": по ней исполнитель
// понимает, что это PRO-ветка и ставить надо на Toobit. Отдельного
// поля с биржей не нужно - у ветки MEXC свои метки.
// Payout не шлём: на Toobit его читает сам исполнитель со страницы,
// здесь он неизвестен.
// Возвращает заметку для лога ответа ("off" / "http 200").
function sendToobitWebhook_(data) {
  if (!CONFIG.TOOBIT.ENABLED || !CONFIG.TOOBIT.WEBHOOK_URL) return "off";
  const payload = {
    ticker:     data.ticker     || "",
    direction:  data.direction  || "",
    price:      data.price      || "",
    volume:     data.volume     || "",
    text:       data.text       || "",
    bartime:    data.bartime    || "",
    timing:     "10m",                     // метка потока: PRO
    receivedAt: data.receivedAt || stampIso_(),
  };
  const resp = UrlFetchApp.fetch(CONFIG.TOOBIT.WEBHOOK_URL, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, deadline: CONFIG.TOOBIT.WEBHOOK_TIMEOUT,
  });
  const code = resp.getResponseCode();
  console.log("Toobit:", code);
  return "http " + code;
}

function mexcPayoutFor_(payout, asset, nowMs, dir, timing) {
  const key = asset + "@" + (timing || CONFIG.MEXC.DEFAULT_TIMING);
  const rec = payout && (payout[key] || payout[asset]);
  if (!rec) return { known: false, value: null };
  const up = typeof rec.up === "number" ? rec.up : rec.p;
  const down = typeof rec.down === "number" ? rec.down : rec.p;
  if (typeof up !== "number" && typeof down !== "number") return { known: false, value: null };
  const value = dir === "UP" ? up : (dir === "DOWN" ? down : Math.min(up, down));
  if (rec.src !== "manual" &&
      nowMs - (rec.t || 0) > CONFIG.MEXC.PAYOUT_STALE_MIN * 60 * 1000)
    return { known: false, value: value };
  return { known: typeof value === "number", value: value };
}

function setMexcPayoutManual(ethPayout, btcPayout, timingOpt) {
  const timings = timingOpt ? [timingOpt] : CONFIG.MEXC.TIMINGS;
  const vals = {};
  for (const tf of timings) {
    if (ethPayout != null) vals["ETH@" + tf] = ethPayout;
    if (btcPayout != null) vals["BTC@" + tf] = btcPayout;
  }
  savePayout_(vals, "manual");
}

function savePayout_(newVals, source) {
  const props = PropertiesService.getScriptProperties();
  let cur = {};
  try { cur = JSON.parse(props.getProperty(CONFIG.MEXC.PAYOUT_PROP) || "{}"); } catch (e) {}
  const nowMs = Date.now();
  const norm1 = (v) => v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
  const changed = [];
  for (const key in newVals) {
    let v = newVals[key];
    if (v == null) continue;
    if (typeof v === "number") { if (isNaN(v)) continue; v = { up: v, down: v }; }
    if (typeof v.up !== "number" || typeof v.down !== "number") continue;
    const up = norm1(v.up), down = norm1(v.down);
    const prevRec = cur[key] || {};
    const prevMin = typeof prevRec.up === "number"
      ? Math.min(prevRec.up, prevRec.down) : prevRec.p;
    cur[key] = { up: up, down: down, t: nowMs, src: source || "" };
    if (prevRec.up !== up || prevRec.down !== down)
      changed.push({ asset: key.replace("@", " ") + "м", prev: prevMin, next: Math.min(up, down), up: up, down: down });
  }
  props.setProperty(CONFIG.MEXC.PAYOUT_PROP, JSON.stringify(cur));
  try { CacheService.getScriptCache().put(CONFIG.MEXC.CACHE_KEY, JSON.stringify(cur), CONFIG.MEXC.CACHE_TTL_SEC); } catch (e) {}

  if (!changed.length) return;
  try {
    const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
    const sh = getOrCreateSheet_(ss, CONFIG.MEXC.PAYOUT_SHEET_NAME, HDR_PAYOUT);
    for (const c of changed)
      sh.appendRow([new Date(), c.asset, c.up === c.down ? c.up : (c.up + "/" + c.down), source || ""]);
    SpreadsheetApp.flush();
  } catch (err) { console.error("payout history write failed:", err); }
  if (CONFIG.MEXC.ALERTS_ENABLED) {
    const min = CONFIG.MEXC.MIN_PAYOUT;
    for (const c of changed) {
      let text = null;
      const wasBelow = typeof c.prev === "number" && c.prev < min;
      const nowBelow = c.next < min;
      if (!wasBelow && nowBelow)
        text = "⛔ MEXC payout " + c.asset + " упал до " + c.next + "% (порог " + min + "%). Сигналы " + c.asset + " на паузе.";
      else if (wasBelow && !nowBelow)
        text = "✅ MEXC payout " + c.asset + " вернулся к " + c.next + "%. Сигналы " + c.asset + " снова идут.";
      if (text) {
        try { sendTelegram({ text: text }, getProp_(CONFIG.MEXC.CHAT_ID_PROP)); }
        catch (err) { console.error("payout alert TG failed:", err); }
      }
    }
  }
}

function mexcPayoutMonitor() {
  if (!CONFIG.MEXC.ENABLED) return;
  if (!CONFIG.MEXC.PAYOUT_URL) { console.log("mexcPayoutMonitor: PAYOUT_URL пуст - ручной режим"); return; }
  let val = {};
  try { val = JSON.parse(PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.PAYOUT_PROP) || "{}"); }
  catch (e) {}
  refreshPayoutIfStale_(val);
}

function fetchEventPayouts_() {
  const resp = UrlFetchApp.fetch(CONFIG.MEXC.PAYOUT_URL, {
    muteHttpExceptions: true,
    deadline: CONFIG.MEXC.PAYOUT_FETCH_TIMEOUT,
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" },
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  if (code < 200 || code >= 300) { console.error("payout fetch HTTP " + code + ": " + body.slice(0, 200)); return null; }
  let root;
  try { root = JSON.parse(body); }
  catch (err) { console.error("payout parse failed (не JSON):", body.slice(0, 200)); return null; }
  const out = {};
  for (const asset of ["ETH", "BTC", "SPCX"]) {
    const contract = findNodeWithSymbol_(root, CONFIG.MEXC.SYMBOLS[asset]);
    if (!contract) { console.error("payout: символ " + CONFIG.MEXC.SYMBOLS[asset] + " не найден в ответе"); continue; }
    const arr = findUnitArray_(contract, CONFIG.MEXC.TIME_UNIT);
    if (!arr) { console.error("payout: юнит " + CONFIG.MEXC.TIME_UNIT + " не найден у " + asset); continue; }
    for (const tf of CONFIG.MEXC.TIMINGS) {
      let el = null;
      for (const o of arr) if (o && o.val === tf && typeof o.upPayRate === "number") { el = o; break; }
      if (!el) { console.error("payout: val=" + tf + " не найден у " + asset); continue; }
      out[asset + "@" + tf] = { up: el.upPayRate, down: (typeof el.downPayRate === "number" ? el.downPayRate : el.upPayRate) };
    }
  }
  return out;
}

function findNodeWithSymbol_(node, symbol) {
  if (node == null || typeof node !== "object") return null;
  if (node.symbol === symbol) return node;
  for (const k in node) {
    const r = findNodeWithSymbol_(node[k], symbol);
    if (r) return r;
  }
  return null;
}

function findUnitArray_(node, unit) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node[unit])) return node[unit];
  for (const k in node) {
    const r = findUnitArray_(node[k], unit);
    if (r) return r;
  }
  return null;
}

function mexcPayoutProbe() {
  const got = fetchEventPayouts_();
  console.log("mexcPayoutProbe:", JSON.stringify(got));
}

// ─── WEBHOOK HANDLER ─────────────────────────────────────────
function doPost(e) {
  const nowTs = new Date();
  const receivedAt = stampIso_(nowTs);
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
  data.receivedAt = receivedAt;
  data._rowTime = nowTs;

  // ══ ГЛОБАЛЬНЫЙ ВРЕМЕННОЙ ГЕЙТ (v3.9.8) ══════════════════════
  if (CONFIG.TIME_BLOCK.GLOBAL) {
    const gateNow = data.bartime ? new Date(data.bartime) : new Date();
    const gate = timeBlockReason_(gateNow, data);
    if (gate) {
      data.price  = (parseFloat(data.price)  || 0).toFixed(2);
      data.volume = (parseFloat(data.volume) || 0).toFixed(2);
      let gOK = false;
      try {
        const gss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
        gOK = logBlocked_(gss, data, gate, "");
      } catch (eg) {
        console.error("гейт: запись в BLOCKEDsignal не удалась:", eg);
        console.error("LOST PAYLOAD [гейт]:", JSON.stringify(data));
      }
      return buildResponse("blocked", gate + " [все ветки] (sheet:" + gOK + ")");
    }
  }

  // ══ ГЕЙТ ТОРГОВОЙ СЕССИИ АКТИВА (v3.9.12) ═══════════════════
  // SPCX (и любой актив из CONFIG.ASSET_SESSION) пропускается ТОЛЬКО
  // в часы своей биржи. Работает независимо от TIME_BLOCK.GLOBAL и
  // стоит до всех веток - обойти не может ни одна. Вне сессии -
  // блок с причиной "SES: ..." и записью в BLOCKEDsignal.
  {
    const sesNow = data.bartime ? new Date(data.bartime) : new Date();
    const ses = assetSessionReason_(sesNow, data);
    if (ses) {
      data.price  = (parseFloat(data.price)  || 0).toFixed(2);
      data.volume = (parseFloat(data.volume) || 0).toFixed(2);
      let sOK = false;
      try {
        const sss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
        sOK = logBlocked_(sss, data, ses, "");
      } catch (es) {
        console.error("сессия: запись в BLOCKEDsignal не удалась:", es);
        console.error("LOST PAYLOAD [сессия]:", JSON.stringify(data));
      }
      return buildResponse("blocked", ses + " [все ветки] (sheet:" + sOK + ")");
    }
  }

  // ── Фаза 0: карантинный список ──
  const badlist = loadBadlist_();
  const mexcOn = CONFIG.MEXC.ENABLED;
  const mexcOnly = mexcOn &&
    CONFIG.MEXC.MEXC_ONLY_TIMINGS.indexOf(mexcTiming_(data)) >= 0;

  // ══ ОСНОВНАЯ ВЕТКА: решение → НЕМЕДЛЕННАЯ доставка ══
  let decision = { status: "skipped", message: "MEXC-only timing" };
  let tgOK = true, partnerOK = true, altNote = "off", altMarker = "", toobitNote = "off";
  const lock = LockService.getScriptLock();
  if (!mexcOnly) {
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

    if (decision.status === "sent") {
      try { sendTelegram(data); } catch (e2) { tgOK = false; console.error("TG fail:", e2); }
      try { partnerOK = postPartner_(data, "10m").indexOf("error") < 0; }
      catch (e2) { partnerOK = false; console.error("Partner fail:", e2); }
      // ...и тот же сигнал - исполнителю на Toobit (v3.9.13). Отдельным
      // хуком, а не потоком партнёра: у исполнителя свой адрес и секрет.
      try { toobitNote = sendToobitWebhook_(data); }
      catch (e2) { toobitNote = "error"; console.error("Toobit fail:", e2); }
    } else {
      try { const r = handleAlt10m_(data); altNote = r.note; altMarker = r.marker; }
      catch (e3) { altNote = "error"; console.error("ALT10m fail:", e3); }
    }
  }

  // ══ ВЕТКА PREMIUM (v3.9.7) ══
  let premNote = "off";
  if (CONFIG.PREMIUM.ENABLED && !mexcOnly) {
    try { premNote = handlePremium_(data); }
    catch (eP) { premNote = "error"; console.error("Premium fail:", eP); }
  }

  // ══ ВЕТКА MEXC: payout → решение → доставка ══
  let decisionMexc = null, mexcDelivery = null;
  if (mexcOn) {
    const mexcPayout = getMexcPayout_();
    if (lock.tryLock(25000)) {
      try {
        decisionMexc = decideSignal_(data, badlist,
          { stateKey: CONFIG.MEXC.STATE_KEY, payout: mexcPayout });

        if (decisionMexc.status === "blocked" &&
            CONFIG.MEXC_ALT.ENABLED &&
            decisionMexc.message.indexOf("FM:") !== 0) {
          const altDecision = decideMexcAlt_(data);
          if (altDecision.status === "sent") {
            decisionMexc = {
              status: "sent",
              message: altDecision.message + " (fallback, основной MEXC: " + decisionMexc.message + ")",
              viaAlt: true,
            };
          }
        }
      } catch (errM) {
        console.error("decideSignal MEXC error:", errM);
        decisionMexc = null;
      }
      lock.releaseLock();
    } else {
      console.error("MEXC lock timeout - ветка MEXC пропущена");
    }
    if (decisionMexc) mexcDelivery = mexcDeliver_(data, decisionMexc, mexcPayout);
  }

  // ══ Логирование в листы: ПОСЛЕ всех доставок ══
  let ss = null;
  try {
    ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  } catch (err) {
    console.error("openById failed:", err);
    console.error("LOST PAYLOAD:", JSON.stringify(data), "decision:", JSON.stringify(decision));
  }
  let sheetOK = false, mexcNote = "";
  if (ss) {
    if (decision.status === "sent") {
      sheetOK = writeToSheets_(ss, data);
      if (!sheetOK) logFailed_safe_(ss, data, "ALLsignal write failed после " + CONFIG.WRITE_RETRIES + " попыток");
    } else if (decision.status === "blocked") {
      sheetOK = logBlocked_(ss, data, decision.message, altMarker);
      if (!sheetOK) logFailed_safe_(ss, data, "BLOCKED write failed: " + decision.message);
    }
    if (decisionMexc && mexcDelivery) {
      try { mexcNote = " | MEXC " + mexcLogSheet_(ss, data, decisionMexc, mexcDelivery); }
      catch (eM) { console.error("MEXC log fail:", eM); mexcNote = " | MEXC log error"; }
    }
  }

  if (mexcOnly) {
    if (!decisionMexc) return buildResponse("error", "MEXC-only сигнал, но ветка MEXC не решила" + mexcNote);
    return buildResponse(decisionMexc.status,
      "MEXC-only (timing " + mexcTiming_(data) + ")" + mexcNote);
  }
  const premTail = " | PREM " + premNote;
  if (decision.status === "sent")
    return buildResponse("sent", decision.message + " (tg:" + tgOK + ", sheet:" + sheetOK + ", partner:" + partnerOK + ", toobit:" + toobitNote + ")" + mexcNote + premTail);
  return buildResponse("blocked", decision.message + " (sheet:" + sheetOK + ", alt:" + altNote + ")" + mexcNote + premTail);
}

// ─── Партнёрский хук: один URL, тег в поле "timing" ──────────
function postPartner_(data, tag) {
  if (!CONFIG.PARTNER_WEBHOOK_ENABLED) return "off";
  if (!CONFIG.PARTNER_STREAMS[tag]) return "off:" + tag;
  const payload = {
    ticker:     data.ticker     || "",
    direction:  data.direction  || "",
    price:      data.price      || "",
    volume:     data.volume     || "",
    text:       data.text       || "",
    bartime:    data.bartime    || "",
    timing:     tag,
    receivedAt: data.receivedAt || stampIso_(),
  };
  const resp = UrlFetchApp.fetch(CONFIG.PARTNER_WEBHOOK_URL, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, deadline: CONFIG.PARTNER_WEBHOOK_TIMEOUT,
  });
  const code = resp.getResponseCode();
  console.log("Partner[" + tag + "]:", code);
  return "http " + code;
}

// ─── Ветка ALT10m: решение + доставка ────────────────────────
function handleAlt10m_(data) {
  if (!CONFIG.ALT10M.ENABLED) return { note: "off", marker: "" };
  const lock = LockService.getScriptLock();
  let d = null;
  if (lock.tryLock(25000)) {
    try { d = decideAlt_(data); }
    catch (err) { console.error("decideAlt error:", err); d = null; }
    lock.releaseLock();
  } else {
    console.error("ALT10m lock timeout - пропуск");
    return { note: "lock-timeout", marker: "" };
  }
  if (!d || d.status !== "sent") return { note: (d ? d.message : "err"), marker: "" };

  let tg = "-", partner = "-";
  const props = PropertiesService.getScriptProperties();
  const chatId = props.getProperty(CONFIG.ALT10M.CHAT_ID_PROP);
  if (chatId) {
    const token = props.getProperty(CONFIG.ALT10M.BOT_TOKEN_PROP);
    try { sendTelegram(data, chatId, token || null); tg = "ok"; }
    catch (e) { tg = "err"; console.error("ALT10m TG fail:", e); }
  } else { tg = "no-chat"; }
  try { partner = postPartner_(data, "ALT10m"); }
  catch (e) { partner = "err"; console.error("ALT10m partner fail:", e); }
  return { note: "sent (tg:" + tg + ", partner:" + partner + ")", marker: "ALT10m" };
}

function decideAlt_(data) {
  const cfg = CONFIG.ALT10M;
  const now = data.bartime ? new Date(data.bartime) : new Date();

  if (cfg.APPLY_TIME_BLOCK) {
    const tb = timeBlockReason_(now, data);
    if (tb) return { status: "blocked", message: "ALT-" + tb };
  }

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(cfg.STATE_KEY);
  let state = raw ? JSON.parse(raw) : { sent: [] };
  if (!state.sent) state.sent = [];
  const windowMs = cfg.WINDOW_MINUTES * 60 * 1000;
  state.sent = state.sent.filter(s => now.getTime() - s.t < windowMs);

  const asset = assetOf_(data);
  const dirUp = String(data.direction || "").toUpperCase();
  const dir = (dirUp === "UP" || dirUp === "BUY") ? "UP" : ((dirUp === "DOWN" || dirUp === "SELL") ? "DOWN" : "?");
  const price = (parseFloat(data.price) || 0).toFixed(2);
  const lim = cfg.LIMITS[asset] || cfg.LIMITS.ETH;
  const sameAsset = state.sent.filter(s => s.asset === asset);
  const save = () => props.setProperty(cfg.STATE_KEY, JSON.stringify(state));

  if (sameAsset.length >= lim.MAX_SIGNALS_PER_WINDOW) {
    save(); return { status: "blocked", message: "ALT-окно " + asset + " (" + sameAsset.length + "/" + lim.MAX_SIGNALS_PER_WINDOW + ")" };
  }
  const samePrice = sameAsset.filter(s => s.price === price).length;
  if (samePrice >= lim.MAX_SAME_PRICE) {
    save(); return { status: "blocked", message: "ALT-цена " + asset + " (" + samePrice + "/" + lim.MAX_SAME_PRICE + ")" };
  }
  state.sent.push({ t: now.getTime(), price: price, dir: dir, asset: asset });
  save();
  return { status: "sent", message: "ALT10m " + asset + " " + dir };
}

// ─── ВЕТКА PREMIUM (v3.9.7) ──────────────────────────────────
function premiumScheduleReason_(now) {
  const cfg = CONFIG.PREMIUM;
  const dow = Utilities.formatDate(now, "Europe/Warsaw", "EEE");
  if ((cfg.ALL_DAY_DAYS || []).indexOf(dow) >= 0) return null;
  if ((cfg.EVENING_DAYS || []).indexOf(dow) >= 0) {
    const h = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "H"), 10);
    if ((cfg.EVENING_HOURS || []).indexOf(h) >= 0) return null;
    return "PREM-расписание: " + dow + " " + pad_(h) + "h (нужны часы " +
           cfg.EVENING_HOURS.join(",") + ")";
  }
  return "PREM-расписание: " + dow + " не участвует";
}

function decidePremium_(data) {
  const cfg = CONFIG.PREMIUM;
  const now = data.bartime ? new Date(data.bartime) : new Date();

  if (!CONFIG.TIME_BLOCK.GLOBAL && cfg.APPLY_TIME_BLOCK) {
    const tb = timeBlockReason_(now, data);
    if (tb) return { status: "blocked", message: "PREM-" + tb };
  }

  const sched = premiumScheduleReason_(now);
  if (sched) return { status: "blocked", message: sched };

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(cfg.STATE_KEY);
  let state = raw ? JSON.parse(raw) : { sent: [] };
  if (!state.sent) state.sent = [];

  const nowMs = now.getTime();
  const windowMs = cfg.WINDOW_MINUTES * 60 * 1000;
  const confMs = cfg.CONFLICT_MINUTES * 60 * 1000;
  const capMs = cfg.GLOBAL_CAP.WINDOW_MINUTES * 60 * 1000;
  const keepMs = Math.max(windowMs, confMs, cfg.GLOBAL_CAP.ENABLED ? capMs : 0);
  state.sent = state.sent.filter(s => nowMs - s.t < keepMs);

  const asset = assetOf_(data);
  const dirUp = String(data.direction || "").toUpperCase();
  const dir = (dirUp === "UP" || dirUp === "BUY") ? "UP" :
              ((dirUp === "DOWN" || dirUp === "SELL") ? "DOWN" : "?");
  const price = (parseFloat(data.price) || 0).toFixed(2);
  const lim = cfg.LIMITS[asset] || cfg.LIMITS.ETH;
  const save = () => props.setProperty(cfg.STATE_KEY, JSON.stringify(state));
  const blocked = (msg) => { save(); return { status: "blocked", message: msg }; };

  const sameAsset = state.sent.filter(s => s.asset === asset);
  if (cfg.ENABLE_CONFLICT &&
      sameAsset.some(s => s.dir !== dir && nowMs - s.t < confMs))
    return blocked("PREM-конфликт " + asset + " за " + cfg.CONFLICT_MINUTES + " мин");
  if (cfg.GLOBAL_CAP.ENABLED) {
    const inCap = state.sent.filter(s => nowMs - s.t < capMs).length;
    if (inCap >= cfg.GLOBAL_CAP.MAX_OPEN)
      return blocked("PREM-кап " + inCap + "/" + cfg.GLOBAL_CAP.MAX_OPEN +
                     " за " + cfg.GLOBAL_CAP.WINDOW_MINUTES + " мин");
  }
  const sw = sameAsset.filter(s => nowMs - s.t < windowMs);
  if (sw.length >= lim.MAX_SIGNALS_PER_WINDOW)
    return blocked("PREM-окно " + asset + " (" + sw.length + "/" +
                   lim.MAX_SIGNALS_PER_WINDOW + ")");
  const samePrice = sw.filter(s => s.price === price).length;
  if (samePrice >= lim.MAX_SAME_PRICE)
    return blocked("PREM-цена " + asset + " " + price + " (" + samePrice + "/" +
                   lim.MAX_SAME_PRICE + ")");

  state.sent.push({ t: nowMs, price: price, dir: dir, asset: asset });
  save();
  return { status: "sent", message: "Premium " + asset + " " + dir +
                                     " #" + (sw.length + 1) };
}

function handlePremium_(data) {
  const cfg = CONFIG.PREMIUM;
  if (!cfg.ENABLED) return "off";
  const lock = LockService.getScriptLock();
  let d = null;
  if (lock.tryLock(25000)) {
    try { d = decidePremium_(data); }
    catch (err) { console.error("decidePremium error:", err); d = null; }
    lock.releaseLock();
  } else {
    console.error("Premium lock timeout - пропуск");
    return "lock-timeout";
  }
  if (!d) return "err";
  if (d.status !== "sent") return d.message;

  let tg = "-", partner = "-";
  const props = PropertiesService.getScriptProperties();
  const chatId = props.getProperty(cfg.CHAT_ID_PROP);
  if (chatId) {
    const token = props.getProperty(cfg.BOT_TOKEN_PROP);
    const text = (cfg.HEADER ? cfg.HEADER + "\n" : "") +
                 (data.text || "Signal received");
    try { sendTelegram({ text: text }, chatId, token || null); tg = "ok"; }
    catch (e) { tg = "err"; console.error("Premium TG fail:", e); }
  } else { tg = "no-chat"; }
  try { partner = postPartner_(data, cfg.PARTNER_TAG); }
  catch (e) { partner = "err"; console.error("Premium partner fail:", e); }
  return "sent (tg:" + tg + ", partner:" + partner + ")";
}

// ─── MEXC: мягкий fallback-фильтр ────────────────────────────
function decideMexcAlt_(data) {
  const cfg = CONFIG.MEXC_ALT;
  const now = data.bartime ? new Date(data.bartime) : new Date();

  if (cfg.APPLY_TIME_BLOCK) {
    const tb = timeBlockReason_(now, data);
    if (tb) return { status: "blocked", message: "MEXC_ALT-" + tb };
  }

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(cfg.STATE_KEY);
  let state = raw ? JSON.parse(raw) : { sent: [] };
  if (!state.sent) state.sent = [];
  const windowMs = cfg.WINDOW_MINUTES * 60 * 1000;
  state.sent = state.sent.filter(s => now.getTime() - s.t < windowMs);

  const asset = assetOf_(data);
  const dirUp = String(data.direction || "").toUpperCase();
  const dir = (dirUp === "UP" || dirUp === "BUY") ? "UP" : ((dirUp === "DOWN" || dirUp === "SELL") ? "DOWN" : "?");
  const price = (parseFloat(data.price) || 0).toFixed(2);
  const lim = cfg.LIMITS[asset] || cfg.LIMITS.ETH;
  const sameAsset = state.sent.filter(s => s.asset === asset);
  const save = () => props.setProperty(cfg.STATE_KEY, JSON.stringify(state));

  if (sameAsset.length >= lim.MAX_SIGNALS_PER_WINDOW) {
    save(); return { status: "blocked", message: "MEXC_ALT-окно " + asset + " (" + sameAsset.length + "/" + lim.MAX_SIGNALS_PER_WINDOW + ")" };
  }
  const samePrice = sameAsset.filter(s => s.price === price).length;
  if (samePrice >= lim.MAX_SAME_PRICE) {
    save(); return { status: "blocked", message: "MEXC_ALT-цена " + asset + " (" + samePrice + "/" + lim.MAX_SAME_PRICE + ")" };
  }
  state.sent.push({ t: now.getTime(), price: price, dir: dir, asset: asset });
  save();
  return { status: "sent", message: "MEXC_ALT " + asset + " " + dir };
}

// ─── MEXC: доставка (БЕЗ листов - они пишутся позже) ─────────
function mexcDeliver_(data, decisionMexc, payout) {
  const nowMs = (data.bartime ? new Date(data.bartime) : new Date()).getTime();
  const asset = assetOf_(data);
  const dirUp = String(data.direction || "").toUpperCase();
  const dir = (dirUp === "UP" || dirUp === "BUY") ? "UP" :
              ((dirUp === "DOWN" || dirUp === "SELL") ? "DOWN" : "?");
  const timing = mexcTiming_(data);
  const tLabel = mexcTimingLabel_(timing);
  const pv = mexcPayoutFor_(payout, asset, nowMs, dir, timing);
  const out = { tLabel: tLabel, pvCell: (pv.known ? pv.value : ""), tgOK: true, hookNote: "off", partnerNote: "off" };
  if (decisionMexc.status !== "sent") return out;

  const arrow = dir === "UP" ? "📈" : (dir === "DOWN" ? "📉" : "");
  const dirDot = CONFIG.MEXC.DIR_EMOJI[dir] || "";
  const assetDot = CONFIG.MEXC.ASSET_EMOJI[asset] || "";
  const emoji = CONFIG.MEXC.TIMING_EMOJI[timing] || "⏱";
  const altTag = decisionMexc.viaAlt ? " ⚫" : "";
  const header = emoji + assetDot + " <b>" + timing + " MIN | " + asset + " " + dir + "</b> " + dirDot + arrow + altTag;
  let mexcText = header + "\n💰 Price: " + (data.price || "-");
  if (asset === "BTC" && CONFIG.MEXC.BTC_FRAME) {
    mexcText = CONFIG.MEXC.BTC_FRAME + "\n" + mexcText + "\n" + CONFIG.MEXC.BTC_FRAME;
  }
  try { sendTelegram({ text: mexcText }, getProp_(CONFIG.MEXC.CHAT_ID_PROP)); }
  catch (e2) { out.tgOK = false; console.error("MEXC TG fail:", e2); }
  try { out.hookNote = sendMexcWebhook_(data, tLabel, pv.known ? pv.value : null); }
  catch (eX) { out.hookNote = "error"; console.error("MEXC hook fail:", eX); }
  try { out.partnerNote = postPartner_(data, "MEXC_" + timing + "m"); }
  catch (eP) { out.partnerNote = "error"; console.error("MEXC partner fail:", eP); }
  return out;
}

// ─── MEXC: логирование в листы (после всех доставок) ─────────
function mexcLogSheet_(ss, data, decisionMexc, d) {
  if (decisionMexc.status === "sent") {
    const sheet = getOrCreateSheet_(ss, CONFIG.MEXC.SHEET_NAME, HDR_MEXC);
    const okW = appendRowSafe_(sheet, [
      rowTime_(data), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      data.direction1 || "", data.direction2 || "", d.pvCell, d.tLabel,
      decisionMexc.viaAlt ? "ALT" : "",
      data.receivedAt || ""
    ]);
    return "sent: " + decisionMexc.message + " (tg:" + d.tgOK + ", sheet:" + okW + ", hook:" + d.hookNote + ", partner:" + d.partnerNote + ")";
  } else {
    const sheet = getOrCreateSheet_(ss, CONFIG.MEXC.BLOCKED_SHEET_NAME, HDR_MEXC_BLOCK);
    const okB = appendRowSafe_(sheet, [
      rowTime_(data), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      decisionMexc.message, d.pvCell, d.tLabel,
      data.receivedAt || ""
    ]);
    return "blocked: " + decisionMexc.message + " (sheet:" + okB + ")";
  }
}

// ─── РЕШЕНИЕ (под локом, без сетевого IO) ───────────────────
function decideSignal_(data, badlist, branch) {
  const stateKey = (branch && branch.stateKey) || "signal_state_v2";
  const now = data.bartime ? new Date(data.bartime) : new Date();
  const props = PropertiesService.getScriptProperties();

  const stateRaw = props.getProperty(stateKey);
  let state = stateRaw ? JSON.parse(stateRaw) : { sent: [] };
  if (!state.sent) state.sent = [];

  const windowMs = CONFIG.WINDOW_MINUTES * 60 * 1000;
  const capMs = CONFIG.GLOBAL_CAP.WINDOW_MINUTES * 60 * 1000;
  const bdMs = (CONFIG.BTC_DOWN && CONFIG.BTC_DOWN.ENABLED)
    ? CONFIG.BTC_DOWN.EXPIRY_MINUTES * 60 * 1000 : 0;
  const keepMs = Math.max(windowMs, CONFIG.CONFLICT_MINUTES * 60 * 1000,
                          CONFIG.GLOBAL_CAP.ENABLED ? capMs : 0, bdMs);
  state.sent = state.sent.filter(s => now.getTime() - s.t < keepMs);

  const direction = (data.direction || "").toUpperCase();
  const isUp = (direction === "UP" || direction === "BUY");
  const isDown = (direction === "DOWN" || direction === "SELL");
  const dir = isUp ? "UP" : (isDown ? "DOWN" : "?");
  const asset = assetOf_(data);
  const settings = data.Settings || "";

  const lim = CONFIG.LIMITS[asset] || CONFIG.LIMITS.ETH;

  const currentHour = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "H"));
  const currentMinute = parseInt(Utilities.formatDate(now, "Europe/Warsaw", "m"));

  const priceNum = parseFloat(data.price) || 0;
  data.price = priceNum.toFixed(2);
  data.volume = (parseFloat(data.volume) || 0).toFixed(2);
  const price = data.price;

  const blocked = (msg) => {
    props.setProperty(stateKey, JSON.stringify(state));
    return { status: "blocked", message: msg };
  };

  // FM (только ветка MEXC): блок при payout ниже порога.
  if (branch && branch.payout !== undefined) {
    const timing = mexcTiming_(data);
    const pv = mexcPayoutFor_(branch.payout, asset, now.getTime(), dir, timing);
    if (pv.known) {
      if (pv.value < CONFIG.MEXC.MIN_PAYOUT)
        return blocked("FM: MEXC payout " + asset + " " + timing + "м " + pv.value + "% < " + CONFIG.MEXC.MIN_PAYOUT + "%");
    } else if (!CONFIG.MEXC.FAIL_OPEN) {
      return blocked("FM: payout " + asset + " неизвестен (монитор молчит), FAIL_OPEN=false");
    }
  }

  // F6: авто-карантин DEV_BADLIST
  if (badlist && badlist.length && settings) {
    if (badlist.indexOf(settings.trim()) >= 0) {
      return blocked("F6: авто-карантин DEV_BADLIST (WR 4д ниже безубытка)");
    }
  }

  // F7: блокировка по окнам времени (Варшава).
  const tb = timeBlockReason_(now, data);
  if (tb) return blocked(tb);

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
  // F8: глобальный кап - суммарно по ОБОИМ активам
  if (CONFIG.GLOBAL_CAP.ENABLED) {
    const inCap = state.sent.filter(s => now.getTime() - s.t < capMs).length;
    if (inCap >= CONFIG.GLOBAL_CAP.MAX_OPEN)
      return blocked("F8: глобальный кап " + inCap + "/" + CONFIG.GLOBAL_CAP.MAX_OPEN +
                     " за " + CONFIG.GLOBAL_CAP.WINDOW_MINUTES + " мин");
  }
  // ── BTC DOWN (v3.9.10): свой лимит ВМЕСТО F4/F5 ──
  const bdCfg = CONFIG.BTC_DOWN;
  if (bdCfg && bdCfg.ENABLED && asset === "BTC" && dir === "DOWN") {
    const expMs = bdCfg.EXPIRY_MINUTES * 60 * 1000;
    const openBd = state.sent.filter(s => s.asset === "BTC" && s.dir === "DOWN" &&
                                          now.getTime() - s.t < expMs).length;
    if (openBd >= bdCfg.MAX_CONCURRENT)
      return blocked("F4bd: BTC DOWN в отработке " + openBd + "/" + bdCfg.MAX_CONCURRENT +
                     " (экспирация " + bdCfg.EXPIRY_MINUTES + " мин)");
  } else {
    // F4: лимит окна (по активу)
    if (sameAssetWin.length >= lim.MAX_SIGNALS_PER_WINDOW)
      return blocked("F4: лимит окна " + asset + " (" + sameAssetWin.length + "/" + lim.MAX_SIGNALS_PER_WINDOW + ")");
    // F5: лимит цены (по активу)
    const samePriceCount = sameAssetWin.filter(s => s.price === price).length;
    if (samePriceCount >= lim.MAX_SAME_PRICE)
      return blocked("F5: лимит цены " + asset + " " + price + " (" + samePriceCount + "/" + lim.MAX_SAME_PRICE + ")");
  }

  // Пропускаем
  state.sent.push({ t: now.getTime(), price: price, dir: dir, asset: asset });
  props.setProperty(stateKey, JSON.stringify(state));
  const cntAsset = sameAssetWin.length + 1;
  return { status: "sent", message: "Signal " + asset + " #" + cntAsset + " (price: " + price + ")" };
}

function pad_(n) { return (n < 10 ? "0" : "") + n; }

// ─── TELEGRAM ────────────────────────────────────────────────
function sendTelegram(data, chatIdOpt, tokenOpt) {
  const url = "https://api.telegram.org/bot" + (tokenOpt || getProp_("TELEGRAM_BOT_TOKEN")) + "/sendMessage";
  const payload = {
    chat_id: chatIdOpt || getProp_("TELEGRAM_CHAT_ID"),
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

const HDR_ALL    = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Direction1","Direction2","ReceivedAt"];
const HDR_BLOCK  = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Reason","Direction1","ALT10m","ReceivedAt"];
const HDR_FAILED = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Context"];
const HDR_MEXC       = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Direction1","Direction2","Payout","Timing","MexcAlt","ReceivedAt"];
const HDR_MEXC_BLOCK = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Reason","Payout","Timing","ReceivedAt"];
const HDR_PAYOUT     = ["Time","Asset","Payout","Source"];

function writeToSheets_(ss, data) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME, HDR_ALL);
    return appendRowSafe_(sheet, [
      rowTime_(data), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      data.direction1 || "", data.direction2 || "",
      data.receivedAt || ""
    ]);
  } catch (err) {
    console.error("writeToSheets_ fatal:", err);
    return false;
  }
}

function logBlocked_(ss, data, reason, altMarker) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
    return appendRowSafe_(sheet, [
      rowTime_(data), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "", reason,
      data.direction1 || "", altMarker || "",
      data.receivedAt || ""
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
      rowTime_(data), data.ticker || "", data.direction || "", data.price || "",
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
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty("signal_state_v2");
  p.deleteProperty(CONFIG.MEXC.STATE_KEY);
  p.deleteProperty(CONFIG.MEXC_ALT.STATE_KEY);
  p.deleteProperty(CONFIG.ALT10M.STATE_KEY);
  p.deleteProperty(CONFIG.PREMIUM.STATE_KEY);
  console.log("State reset OK (основная, MEXC, MEXC_ALT, ALT10m, Premium)");
}

// ─── РАЗОВАЯ ЧИСТКА КОЛОНКИ ReceivedAt ───────────────────────
function normalizeReceivedAtUtc(applyChanges) {
  const doApply = (applyChanges === true);
  const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  const sheets = [CONFIG.SHEET_NAME, CONFIG.BLOCKED_SHEET_NAME,
                  CONFIG.MEXC.SHEET_NAME, CONFIG.MEXC.BLOCKED_SHEET_NAME];
  const withOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
  let grand = 0;

  for (const name of sheets) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) { console.log(name + ": пропуск (нет данных)"); continue; }
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    let col = -1;
    for (let i = 0; i < head.length; i++)
      if (String(head[i]).trim() === "ReceivedAt") { col = i + 1; break; }
    if (col < 0) { console.log(name + ": колонка ReceivedAt не найдена - пропуск"); continue; }

    const n = sh.getLastRow() - 1;
    const rng = sh.getRange(2, col, n, 1);
    const vals = rng.getValues();
    let changed = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = String(vals[i][0] || "").trim();
      if (!v || !withOffset.test(v)) continue;
      const d = new Date(v);
      if (isNaN(d.getTime())) { console.error(name + " строка " + (i+2) + ": не разобрал '" + v + "'"); continue; }
      vals[i][0] = d.toISOString();
      changed++;
    }
    grand += changed;
    if (changed && doApply) { rng.setValues(vals); SpreadsheetApp.flush(); }
    console.log(name + ": со смещением найдено " + changed +
                (changed ? (doApply ? " - ИСПРАВЛЕНО" : " - НЕ трогал (пробный прогон)") : ""));
  }
  console.log(doApply
    ? ("ГОТОВО. Приведено к UTC: " + grand + " строк.")
    : ("ПРОБНЫЙ ПРОГОН, ничего не изменено. К UTC привёл бы " + grand +
       " строк. Чтобы применить: normalizeReceivedAtUtc(true)"));
}

// ─── САМОПРОВЕРКА (запусти руками один раз после деплоя) ─────
function selfTest() {
  const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  const a = getOrCreateSheet_(ss, CONFIG.SHEET_NAME, HDR_ALL);
  const b = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
  const f = getOrCreateSheet_(ss, CONFIG.FAILED_SHEET_NAME, HDR_FAILED);

  console.log("=== v3.9.13 ===");
  // v3.9.11: быстрая проверка определения актива
  console.log("АКТИВ (assetOf_): BTCUSDT.P →", assetOf_({ ticker: "BTCUSDT.P" }),
    "| ETHUSDT.P →", assetOf_({ ticker: "ETHUSDT.P" }),
    "| SPCXUSDT.P →", assetOf_({ ticker: "SPCXUSDT.P" }),
    "| пусто →", assetOf_({ ticker: "" }));

  // v3.9.12: торговые сессии по активу
  const sesCfg = CONFIG.ASSET_SESSION || {};
  const sesKeys = Object.keys(sesCfg);
  if (sesKeys.length) {
    for (const k of sesKeys) {
      const c = sesCfg[k];
      const nowSes = assetSessionReason_(new Date(), { ticker: k + "USDT.P" });
      console.log("СЕССИЯ " + k + ":", c.ENABLED ? "ON" : "OFF",
        "| " + c.FROM + "-" + c.TO + " " + (c.TZ || "America/New_York") +
        " [" + (c.DAYS || WEEKDAYS).join(",") + "]",
        "| сейчас:", nowSes ? ("БЛОКИРУЕТ → " + nowSes) : "пропускает");
    }
  } else {
    console.log("СЕССИИ ПО АКТИВУ: не заданы (все активы без ограничения часов)");
  }
  const demo = new Date();
  console.log("ВРЕМЯ: формат ReceivedAt =", CONFIG.RECEIVED_AT_FORMAT,
    "| пример:", stampIso_(demo),
    "| колонка A того же сигнала:", Utilities.formatDate(demo, "Europe/Warsaw", "yyyy-MM-dd HH:mm:ss"),
    "| это ОДИН момент времени" +
    (CONFIG.RECEIVED_AT_FORMAT === "utc"
      ? " (часы отличаются на величину пояса - так и должно быть, Z = UTC)"
      : " (часы совпадают)"));
  console.log("ЛИМИТЫ (F4/F5): ETH окно " + CONFIG.LIMITS.ETH.MAX_SIGNALS_PER_WINDOW +
    " / цена " + CONFIG.LIMITS.ETH.MAX_SAME_PRICE +
    " | BTC окно " + CONFIG.LIMITS.BTC.MAX_SIGNALS_PER_WINDOW +
    " / цена " + CONFIG.LIMITS.BTC.MAX_SAME_PRICE +
    " | (SPCX → фолбэк на ETH-лимиты)" +
    " | окно " + CONFIG.WINDOW_MINUTES + " мин");
  const wins = (CONFIG.TIME_BLOCK.WINDOWS || []).map(function (w) {
    return w.from + "-" + w.to + " [" + (w.days || CONFIG.TIME_BLOCK.DAYS).join(",") + "]" +
           (w.strict ? " STRICT(режет и BTC DOWN)" : "");
  });
  console.log("ОКНА ВРЕМЕНИ (F7):", CONFIG.TIME_BLOCK.ENABLED ? wins.join(" | ") : "DISABLED");
  console.log("  режим:", CONFIG.TIME_BLOCK.GLOBAL
    ? "ГЛОБАЛЬНЫЙ ГЕЙТ - действует на ВСЕ ветки (основная, MEXC, MEXC_ALT, ALT10m, Premium)"
    : ("по веткам: ALT10m=" + !!CONFIG.ALT10M.APPLY_TIME_BLOCK +
       ", MEXC_ALT=" + !!CONFIG.MEXC_ALT.APPLY_TIME_BLOCK +
       ", Premium=" + !!CONFIG.PREMIUM.APPLY_TIME_BLOCK +
       " (основная и MEXC - всегда)"));
  console.log("ГЛОБАЛЬНЫЙ КАП (F8):", CONFIG.GLOBAL_CAP.ENABLED
    ? (CONFIG.GLOBAL_CAP.MAX_OPEN + " за " + CONFIG.GLOBAL_CAP.WINDOW_MINUTES +
       " мин (окно > экспирации 10 мин => не больше " + CONFIG.GLOBAL_CAP.MAX_OPEN +
       " одновременно, в пределах ОДНОЙ ветки)") : "DISABLED");

  const nowD = new Date();
  const nowTb = timeBlockReason_(nowD);
  console.log("ОКНА ВРЕМЕНИ сейчас:", nowTb ? ("БЛОКИРУЕТ → " + nowTb) : "пропускает");

  const bdc = CONFIG.BTC_DOWN;
  if (bdc && bdc.ENABLED) {
    const strictWins = (CONFIG.TIME_BLOCK.WINDOWS || [])
      .filter(function (w) { return w.strict; })
      .map(function (w) { return w.from + "-" + w.to; });
    const tbBd = timeBlockReason_(nowD, { ticker: "BTCUSDT.P", direction: "DOWN" });
    console.log("BTC DOWN: особые правила ON" +
      " | лимит " + bdc.MAX_CONCURRENT + " одновременно в отработке (" +
      bdc.EXPIRY_MINUTES + " мин), вместо F4/F5" +
      " | освобождён от окон: " + (bdc.EXEMPT_FROM_TIME_BLOCK ? "ДА" : "нет") +
      (bdc.EXEMPT_FROM_TIME_BLOCK
        ? (", кроме строгих: " + (strictWins.length ? strictWins.join(", ") : "нет"))
        : "") +
      " | общий кап F8 действует как обычно");
    console.log("  сейчас для BTC DOWN:", tbBd ? ("БЛОКИРУЕТ → " + tbBd) : "пропускает");
  } else {
    console.log("BTC DOWN: особые правила DISABLED (общие правила BTC)");
  }

  if (CONFIG.MEXC.ENABLED) {
    getOrCreateSheet_(ss, CONFIG.MEXC.SHEET_NAME, HDR_MEXC);
    getOrCreateSheet_(ss, CONFIG.MEXC.BLOCKED_SHEET_NAME, HDR_MEXC_BLOCK);
    getOrCreateSheet_(ss, CONFIG.MEXC.PAYOUT_SHEET_NAME, HDR_PAYOUT);
    const chatOk = !!PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.CHAT_ID_PROP);
    const po = getMexcPayout_();
    console.log("MEXC: ветка ON | chat_id задан:", chatOk,
      "| символы:", JSON.stringify(CONFIG.MEXC.SYMBOLS),
      "| payout:", JSON.stringify(po),
      "| порог:", CONFIG.MEXC.MIN_PAYOUT + "%",
      "| источник:", CONFIG.MEXC.PAYOUT_URL ? ("URL-монитор (" + CONFIG.MEXC.TIME_UNIT + " " + CONFIG.MEXC.TIMINGS.join("/") + ")") : "ручной (setMexcPayoutManual)",
      "| MEXC-хук:", CONFIG.MEXC.WEBHOOK_ENABLED ? (CONFIG.MEXC.WEBHOOK_URL || "URL НЕ ЗАДАН") : "DISABLED",
      "| FAIL_OPEN:", CONFIG.MEXC.FAIL_OPEN);
    console.log("MEXC_ALT (мягкий fallback):", CONFIG.MEXC_ALT.ENABLED
      ? ("ON | окно " + CONFIG.MEXC_ALT.WINDOW_MINUTES + "мин, ETH " + CONFIG.MEXC_ALT.LIMITS.ETH.MAX_SIGNALS_PER_WINDOW +
         "/BTC " + CONFIG.MEXC_ALT.LIMITS.BTC.MAX_SIGNALS_PER_WINDOW +
         " | окна времени: " + (CONFIG.MEXC_ALT.APPLY_TIME_BLOCK ? "ДА" : "нет"))
      : "DISABLED");
  } else {
    console.log("MEXC: ветка DISABLED");
  }
  // v3.9.13: хук Toobit (PRO-ветка → локальный исполнитель)
  console.log("TOOBIT-хук:", CONFIG.TOOBIT.ENABLED
    ? (CONFIG.TOOBIT.WEBHOOK_URL || "URL НЕ ЗАДАН")
    : "DISABLED",
    "| шлём принятые основной веткой сигналы с меткой \"10m\"",
    "| адрес общий с MEXC-хуком:", CONFIG.TOOBIT.WEBHOOK_URL === CONFIG.MEXC.WEBHOOK_URL);
  const props = PropertiesService.getScriptProperties();
  console.log("Партнёрские потоки:",
    "мастер:", CONFIG.PARTNER_WEBHOOK_ENABLED,
    "| потоки:", JSON.stringify(CONFIG.PARTNER_STREAMS));
  console.log("ALT10m:", CONFIG.ALT10M.ENABLED
    ? ("ON | окно " + CONFIG.ALT10M.WINDOW_MINUTES + "мин, ETH " + CONFIG.ALT10M.LIMITS.ETH.MAX_SIGNALS_PER_WINDOW +
       "/BTC " + CONFIG.ALT10M.LIMITS.BTC.MAX_SIGNALS_PER_WINDOW +
       " | ТГ-группа: " + !!props.getProperty(CONFIG.ALT10M.CHAT_ID_PROP) +
       " | партнёр: " + (CONFIG.PARTNER_STREAMS["ALT10m"] ? "ON" : "off") +
       " | окна времени: " + (CONFIG.ALT10M.APPLY_TIME_BLOCK ? "ДА" : "нет"))
    : "DISABLED");
  resetBadlistCache();
  const bl = loadBadlist_();
  console.log("OK → вкладки:", a.getName(), "/", b.getName(), "/", f.getName(),
    "| TG token:", !!getProp_("TELEGRAM_BOT_TOKEN"), "| chat:", !!getProp_("TELEGRAM_CHAT_ID"),
    "| partner webhook:", CONFIG.PARTNER_WEBHOOK_ENABLED ? CONFIG.PARTNER_WEBHOOK_URL : "DISABLED",
    "| badlist (F6):", CONFIG.BADLIST.ENABLED ? (bl.length + " конфигураций в карантине") : "DISABLED");

  const pc = CONFIG.PREMIUM;
  if (pc.ENABLED) {
    const pChat = props.getProperty(pc.CHAT_ID_PROP);
    console.log("PREMIUM: ветка ON" +
      " | расписание: " + pc.ALL_DAY_DAYS.join(",") + " целиком; " +
      pc.EVENING_DAYS.join(",") + " часы " + pc.EVENING_HOURS.join(",") +
      " | лимиты ETH " + pc.LIMITS.ETH.MAX_SIGNALS_PER_WINDOW + "/" + pc.LIMITS.ETH.MAX_SAME_PRICE +
      ", BTC " + pc.LIMITS.BTC.MAX_SIGNALS_PER_WINDOW + "/" + pc.LIMITS.BTC.MAX_SAME_PRICE +
      ", окно " + pc.WINDOW_MINUTES + " мин" +
      " | свой кап " + pc.GLOBAL_CAP.MAX_OPEN + " за " + pc.GLOBAL_CAP.WINDOW_MINUTES + " мин" +
      " | ТГ-группа задана: " + !!pChat +
      " | свой бот: " + !!props.getProperty(pc.BOT_TOKEN_PROP) +
      " | партнёр: " + (CONFIG.PARTNER_STREAMS[pc.PARTNER_TAG] ? "ON" : "off") +
      " | в листы: НЕ пишем");
    const pNow = premiumScheduleReason_(new Date());
    console.log("  расписание PREMIUM сейчас:", pNow ? ("не подходит → " + pNow) : "ПОДХОДИТ");
    if (!pChat)
      console.log("  ВНИМАНИЕ: Script Property " + pc.CHAT_ID_PROP +
                  " не задан - сигналы Premium никуда не уйдут.");
  } else {
    console.log("PREMIUM: ветка DISABLED");
  }
}
