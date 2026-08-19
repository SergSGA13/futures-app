// ============================================================
// TradingView Signal Webhook → Telegram + Google Sheets  v3.9
// ОДИН скрипт на ОБА актива (ETH + BTC), запись в ОДНУ вкладку.
// ============================================================
// v3.9.5: хук Toobit - сигналы PRO-ветки уходят исполнителю.
//   - CONFIG.TOOBIT: свой URL, свой выключатель. Шлём ПРИНЯТЫЕ основной
//     (PRO) веткой сигналы - те же, что идут в ТГ и партнёру с тегом
//     "10m". Payload побайтово тот же, что у партнёра, включая
//     "timing":"10m" - по этой метке исполнитель и понимает, что
//     ставить надо на Toobit: ветка MEXC шлёт "MEXC _10m"/"MEXC _30m",
//     ветка ALT - "ALT10m", и потоки не путаются.
//   - Payout НЕ шлём: у Toobit его считает сам исполнитель по странице
//     (порог строго больше 75%), потому что источник сигнала его не
//     знает. Отсюда и разница: у MEXC payout проверяется здесь, у
//     Toobit - на месте.
//   - Сбой хука не влияет ни на Telegram, ни на записи, ни на партнёра.
// v3.9.4: партнёрские потоки по тегам + ветка ALT10m с фильтрами.
//   - Партнёр получает несколько потоков на ОДИН хук
//     (PARTNER_WEBHOOK_URL), различает по полю "timing". У каждого
//     свой переключатель CONFIG.PARTNER_STREAMS: "10m" (PRO, вкл),
//     "ALT10m" (выкл), "MEXC_10m"/"MEXC_30m" (выкл). Мастер -
//     PARTNER_WEBHOOK_ENABLED. Помощник postPartner_(data, tag).
//   - Ветка ALT10m (CONFIG.ALT10M): берёт заблокированные основной
//     веткой сигналы, прогоняет через СВОИ мягкие лимиты (окно 2 мин,
//     ETH 3 / BTC 2, одинаковых цен ≤2). Прошедшие → ТГ-группа ALT10m
//     и партнёр (тег "ALT10m"). Каждый прошедший помечается "ALT10m"
//     в новой колонке листа BLOCKEDsignal. Заменяет прежний ALT_FEED
//     (тот слал сырой поток без фильтров).
//   - MEXC → партнёр (теги MEXC_10m/MEXC_30m) добавлен, но по
//     умолчанию выключен; отдельный MEXC-хук (исполнитель) не тронут.
// v3.9.3: скорость доставки + ALT-ветка + F6 выключен.
//   - ПОРЯДОК ОБРАБОТКИ переставлен: PRO-группа и партнёрский хук
//     получают сигнал СРАЗУ после фильтров основной ветки, не
//     дожидаясь payout MEXC, ветки MEXC и записей в листы. Записи в
//     Google Sheets ушли в самый конец - их задержка больше не
//     влияет на доставку. Выигрыш ~1.5-5 секунд на сигнал.
//     Логика фильтров/лимитов НЕ менялась (стейты веток независимы,
//     каждое решение - под своим коротким локом).
//   - ALT-ветка (CONFIG.ALT_FEED): сигналы, заблокированные фильтрами
//     основной ветки (то, что пишется в BLOCKEDsignal), уходят в
//     отдельный ТГ-канал своим ботом (Script Properties
//     ALT_TELEGRAM_BOT_TOKEN + ALT_TELEGRAM_CHAT_ID) - масштабирование
//     на вторую аудиторию подписчиков.
//   - F6 (авто-карантин DEV_BADLIST) выключен: BADLIST.ENABLED=false.
// v3.9.2: MEXC-хук - принятые веткой MEXC сигналы уходят POST-ом
//   на CONFIG.MEXC.WEBHOOK_URL (устроен в точности как партнёрский
//   вебхук: тот же payload + timing "MEXC _10m"/"MEXC _30m" + payout).
//   Получатель сам решает, что исполнять (например только _10m).
//   По умолчанию выключено; сбой хука не влияет на поток.
//   Готовый получатель-автотрейдер: scripts/mexc-executor (опция).
// v3.9.1: метки timing в вебхуках и листах MEXC.
//   - Партнёрский вебхук: в payload добавлено timing = "10m"
//     (партнёру уходят только 10-минутки; в лист ALLsignal timing
//     НЕ пишется - лист не меняется).
//   - MEXCsignal/MEXCblocked: timing = "MEXC _10m" / "MEXC _30m"
//     (колонка "Timing", первая свободная после Payout).
//   30-минутки помечаются в JSON алерта TradingView как
//   "timing":"MEXC _30m" - они идут ТОЛЬКО в MEXC (mexcOnly),
//   в ALLsignal/партнёру не попадают. 10-минуткам поле не нужно
//   (нет "30" в timing → трактуется как 10м).
// v3.9: ОТДЕЛЬНАЯ ВЕТКА для трейдеров MEXC (CONFIG.MEXC).
//   Каждый сигнал проходит ДВА независимых решения:
//   - основная ветка: как раньше (свой стейт signal_state_v2,
//     свои вкладки, своя ТГ-группа, партнёрский вебхук);
//   - ветка MEXC: СВОЙ стейт лимитов (signal_state_mexc_v1),
//     свои вкладки MEXCsignal/MEXCblocked, СВОЯ ТГ-группа
//     (Script Property MEXC_TELEGRAM_CHAT_ID) + новый фильтр
//     FM: блок при payout MEXC < MIN_PAYOUT (80%).
//   Стейты НЕ пересекаются: если в основную группу прошло
//   3 сигнала, а на MEXC из-за payout прошёл 1 - лимиты MEXC
//   считаются по СВОИМ принятым, и после возврата payout к 80%
//   ветка MEXC принимает сигналы независимо от основной.
//   Payout тянется с внутреннего endpoint Event Futures MEXC
//   (event_contract/detail, найден через DevTools 18.07.2026):
//   один JSON на все контракты, ставки по направлениям (upPayRate/
//   downPayRate) и таймфреймам (MINUTE 10/30, HOUR, DAY). Свежесть
//   на решении - дожим в getMexcPayout_ (30 с), между сигналами -
//   минутный триггер mexcPayoutMonitor() (алерты/история). Запасной
//   путь - ручной ввод setMexcPayoutManual(); при отсутствии/
//   устаревании данных действует FAIL_OPEN (по умолчанию true -
//   сигналы идут, фильтр FM тихо пропускается).
//   Монитор шлёт алерты в группу MEXC на переходах payout через
//   порог: "⛔ упал ниже 80%" / "✅ вернулся к 80%".
//   EV-справка: WIN +0.8×ставка / LOSE -ставка. Безубыток
//   WR = 1/(1+payout): 80% → 55.6%, 75% → 57.1%, 70% → 58.8%.
//   При WR ~60% почти вся кромка съедается уже на 70-75%.
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
// МИГРАЦИЯ v3.9.3 → v3.9.4: заменить код. Включение потоков:
//   - ALT10m: Script Properties ALT_TELEGRAM_CHAT_ID (+ опц.
//     ALT_TELEGRAM_BOT_TOKEN), затем CONFIG.ALT10M.ENABLED = true.
//     Партнёру ALT10m: CONFIG.PARTNER_STREAMS["ALT10m"] = true.
//     В листе BLOCKEDsignal появится колонка ALT10m (для старого
//     листа допиши заголовок "ALT10m" в первую свободную колонку J).
//   - MEXC партнёру: CONFIG.PARTNER_STREAMS["MEXC_10m"/"MEXC_30m"]=true.
//   Вернуть карантин F6: CONFIG.BADLIST.ENABLED = true.
// МИГРАЦИЯ v3.8 → v3.9:
//   1) Заменить код проекта этим файлом.
//   2) Script Properties: добавить MEXC_TELEGRAM_CHAT_ID
//      (chat_id новой ТГ-группы MEXC; бот должен быть в группе).
//   3) Триггеры (часы слева) → Add Trigger → mexcPayoutMonitor,
//      time-driven, каждые 1-5 минут.
//   4) Источник payout уже настроен (PAYOUT_URL, таймфреймы из
//      TIMINGS: 10 и 30 минут). Проверить: запустить mexcPayoutProbe()
//      - в логе должны быть числа по обоим таймфреймам.
//      Если HTTP 403 - endpoint закрыт для серверов Google, тогда
//      вручную setMexcPayoutManual(80, 80) при изменении payout.
//   5) 30-минутные алерты TradingView: добавить в JSON алерта поле
//      "timing":"MEXC _30m" - сигнал получит шапку 🕒 30 MIN, проверку
//      payout 30-минутного контракта и метку "MEXC _30m" в листе.
//      Без поля (или "10m") = 10-минутка.
//      30-минутка - ЭКСКЛЮЗИВ MEXC (MEXC_ONLY_TIMINGS): такие
//      сигналы идут ТОЛЬКО в группу MEXC, основная ветка (TG,
//      ALLsignal, партнёр, её лимиты) их не видит вовсе.
//      ALLsignal и партнёру уходит метка "10m" (только 10-минутки).
//   6) selfTest() один раз - строка "MEXC:" в логе.
//   Отключить ветку MEXC без удаления кода: CONFIG.MEXC.ENABLED=false.
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
  // ВЫКЛЮЧЕН по просьбе владельца (21.07.2026). Вкладку DEV_BADLIST
  // GitHub Actions продолжает строить каждое утро - аналитика в
  // приложении живёт, карантин сигналов не применяется. Бонус к
  // скорости: loadBadlist_ при ENABLED=false возвращается мгновенно.
  BADLIST: {
    ENABLED: false,                // true - включить карантин обратно
    SHEET_NAME: "DEV_BADLIST",     // вкладку строит GitHub Actions ежедневно
    CACHE_KEY: "dev_badlist_v1",
    CACHE_TTL_SEC: 3600,           // перечитывать вкладку не чаще раза в час
  },

  // ─── Ветка MEXC (v3.9): независимое решение + payout-фильтр ───
  MEXC: {
    ENABLED: true,
    STATE_KEY: "signal_state_mexc_v1", // СВОЙ стейт лимитов (не общий!)
    SHEET_NAME:         "MEXCsignal",
    BLOCKED_SHEET_NAME: "MEXCblocked",
    PAYOUT_SHEET_NAME:  "MEXC_PAYOUT", // история payout (пишет монитор)
    CHAT_ID_PROP: "MEXC_TELEGRAM_CHAT_ID", // Script Property: chat_id группы MEXC

    // FM: минимальный payout (%). Ниже - сигнал в MEXCblocked.
    // Безубыток WR = 1/(1+payout): 80%→55.6%, 75%→57.1%, 70%→58.8%.
    MIN_PAYOUT: 80,
    PAYOUT_STALE_MIN: 15,  // данные старше 15 мин считаем неизвестными
    FAIL_OPEN: true,       // payout неизвестен: true - пропускать, false - блокировать

    PAYOUT_PROP: "mexc_payout_v1",       // Script Property со значениями
    CACHE_KEY: "mexc_payout_cache_v1",   // CacheService (быстрый путь)
    CACHE_TTL_SEC: 25,

    // Свежесть на РЕШЕНИИ: payout может меняться каждые ~30 секунд,
    // поэтому он тянется из PAYOUT_URL прямо в doPost (Фаза 0, вне
    // лока), если сохранённому значению больше PAYOUT_FRESH_SEC.
    // Time-триггер mexcPayoutMonitor при этом нужен только для
    // алертов/истории в паузах между сигналами (раз в 1-5 мин;
    // чаще Apps Script не умеет, а sleep-трюки съедают квоту).
    PAYOUT_FRESH_SEC: 30,
    PAYOUT_FETCH_TIMEOUT: 5,             // секунд на запрос к MEXC

    // Источник payout: endpoint деталей Event Futures (найден через
    // DevTools 18.07.2026). Отдаёт ВСЕ контракты одним JSON; у каждого
    // символа ставки по таймфреймам:
    //   "MINUTE":[{"val":10,"upPayRate":0.8,"downPayRate":0.8},
    //             {"val":30,"upPayRate":0.85,...}], "HOUR":[...], ...
    // Пустая строка = ручной режим (setMexcPayoutManual).
    PAYOUT_URL: "https://www.mexc.com/api/platform/futures/api/v1/event_contract/detail",
    SYMBOLS: { ETH: "ETH_USDT", BTC: "BTC_USDT" },
    // Таймфреймы отработки: payout хранится и проверяется ПО КАЖДОМУ
    // (у MEXC 10m и 30m - разные ставки). Тайминг сигнала задаётся в
    // алерте TradingView полем "timing": 30-минутки помечаются
    // "timing":"MEXC _30m"; 10-минуткам поле не нужно (по умолчанию 10).
    TIME_UNIT: "MINUTE",
    TIMINGS: [10, 30],
    DEFAULT_TIMING: 10,
    // Шапка сообщения в группу MEXC: "<эмодзи> <тайминг> MIN | ACTIVE UP/DOWN"
    TIMING_EMOJI: { 10: "⚡️", 30: "🕒" },
    // Тайминги-эксклюзивы MEXC: сигналы с таким timing идут ТОЛЬКО в
    // ветку MEXC. Основная ветка их не видит вовсе: ни Telegram, ни
    // ALLsignal, ни партнёрский вебхук, ни счётчики её лимитов.
    MEXC_ONLY_TIMINGS: [30],

    // Алерты "⛔ payout упал / ✅ вернулся" в группу MEXC: выключены по
    // просьбе владельца (18.07.2026) - группа только для сигналов.
    // История в MEXC_PAYOUT и сам фильтр FM работают независимо от этого.
    ALERTS_ENABLED: false,

    // ─── MEXC-хук (v3.9.2): доставка сигналов MEXC внешнему получателю ───
    // Устроен В ТОЧНОСТИ как партнёрский вебхук: один URL, тот же
    // payload + timing ("MEXC _10m"/"MEXC _30m") и текущий payout.
    // Получатель сам решает, что исполнять (например только _10m).
    // Сбой хука не влияет на Telegram и записи. Пустой URL = выключено.
    WEBHOOK_URL: "",
    WEBHOOK_ENABLED: false,
    WEBHOOK_TIMEOUT: 5,
  },

  // ─── Хук Toobit (v3.9.5): PRO-ветка → локальный исполнитель ───
  // Шлётся то же, что уходит в ТГ и партнёру с тегом "10m", то есть
  // ПРИНЯТЫЕ основной веткой сигналы, и тем же телом. Куда ставить,
  // исполнитель решает по метке "timing":"10m" - у ветки MEXC свои
  // метки ("MEXC _10m"/"MEXC _30m"), у ALT своя.
  // 30-минутки сюда не попадают: они эксклюзив MEXC
  // (MEXC_ONLY_TIMINGS) и основную ветку не проходят.
  // Payout не передаём - на Toobit его читает сам исполнитель со
  // страницы, здесь он неизвестен. Пустой URL = выключено.
  TOOBIT: {
    ENABLED: true,
    WEBHOOK_URL: "",          // адрес туннеля: https://<...>/signal?secret=<секрет>
    WEBHOOK_TIMEOUT: 5,
  },

  // ─── Надёжность записи ───
  WRITE_RETRIES: 3,
  WRITE_RETRY_SLEEP_MS: 350,

  // ─── Partner webhook (v3.9.4: один хук, разные теги) ───
  // Партнёр получает разные потоки на ОДИН URL и различает их по полю
  // "timing". У каждого потока свой переключатель в PARTNER_STREAMS.
  PARTNER_WEBHOOK_URL: "https://signalapiwebhook1312.win/webhook/signal/74f9addb559e663d75047ed9d250edf6e526510cd47440be",
  PARTNER_WEBHOOK_ENABLED: true,  // мастер-выключатель всей отправки партнёру
  PARTNER_WEBHOOK_TIMEOUT: 10,    // секунд
  PARTNER_STREAMS: {
    "10m":      true,    // PRO (основная ветка) - как было
    "ALT10m":   false,   // из BLOCKEDsignal (свои фильтры - CONFIG.ALT10M)
    "MEXC_10m": false,   // MEXC 10-мин - пока НЕ слать партнёру
    "MEXC_30m": false,   // MEXC 30-мин - пока НЕ слать партнёру
  },

  // ─── Ветка ALT10m (v3.9.4): фильтрованный поток из BLOCKEDsignal ───
  // Работает с сигналами, ЗАБЛОКИРОВАННЫМИ основной веткой. Свои, более
  // мягкие лимиты (окно 2 мин, ETH 3 / BTC 2, одинаковых цен ≤2).
  // Прошедшие фильтр → в Telegram-группу ALT10m (Script Properties
  // ALT_TELEGRAM_CHAT_ID + ALT_TELEGRAM_BOT_TOKEN; пусто в токене =
  // основной бот) и партнёру с тегом "ALT10m" (если PARTNER_STREAMS).
  // Каждый прошедший помечается словом "ALT10m" в отдельной колонке
  // листа BLOCKEDsignal. 30-минутки MEXC сюда не попадают.
  ALT10M: {
    ENABLED: false,                       // мастер-переключатель ветки
    STATE_KEY: "signal_state_alt10m_v1",
    WINDOW_MINUTES: 2,                    // окно/интервал лимитов
    LIMITS: {
      ETH: { MAX_SIGNALS_PER_WINDOW: 3, MAX_SAME_PRICE: 2 },
      BTC: { MAX_SIGNALS_PER_WINDOW: 2, MAX_SAME_PRICE: 2 },
    },
    BOT_TOKEN_PROP: "ALT_TELEGRAM_BOT_TOKEN",  // пусто = основной бот
    CHAT_ID_PROP: "ALT_TELEGRAM_CHAT_ID",      // пусто = не слать в ТГ
  },

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

// ─── MEXC PAYOUT (v3.9) ──────────────────────────────────────
// Значения хранятся в Script Property PAYOUT_PROP в виде
// {ETH:{p:80,t:169...,src:"monitor"}, BTC:{...}} (t - millis записи).
// Быстрый путь - CacheService; fail-open как у бэдлиста: любой
// сбой чтения = {} (payout неизвестен, дальше решает FAIL_OPEN).
//
// Payout плавает каждые ~30 секунд, поэтому здесь же - ДОЖИМ до
// свежести: если по активу задан URL и сохранённое значение старше
// PAYOUT_FRESH_SEC (или ручное - его монитор обновляет всегда,
// когда есть URL), тянем свежее прямо сейчас. Вызов идёт из
// Фазы 0 doPost (ВНЕ лока), так что сеть не попадает в критическую
// секцию. Сбой запроса = остаёмся на сохранённом значении.
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

// Дожим свежести: если хоть одному активу больше PAYOUT_FRESH_SEC,
// один запрос к PAYOUT_URL обновляет ОБА (endpoint отдаёт все
// контракты разом). Возвращает обновлённый объект или null.
// savePayout_ по пути пишет историю и шлёт алерты.
function refreshPayoutIfStale_(val) {
  if (!CONFIG.MEXC.PAYOUT_URL) return null;
  const nowMs = Date.now();
  let stale = false;
  for (const asset of ["ETH", "BTC"]) {
    for (const tf of CONFIG.MEXC.TIMINGS) {
      const rec = val && val[asset + "@" + tf];
      if (!rec || nowMs - (rec.t || 0) > CONFIG.MEXC.PAYOUT_FRESH_SEC * 1000) { stale = true; break; }
    }
    if (stale) break;
  }
  if (!stale) return null;
  let got = null;
  try { got = fetchEventPayouts_(); }
  // (один запрос даёт все активы и таймфреймы разом)
  catch (err) { console.error("payout refresh failed:", err); return null; }
  if (!got || !Object.keys(got).length) return null;
  savePayout_(got, "monitor");
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.PAYOUT_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}

// Тайминг отработки сигнала (минуты, 10 или 30): из поля "timing"
// алерта TradingView. Принимает любую форму, содержащую число:
// "MEXC _30m", "30", 30, "30 min" → 30; всё остальное (в т.ч.
// "10m", "MEXC _10m", отсутствие поля) → 10.
function mexcTiming_(data) {
  const s = String((data && (data.timing || data.mexc_tf)) || "");
  return /30/.test(s) ? 30 : 10;
}

// Метка тайминга для листа MEXC: "MEXC _10m" / "MEXC _30m"
// (пробел и подчёркивание - как в JSON-алертах TradingView).
function mexcTimingLabel_(tf) { return "MEXC _" + tf + "m"; }

// ─── MEXC-хук (v3.9.2): как sendPartnerWebhook, но для ветки MEXC ──
// Вызывается только для ПРИНЯТЫХ веткой MEXC сигналов. Тот же формат
// payload, что у партнёра, плюс timing-метка и текущий payout.
// Возвращает заметку для лога ответа ("off" / "http 200").
function sendMexcWebhook_(data, label, payoutVal) {
  if (!CONFIG.MEXC.WEBHOOK_ENABLED || !CONFIG.MEXC.WEBHOOK_URL) return "off";
  const payload = {
    ticker:     data.ticker     || "",
    direction:  data.direction  || "",
    price:      data.price      || "",
    volume:     data.volume     || "",
    text:       data.text       || "",
    bartime:    data.bartime    || "",
    timing:     label,                  // "MEXC _10m" / "MEXC _30m"
    payout:     payoutVal,              // число % или null (неизвестен)
    receivedAt: data.receivedAt || new Date().toISOString(),   // время прихода, до мс (UTC)
  };
  const resp = UrlFetchApp.fetch(CONFIG.MEXC.WEBHOOK_URL, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, deadline: CONFIG.MEXC.WEBHOOK_TIMEOUT,
  });
  return "http " + resp.getResponseCode();
}

// ─── Хук Toobit (v3.9.5): как sendMexcWebhook_, но для PRO-ветки ──
// Вызывается только для ПРИНЯТЫХ основной веткой сигналов. Тело - в
// точности партнёрское, с меткой потока "10m": по ней исполнитель
// понимает, что это PRO-ветка и ставить надо на Toobit. Отдельного
// поля с биржей не нужно - ветка MEXC шлёт свои метки.
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
    receivedAt: data.receivedAt || new Date().toISOString(),
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

// Актуален ли payout по активу и таймингу: {known:bool, value:число %}.
// dir ("UP"/"DOWN") выбирает ставку направления - у MEXC upPayRate и
// downPayRate могут различаться; без dir берётся худшая из двух.
// known=false и когда данных нет, и когда они старше PAYOUT_STALE_MIN.
// Ручной ввод (src="manual") НЕ протухает: значение действует,
// пока его не сменят - иначе пришлось бы перевводить каждые 15 мин.
function mexcPayoutFor_(payout, asset, nowMs, dir, timing) {
  const key = asset + "@" + (timing || CONFIG.MEXC.DEFAULT_TIMING);
  const rec = payout && (payout[key] || payout[asset]);  // payout[asset] - старый формат
  if (!rec) return { known: false, value: null };
  const up = typeof rec.up === "number" ? rec.up : rec.p;   // rec.p - старый формат
  const down = typeof rec.down === "number" ? rec.down : rec.p;
  if (typeof up !== "number" && typeof down !== "number") return { known: false, value: null };
  const value = dir === "UP" ? up : (dir === "DOWN" ? down : Math.min(up, down));
  if (rec.src !== "manual" &&
      nowMs - (rec.t || 0) > CONFIG.MEXC.PAYOUT_STALE_MIN * 60 * 1000)
    return { known: false, value: value };
  return { known: typeof value === "number", value: value };
}

// Ручной ввод payout (%, число за актив; null/undefined - не менять).
// Пример: setMexcPayoutManual(80, 76) - на ВСЕ таймфреймы;
// setMexcPayoutManual(85, 85, 30) - только на 30-минутки.
// Ставит одинаковое значение на оба направления. Работает и без
// PAYOUT_URL - тогда это единственный источник данных для FM.
function setMexcPayoutManual(ethPayout, btcPayout, timingOpt) {
  const timings = timingOpt ? [timingOpt] : CONFIG.MEXC.TIMINGS;
  const vals = {};
  for (const tf of timings) {
    if (ethPayout != null) vals["ETH@" + tf] = ethPayout;
    if (btcPayout != null) vals["BTC@" + tf] = btcPayout;
  }
  savePayout_(vals, "manual");
}

// Общая запись payout: props + кэш + история + алерты на переходах.
// newVals: {"ETH@10": число | {up,down}, "BTC@30": ...}.
function savePayout_(newVals, source) {
  const props = PropertiesService.getScriptProperties();
  let cur = {};
  try { cur = JSON.parse(props.getProperty(CONFIG.MEXC.PAYOUT_PROP) || "{}"); } catch (e) {}
  const nowMs = Date.now();
  const norm1 = (v) => v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10; // 0.8 → 80
  const changed = [];
  for (const key in newVals) {
    let v = newVals[key];
    if (v == null) continue;
    if (typeof v === "number") { if (isNaN(v)) continue; v = { up: v, down: v }; }
    if (typeof v.up !== "number" || typeof v.down !== "number") continue;
    const up = norm1(v.up), down = norm1(v.down);
    const prevRec = cur[key] || {};
    const prevMin = typeof prevRec.up === "number"
      ? Math.min(prevRec.up, prevRec.down) : prevRec.p;   // p - старый формат
    cur[key] = { up: up, down: down, t: nowMs, src: source || "" };
    if (prevRec.up !== up || prevRec.down !== down)
      changed.push({ asset: key.replace("@", " ") + "м", prev: prevMin, next: Math.min(up, down), up: up, down: down });
  }
  props.setProperty(CONFIG.MEXC.PAYOUT_PROP, JSON.stringify(cur));
  try { CacheService.getScriptCache().put(CONFIG.MEXC.CACHE_KEY, JSON.stringify(cur), CONFIG.MEXC.CACHE_TTL_SEC); } catch (e) {}

  if (!changed.length) return;
  // история (только при изменении значения - не раз в минуту)
  try {
    const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
    const sh = getOrCreateSheet_(ss, CONFIG.MEXC.PAYOUT_SHEET_NAME, HDR_PAYOUT);
    for (const c of changed)
      sh.appendRow([new Date(), c.asset, c.up === c.down ? c.up : (c.up + "/" + c.down), source || ""]);
    SpreadsheetApp.flush();
  } catch (err) { console.error("payout history write failed:", err); }
  // алерты в группу MEXC на переходах через порог (по худшему направлению)
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

// Монитор payout: повесить time-триггер на 1 минуту (или 5).
// Его роль - алерты и история в паузах между сигналами; свежесть
// на самих решениях обеспечивает дожим в getMexcPayout_ (Фаза 0).
// Если PAYOUT_URL пуст - тихо выходит (ручной режим).
function mexcPayoutMonitor() {
  if (!CONFIG.MEXC.ENABLED) return;
  if (!CONFIG.MEXC.PAYOUT_URL) { console.log("mexcPayoutMonitor: PAYOUT_URL пуст - ручной режим"); return; }
  let val = {};
  try { val = JSON.parse(PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.PAYOUT_PROP) || "{}"); }
  catch (e) {}
  refreshPayoutIfStale_(val);
}

// Один запрос к event_contract/detail →
//   {"ETH@10":{up,down}, "ETH@30":{...}, "BTC@10":..., "BTC@30":...}.
// Структуру ответа не завязываем на точную обёртку: ищем в дереве
// узел с symbol=="ETH_USDT", в нём - массив TIME_UNIT ("MINUTE"),
// в массиве - элементы с val из TIMINGS. Так парсер переживёт
// перестановки полей в ответе MEXC.
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
  for (const asset of ["ETH", "BTC"]) {
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

// DFS: первый узел дерева, у которого node.symbol === symbol.
function findNodeWithSymbol_(node, symbol) {
  if (node == null || typeof node !== "object") return null;
  if (node.symbol === symbol) return node;
  for (const k in node) {
    const r = findNodeWithSymbol_(node[k], symbol);
    if (r) return r;
  }
  return null;
}

// DFS: первый массив под ключом unit ("MINUTE"/"HOUR"/"DAY") в поддереве.
function findUnitArray_(node, unit) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node[unit])) return node[unit];
  for (const k in node) {
    const r = findUnitArray_(node[k], unit);
    if (r) return r;
  }
  return null;
}

// Диагностика источника: запустить руками, смотрит сырой ответ.
// Если в логе HTTP 403/лом - endpoint закрыт для серверов, остаёмся
// на ручном вводе или мосте из браузера.
function mexcPayoutProbe() {
  const got = fetchEventPayouts_();
  console.log("mexcPayoutProbe:", JSON.stringify(got));
}

// ─── WEBHOOK HANDLER ─────────────────────────────────────────
function doPost(e) {
  // Время ПОСТУПЛЕНИЯ сигнала (UTC, до миллисекунд) - фиксируем в самом
  // начале, до парсинга/лока/IO, чтобы отражало реальный момент прихода.
  const receivedAt = new Date().toISOString();   // "2026-07-21T05:30:07.123Z"
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
  data.receivedAt = receivedAt;   // доступно в партнёрском и MEXC хуках

  // ── Фаза 0: карантинный список (при BADLIST.ENABLED=false - мгновенно) ──
  const badlist = loadBadlist_();
  const mexcOn = CONFIG.MEXC.ENABLED;
  // Сигналы с таймингом-эксклюзивом (30 мин) минуют основную ветку
  const mexcOnly = mexcOn &&
    CONFIG.MEXC.MEXC_ONLY_TIMINGS.indexOf(mexcTiming_(data)) >= 0;

  // ══ ОСНОВНАЯ ВЕТКА (v3.9.3): решение → НЕМЕДЛЕННАЯ доставка ══
  // PRO-группа и партнёр получают сигнал сразу после фильтров, НЕ
  // дожидаясь payout MEXC, ветки MEXC и записей в листы. Заблокированный
  // сигнал так же немедленно уходит в ALT-канал (если включён).
  // Лок короткий и только вокруг решения (чтение/запись стейта).
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
      // 10m → партнёр (тег "10m"), как было
      try { partnerOK = postPartner_(data, "10m").indexOf("error") < 0; }
      catch (e2) { partnerOK = false; console.error("Partner fail:", e2); }
      // ...и тот же сигнал - исполнителю на Toobit. Отдельным хуком, а
      // не потоком партнёра: у исполнителя свой URL и свой секрет.
      try { toobitNote = sendToobitWebhook_(data); }
      catch (e2) { toobitNote = "error"; console.error("Toobit fail:", e2); }
    } else {
      // Ветка ALT10m: заблокированные основной веткой сигналы проходят
      // свой фильтр; прошедшие → ТГ-группа ALT10m + партнёр (тег ALT10m).
      // altMarker пишется в колонку ALT10m листа BLOCKEDsignal.
      try { const r = handleAlt10m_(data); altNote = r.note; altMarker = r.marker; }
      catch (e3) { altNote = "error"; console.error("ALT10m fail:", e3); }
    }
  }

  // ══ ВЕТКА MEXC: payout (сеть, только если устарел) → решение → доставка ══
  // Свой стейт и свой короткий лок; основная ветка уже доставлена.
  let decisionMexc = null, mexcDelivery = null;
  if (mexcOn) {
    const mexcPayout = getMexcPayout_();
    if (lock.tryLock(25000)) {
      try {
        decisionMexc = decideSignal_(data, badlist,
          { stateKey: CONFIG.MEXC.STATE_KEY, payout: mexcPayout });
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
  // Сбой листов больше не задерживает и не блокирует сигналы.
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

  // Эксклюзив MEXC: ответ только по ветке MEXC
  if (mexcOnly) {
    if (!decisionMexc) return buildResponse("error", "MEXC-only сигнал, но ветка MEXC не решила" + mexcNote);
    return buildResponse(decisionMexc.status,
      "MEXC-only (timing " + mexcTiming_(data) + ")" + mexcNote);
  }
  if (decision.status === "sent")
    return buildResponse("sent", decision.message + " (tg:" + tgOK + ", sheet:" + sheetOK
      + ", partner:" + partnerOK + ", toobit:" + toobitNote + ")" + mexcNote);
  return buildResponse("blocked", decision.message + " (sheet:" + sheetOK + ", alt:" + altNote + ")" + mexcNote);
}

// ─── Партнёрский хук: один URL, тег в поле "timing" (v3.9.4) ──
// Возвращает заметку для лога: "off" / "off:<tag>" / "http NNN".
// Гейт: мастер PARTNER_WEBHOOK_ENABLED + PARTNER_STREAMS[tag].
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
    timing:     tag,                       // "10m"/"ALT10m"/"MEXC_10m"/"MEXC_30m"
    receivedAt: data.receivedAt || new Date().toISOString(),
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

// ─── Ветка ALT10m: решение + доставка (v3.9.4) ───────────────
// Возвращает { note, marker }: note - для лога, marker - "ALT10m"
// или "" (что писать в колонку ALT10m листа BLOCKEDsignal).
function handleAlt10m_(data) {
  if (!CONFIG.ALT10M.ENABLED) return { note: "off", marker: "" };
  // решение под своим локом (свой стейт, без сетевого IO)
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

  // прошёл фильтр ALT10m → доставка
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

// Лёгкое решение ветки ALT10m: только окно + лимит одинаковой цены,
// по своим лимитам (CONFIG.ALT10M). Без time-фильтров/карантина/капа.
function decideAlt_(data) {
  const cfg = CONFIG.ALT10M;
  const now = data.bartime ? new Date(data.bartime) : new Date();
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(cfg.STATE_KEY);
  let state = raw ? JSON.parse(raw) : { sent: [] };
  if (!state.sent) state.sent = [];
  const windowMs = cfg.WINDOW_MINUTES * 60 * 1000;
  state.sent = state.sent.filter(s => now.getTime() - s.t < windowMs);

  const asset = (data.ticker || "").indexOf("BTC") >= 0 ? "BTC" : "ETH";
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

// ─── MEXC: доставка (v3.9.3, БЕЗ листов - они пишутся позже) ──
// Телеграм в группу MEXC + MEXC-хук. Возвращает объект с метками для
// последующего логирования (mexcLogSheet_).
function mexcDeliver_(data, decisionMexc, payout) {
  // то же время, что и в decideSignal_ - payout в строке лога
  // соответствует значению, по которому принималось решение
  const nowMs = (data.bartime ? new Date(data.bartime) : new Date()).getTime();
  const asset = (data.ticker || "").indexOf("BTC") >= 0 ? "BTC" : "ETH";
  const dirUp = String(data.direction || "").toUpperCase();
  const dir = (dirUp === "UP" || dirUp === "BUY") ? "UP" :
              ((dirUp === "DOWN" || dirUp === "SELL") ? "DOWN" : "?");
  const timing = mexcTiming_(data);
  const tLabel = mexcTimingLabel_(timing);   // "MEXC _10m" / "MEXC _30m"
  const pv = mexcPayoutFor_(payout, asset, nowMs, dir, timing);
  const out = { tLabel: tLabel, pvCell: (pv.known ? pv.value : ""), tgOK: true, hookNote: "off", partnerNote: "off" };
  if (decisionMexc.status !== "sent") return out;

  // Короткий формат для группы MEXC: шапка (тайминг + актив +
  // направление) и цена - без полного текста сигнала.
  // 10м и 30м различаются эмодзи (TIMING_EMOJI).
  const arrow = dir === "UP" ? "📈" : (dir === "DOWN" ? "📉" : "");
  const emoji = CONFIG.MEXC.TIMING_EMOJI[timing] || "⏱";
  const header = emoji + " <b>" + timing + " MIN | " + asset + " " + dir + "</b> " + arrow;
  const mexcText = header + "\n💰 Price: " + (data.price || "-");
  try { sendTelegram({ text: mexcText }, getProp_(CONFIG.MEXC.CHAT_ID_PROP)); }
  catch (e2) { out.tgOK = false; console.error("MEXC TG fail:", e2); }
  // MEXC-хук (отдельный получатель/исполнитель); сбой не мешает потоку
  try { out.hookNote = sendMexcWebhook_(data, tLabel, pv.known ? pv.value : null); }
  catch (eX) { out.hookNote = "error"; console.error("MEXC hook fail:", eX); }
  // Партнёрский хук с тегом MEXC_10m / MEXC_30m (по умолчанию выключен)
  try { out.partnerNote = postPartner_(data, "MEXC_" + timing + "m"); }
  catch (eP) { out.partnerNote = "error"; console.error("MEXC partner fail:", eP); }
  return out;
}

// ─── MEXC: логирование в листы (после всех доставок) ─────────
function mexcLogSheet_(ss, data, decisionMexc, d) {
  if (decisionMexc.status === "sent") {
    const sheet = getOrCreateSheet_(ss, CONFIG.MEXC.SHEET_NAME, HDR_MEXC);
    const okW = appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      data.direction1 || "", data.direction2 || "", d.pvCell, d.tLabel
    ]);
    return "sent: " + decisionMexc.message + " (tg:" + d.tgOK + ", sheet:" + okW + ", hook:" + d.hookNote + ", partner:" + d.partnerNote + ")";
  } else {
    const sheet = getOrCreateSheet_(ss, CONFIG.MEXC.BLOCKED_SHEET_NAME, HDR_MEXC_BLOCK);
    const okB = appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "",
      decisionMexc.message, d.pvCell, d.tLabel
    ]);
    return "blocked: " + decisionMexc.message + " (sheet:" + okB + ")";
  }
}

// ─── РЕШЕНИЕ (под локом, без сетевого IO) ───────────────────
// branch (v3.9, необязателен) - параметры ветки:
//   { stateKey: "signal_state_mexc_v1", payout: {ETH:{p,t},BTC:{p,t}} }
// Без branch работает основная ветка (stateKey "signal_state_v2",
// payout-фильтра нет). Каждая ветка копит СВОЙ список принятых:
// лимиты F4/F5/F8 и конфликт FC считаются только по своим сигналам.
function decideSignal_(data, badlist, branch) {
  const stateKey = (branch && branch.stateKey) || "signal_state_v2";
  const now = data.bartime ? new Date(data.bartime) : new Date();
  const props = PropertiesService.getScriptProperties();

  const stateRaw = props.getProperty(stateKey);
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
    props.setProperty(stateKey, JSON.stringify(state));
    return { status: "blocked", message: msg };
  };

  // FM (v3.9, только ветка MEXC): блок при payout ниже порога.
  // Заблокированный здесь сигнал НЕ попадает в стейт ветки, поэтому
  // не съедает её лимиты - после возврата payout к порогу ветка
  // принимает сигналы так, будто паузы не было.
  if (branch && branch.payout !== undefined) {
    const timing = mexcTiming_(data);
    const pv = mexcPayoutFor_(branch.payout, asset, now.getTime(), dir, timing);
    if (pv.known) {
      if (pv.value < CONFIG.MEXC.MIN_PAYOUT)
        return blocked("FM: MEXC payout " + asset + " " + timing + "м " + pv.value + "% < " + CONFIG.MEXC.MIN_PAYOUT + "%");
    } else if (!CONFIG.MEXC.FAIL_OPEN) {
      return blocked("FM: payout " + asset + " неизвестен (монитор молчит), FAIL_OPEN=false");
    }
    // payout неизвестен + FAIL_OPEN=true → фильтр тихо пропускается
  }

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
  props.setProperty(stateKey, JSON.stringify(state));
  const cntAsset = sameAssetWin.length + 1;
  return { status: "sent", message: "Signal " + asset + " #" + cntAsset + " (price: " + price + ")" };
}

function pad_(n) { return (n < 10 ? "0" : "") + n; }

// ─── TELEGRAM ────────────────────────────────────────────────
// chatIdOpt (v3.9): необязательный chat_id - для группы MEXC.
// tokenOpt (v3.9.3): необязательный токен другого бота - для ALT-ветки.
// Без них шлём основным ботом в основную группу, как раньше.
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

const HDR_ALL    = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Direction1","Direction2"];
const HDR_BLOCK  = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Reason","Direction1","ALT10m"];
const HDR_FAILED = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Context"];
const HDR_MEXC       = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Direction1","Direction2","Payout","Timing"];
const HDR_MEXC_BLOCK = ["Time","Ticker","Direction","Price","Volume","Text","Settings","Reason","Payout","Timing"];
const HDR_PAYOUT     = ["Time","Asset","Payout","Source"];

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

function logBlocked_(ss, data, reason, altMarker) {
  try {
    const sheet = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
    return appendRowSafe_(sheet, [
      new Date(), data.ticker || "", data.direction || "", data.price || "",
      data.volume || "", data.text || "", data.Settings || "", reason,
      data.direction1 || "", altMarker || ""    // колонка ALT10m: "ALT10m" если ушёл в ветку
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
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty("signal_state_v2");
  p.deleteProperty(CONFIG.MEXC.STATE_KEY);
  p.deleteProperty(CONFIG.ALT10M.STATE_KEY);
  console.log("State reset OK (основная, MEXC, ALT10m)");
}

// ─── САМОПРОВЕРКА (запусти руками один раз после деплоя) ─────
function selfTest() {
  const ss = SpreadsheetApp.openById(getProp_("SPREADSHEET_ID"));
  const a = getOrCreateSheet_(ss, CONFIG.SHEET_NAME, HDR_ALL);
  const b = getOrCreateSheet_(ss, CONFIG.BLOCKED_SHEET_NAME, HDR_BLOCK);
  const f = getOrCreateSheet_(ss, CONFIG.FAILED_SHEET_NAME, HDR_FAILED);
  if (CONFIG.MEXC.ENABLED) {
    getOrCreateSheet_(ss, CONFIG.MEXC.SHEET_NAME, HDR_MEXC);
    getOrCreateSheet_(ss, CONFIG.MEXC.BLOCKED_SHEET_NAME, HDR_MEXC_BLOCK);
    getOrCreateSheet_(ss, CONFIG.MEXC.PAYOUT_SHEET_NAME, HDR_PAYOUT);
    const chatOk = !!PropertiesService.getScriptProperties().getProperty(CONFIG.MEXC.CHAT_ID_PROP);
    const po = getMexcPayout_();
    console.log("MEXC: ветка ON | chat_id задан:", chatOk,
      "| payout:", JSON.stringify(po),
      "| порог:", CONFIG.MEXC.MIN_PAYOUT + "%",
      "| источник:", CONFIG.MEXC.PAYOUT_URL ? ("URL-монитор (" + CONFIG.MEXC.TIME_UNIT + " " + CONFIG.MEXC.TIMINGS.join("/") + ")") : "ручной (setMexcPayoutManual)",
      "| MEXC-хук:", CONFIG.MEXC.WEBHOOK_ENABLED ? (CONFIG.MEXC.WEBHOOK_URL || "URL НЕ ЗАДАН") : "DISABLED",
      "| FAIL_OPEN:", CONFIG.MEXC.FAIL_OPEN);
  } else {
    console.log("MEXC: ветка DISABLED");
  }
  console.log("Toobit-хук:", CONFIG.TOOBIT.ENABLED
    ? (CONFIG.TOOBIT.WEBHOOK_URL || "URL НЕ ЗАДАН") : "DISABLED");
  const props = PropertiesService.getScriptProperties();
  console.log("Партнёрские потоки:",
    "мастер:", CONFIG.PARTNER_WEBHOOK_ENABLED,
    "| потоки:", JSON.stringify(CONFIG.PARTNER_STREAMS));
  console.log("ALT10m:", CONFIG.ALT10M.ENABLED
    ? ("ON | окно " + CONFIG.ALT10M.WINDOW_MINUTES + "мин, ETH " + CONFIG.ALT10M.LIMITS.ETH.MAX_SIGNALS_PER_WINDOW +
       "/BTC " + CONFIG.ALT10M.LIMITS.BTC.MAX_SIGNALS_PER_WINDOW + ", одинаковых ≤" + CONFIG.ALT10M.LIMITS.ETH.MAX_SAME_PRICE +
       " | ТГ-группа: " + !!props.getProperty(CONFIG.ALT10M.CHAT_ID_PROP) +
       " | партнёр: " + (CONFIG.PARTNER_STREAMS["ALT10m"] ? "ON" : "off"))
    : "DISABLED");
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
