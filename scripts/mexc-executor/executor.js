#!/usr/bin/env node
/*
 * MEXC Executor - автоторговля сигналов "MEXC _10m" кликами в браузере.
 *
 * Принимает POST /signal от вебхука (Apps Script, CONFIG.MEXC.EXECUTOR)
 * и ставит ставку Up/Down на странице Event Futures MEXC через
 * Playwright с постоянным залогиненным профилем Chrome.
 *
 * У Event Futures НЕТ официального API - это автоматизация интерфейса
 * твоего собственного аккаунта. Используй осознанно: возможен риск по
 * ToS биржи, начинай с dryRun и минимальной ставки.
 *
 * Запуск:
 *   node executor.js login    - разовый вход в аккаунт (откроется окно)
 *   node executor.js          - боевой/dry-run сервер (см. config.json)
 *
 * Безопасность по умолчанию: dryRun=true (все действия, кроме
 * финального клика), лимит ставок в день, авто-переход в dryRun после
 * подряд идущих ошибок, скриншот каждого действия в logs/shots/.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, 'config.json');
if (!fs.existsSync(CFG_PATH)) {
  console.error('Нет config.json - скопируй config.example.json в config.json и заполни.');
  process.exit(1);
}
// .replace() снимает BOM: блокнот и PowerShell (Set-Content -Encoding UTF8
// в версии 5.1) пишут UTF-8 с меткой в начале файла, а JSON.parse на ней
// падает с "Unexpected token" - причём в сообщении метка невидима.
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const PROFILE = path.join(ROOT, 'profile');           // куки/логин живут тут
const LOGS = path.join(ROOT, 'logs');
const SHOTS = path.join(LOGS, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let playwright;
try { playwright = require('playwright'); }
catch (e) {
  // migrate и add-asset только переписывают config.json - браузер им не
  // нужен, и требовать установку Playwright ради правки файла незачем.
  if (!['migrate', 'add-asset'].includes(process.argv[2])) {
    console.error('Playwright не установлен. В папке mexc-executor выполни:\n  npm install playwright && npx playwright install chromium');
    process.exit(1);
  }
}

// ── биржи ──
// Сначала исполнитель умел одну биржу, и её описание лежало в конфиге
// плоскими ключами: urls, selectors, timeUnitText. Теперь бирж может
// быть несколько (MEXC и Toobit), но старый плоский вид продолжает
// работать: он превращается в единственную биржу с именем
// defaultExchange. Всё, что не задано у биржи, наследуется от верхнего
// уровня - так добавление второй биржи не требует дублировать общее.
if (!CFG.exchanges || !Object.keys(CFG.exchanges).length) {
  CFG.exchanges = { [CFG.defaultExchange || 'mexc']: {} };
}
const EX_CACHE = new Map();
function exNames() {
  return Object.keys(CFG.exchanges).filter(n => CFG.exchanges[n].enabled !== false);
}
function defaultEx() {
  const names = exNames();
  const d = CFG.defaultExchange;
  return (d && names.includes(d)) ? d : (names[0] || 'mexc');
}
function exCfg(name) {
  const key = name || defaultEx();
  if (EX_CACHE.has(key)) return EX_CACHE.get(key);
  const e = CFG.exchanges[key] || {};
  const v = {
    name: key,
    title: e.title || key.toUpperCase(),
    urls: e.urls || CFG.urls || {},
    // Селекторы сливаем, а не заменяем: у второй биржи обычно отличаются
    // один-два, а не весь набор.
    selectors: { ...(CFG.selectors || {}), ...(e.selectors || {}) },
    timeUnitText: e.timeUnitText || CFG.timeUnitText || { 10: '10m', 30: '30m' },
    // Надпись рядом со строкой чипов экспирации. Нужна, когда такие же
    // подписи есть в другом месте страницы - у Toobit «5m» и «30m» есть
    // ещё и в интервалах графика.
    timeUnitAnchor: e.timeUnitAnchor || CFG.timeUnitAnchor || '',
    marketClosedText: e.marketClosedText || CFG.marketClosedText || 'Market Closed',
    openPositionsLabel: e.openPositionsLabel || CFG.openPositionsLabel || 'Open Positions',
    // Порог выплаты у каждой биржи свой. minPayoutStrict - когда нужно
    // именно БОЛЬШЕ порога, а не «не меньше».
    minPayout: e.minPayout ?? CFG.minPayout ?? 80,
    minPayoutStrict: e.minPayoutStrict === true,
    // Главное отличие Toobit: сигналы приходят без выплаты, и проверить
    // её можно только на странице. Не прочитали - не ставим.
    requirePagePayout: e.requirePagePayout === true,
    // Читать ли выплату со страницы вообще. Когда источник сигналов уже
    // отобрал их по проценту возврата, второе чтение только тратит
    // секунды на десятиминутной свече. Выключается в панели.
    checkPayout: e.checkPayout !== false,
    // ?? вместо ||: пустая строка здесь ЗНАЧАЩАЯ - она выключает поиск
    // по слову направления. С || она подменялась значением по умолчанию,
    // и выключить путь было нечем.
    payoutRe: e.payoutRe ?? CFG.payoutRe ?? '{DIR}\\s*Payout\\s*([0-9.]+)\\s*%',
    // Третий путь к выплате: на странице может не быть слов Up/Down
    // вовсе (у Toobit до входа там две кнопки «Log in»), зато выплаты
    // идут двумя одинаковыми блоками сверху вниз. re собирает их все по
    // порядку, order говорит, какой чей. Порядок задаётся явно - гадать
    // о том, где чья выплата, нельзя.
    payoutList: e.payoutList || CFG.payoutList || null,
    dirWords: e.dirWords || CFG.dirWords || { UP: 'Up', DOWN: 'Down' },
    stakes: e.stakes || CFG.stakes || {},
    stakeLimits: e.stakeLimits || CFG.stakeLimits || {},
    // Лимит одновременных ставок держит БИРЖА, поэтому он у каждой свой.
    maxOpenBets: e.maxOpenBets ?? CFG.maxOpenBets ?? 5,
    // Ставить, не убедившись в выбранной экспирации, нельзя: ставка
    // уйдёт на чужие минуты и с чужой выплатой. false - только если
    // разметку иначе не прочитать и риск осознан.
    requireTimeframeCheck: e.requireTimeframeCheck !== false,
    // Какие времена экспирации биржа вообще отрабатывает. На Toobit идут только
    // 10-минутные сигналы PRO-ветки, и 30-минутка, попавшая туда по
    // ошибке маршрутизации, должна отбиться, а не открыться.
    execTimings: e.execTimings || CFG.execTimings || [10],
    // Отдельные активы бывают уже общего списка: акции MU и NVIDIA у
    // MEXC играются только тридцатиминутками, десятиминутного события по
    // ним просто нет. Правило по активу точнее общего, поэтому оно его и
    // заменяет - тем же порядком, каким список биржи заменяет верхний.
    assetTimings: { ...(CFG.assetTimings || {}), ...(e.assetTimings || {}) },
    // Метки потока в поле "timing" сигнала. Источник шлёт разные потоки
    // разными метками: PRO-ветка - "10m", ветка MEXC - "MEXC _10m" и
    // "MEXC _30m", ветка ALT - "ALT10m". По ним и различаем, куда
    // ставить, без отдельного поля в сигнале. Сравнение ТОЧНОЕ: "10m"
    // это подстрока и "ALT10m", и "MEXC_10m", и по вхождению PRO-поток
    // забрал бы чужие сигналы.
    signalTimings: (e.signalTimings || []).map(t => String(t).toLowerCase().trim()),
    // Проверка цены входа. Между сигналом и нажатием проходит от десяти
    // секунд до минуты, и за это время цена успевает откатиться - вход
    // получается хуже того, на который сигнал рассчитан.
    priceGuard: { ...(CFG.priceGuard || {}), ...(e.priceGuard || {}) },
    // Где на странице искать текущую цену. Пусто - ищем сами:
    // в заголовке вкладки, потом самым крупным числом в шапке.
    priceSelector: e.priceSelector ?? CFG.priceSelector ?? '',
    // На сколько процентов сумма ставки гуляет вокруг настроенной.
    stakeJitterPct: e.stakeJitterPct ?? CFG.stakeJitterPct ?? 0,
    // Откуда брать дневной итог: 'dialog' - сводное окно биржи (MEXC),
    // 'positions' - складываем сами по списку закрытых позиций (Toobit,
    // где сводного окна нет).
    pnlSource: e.pnlSource || CFG.pnlSource || 'dialog',
    // Как актив называется НА БИРЖЕ, если это не то же, что ключ в urls.
    // У MEXC акции подписаны иначе: ключ SPCX, а символ SPCXSTOCK_USDT.
    // Без этой пары проверка актива искала бы в заголовке «SPCX_USDT» и
    // не находила ничего - то есть ставка отбивалась бы даже на верной
    // странице.
    symbols: { ...(CFG.symbols || {}), ...(e.symbols || {}) },
    // Пробуждение вне смены: сигнал приходит в тихие часы, а биржа
    // всё равно открывается и ставка играется по обычным правилам.
    wakeOnSignal: { ...(CFG.wakeOnSignal || {}), ...(e.wakeOnSignal || {}) },
    // Подписи интервалов ГРАФИКА (не экспирации) и надпись рядом с ними.
    // Пусто - холостое действие ограничится курсором и колесом.
    chartIntervals: e.chartIntervals || CFG.chartIntervals || [],
    chartAnchor: e.chartAnchor ?? CFG.chartAnchor ?? '',
  };
  EX_CACHE.set(key, v);
  return v;
}
function exReset() { EX_CACHE.clear(); }
// Биржа, на которой сейчас идёт работа со страницей. Ставки исполняются
// строго по одной, поэтому одной переменной достаточно.
let EX = null;
function curEx() { return EX || exCfg(defaultEx()); }
// Все активы всех бирж - для нормализации сигнала и подсказок панели.
function exOfAsset(asset) {
  return exNames().filter(n => (exCfg(n).urls || {})[asset]);
}

// ── состояние ──
const state = {
  dryRun: CFG.dryRun !== false,       // по умолчанию dry-run!
  betsToday: 0,
  day: new Date().toDateString(),
  consecutiveErrors: 0,
  queue: [],
  busy: false,
  recent: [],                          // дедуп повторных доставок
  placed: [],                          // времена размещённых ставок (кап слотов)
  paused: false,
  startedAt: Date.now(),
  lastIdle: null,                      // последнее холостое действие
  lastSignalAt: null,                  // когда пришёл последний сигнал
  sheetRows: null,                     // сколько строк листа уже обработано
  sheetPolledAt: null,
  sheetError: null,
  silenceAlerted: false,               // алерт о тишине уже отправлен
  windowManual: false,                 // окно открыто руками из панели
  windowAt: null,                      // когда окно открылось/закрылось само
  wakes: [],                           // времена пробуждений биржи вне смены
  pnlDone: {},                         // по биржам: за какую минуту сводка уже собрана
};

// ── состояние на диске ──
// Слоты и дневной счётчик обязаны переживать перезапуск: биржа держит
// максимум 5 одновременных ставок, а исполнитель после рестарта считал
// бы, что открыто ноль, и мог открыть шестую.
// Минимум биржи по сумме ставки. Максимум у каждого актива свой и лежит
// в stakeLimits, а нижняя граница общая.
const MANUAL_STAKE_MIN = 5;
const STATE_PATH = path.join(ROOT, 'state.json');
const PERSIST = ['betsToday', 'day', 'placed', 'lastSignalAt', 'sheetRows', 'wakes', 'pnlDone'];
function saveState() {
  try {
    const o = {};
    for (const k of PERSIST) o[k] = state[k];
    fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(o));
    fs.renameSync(STATE_PATH + '.tmp', STATE_PATH);
  } catch (e) { log('состояние не сохранилось: ' + e.message); }
}
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const o = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    // Данные вчерашнего дня не тащим: счётчики дня начинаются заново.
    const sameDay = o.day === new Date().toDateString();
    for (const k of PERSIST) if (o[k] !== undefined) state[k] = o[k];
    if (!sameDay) {
      state.day = new Date().toDateString();
      state.betsToday = 0;
      state.wakes = [];
    }
    if (!Array.isArray(state.placed)) state.placed = [];
    if (!Array.isArray(state.wakes)) state.wakes = [];
    log(`состояние восстановлено: ставок сегодня ${state.betsToday}, слотов ${openSlots()}`);
  } catch (e) { log('состояние не прочиталось: ' + e.message); }
}

// ── мелочи для «человечности» ──
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ставка зависит от актива: на MEXC это ETH 150 / BTC 250.
// Старый плоский stakeUSDT продолжает работать как запасной вариант.
// Какие экспирации разрешены этому активу. Список актива только СУЖАЕТ
// общий, а не заменяет его: галочки экспираций в панели - выключатель, и
// он обязан выключать. Иначе снятая галочка «30 минут» останавливала бы
// BTC с ETH, а акции продолжали бы торговаться молча.
function timingsFor(asset, ex) {
  const E = exCfg(ex);
  const all = (E.execTimings || []).map(Number);
  const own = (E.assetTimings || {})[asset];
  if (!Array.isArray(own) || !own.length) return all;
  return all.filter(t => own.map(Number).includes(t));
}
function stakeFor(asset, ex) {
  const t = exCfg(ex).stakes || {};
  return t[asset] != null ? t[asset] : (CFG.stakeUSDT ?? 5);
}
// Потолок ставки по активу: у поля ввода на бирже свой лимит
// (на ETH видно "1～150 USDT"), и панель не должна давать выйти за него.
function stakeMax(asset, ex) {
  const l = exCfg(ex).stakeLimits || {};
  return l[asset] != null ? l[asset] : 150;
}

// Биржа держит не больше 5 ставок одновременно. Слот занят до экспирации
// САМОЙ ставки плюс запас: фиксированное окно годилось, пока все ставки
// были десятиминутными, а с 30-минутными оно освобождало слот в учёте
// на двадцать минут раньше, чем на бирже - и шестая ставка ушла бы в
// отказ. Запас нужен потому, что расчёт на бирже происходит не мгновенно.
function slotUntil(p) {
  return p.t + (p.timing ?? 10) * 60000 + (CFG.slotMarginMin ?? 1) * 60000;
}
function prunePlaced() {
  const now = Date.now();
  state.placed = state.placed.filter(p => now < slotUntil(p));
  return state.placed;
}
// Слоты считаем ПО БИРЖЕ: пятёрка одновременных ставок - ограничение
// самой биржи, и открытые на MEXC позиции не занимают места на Toobit.
function openSlots(ex) {
  const all = prunePlaced();
  return ex ? all.filter(p => (p.ex || defaultEx()) === ex).length : all.length;
}
// Лимит направления считается ПО АКТИВУ: «подряд идущие сигналы одной
// стороны - обычно один заход» верно внутри одного инструмента, а ETH UP
// и BTC UP это два разных захода, и делить лимит им незачем.
function dirSlots(dir, asset, ex) {
  return prunePlaced().filter(p => p.dir === dir
    && (!asset || p.asset === asset)
    && (!ex || (p.ex || defaultEx()) === ex)).length;
}
function dirLimit(dir) {
  const d = CFG.dirLimits || {};
  const v = d[dir];
  return (typeof v === 'number' && v > 0) ? v : (CFG.maxOpenBets ?? 5);
}

// ── расписание активности ──
// Круглосуточная торговля без единого перерыва - самый заметный признак
// машины. Расписание задаётся недельной сеткой 7x24: строка на день
// недели, символ на час ('1' - работаем, '0' - спим). Вне активных
// часов сигналы отклоняются со статусом skip-quiet.
const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// Пустое/битое расписание = работаем всегда. Молча чинить длину строк
// важнее, чем падать: конфиг правится руками.
//
// Сетка у каждой биржи своя: смысл в том, чтобы пока работает одна,
// вторая молчала, и они менялись сменами. Общий выключатель один -
// schedule.enabled; у биржи без своей сетки берётся общая.
function gridOf(rows) {
  if (!Array.isArray(rows) || rows.length !== 7) return null;
  return rows.map(r => String(r || '').padEnd(24, '0').slice(0, 24));
}
function scheduleGrid(ex) {
  const S = CFG.schedule || {};
  if (!S.enabled) return null;
  const own = ex ? gridOf(((CFG.exchanges[ex] || {}).schedule || {}).hours) : null;
  return own || gridOf(S.hours);
}
function activeAt(grid, day, hour) {
  return grid[((day % 7) + 7) % 7][((hour % 24) + 24) % 24] === '1';
}
// Сдвиг края блока, детерминированный ОТ ДАТЫ И ЧАСА, а не случайный при
// каждой проверке: иначе сигнал, пришедший ровно на границе, то проходил
// бы, то нет. Ровное «каждый день с 08:00» - такой же машинный след,
// как и работа 24/7, поэтому края блоков слегка гуляют.
function edgeJitter(tag, spanMin) {
  if (!spanMin) return 0;
  const n = new Date();
  const s = `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}|${tag}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % (Math.min(spanMin, 59) + 1);
}
function inActiveHours(when, ex) {
  const grid = scheduleGrid(ex);
  if (!grid) return true;                    // расписание выключено
  const n = when || new Date();
  const day = n.getDay(), hour = n.getHours(), min = n.getMinutes();
  if (!activeAt(grid, day, hour)) return false;

  const jit = CFG.schedule.jitterMin ?? 0;
  if (!jit) return true;
  // Начало блока: просыпаемся не ровно в :00, а на несколько минут позже
  // Имя биржи входит в подпись: иначе обе смены начинались бы на одной и
  // той же минуте, и пересменка выглядела бы как переключение рубильника.
  const who = ex || defaultEx();
  const prevActive = hour === 0 ? activeAt(grid, day - 1, 23) : activeAt(grid, day, hour - 1);
  if (!prevActive && min < edgeJitter(`s${who}${day}-${hour}`, jit)) return false;
  // Конец блока: заканчиваем чуть раньше :00
  const nextActive = hour === 23 ? activeAt(grid, day + 1, 0) : activeAt(grid, day, hour + 1);
  if (!nextActive && min >= 60 - edgeJitter(`e${who}${day}-${hour}`, jit)) return false;
  return true;
}
// Работает ли ХОТЬ ОДНА биржа прямо сейчас. По этому вопросу решаются
// общие дела: держать ли окно браузера, ходить ли холостыми действиями,
// считать ли молчание сигналов подозрительным.
function anyActive(when) {
  return exNames().some(n => inActiveHours(when, n));
}
// Биржи, активные прямо сейчас.
function activeExchanges(when) {
  return exNames().filter(n => inActiveHours(when, n));
}
// Человекочитаемое расписание на сегодня - для панели и лога.
function todayWindows(ex) {
  const grid = scheduleGrid(ex);
  if (!grid) return null;
  const day = new Date().getDay();
  const out = [];
  let start = null;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && activeAt(grid, day, h);
    if (on && start == null) start = h;
    if (!on && start != null) {
      out.push(`${String(start).padStart(2, '0')}:00-${String(h).padStart(2, '0')}:00`);
      start = null;
    }
  }
  // «выходной» без слова «сегодня»: подпись подставляют в готовые фразы,
  // которые это слово уже сказали - выходило «сегодня сегодня выходной».
  return out.length ? out.join(', ') : 'выходной';
}

// Настройки, изменённые с панели, переживают перезапуск: пишем их в тот
// же config.json. Сначала во временный файл, потом переименование -
// иначе прерванная запись оставила бы файл без настроек, и исполнитель
// не поднялся бы. Без BOM: его переживает наш парсер, но не чужие.
function saveConfig() {
  const tmp = CFG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(CFG, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmp, CFG_PATH);
}

function log(line) {
  // Два времени в строке: UTC для сопоставления с логом туннеля и
  // местное - потому что расписание задаётся в местном, и разбирать
  // «попал ли в окно» по одному UTC значит каждый раз считать в уме.
  const n = new Date();
  const msg = `[${n.toISOString()} | ${n.toLocaleTimeString('ru-RU')}] ${line}`;
  console.log(msg);
  fs.appendFileSync(path.join(LOGS, 'executor.log'), msg + '\n');
}
// lag_ms - сколько прошло от прихода сигнала до записи. Без него
// «ставка открылась на 40 секунд позже» приходилось вылавливать из
// текстового лога вручную, а по журналу этого не видно вовсе.
const BETS_HEAD = 'time,exchange,asset,direction,timing,tag,stake,payout_page,mode,status,lag_ms,note';
const BETS_HEAD_V3 = 'time,exchange,asset,direction,timing,stake,payout_page,mode,status,lag_ms,note';
const BETS_HEAD_V2 = 'time,exchange,asset,direction,timing,stake,payout_page,mode,status,note';
const BETS_HEAD_OLD = 'time,asset,direction,timing,stake,payout_page,mode,status,note';
function logBet(rec) {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) fs.writeFileSync(f, BETS_HEAD + '\n');
  // Задержка считается от прихода сигнала, а не от начала ставки: ждать
  // окна сбора пачки и собираться странице - тоже часть опоздания.
  // receivedAt приходит и числом (после acceptSignal), и строкой ISO -
  // отказы записываются раньше, чем поле нормализуют. Вычитание из строки
  // давало NaN прямо в столбце.
  const got = typeof rec.receivedAt === 'number' ? rec.receivedAt : Date.parse(rec.receivedAt);
  const lag = Number.isFinite(got) ? Math.max(0, Date.now() - got) : '';
  // Метку чистим от запятых: она уедет в свой столбец, а не разорвёт строку.
  const tag = String(rec.tag || '').replace(/[,\r\n]/g, ' ').trim();
  fs.appendFileSync(f, [new Date().toISOString(), rec.ex || defaultEx(), rec.asset, rec.direction,
    rec.timing, tag, rec.stake, rec.payoutPage ?? '', rec.mode, rec.status, lag,
    JSON.stringify(rec.note || '')].join(',') + '\n');
}

// Со второй биржей в журнале появился столбец exchange. Дописать его в
// конец было нельзя: заметка обязана оставаться последней, в ней бывают
// запятые. Поэтому старый файл переписываем один раз при старте,
// проставляя всем прежним строкам биржу по умолчанию - иначе история
// ставок читалась бы со сдвигом колонок.
// Журнал переезжал дважды: сначала в нём не было биржи, потом задержки.
// Обе старые формы доводим до нынешней за один проход - иначе панель
// читала бы заметку не из того столбца.
// Журнал переезжал трижды: в нём не было биржи, потом задержки, потом
// метки потока. Разбираем строку по ЕЁ ЖЕ шапке и собираем заново по
// нынешней - тогда любой прошлый формат доходит за один проход, и
// следующий переезд не потребует считать столбцы руками.
const BETS_HEADS_OLD = [BETS_HEAD_OLD, BETS_HEAD_V2, BETS_HEAD_V3];
function migrateBetsCsv() {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  const from = lines[0];
  if (from === BETS_HEAD || !BETS_HEADS_OLD.includes(from)) return;
  const cols = from.split(',');
  const noteAt = cols.length - 1;          // заметка всегда последняя
  const want = BETS_HEAD.split(',');
  const def = defaultEx();
  const out = [BETS_HEAD];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const c = l.split(',');
    const rec = {};
    cols.forEach((h, i) => { rec[h] = c[i]; });
    // В самой заметке запятые бывают: всё, что после её столбца, - тоже она.
    rec.note = c.length > cols.length ? c.slice(noteAt).join(',') : (c[noteAt] ?? '');
    if (!rec.exchange) rec.exchange = def;
    out.push(want.map(h => rec[h] ?? '').join(','));
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const bak = f.replace(/\.csv$/, `.pre-${stamp}.csv`);
  fs.copyFileSync(f, bak);
  fs.writeFileSync(f, out.join('\n') + '\n');
  log(`журнал ставок переведён на новый формат: ${out.length - 1} строк, копия рядом (${path.basename(bak)})`);
}

async function tgAlert(text) {
  if (!CFG.tgToken || !CFG.tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.tgChatId, text: '🤖 Executor: ' + text }),
    });
  } catch (e) { log('tgAlert fail: ' + e.message); }
}

// ── браузер ──
// browserPath - запасной путь к chrome.exe на случай, когда Playwright не
// находит свой браузер сам (ставился под другого пользователя, лежит в
// нестандартном месте). Пусто = пусть ищет как обычно.
// Размер окна выбирается при запуске и держится всю сессию. Ровно
// 1280x860 изо дня в день - такой же отпечаток, как ровная сумма ставки:
// у живого человека окно то развёрнуто, то подтянуто под вторую панель.
const VIEWPORT = { width: randInt(1240, 1440), height: randInt(800, 920) };
function launchOpts(headless) {
  const o = {
    headless,
    viewport: { ...VIEWPORT },
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + 88}`,
      '--disable-blink-features=AutomationControlled',
      // Chrome тормозит таймеры и отрисовку в фоновом окне, а окно у нас
      // фоновое почти всегда. Из-за этого SPA биржи может собираться
      // десятками секунд вместо семи - и ставка не успевает в свои 10 мин.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };
  if (CFG.browserPath) o.executablePath = CFG.browserPath;
  return o;
}

let ctx = null, page = null;
// У КАЖДОЙ биржи своя вкладка. Одна страница на двоих означала, что
// биржи перетягивают её друг у друга: холостое действие уводило её на
// чужой актив и экспирацию, а следующая ставка тратила секунды на
// возврат - и часто не успевала, отсюда «экспирация не переключилась» и
// «страница показывает BTC». Со своей вкладкой каждая биржа сохраняет
// выбранный актив и экспирацию между ставками.
const pages = new Map();
async function browser() {
  if (ctx) return;
  ctx = await playwright.chromium.launchPersistentContext(PROFILE, launchOpts(CFG.headless !== false));
  // Окно могут закрыть крестиком - тогда ctx мёртв, и следующая ставка
  // должна поднять новый, а не биться в закрытый контекст.
  ctx.on('close', () => { ctx = null; page = null; pages.clear(); });
}
// Вкладка биржи: живая - отдаём, нет - заводим. Первую вкладку контекста
// переиспользуем, иначе рядом всегда висела бы пустая.
async function pageFor(name) {
  await browser();
  const have = pages.get(name);
  if (have && !have.isClosed()) return have;
  const taken = new Set([...pages.values()]);
  const free = ctx.pages().find(p => !p.isClosed() && !taken.has(p));
  const p = free || await ctx.newPage();
  watchNav(p);
  pages.set(name, p);
  return p;
}
// Счётчик переходов вкладки. Нужен памяти об экспирации: любой переход -
// это новая сборка приложения, и всё, что мы знали о выбранных чипах,
// перестаёт быть правдой.
const navEpoch = new WeakMap();
function watchNav(p) {
  if (navEpoch.has(p)) return;
  navEpoch.set(p, 1);
  p.on('framenavigated', f => {
    if (f === p.mainFrame()) navEpoch.set(p, (navEpoch.get(p) || 0) + 1);
  });
}
function pageNav(p) { return p ? (navEpoch.get(p) || 0) : 0; }
function openExchanges() {
  return [...pages.entries()].filter(([, p]) => p && !p.isClosed()).map(([n]) => n);
}
async function closePageOf(name) {
  const p = pages.get(name);
  pages.delete(name);
  if (p && !p.isClosed()) await p.close().catch(() => {});
  if (page === p) page = null;
}
async function closeBrowser() {
  if (!ctx) return;
  const c = ctx;
  ctx = null; page = null; pages.clear();
  await c.close().catch(() => {});
}
function browserOpen() { return !!ctx && openExchanges().length > 0; }

// ── клик «как человек» ──
// Playwright по умолчанию бьёт точно в геометрический центр элемента и
// без задержки между нажатием и отпусканием. Сотня ставок подряд с
// пиксель-в-пиксель одинаковыми координатами - готовая сигнатура.
// Целимся в случайную точку центральных 60% кнопки: по самому краю
// попадать нельзя, там элемент бывает перекрыт тенью или соседом.
// position/delay задаются самому locator.click, поэтому все проверки
// (виден, включён, не перекрыт, доскроллить) остаются на месте -
// в отличие от ручного page.mouse.click по координатам.
// Текст кнопки направления бывает со значком: на Toobit это «↗ Higher»
// и «↘ Lower». Точное сравнение по слову такую надпись не ловит,
// поэтому в шаблонах разрешаем любые не-буквы вокруг слова.
function wordRe(word) {
  return new RegExp('^[^\\p{L}]*' + word + '[^\\p{L}]*$', 'iu');
}

// Где сейчас курсор. page.mouse своего положения не отдаёт, поэтому
// ведём сами: без этого каждое движение начиналось бы из (0,0).
// Отдельно НА КАЖДУЮ вкладку: у бирж теперь свои страницы, и путь от
// координат чужой вкладки был бы бессмыслицей.
const mouseAt = new WeakMap();

// Подвод курсора к точке по дуге. Прямая из точки в точку - такой же
// машинный след, как и мгновенный «телепорт» в кнопку: у человека
// траектория выгнута, скорость неравномерная (разгон и торможение), а
// рука подрагивает. Квадратичная кривая Безье с контрольной точкой
// сбоку от прямой даёт ровно это, и стоит десяток move-событий.
async function mouseGlide(pg, x, y) {
  const from = mouseAt.get(pg) || { x: x + randInt(-320, 320), y: y + randInt(-220, 220) };
  const dist = Math.hypot(x - from.x, y - from.y) || 1;
  const steps = Math.max(6, Math.min(26, Math.round(dist / 24) + randInt(2, 6)));
  // Нормаль к прямой: вдоль неё отводим контрольную точку. Чем длиннее
  // путь, тем заметнее дуга - как у настоящего движения рукой.
  const nx = -(y - from.y) / dist, ny = (x - from.x) / dist;
  const bend = (Math.random() < 0.5 ? -1 : 1) * Math.min(90, dist * (0.08 + Math.random() * 0.15));
  const cx = (from.x + x) / 2 + nx * bend, cy = (from.y + y) / 2 + ny * bend;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease-in-out
    const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e * e * x;
    const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e * e * y;
    await pg.mouse.move(px + (Math.random() - 0.5) * 1.6, py + (Math.random() - 0.5) * 1.6);
    if (i % 3 === 0) await sleep(randInt(4, 18));
  }
  await pg.mouse.move(x, y);
  mouseAt.set(pg, { x, y });
}

// Подход к элементу: иногда покрутить колесо (человек не попадает в
// кнопку с первого взгляда, он сначала осматривает страницу), затем
// довести элемент до вида и подъехать курсором. Всё необязательное -
// сбой здесь не должен мешать ставке, поэтому ошибки глотаем.
async function approach(loc) {
  const pg = loc.page();
  try {
    if (Math.random() < 0.35) {
      await pg.mouse.wheel(0, randInt(-190, 190));
      await sleep(randInt(140, 420));
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const bb = await loc.boundingBox();
    if (!bb) return;
    await mouseGlide(pg,
      bb.x + bb.width * (0.25 + Math.random() * 0.5),
      bb.y + bb.height * (0.25 + Math.random() * 0.5));
    await sleep(randInt(60, 220));
  } catch (e) { /* подвод - украшение, а не условие ставки */ }
}

// Клик, который не сдаётся с первого раза. На Toobit чип «Time
// Increment» - обычный div, и его центр перекрыт соседним элементом:
// locator.click ждёт «получает события» и падает по таймауту, хотя чип
// на экране и кликабелен руками. Порядок отступления: человечный клик →
// клик с force (пропускает проверку перекрытия, но остальные оставляет)
// → синтетический DOM-клик. Каждый следующий шаг менее «человечный»,
// поэтому применяется только когда предыдущий не сработал.
// Что сработало в прошлый раз - чтобы не тратить каждый раз шесть
// секунд на заведомо провальный обычный клик. Память живёт до
// перезапуска: после обновления биржи разметка может поправиться, и
// новый запуск снова начнёт с человечного клика.
const clickWay = new Map();
async function clickStubborn(loc, what) {
  const key = curEx().name + '|' + what.replace(/\d+/g, '');
  const known = clickWay.get(key);
  if (known === 'force' || known === 'dom') {
    try {
      if (known === 'force') await loc.click({ force: true, timeout: 4000 });
      else await loc.evaluate(el => el.click());
      return known + ' (как в прошлый раз)';
    } catch (e) { /* разметка поменялась - идём обычным путём */ }
  }
  try { await humanClick(loc, 6000); clickWay.set(key, 'обычный'); return 'обычный'; }
  catch (e1) {
    log(`${what}: обычный клик не прошёл (${String(e1.message).split('\n')[0]}), пробую с force`);
    try {
      await loc.click({ force: true, timeout: 4000 });
      clickWay.set(key, 'force');
      return 'force';
    } catch (e2) {
      log(`${what}: force тоже не прошёл, кликаю через DOM`);
      await loc.evaluate(el => el.click());
      clickWay.set(key, 'dom');
      return 'dom';
    }
  }
}

async function humanClick(loc, timeout = 5000) {
  if (CFG.humanize === false) return loc.click({ timeout });
  await sleep(randInt(120, 480));
  await approach(loc);
  // Размеры берём именно padding-box (clientWidth/Height): position в
  // Playwright отсчитывается от его левого верхнего угла, а
  // boundingBox() отдаёт border-box - он больше на толщину рамки, и
  // доли от него смещали точку наружу от задуманной области.
  // clientWidth=0 у инлайновых элементов - тогда откатываемся на bbox.
  const box = await loc.evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }))
    .catch(() => null)
    .then(async b => (b && b.w && b.h) ? b
      : await loc.boundingBox().catch(() => null).then(bb => bb ? { w: bb.width, h: bb.height } : null));
  if (!box || box.w < 8 || box.h < 8) return loc.click({ timeout });
  const position = {
    x: box.w * (0.2 + Math.random() * 0.6),
    y: box.h * (0.2 + Math.random() * 0.6),
  };
  await loc.hover({ position, timeout }).catch(() => {});
  await sleep(randInt(40, 160));
  return loc.click({ position, delay: randInt(45, 130), timeout });
}

// Ввод суммы посимвольно. Мгновенная подстановка всего значения - тоже
// машинный след. Если поле повело себя неожиданно (маска, автоформат),
// откатываемся на обычный fill и проверяем результат.
async function humanFill(loc, value, timeout = 5000) {
  const v = String(value);
  if (CFG.humanize === false) return loc.fill(v, { timeout });
  try {
    await humanClick(loc, timeout);
    await loc.fill('', { timeout });
    await loc.pressSequentially(v, { delay: randInt(55, 145), timeout });
    if ((await loc.inputValue().catch(() => null)) === v) return;
    log('посимвольный ввод дал не то значение - подставляю целиком');
  } catch (e) {
    log('посимвольный ввод не удался (' + e.message + ') - подставляю целиком');
  }
  await loc.fill(v, { timeout });
}

async function shot(tag) {
  try {
    const f = path.join(SHOTS, `${Date.now()}-${tag}.png`);
    await page.screenshot({ path: f });
    return f;
  } catch (e) { return null; }
}

// Снимок содержимого страницы: какие поля ввода и кнопки на ней есть.
// Нужен, когда селектор не сработал: сообщение "Timeout 5000ms exceeded"
// не говорит, чего именно не нашлось, а страницу глазами не увидеть.
async function dumpPage(tag) {
  try {
    const info = await page.evaluate(() => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      return {
        url: location.href,
        inputs: [...document.querySelectorAll('input')].map(i => ({
          ph: i.placeholder || '', type: i.type || '',
          im: i.getAttribute('inputmode') || '', vis: vis(i),
        })),
        buttons: [...new Set([...document.querySelectorAll('button,[role=button]')]
          .filter(vis).map(b => (b.innerText || '').trim()).filter(t => t && t.length < 40))],
        payoutText: (document.body.innerText.match(/[^\n]*Payout[^\n]*/gi) || []).slice(0, 6),

        // Кнопки направления бывают не button и без role=button - на
        // Toobit в списке кнопок нет ни Up, ни Down. Ищем ЛЮБОЙ видимый
        // элемент, чей собственный текст равен слову направления, и
        // показываем тег с классами: по ним и пишется селектор.
        dirLike: (() => {
          const words = /^(up|down|buy|sell|rise|fall|higher|lower|long|short)$/i;
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            if (!vis(el) || el.children.length > 2) continue;
            const t = (el.innerText || '').trim();
            // Значок перед словом («↗ Higher») отбрасываем: иначе кнопка
            // направления в списке не появится.
            if (!words.test(t.replace(/[^\p{L}]/gu, ''))) continue;
            out.push({
              t, tag: el.tagName.toLowerCase(),
              cls: String(el.className || '').slice(0, 60),
              role: el.getAttribute('role') || '',
            });
            if (out.length >= 12) break;
          }
          return out;
        })(),

        // Что написано ВОКРУГ каждого упоминания выплаты. Сама строка
        // «Expected Payout Ratio» без числа бесполезна: процент лежит в
        // соседнем узле, и увидеть надо именно связку.
        payoutBlocks: (() => {
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            if (!vis(el) || el.children.length > 3) continue;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!/payout|ratio|return/i.test(t) || t.length > 160) continue;
            // Поднимаемся до предка, где рядом с надписью появилось число
            let box = el, txt = t;
            for (let i = 0; i < 4 && box.parentElement; i++) {
              if (/[0-9]+(\.[0-9]+)?\s*%/.test(txt)) break;
              box = box.parentElement;
              txt = (box.innerText || '').replace(/\s+/g, ' ').trim();
            }
            if (txt.length <= 220 && !out.includes(txt)) out.push(txt);
            if (out.length >= 6) break;
          }
          return out;
        })(),
      };
    });
    log(`ДАМП [${tag}] url=${info.url} | фреймов на странице: ${page.frames().length}`);
    log(`  поля ввода (${info.inputs.length}): ` + JSON.stringify(info.inputs.slice(0, 12)));
    log(`  кнопки (${info.buttons.length}): ` + JSON.stringify(info.buttons.slice(0, 30)));
    log(`  строки с Payout: ` + JSON.stringify(info.payoutText));
    log(`  выплата в контексте: ` + JSON.stringify(info.payoutBlocks));
    log(`  похожее на Up/Down (${info.dirLike.length}): ` + JSON.stringify(info.dirLike));
    // Символы, которые биржа показывает прямо сейчас: по ним видно,
    // торгуется ли вообще нужный инструмент, или его в этот час нет.
    const syms = await pageSymbols();
    log(`  символы на странице (${syms.length}): ` + JSON.stringify(syms.slice(0, 30)));
    if (page.frames().length > 1) {
      log('  фреймы: ' + JSON.stringify(page.frames().map(f => f.url()).slice(0, 6)));
    }
    return info;
  } catch (e) {
    log(`ДАМП [${tag}] не удался: ${e.message}`);
    return null;
  }
}

// Кандидаты на поле суммы: вёрстка вкладок Simple и Pro различается,
// плейсхолдер зависит от локали и лимитов аккаунта.
// Селектор поля суммы, который на этой бирже сработал в прошлый раз.
// Список перебирается по порядку с ожиданием на каждом, и на Toobit
// подходил только третий: две с половиной секунды каждой ставки уходили
// на заведомо промахивающиеся первые два.
const amountHit = new Map();
function amountSelectors() {
  const list = [
    curEx().selectors.amount,
    'input[placeholder*="USDT"]',
    'input[placeholder*="~"]',
    'input[inputmode="decimal"]',
    'input[type="number"]',
  ].filter(Boolean);
  const hit = amountHit.get(curEx().name);
  return hit ? [hit, ...list.filter(s => s !== hit)] : list;
}

async function findAmount(perTryMs) {
  for (const sel of amountSelectors()) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: perTryMs });
      amountHit.set(curEx().name, sel);
      return { loc, sel };
    } catch (e) { /* следующий */ }
  }
  return null;
}

// Ждём, пока торговая панель реально отрисуется. Фиксированной паузы
// мало: MEXC - SPA, и через 2.5 секунды после domcontentloaded на
// странице может не быть ещё ни одной кнопки (видно в ДАМПе: 0 полей,
// 0 кнопок, payout "--"). Признак готовности - появившееся поле суммы.
async function waitForPanel() {
  const deadline = Date.now() + (CFG.panelTimeoutMs ?? 40000);
  let found = null;
  while (Date.now() < deadline) {
    found = await findAmount(1200);
    if (found) return found;
    await page.waitForTimeout(400);
  }
  return null;
}

// Счётчик открытых позиций из вкладки "Open Positions (N)".
// Это единственный доступный признак того, что ставка ДЕЙСТВИТЕЛЬНО
// открылась: клик по кнопке сам по себе ничего не доказывает.
async function openPositionsCount() {
  try {
    const body = await page.evaluate(() => document.body.innerText);
    // Метку экранируем: в интерфейсе она может содержать скобки и точки.
    const label = curEx().openPositionsLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = body.match(new RegExp(label + '\\s*\\((\\d+)\\)', 'i'));
    return m ? parseInt(m[1], 10) : null;
  } catch (e) { return null; }
}

// Ждём, пока счётчик вырастет. Возвращает новое значение или null.
async function waitPositionsGrow(before, timeoutMs) {
  if (before == null) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await openPositionsCount();
    if (now != null && now > before) return now;
    await page.waitForTimeout(400);
  }
  return null;
}

// Достаём payout со страницы. На MEXC это строка "Up Payout 80%" - её
// ловит шаблон payoutRe с подстановкой слова направления. Разметку
// второй биржи заранее не знаем, поэтому есть запасной путь: процент,
// написанный на самой кнопке направления или в ближайшем предке, где он
// вообще появляется. Если там нашлось НЕСКОЛЬКО разных процентов,
// возвращаем null: выбирать наугад между выплатой Up и выплатой Down
// хуже, чем честно сказать «не прочитал» - на биржах с обязательной
// проверкой это означает отказ от ставки, а не ставку вслепую.
// Выплата, привязанная К САМОЙ КНОПКЕ направления, а не к порядку блоков
// на странице. Порядок приходилось задавать руками (order: UP, DOWN), и
// он оказался угадан неверно: на ставках вверх исполнитель читал 79-82%,
// а биржа применяла 72% - то есть бралось значение соседнего блока.
// Заодно те же ставки, где читалось честные 72%, отбивались порогом. То
// есть ошибка была не в дрейфе, а в сопоставлении.
//
// Геометрия угадывания не требует: подпись выплаты лежит рядом со своей
// кнопкой, и ближайшая к «Higher» - это выплата Higher, какой бы ни был
// порядок в разметке. Считаем расстояния между центрами и выбираем
// сопоставление с наименьшей суммой - для двух кнопок вариантов всего
// два.
async function payoutByButtons() {
  const E = curEx();
  const words = { UP: E.dirWords.UP || 'Up', DOWN: E.dirWords.DOWN || 'Down' };
  const re = (E.payoutList && E.payoutList.re) || '([0-9]{1,3}(?:[.,][0-9]+)?)\\s*%';
  try {
    return await page.evaluate(({ words, re }) => {
      const vis = el => {
        if (!(el.offsetWidth || el.offsetHeight)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const mid = el => { const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

      // Кнопки направления: собственный текст равен слову, значки вокруг
      // игнорируем - «↗ Higher» это Higher.
      const btn = {};
      for (const [dir, w] of Object.entries(words)) {
        const exact = new RegExp('^[^\p{L}]*' + w + '[^\p{L}]*$', 'iu');
        for (const el of document.querySelectorAll('*')) {
          if (!vis(el) || el.children.length > 2) continue;
          if (!exact.test((el.innerText || '').trim())) continue;
          btn[dir] = mid(el);
          break;
        }
      }
      if (!btn.UP || !btn.DOWN) return null;

      // Блоки выплаты: самый мелкий видимый узел, чей текст даёт процент.
      const rx = new RegExp(re, 'i');
      const blocks = [];
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 3) continue;
        const t = (el.innerText || '').trim();
        if (t.length > 120) continue;
        const m = t.match(rx);
        if (!m) continue;
        const v = parseFloat(String(m[1]).replace(',', '.'));
        if (!Number.isFinite(v) || v < 10 || v > 500) continue;
        const c = mid(el);
        // Один и тот же блок ловится и на родителе, и на потомке -
        // оставляем ближайший к уже найденному, а не оба.
        if (blocks.some(b => Math.abs(b.x - c.x) < 6 && Math.abs(b.y - c.y) < 6)) continue;
        blocks.push({ v, x: c.x, y: c.y });
      }
      if (blocks.length < 2) return null;

      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      // Ближайшие к кнопкам два блока, в двух возможных сочетаниях.
      let best = null;
      for (let i = 0; i < blocks.length; i++) {
        for (let j = 0; j < blocks.length; j++) {
          if (i === j) continue;
          const sum = d(btn.UP, blocks[i]) + d(btn.DOWN, blocks[j]);
          if (!best || sum < best.sum) best = { sum, up: blocks[i], down: blocks[j] };
        }
      }
      if (!best) return null;
      // Насколько выбор уверенный: во сколько раз второй вариант хуже.
      const alt = d(btn.UP, best.down) + d(btn.DOWN, best.up);
      return { UP: best.up.v, DOWN: best.down.v, sum: best.sum, alt,
               blocks: blocks.length };
    }, { words, re });
  } catch (e) { return null; }
}

async function pagePayout(direction) {
  const E = curEx();
  const word = E.dirWords[direction] || (direction === 'UP' ? 'Up' : 'Down');
  // Первым делом - привязка к кнопке: она не требует угадывать порядок.
  // Принимаем только уверенный выбор: если сочетание «наоборот» почти
  // такое же по расстояниям, значит подписи стоят так, что рядом с
  // кнопкой оказались обе, и решать по геометрии нельзя.
  lastPayouts = null;
  const byBtn = await payoutByButtons();
  if (byBtn && byBtn.alt > byBtn.sum * 1.25) {
    lastPayouts = { UP: byBtn.UP, DOWN: byBtn.DOWN, how: 'по кнопкам' };
    return byBtn[direction];
  }
  if (byBtn) {
    log(`выплата по кнопкам неуверенна (${byBtn.UP}% / ${byBtn.DOWN}%, `
      + `расстояния ${Math.round(byBtn.sum)} против ${Math.round(byBtn.alt)}) - иду дальше`);
  }
  // Пустой payoutRe = путь выключен. Он ищет процент ПОСЛЕ слова
  // направления, а на Toobit подпись выплаты стоит НАД кнопкой - и
  // шаблон брал процент соседнего блока: для Up возвращалось значение
  // Down. Молча неверная выплата хуже непрочитанной, поэтому там, где
  // порядок не тот, путь просто отключается.
  if (E.payoutRe) {
    try {
      const body = await page.evaluate(() => document.body.innerText);
      const m = body.match(new RegExp(String(E.payoutRe).replace('{DIR}', word), 'i'));
      if (m && m[1]) return parseFloat(m[1]);
    } catch (e) { /* пробуем запасной путь */ }
  }
  try {
    // Ищем не только button/[role=button]: на Toobit кнопки направления
    // вообще не значатся кнопками, в списке страницы их нет. Берём любой
    // ВИДИМЫЙ элемент, чей собственный текст равен слову направления, и
    // поднимаемся к ближайшему предку, где рядом появился процент.
    const txt = await page.evaluate(w => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      // Значки и пробелы вокруг слова игнорируем: «↗ Higher» это Higher.
      const exact = new RegExp('^[^\\p{L}]*' + w + '[^\\p{L}]*$', 'iu');
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 2) continue;
        if (!exact.test((el.innerText || '').trim())) continue;
        for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) {
          const t = e.innerText || '';
          if (t.includes('%')) return t;
        }
      }
      return '';
    }, word);
    const vals = [...String(txt).matchAll(/([0-9]{1,3}(?:[.,][0-9]+)?)\s*%/g)]
      .map(m => parseFloat(m[1].replace(',', '.')))
      .filter(v => v >= 10 && v <= 500);
    const uniq = [...new Set(vals)];
    if (uniq.length === 1) return uniq[0];
    if (uniq.length > 1) log(`выплата у «${word}» неоднозначна: ${uniq.join('%, ')}% - считаю непрочитанной`);
  } catch (e) { /* остаётся третий путь */ }

  // Третий путь: блоки выплат по порядку сверху вниз.
  try {
    const L = E.payoutList;
    if (!L || !L.re || !Array.isArray(L.order)) return null;
    const idx = L.order.indexOf(direction);
    if (idx < 0) return null;
    const body = await page.evaluate(() => document.body.innerText);
    const found = [...body.matchAll(new RegExp(L.re, 'gi'))]
      .map(m => parseFloat(String(m[1]).replace(',', '.')))
      .filter(v => Number.isFinite(v) && v >= 10 && v <= 500);
    if (found.length !== L.order.length) {
      if (found.length) {
        log(`блоков выплаты на странице ${found.length}, а ожидалось ${L.order.length}`
          + ` (${found.join('%, ')}%) - считаю непрочитанной`);
      }
      return null;
    }
    lastPayouts = { UP: found[L.order.indexOf('UP')], DOWN: found[L.order.indexOf('DOWN')],
                    how: 'по порядку блоков' };
    return found[idx];
  } catch (e) { return null; }
}
// Обе выплаты последнего чтения. Уходят в журнал: когда биржа применяет
// не то число, что мы прочитали, по одной записи не понять, взяли мы
// соседний блок или выплата успела уехать.
let lastPayouts = null;

// Какой актив показывает страница СЕЙЧАС - по заголовку документа.
// Адрес меняется мгновенно, а SPA перерисовывает панель позже, поэтому
// url тут не свидетель: он уже говорит BTC, когда на экране ещё ETH.
// Заголовок биржа переписывает вместе с контрактом.
// null - определить не удалось (нет символа или их несколько).
// Пары «ключ актива - символ на бирже», длинные символы первыми: иначе
// короткий совпал бы как начало длинного (SPCX внутри SPCXSTOCK).
function assetSymbols(E) {
  const ex = E || curEx();
  return Object.keys(ex.urls || {})
    .map(k => [k, (ex.symbols || {})[k] || k])
    .sort((a, b) => b[1].length - a[1].length);
}
function symbolOf(asset, E) {
  const ex = E || curEx();
  return (ex.symbols || {})[asset] || asset;
}
const symbolRe = sym => new RegExp(sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  + '\\s*[_/-]?\\s*USDT', 'i');

async function pageAsset() {
  const t = await page.title().catch(() => '');
  const hit = assetSymbols().filter(([, sym]) => symbolRe(sym).test(t));
  return hit.length === 1 ? hit[0][0] : null;
}

// Актив, который показывает САМА ПАНЕЛЬ, а не заголовок вкладки.
// Заголовок на Toobit догоняет адрес с задержкой в десятки секунд, а
// символ в шапке панели меняется сразу. Мешает то, что символов на
// странице несколько: рядом бежит лента чужих сделок (BTCUSDT, SOLUSDT).
// Различаем по кеглю: символ инструмента набран крупно, лента - мелко.
// Это подсказка, а не приговор: используется только чтобы РАЗРЕШИТЬ
// ставку, когда заголовок ещё не обновился. Отказ по-прежнему выносит
// проверка заголовка.
async function pageAssetOnPage() {
  const pairs = assetSymbols();
  if (!pairs.length) return null;
  try {
    return await page.evaluate(ps => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      let best = null, bestSize = 0;
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 1) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 24) continue;
        for (const [key, sym] of ps) {
          if (!new RegExp('^' + sym + '\\s*[-_/]?\\s*USDT', 'i').test(t)) continue;
          const size = parseFloat(getComputedStyle(el).fontSize) || 0;
          if (size > bestSize) { bestSize = size; best = key; }
        }
      }
      // Мелкий текст - это лента, а не шапка: такому не верим.
      return bestSize >= 14 ? best : null;
    }, pairs);
  } catch (e) { return null; }
}

// ── цена на странице ──
// Нужна, чтобы не входить хуже, чем показывал сигнал. Официального API у
// событийных фьючерсов нет, поэтому читаем то же, что видит человек.
// Три источника по убыванию надёжности: селектор из конфига, заголовок
// вкладки (биржи держат там последнюю цену) и самое крупное число в
// шапке страницы. Не прочитали - возвращаем null, и проверка цены
// молча отключается: терять сигналы из-за неё нельзя.
function parsePrice(t) {
  if (!t) return null;
  // 1 234,56 / 1,234.56 / 4321.5 - разделитель тысяч выкидываем, а
  // десятичную запятую превращаем в точку.
  const m = String(t).match(/(\d[\d,.   ]{0,15}\d|\d)\s*([KMBkmbКМкм])?/);
  if (!m) return null;
  let x = m[1].replace(/[   ]/g, '');
  if (/,\d{1,8}$/.test(x) && !/\.\d/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
  else x = x.replace(/,/g, '');
  let v = parseFloat(x);
  if (!Number.isFinite(v) || v <= 0) return null;
  // Хвост K/M/B: биржи пишут цену в заголовке вкладки сокращённо, и
  // «80.141K» без множителя читалось как 80.141 - в тысячу раз мимо.
  // Отсюда в журнале «цена лучше на 99921%».
  const mult = { k: 1e3, к: 1e3, m: 1e6, м: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()];
  if (mult) v *= mult;
  return v;
}
async function pagePrice() {
  const E = curEx();
  if (E.priceSelector) {
    try {
      const loc = page.locator(E.priceSelector).first();
      if (await loc.count() > 0) {
        const v = parsePrice((await loc.innerText({ timeout: 1500 })).trim());
        if (v) return v;
      }
    } catch (e) { /* ищем дальше */ }
  }
  // Заголовок вкладки: «4321.55 | ETHUSDT | Toobit». Проценты и объёмы
  // туда не попадают, поэтому первое же число - цена.
  try {
    const t = await page.title();
    // Символ из заголовка убираем: в «ETH-SWAP-USDT» тоже есть цифры не
    // всегда, но у пар вроде 1000PEPE - есть, и они не цена.
    const clean = String(t).replace(/[A-Za-z0-9]*(USDT|USD|SWAP)[A-Za-z0-9_/-]*/gi, ' ');
    const v = parsePrice(clean);
    if (v) return v;
  } catch (e) { /* ищем дальше */ }
  // Последнее: самое крупно набранное число в верхней трети страницы.
  // Там у всех бирж стоит последняя цена; сумма ставки и таймер мельче
  // и лежат ниже.
  try {
    return await page.evaluate(() => {
      const num = /^[+-]?[\d][\d  ,.]*$/;
      let best = null, bestSize = 0;
      for (const el of document.querySelectorAll('span,div,p,h1,h2,strong,b')) {
        if (el.children.length) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 16 || !num.test(t)) continue;
        if (!/[.,]\d|\d{4}/.test(t)) continue;     // целое из трёх цифр - не цена
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.top < 0 || r.top > window.innerHeight * 0.55) continue;
        const size = parseFloat(getComputedStyle(el).fontSize) || 0;
        if (size < 15 || size <= bestSize) continue;
        bestSize = size; best = t;
      }
      return best;
    }).then(parsePrice);
  } catch (e) { return null; }
}

// Какие символы биржа вообще показывает прямо сейчас. Нужно, когда она
// уводит с адреса актива: одно дело - сломанный адрес в конфиге, и совсем
// другое - инструмент, которого в этот час на бирже просто нет. По логу
// эти два случая неразличимы, а лечатся по-разному.
async function pageSymbols(openList) {
  const read = () => page.evaluate(() => {
      const re = /^[A-Z0-9]{2,10}\s*[_/-]?\s*USDT$/;
      const out = new Set();
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length) continue;
        if (!(el.offsetWidth || el.offsetHeight)) continue;
        const t = (el.textContent || '').trim().toUpperCase();
        if (t.length <= 16 && re.test(t)) out.add(t);
        if (out.size >= 40) break;
      }
      return [...out];
  });
  try {
    let syms = await read();
    // Список символов обычно свёрнут, и в свёрнутом виде на странице
    // виден ровно один символ - текущий. Такой перечень ничего не
    // объясняет, поэтому раскрываем список и читаем ещё раз. Делается
    // это только когда ставка уже отменена, так что состояние страницы
    // портить не жалко.
    if (openList && syms.length < 3) {
      const cur = await pageAssetOnPage();
      if (cur) {
        const head = page.getByText(new RegExp('^' + symbolOf(cur)
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[_/-]?\\s*USDT$', 'i')).first();
        if (await head.count() > 0 && await head.isVisible().catch(() => false)) {
          await head.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(900);
          const more = await read();
          if (more.length > syms.length) syms = more;
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    }
    return syms;
  } catch (e) { return []; }
}

// Переключить актив ТАК ЖЕ, КАК ЧЕЛОВЕК: через выбор символа на самой
// странице, а не адресом. Нужно, когда приложение биржи игнорирует путь и
// восстанавливает последний просмотренный символ - тогда сколько ни грузи
// адрес SPCX, на экране остаётся BTC. Человек в этом случае просто
// открывает список символов и выбирает нужный.
//
// Кликаем ТОЛЬКО по элементу, весь текст которого - искомый символ и
// ничего больше. Иначе на торговой странице легко попасть в ленту чужих
// сделок или в строку открытой позиции.
// Активы, до которых доходит только выбор на странице. Ключ - биржа и
// актив: на одной бирже адрес актива может работать, на другой нет.
const uiAsset = new Set();
async function switchAssetOnPage(asset) {
  // В списке символов написано то, как актив зовётся НА БИРЖЕ, а не наш
  // ключ: искать «SPCX» там, где написано «SPCXSTOCK_USDT», бесполезно.
  const sym = symbolOf(asset);
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '\\s*[_/-]?\\s*USDT$', 'i');
  const exact = new RegExp('^' + esc + '$', 'i');
  const pick = async () => {
    for (const rx of [re, exact]) {
      const loc = page.getByText(rx);
      const n = Math.min(await loc.count().catch(() => 0), 12);
      for (let i = 0; i < n; i++) {
        const c = loc.nth(i);
        if (!(await c.isVisible().catch(() => false))) continue;
        const box = await c.boundingBox().catch(() => null);
        if (!box || box.width < 8 || box.height < 8) continue;
        return c;
      }
    }
    return null;
  };

  // Список символов может быть уже раскрыт - тогда выбираем сразу.
  let target = await pick();
  if (!target) {
    // Не раскрыт: жмём на текущий символ в шапке, чтобы список появился.
    const cur = await pageAssetOnPage();
    if (cur) {
      const head = page.getByText(new RegExp('^' + symbolOf(cur)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[_/-]?\\s*USDT$', 'i')).first();
      if (await head.count() > 0 && await head.isVisible().catch(() => false)) {
        await humanClick(head).catch(() => {});
        await page.waitForTimeout(randInt(700, 1300));
        target = await pick();
      }
    }
  }
  if (!target) return false;
  await humanClick(target).catch(() => {});
  // Ждём, пока приложение перерисуется под новый символ.
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    await page.waitForTimeout(400);
    if ((await pageAssetOnPage()) === asset || (await pageAsset()) === asset) return true;
  }
  return false;
}

// Берём первый ВИДИМЫЙ чип, а не первый попавшийся: селектор широкий
// и легко цепляет скрытую разметку вкладок.
async function visibleChip(re) {
  const all = page.locator(EX.selectors.timeUnit).filter({ hasText: re });
  const n = Math.min(await all.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const c = all.nth(i);
    if (await c.isVisible().catch(() => false)) return c;
  }
  // Селектор из конфига перечисляет теги, а на Toobit чипы «Time
  // Increment» - обычные div: по селектору находилось НОЛЬ элементов,
  // хотя на экране они есть. getByText берёт самый глубокий узел с
  // точным текстом, каким бы тегом он ни был.
  const byText = page.getByText(re).first();
  if (await byText.count() > 0 && await byText.isVisible().catch(() => false)) return byText;
  return null;
}
// «Выбран» на разных вёрстках отмечается по-разному: aria-selected на
// самом элементе или класс active/selected/checked на нём либо на
// обёртке вкладки. Поэтому смотрим и вверх по нескольким предкам.
const chipActive = c => c.evaluate(el => {
  const hit = e => !!e && (
    (e.getAttribute && e.getAttribute('aria-selected') === 'true') ||
    /(^|[-_ ])(active|selected|checked)([-_ ]|$)/i.test(String(e.className || '')));
  for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) if (hit(e)) return true;
  return false;
}).catch(() => false);

// Какой чип отмечен выбранным - ПО СТИЛЮ. Разметка Toobit не ставит
// ни aria-selected, ни класса active: чипы отличаются только видом.
// Зато выбранный там ровно один, а остальные одинаковые - значит
// «белая ворона» и есть выбранный. Сравниваем фон, цвет, насыщенность
// и рамку. Если чипов меньше трёх или отличается не один - молчим.
// ── чипы экспирации ──
// Одна и та же подпись на странице встречается дважды: «5m» и «30m» есть
// и у графика (1s 1m 5m 15m 30m 1h 4h 1D), и в строке Time Increment.
// Пока чипы искались по всей странице, сравнивался вид кнопки графика с
// видом чипа экспирации - «белая ворона» находилась не та, а нажатие
// «5m» при доказательстве меняло интервал ГРАФИКА, а не экспирацию.
// Поэтому сначала находим ГРУППУ: ближайшего общего предка, внутри
// которого лежит нужная подпись и как можно больше остальных. Если у
// биржи задан timeUnitAnchor («Time Increment»), группа рядом с этой
// надписью получает предпочтение.
// only - свой набор подписей вместо экспирации: им пользуется холостое
// действие с графиком, у которого свои интервалы и свой якорь.
async function chipScan(want, only) {
  const labels = only && only.length ? only : Object.values(EX.timeUnitText);
  const anchor = (only && only.length ? EX.chartAnchor : EX.timeUnitAnchor) || '';
  try {
    return await page.evaluate(({ labels, anchor, want }) => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      const KEYS = ['backgroundColor', 'backgroundImage', 'color', 'fontWeight',
                    'borderColor', 'borderWidth', 'borderRadius', 'boxShadow',
                    'outlineColor', 'textDecorationLine', 'opacity', 'filter'];
      const sig = el => {
        const parts = [];
        for (const who of [null, '::before', '::after']) {
          const cs = getComputedStyle(el, who);
          for (const k of KEYS) parts.push(cs[k]);
          if (who) parts.push(cs.content, cs.width, cs.height);
        }
        return parts.join('|');
      };
      // Все видимые узлы с нужными подписями.
      const cands = [];
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 1) continue;
        const t = (el.innerText || '').trim();
        if (labels.includes(t)) cands.push({ t, el });
      }
      if (!cands.length) return null;

      // Кандидаты в группы: предки, содержащие несколько разных подписей.
      const groups = [];
      for (const c of cands) {
        for (let e = c.el.parentElement, i = 0; e && i < 6; e = e.parentElement, i++) {
          if (groups.some(g => g.box === e)) continue;
          const inside = cands.filter(x => e.contains(x.el));
          const names = new Set(inside.map(x => x.t));
          if (names.size < 2) continue;
          const txt = ((e.parentElement || e).innerText || '').slice(0, 400);
          groups.push({
            box: e, inside, count: names.size,
            hasWant: !want || inside.some(x => x.t === want),
            anchored: anchor ? txt.includes(anchor) : false,
            depth: i,
          });
        }
      }
      if (!groups.length) return null;
      // Лучшая группа: с нужной подписью, ближе к якорю, шире по составу,
      // и при прочих равных - самая тесная (меньший подъём).
      groups.sort((a, b) =>
        (b.hasWant - a.hasWant) || (b.anchored - a.anchored) ||
        (b.count - a.count) || (a.depth - b.depth));
      const g = groups[0];
      if (!g.hasWant) return null;

      // Вид каждого чипа группы: подпись самого узла и двух предков.
      const styles = {};
      for (const x of g.inside) {
        if (styles[x.t]) continue;
        const chain = [];
        for (let e = x.el, i = 0; e && i < 3 && e !== g.box.parentElement; e = e.parentElement, i++) chain.push(sig(e));
        styles[x.t] = chain.join('||');
      }
      // Выбранный - тот, чей вид отличается от остальных одинаковых.
      let active = null;
      const vals = Object.values(styles);
      if (vals.length >= 3) {
        const counts = {};
        for (const v of vals) counts[v] = (counts[v] || 0) + 1;
        const odd = Object.entries(styles).filter(([, v]) => counts[v] === 1);
        if (odd.length === 1) active = odd[0][0];
      }

      // Координаты чипов: поднимаемся, только пока цель мала. Считаем
      // сразу ДЛЯ ВСЕХ подписей группы, а не только для нужной: иначе,
      // чтобы нажать соседнюю экспирацию, пришлось бы искать группу
      // заново - и найтись могла бы ЧУЖАЯ. Ровно так проверка и срывалась
      // на Toobit: «30m» есть и у интервалов графика, и у экспирации,
      // клик уходил в график, выплаты не менялись.
      const boxFor = (label) => {
        const hitItem = g.inside.find(x => x.t === label);
        if (!hitItem) return null;
        let hit = hitItem.el;
        for (let i = 0; i < 3 && hit.parentElement && hit !== g.box; i++) {
          const r = hit.getBoundingClientRect();
          if (r.width >= 24 && r.height >= 16) break;
          hit = hit.parentElement;
        }
        const r = hit.getBoundingClientRect();
        return r.width >= 4 && r.height >= 4
          ? { x: r.x, y: r.y, w: r.width, h: r.height, el: hit } : null;
      };
      let box = null;
      const boxes = {};
      for (const label of Object.keys(styles)) {
        const b = boxFor(label);
        if (b) { delete b.el; boxes[label] = b; }
      }
      if (want) {
        const b = boxFor(want);
        if (b) {
          b.el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = b.el.getBoundingClientRect();
          if (r.width >= 4 && r.height >= 4) box = { x: r.x, y: r.y, w: r.width, h: r.height };
          delete b.el;
        }
      }
      // Текст всей группы - чтобы снаружи можно было проверить, не лежат
      // ли в ней ЧУЖИЕ подписи. labels перечисляет только те, что искали,
      // и по ним подмеса не видно: в ряду «5m 10m 30m 1h» при поиске
      // интервалов графика нашлись бы 5m и 1h, а 10m и 30m - подписи
      // экспирации - остались бы незамеченными.
      const text = (g.box.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return { active, box, boxes, labels: Object.keys(styles), anchored: g.anchored, text };
    }, { labels, anchor, want: want || null });
  } catch (e) { return null; }
}

async function activeChipByStyle() {
  const r = await chipScan(null);
  return r ? r.active : null;
}

// Выбранная экспирация глазами САМОЙ биржи: приложения обычно помнят её
// между заходами, а помнят - в localStorage. Читаем только на чтение и
// только то, что похоже на время: ключ про time/increment/period, а
// значение совпадает с одним из наших времён экспирации («10», «10m», 600000).
async function activeChipByStorage() {
  const pairs = Object.entries(EX.timeUnitText);   // [['10','10m'], ...]
  try {
    return await page.evaluate(ps => {
      const stores = [];
      try { stores.push(localStorage); } catch (e) {}
      try { stores.push(sessionStorage); } catch (e) {}
      const hits = new Set();
      const KEY = /(time|increment|period|duration|expir|minute|interval)/i;
      const match = (val) => {
        const v = String(val).trim().toLowerCase();
        for (const [min, label] of ps) {
          if (v === min || v === label.toLowerCase() || v === String(+min * 60)
              || v === String(+min * 60000)) return label;
        }
        return null;
      };
      for (const st of stores) {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (!KEY.test(k)) continue;
          const raw = st.getItem(k);
          if (raw == null) continue;
          let hit = match(raw);
          if (!hit && /^[[{]/.test(raw.trim())) {
            // Значение бывает объектом: ищем поле с временем внутри.
            try {
              const o = JSON.parse(raw);
              for (const [kk, vv] of Object.entries(o || {})) {
                if (!KEY.test(kk) || typeof vv === 'object') continue;
                hit = match(vv);
                if (hit) break;
              }
            } catch (e) {}
          }
          if (hit) hits.add(hit);
        }
      }
      return hits.size === 1 ? [...hits][0] : null;
    }, pairs);
  } catch (e) { return null; }
}

// Какой чип отмечен выбранным сейчас. null - разметка не даёт этого
// понять ни разметкой, ни видом.
// ── память о выбранной экспирации ──
// Прочитать выбранный чип на Toobit нечем: ни aria-selected, ни класса,
// ни отличий по виду. Остаётся доказательство сменой выплат - восемь
// секунд на каждую ставку, и половина из них проваливалась («страница не
// отзывается»), потому что доказательство требует, чтобы страница
// перерисовалась ДВАЖДЫ подряд именно в отведённую секунду.
//
// Но состояние чипов меняем ТОЛЬКО МЫ: биржа сама экспирацию не
// перещёлкивает, ставка её не сбрасывает. Значит, однажды доказанный
// выбор остаётся верным, пока вкладка не перешла на другой адрес и мы
// сами не нажали другой чип. Память об этом снимает и секунды, и
// пропуски: чаще всего нужная экспирация уже стоит с прошлого раза.
const tfMemo = new WeakMap();
// «Тот же расклад выплат»: значения совпали по количеству и не разошлись
// больше порога. Внутри одной экспирации выплаты гуляют на один-три
// пункта, а между экспирациями разница в десятки - 10 минут против 5
// это 80% против 66%. Поэтому расклад и годится как отпечаток состояния.
// null - сравнивать нечего, решение принимать не по чему.
function payoutDriftPts() { return Math.abs(CFG.payoutDriftPts ?? 5); }
function samePayouts(a, b, tol) {
  if (!a || !b) return null;
  const x = String(a).split(',').map(Number), y = String(b).split(',').map(Number);
  if (x.length !== y.length) return false;
  const t = tol ?? payoutDriftPts();
  return x.every((v, i) => Number.isFinite(v) && Number.isFinite(y[i]) && Math.abs(v - y[i]) <= t);
}

function rememberTf(tf, fp) {
  if (page) tfMemo.set(page, { tf, at: Date.now(), nav: pageNav(page), url: page.url(), fp: fp ?? null });
}
function forgetTf() { if (page) tfMemo.delete(page); }
function recallTf() {
  const m = page && tfMemo.get(page);
  if (!m) return null;
  // Переход по адресу = новая сборка приложения: чипы отрисовались
  // заново, и что там выбрано - мы больше не знаем.
  if (m.nav !== pageNav(page) || m.url !== page.url()) { tfMemo.delete(page); return null; }
  // Срок годности - на случай, если приложение всё же переставит чип
  // само: раз в полтора часа доказываем заново, это дешевле веры вслепую.
  if (Date.now() - m.at > (CFG.tfMemoMinutes ?? 90) * 60000) { tfMemo.delete(page); return null; }
  return m;
}
// Биржи, у которых выбранный чип не читается разметкой. Для них холостое
// действие «смена экспирации» запрещено: оно уводит страницу в состояние,
// которое потом нечем прочитать, и следующая ставка тратит на возврат
// секунды или отменяется совсем.
const tfBlind = new Set();

// Только разметка: aria-selected и классы. Дёшево и годится для опроса
// в цикле, в отличие от полной проверки со сравнением стилей.
async function activeChipMarkup() {
  for (const t of Object.values(EX.timeUnitText)) {
    const c = await visibleChip(new RegExp('^\\s*' + t + '\\s*$'));
    if (c && await chipActive(c)) return t;
  }
  return null;
}
async function activeChipName() {
  const mark = await activeChipMarkup();
  if (mark) return mark;
  const byStyle = await activeChipByStyle();
  if (byStyle) return byStyle;
  return await activeChipByStorage();
}

// Клик по чипу настоящей мышью в его координаты. Синтетический
// el.click() на Toobit «срабатывал» без ошибки и НЕ переключал
// экспирацию: приложение слушает не click, а нажатие мыши. Ставка при
// этом уходила на 5 минут - и с выплатой от чужой экспирации.
// Здесь события те же, что от руки, и проверки перекрытия не мешают.
async function clickBox(box) {
  if (!box) return false;
  const x = box.x + box.w * (0.3 + Math.random() * 0.4);
  const y = box.y + box.h * (0.3 + Math.random() * 0.4);
  await mouseGlide(page, x, y);
  await sleep(randInt(40, 140));
  await page.mouse.down();
  await sleep(randInt(45, 120));
  await page.mouse.up();
  return true;
}
async function clickChipByMouse(text, only) {
  const r = await chipScan(text, only);
  return r && r.box ? clickBox(r.box) : false;
}

// Отпечаток выплат страницы: все проценты по порядку. Меняется вместе с
// экспирацией - у каждой экспирации своя ставка возврата.
async function payoutFingerprint() {
  try {
    const body = String(await page.evaluate(() => document.body.innerText));
    // Если биржа описала, как выглядит строка выплаты, берём ТОЛЬКО её.
    // Общий сбор процентов притаскивал в отпечаток кучу постороннего:
    // «42,58,72,81,72,72,0» - и менялись там всего две цифры из семи, а
    // остальные пять могли сдвинуться от чего угодно на странице и
    // испортить сравнение в обе стороны.
    const L = curEx().payoutList;
    if (L && L.re) {
      const own = [...body.matchAll(new RegExp(L.re, 'gi'))]
        .map(m => m[1]).filter(v => +v >= 10 && +v <= 500);
      if (own.length) return own.join(',');
    }
    const all = [...body.matchAll(/([0-9]{1,3}(?:[.,][0-9]+)?)\s*%/g)]
      .map(m => m[1]).slice(0, 8);
    return all.length ? all.join(',') : null;
  } catch (e) { return null; }
}

// Доказательство от противного, когда выбранный чип не отличить ни
// разметкой, ни видом. Нажимаем ЧУЖУЮ экспирацию и смотрим, изменились ли
// выплаты; потом нажимаем нужный и смотрим снова. Две перемены подряд
// означают, что страница слушается чипов, а последним нажат наш - значит
// на нём и стоим. Если хоть одна перемена не случилась, ничего не
// доказано и ставки не будет.
// Ждём, пока отпечаток выплат станет ОТЛИЧНЫМ от прежнего. Раньше здесь
// стояло одно ожидание в секунду и одна проверка: если приложение
// перерисовывалось чуть медленнее (а под нагрузкой это обычное дело),
// перемена происходила сразу ПОСЛЕ замера, и доказательство считалось
// проваленным на ровном месте - отсюда сотня «страница не отзывается».
async function waitPayoutChange(from, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await page.waitForTimeout(200);
    const s = await payoutFingerprint();
    if (s && samePayouts(s, from) === false) return s;
  }
  return null;
}
// Возврат к ИСХОДНОМУ раскладу, а не просто «к какому-нибудь другому».
// Прежняя проверка требовала лишь, чтобы после нажатия нашего чипа
// выплаты отличались от соседских, - и естественный дрейф на пункт
// засчитывался как переключение обратно. То есть ставка могла остаться
// на соседней экспирации, а проверка - отчитаться об успехе.
async function waitPayoutBack(target, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    await page.waitForTimeout(200);
    const s = await payoutFingerprint();
    if (s) { last = s; if (samePayouts(s, target) === true) return s; }
  }
  return { failed: last };
}

async function proveByPayoutSwitch(tfText) {
  const wait = CFG.payoutSwitchMs ?? 3500;
  // Группу ищем ОДИН раз и по нашей подписи, а соседей берём из неё же.
  // Раньше каждый клик искал группу заново по своей подписи, и «30m»
  // находился среди интервалов ГРАФИКА - там он тоже есть. Клик уходил в
  // график, выплаты не менялись, проверка честно сдавалась: 119 срывов из
  // 144 пришлись именно на «30m», а на «10m», которого у графика нет, -
  // всего 25.
  const grp = await chipScan(tfText).catch(() => null);
  if (!grp || !grp.boxes || !grp.boxes[tfText]) return false;
  const others = Object.keys(grp.boxes).filter(t => t !== tfText);
  if (!others.length) {
    log(`проверка чипов: кроме ${tfText} в группе экспираций больше ничего нет`);
    return false;
  }
  let sig0 = await payoutFingerprint();
  if (!sig0) return false;
  // Перебираем ВСЕХ соседей: у двух соседних экспираций выплаты могут
  // совпасть, и тогда «ничего не изменилось» значит не то, что страница
  // мертва, а то, что сосед оказался неудачным.
  for (const other of others.sort(() => Math.random() - 0.5)) {
    forgetTf();
    if (!(await clickBox(grp.boxes[other]).catch(() => false))) continue;
    const sig1 = await waitPayoutChange(sig0, wait);
    if (!sig1) {
      log(`проверка чипов: нажал ${other} в ряду экспираций, выплаты не изменились за ${wait}мс`);
      continue;
    }
    if (!(await clickBox(grp.boxes[tfText]).catch(() => false))) return false;
    const back = await waitPayoutBack(sig0, wait);
    if (!back || back.failed !== undefined) {
      log(`проверка чипов: нажал ${tfText}, а выплаты не вернулись к исходным `
        + `(${sig0} → ${sig1} → ${back && back.failed}) - на нашей экспирации мы не стоим`);
      return false;
    }
    const sig2 = back;
    log(`экспирация ${tfText}: выбор не отмечен в разметке, но страница отозвалась `
      + `на ${other} и на ${tfText} (выплаты ${sig0} → ${sig1} → ${sig2}) - принимаю`);
    return true;
  }
  // Ни один сосед не отозвался - возвращаем свой чип и уходим ни с чем.
  log('проверка чипов: страница не отозвалась ни на одну чужую экспирацию');
  await clickBox(grp.boxes[tfText]).catch(() => {});
  await page.waitForTimeout(randInt(600, 1000));
  return false;
}

// Выставить экспирацию и УБЕДИТЬСЯ, что она выставилась. Проверка сразу
// после клика ловила старое состояние: SPA перерисовывает чипы не
// мгновенно, и в журнале копились «экспирация не переключилась на 10m»,
// хотя через секунду он был уже тот. Поэтому ждём результата до трёх
// секунд и, если не дождались, нажимаем второй раз.
async function ensureTimeframe(tfText) {
  const re = new RegExp('^\\s*' + tfText + '\\s*$');
  let cur = await activeChipName();
  if (cur === tfText) { rememberTf(tfText, await payoutFingerprint()); return { ok: true, cur, tries: 0, how: 'по разметке' }; }
  if (cur == null) {
    tfBlind.add(EX.name);
    // Разметка молчит, но мы САМИ ставили эту экспирацию на этой же
    // вкладке и с тех пор никуда не переходили. Верить своей записи
    // надёжнее, чем доказывать заново: доказательство стоит секунд
    // восемь и само иногда не удаётся - а это и был главный источник
    // «не удалось убедиться, что выбрана экспирация».
    // Память верна, пока страницу не перерисовали. Но приложение биржи
    // умеет пересобрать торговый виджет БЕЗ перехода по адресу - после
    // истёкшей позиции, например, - и сбросить экспирацию на свою
    // умолчательную. Переходов при этом ноль, память об этом не узнает и
    // соврёт: так ставка ушла на 5 минут с выплатой 66%, пока журнал
    // писал 10 минут и 80%. Поэтому память носит с собой расклад выплат
    // на момент подтверждения и сверяется с текущим: одна экспирация от
    // другой отличается десятками пунктов, а дрейф внутри - единицами.
    const memo = recallTf();
    if (memo && memo.tf === tfText) {
      const now = await payoutFingerprint();
      const same = samePayouts(memo.fp, now);
      if (same !== false) {
        return { ok: true, cur: tfText, tries: 0, how: same === true ? 'по памяти' : 'по памяти (выплаты не сверить)' };
      }
      log(`память говорит ${tfText}, но выплаты сменились (${memo.fp} → ${now}) - `
        + 'проверяю экспирацию заново');
      forgetTf();
    }
  }
  // Пока щёлкаем - память недействительна: если нас прервут посреди,
  // на странице окажется что угодно, и запись об этом соврала бы.
  forgetTf();
  for (let tries = 1; tries <= 2; tries++) {
    const chip = await visibleChip(re);
    let how = 'мышью';
    if (!(await clickChipByMouse(tfText).catch(() => false))) {
      if (!chip) return { ok: false, cur, tries, missing: true };
      how = await clickStubborn(chip, `чип ${tfText}`).catch(() => null);
      if (!how) return { ok: false, cur, tries };
    }
    // В ожидании спрашиваем только разметку: полный activeChipName
    // каждые 300мс перебирает все чипы, сравнивает стили и лезет в
    // хранилище - на бирже, где разметка всё равно молчит, эти три
    // секунды уходили в никуда четырежды за ставку.
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      await page.waitForTimeout(300);
      const mark = await activeChipMarkup();
      if (mark === tfText) { rememberTf(tfText, await payoutFingerprint()); return { ok: true, cur: mark, tries, how }; }
    }
    cur = await activeChipName();
    if (cur === tfText) { rememberTf(tfText, await payoutFingerprint()); return { ok: true, cur, tries, how }; }
    if (tries === 1) log(`чип ${tfText}: нажал (${how}), а выбран ${cur ?? 'неизвестно'} - пробую ещё раз`);
  }
  // Разметка молчит - пробуем доказать переключение сменой выплат.
  if (cur == null && await proveByPayoutSwitch(tfText)) {
    rememberTf(tfText, await payoutFingerprint());
    return { ok: true, cur: tfText, tries: 2, how: 'по смене выплат' };
  }
  return { ok: false, cur, tries: 2 };
}

// ── ставка ──
async function placeBet(sig) {
  const t0 = Date.now();
  // С этой строки и до конца ставки все страничные помощники смотрят в
  // конфиг ИМЕННО ЭТОЙ биржи: селекторы, тексты чипов, порог выплаты.
  EX = exCfg(sig.ex);
  const url = EX.urls[sig.asset];
  if (!url) throw new Error(`нет URL для актива ${sig.asset} на бирже ${EX.title}`);
  page = await pageFor(sig.ex);
  // Своя вкладка ставки. Общая переменная page - удобство для помощников,
  // но её может увести чужая задача; перед нажатием сверимся с этой.
  const myPage = page;
  // На передний план - тот же разговор про фоновое окно: невидимой
  // вкладке браузер отдаёт кадры по остаточному принципу.
  await page.bringToFront().catch(() => {});

  // Если нужная страница УЖЕ открыта и панель на ней жива - не трогаем
  // её вовсе. Раньше каждая ставка начиналась с полной перезагрузки:
  // лишние секунды на десятиминутной ставке, мигающее окно и повторная
  // сборка SPA на ровном месте. Проверка стоит полторы секунды и в
  // обычном случае экономит десять.
  // Биржа умеет увести со своего же адреса САМА, и не сразу: страница
  // открылась на SPCX, прошли проверки, а к моменту нажатия в адресе уже
  // BTC. Раньше это была ошибка - сигнал терялся целиком, да ещё и
  // приближал автопереход в DRY-RUN по серии ошибок. Теперь уехавшая
  // страница просто возвращается на место, и вся ставка играется заново:
  // адрес, актив, экспирация, выплата, сумма. Двух заходов достаточно -
  // если биржа уводит и во второй раз, дело не в случайности.
  // Способ начать заход: null - обычный, 'load' - непременно перегрузить
  // адрес, 'ui' - перегрузить И выбрать актив на самой странице. Третий
  // нужен там, где приложение биржи игнорирует путь и восстанавливает
  // последний просмотренный символ: сколько ни грузи адрес SPCX, на
  // экране остаётся BTC, и помогает только выбор символа руками.
  // Если этому активу адрес уже не помогал, начинаем сразу с выбора на
  // странице. Иначе каждая ставка по нему тратила бы два заведомо
  // провальных захода - секунд тридцать, которых у десятиминутной свечи
  // просто нет.
  const uiKey = `${sig.ex}|${sig.asset}`;
  let recover = uiAsset.has(uiKey) ? 'ui' : null;
  // Чем подтвердили экспирацию - разметкой, памятью или сменой выплат.
  // Уходит в журнал: разбирать «почему ставка оказалась на чужих минутах»
  // по одному только статусу невозможно.
  let tfHow = '';
  // Обе выплаты страницы на момент решения: если биржа применит другое
  // число, по журналу будет видно, взяли мы соседний блок или выплата
  // успела уехать.
  let payoutPair = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let ready = null;
    // После первого промаха короткий путь запрещён: раз страница уже
    // уехала сама, верить тому, что на ней открыто, нельзя - только
    // полная загрузка своего адреса.
    if (!recover && page.url().startsWith(url)) {
      ready = await findAmount(1500);
      if (ready) log('страница уже открыта, перезагрузка не нужна');
    }
    if (!ready) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
      // Биржа может увести с заданного адреса на «последний символ»: так
      // делает Toobit, если адрес задан параметром (?symbol=...), а не
      // путём. Первый заход мог прийтись на ещё не проснувшееся приложение,
      // поэтому повторяем - к этому моменту оно уже загружено и роутер
      // обычно слушается. Если и это не помогло, скажем прямо в отказе.
      if (!page.url().startsWith(url)) {
        log(`биржа увела с ${url} на ${page.url()} - повторяю переход`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
        if (!page.url().startsWith(url)) log(`адрес снова ${page.url()} - похоже, в конфиге неверный URL актива`);
      }
      ready = await waitForPanel();
      if (recover === 'ui') {
        // Может, в этот раз адрес и сработал: проверяем, прежде чем лезть
        // в список символов. Заодно так снимается память, если биржа
        // починилась.
        //
        // Смотрим ДВАЖДЫ с паузой: приложение уводит символ не мгновенно,
        // и по одному взгляду сразу после загрузки страница честно
        // показывает нужный актив - а через секунду уже чужой. Поверив
        // одному взгляду, мы пропустили бы выбор на странице и уехали в
        // отказ на третьем заходе.
        await page.waitForTimeout(700);
        const first = (await pageAsset()) || (await pageAssetOnPage());
        await page.waitForTimeout(1600);
        const second = (await pageAsset()) || (await pageAssetOnPage());
        const already = first === sig.asset && second === sig.asset ? sig.asset : second;
        if (already === sig.asset) {
          if (uiAsset.delete(uiKey)) log(`${sig.asset} открылся по адресу - выбор на странице больше не нужен`);
        } else {
          log(`выбираю ${sig.asset} на самой странице - адресом биржа не слушается`);
          const ok = await switchAssetOnPage(sig.asset).catch(() => false);
          log(ok ? `${sig.asset} выбран на странице` : `выбрать ${sig.asset} на странице не удалось`);
          if (ok) {
            uiAsset.add(uiKey);
            ready = (await findAmount(2500)) || ready;
          }
        }
      }
    }
    if (!ready) {
      // Не сдаёмся с первого раза: панель биржи иногда собирается дольше
      // отведённого, и по дампу видно, что поле на странице УЖЕ есть.
      // Перезагрузка дешевле проигранного сигнала.
      log('панель не собралась за ' + (CFG.panelTimeoutMs ?? 40000) + 'мс - перезагружаю страницу и пробую ещё раз');
      await shot('panel-not-ready-1');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
      ready = await waitForPanel();
    }
    if (!ready) {
      await shot('panel-not-ready');
      await dumpPage('panel-not-ready');
      throw new Error('торговая панель не отрисовалась за две попытки - смотри ДАМП выше');
    }
    log('панель готова, поле суммы: ' + ready.sel);

    // Ставка не на тот актив - самая дорогая из возможных ошибок, и
    // единственное, что её ловит, это сверка страницы с сигналом. Ждём,
    // пока SPA договорит: сразу после goto заголовок ещё прежний.
    const settleAsset = async () => {
      let seen = await pageAsset();
      if (!seen || seen === sig.asset) return seen;
      const until = Date.now() + (CFG.assetSettleMs ?? 6000);
      while (Date.now() < until && seen && seen !== sig.asset) {
        await page.waitForTimeout(400);
        seen = await pageAsset();
      }
      return seen;
    };
    let seen = await settleAsset();
    // Заголовок врёт, но панель показывает нужный символ - значит мы на
    // месте, и ждать нечего. Ровно этот случай ронял ставки на Toobit:
    // после переключения с BTC на ETH в title ещё висел BTC.
    if (seen && seen !== sig.asset) {
      const onPage = await pageAssetOnPage();
      if (onPage === sig.asset) {
        log(`заголовок отстал (в title ${seen}), но панель показывает ${onPage} - работаю`);
        seen = onPage;
      }
    }
    // Ни заголовок, ни панель не подтвердили актив. Одна перезагрузка:
    // адрес мы задавали сами, он и есть источник правды, а перезагрузка
    // заставляет SPA переписать всё остальное.
    if (seen && seen !== sig.asset && page.url().startsWith(url)) {
      log(`заголовок отстал: адрес ${sig.asset}, а в title ещё ${seen} - перезагружаю страницу`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
      ready = (await waitForPanel()) || ready;
      seen = await settleAsset();
      if (seen && seen !== sig.asset && (await pageAssetOnPage()) === sig.asset) {
        log(`после перезагрузки заголовок всё ещё ${seen}, но панель показывает ${sig.asset} - работаю`);
        seen = sig.asset;
      }
    }
    if (seen && seen !== sig.asset) {
      await shot('wrong-asset');
      // Не тот актив - это ровно тот же промах, что и уехавший адрес, просто
      // замеченный раньше. Значит и лечится так же: перезагрузкой, а потом
      // выбором символа на самой странице.
      if (attempt < 3) {
        recover = attempt === 1 ? 'load' : 'ui';
        log(`страница показывает ${seen}, а сигнал по ${sig.asset} - `
          + (recover === 'ui' ? 'пробую выбрать актив на самой странице'
                              : 'перезагружаю и играю ставку заново'));
        continue;
      }
      const syms = await pageSymbols(true);
      await dumpPage('wrong-asset');
      log(`пропуск ${sig.asset} ${sig.direction}: биржа не пустила на ${sig.asset}`
        + ` - на странице ${seen}. Символы, которые она сейчас показывает: `
        + (syms.length ? syms.join(', ') : 'прочитать не удалось')
        + `. Если ${sig.asset} среди них нет, инструмент сейчас не торгуется;`
        + ' если есть - проверь URL актива в конфиге.');
      return { status: 'skip-redirect', note: `страница показывает ${seen} вместо ${sig.asset}` };
    }
    // Определить не удалось - идём дальше с записью: жёсткий отказ на этом
    // основании остановил бы все ставки, если биржа сменит заголовок.
    log(seen ? `актив страницы ${seen} совпал` : 'актив страницы по заголовку не определить');
    // Отметка переходов: если к моменту нажатия она изменилась, значит
    // страницу увели ПОСЛЕ всех проверок, и увели не мы.
    const navAt = pageNav(page);

    // Точка отсчёта для проверки цены. Если сигнал цену не принёс, берём
    // цену на этот момент: она всё равно на десятки секунд свежее той, по
    // которой ставка будет нажата, и откат между «панель готова» и
    // нажатием ловит уже она.
    const guard = { ...(EX.priceGuard || {}) };
    let refPrice = null, refFrom = '';
    if (guard.enabled !== false) {
      if (sig.price) { refPrice = sig.price; refFrom = 'из сигнала'; }
      else {
        refPrice = await pagePrice();
        if (refPrice) refFrom = 'на начало ставки';
      }
      // Цена из сигнала может быть от другого инструмента (перепутанный
      // поток) или с другим масштабом. Сверяем с ценой страницы: расхождение
      // в разы значит, что сравнивать их бессмысленно.
      if (sig.price) {
        const nowPx = await pagePrice();
        if (nowPx && (nowPx / sig.price > 1.2 || sig.price / nowPx > 1.2)) {
          log(`цена из сигнала ${sig.price}, а на странице ${nowPx} - это разные величины, `
            + 'проверку цены веду от страницы');
          refPrice = nowPx; refFrom = 'на начало ставки';
        }
      }
      if (refPrice) log(`цена ${refFrom}: ${refPrice}`);
      else log('цену на странице прочитать не удалось - проверка цены входа пропущена');
    }

    // залогинены ли мы: на странице не должно быть кнопки Log In
    const loginBtn = page.locator(EX.selectors.loginMarker).first();
    if (await loginBtn.count() > 0 && await loginBtn.isVisible().catch(() => false)) {
      await shot('not-logged-in');
      throw new Error('НЕ ЗАЛОГИНЕН - выполни: node executor.js login');
    }

    // ── время экспирации ──
    // Экспирация НЕ подтверждается ничем, кроме выбранного чипа, поэтому
    // ошибиться тут значит открыть ставку не на те минуты - и прочитать
    // выплату чужой экспирации.
    const tfText = EX.timeUnitText[String(sig.timing)] || '10m';
    const tf = await ensureTimeframe(tfText);
    if (tf.missing) {
      await shot('no-expiry');
      await dumpPage('no-expiry');
      throw new Error(`чип экспирации "${tfText}" не найден - смотри ДАМП выше`);
    }
    if (tf.ok) {
      // «по памяти» видно в журнале намеренно: если однажды окажется, что
      // память врёт, найти это можно будет только по этой пометке.
      tfHow = tf.how || '';
      log(`экспирация ${tfText} выбрана`
        + (tf.tries ? ` (нажатий: ${tf.tries}, ${tf.how})` : (tf.how ? ` (${tf.how})` : '')));
    } else if (tf.cur == null) {
      // Непроверяемый выбор экспирации - ставка вслепую на чужих условиях.
      if (EX.requireTimeframeCheck === false) {
        log(`экспирация ${tfText}: проверить выбор нечем, но проверка отключена в конфиге - ставлю`);
      } else {
        log(`пропуск ${sig.asset} ${sig.direction}: не удалось убедиться, что выбрана экспирация ${tfText}`
          + ' - ставка на чужой экспирации хуже пропущенной');
        await shot('expiry-unverified');
        await dumpPage('expiry-unverified');
        return { status: 'skip-expiry' };
      }
    } else {
      await shot('expiry-mismatch');
      throw new Error(`экспирация не переключилась на ${tfText}, на странице выбрана ${tf.cur}`);
    }

    // Рынок может быть закрыт: у SPCX торги идут не круглосуточно, и на
    // выходных вместо кнопок Up/Down висит «Market Closed». Без этой
    // проверки ставка падала бы в ошибку «кнопка не найдена» с дампом -
    // то есть штатная ситуация выглядела бы как поломка селекторов.
    const closed = await page.locator('button, div[role=button]')
      .filter({ hasText: new RegExp(EX.marketClosedText, 'i') })
      .count().catch(() => 0);
    if (closed > 0) {
      log(`пропуск ${sig.asset}: рынок закрыт`);
      await shot('market-closed');
      return { status: 'skip-market-closed' };
    }

    // ── выплата ──
    // На MEXC это страховка: сигнал уже отобран по payout источником, а на
    // странице он мог сползти. На Toobit это единственная проверка вообще -
    // туда сигналы приходят без выплаты, и ставить, не прочитав её со
    // страницы, значит ставить вслепую. Отсюда requirePagePayout: не
    // прочитали - не ставим.
    // Проверку можно выключить: тогда страницу не читаем вовсе и экономим
    // секунду-полторы. Смысл в этом есть только если выплату уже отобрал
    // источник сигнала - иначе ставка идёт вслепую.
    const pv = EX.checkPayout ? await pagePayout(sig.direction) : null;
    if (!EX.checkPayout) log('проверка выплаты выключена - беру условия страницы как есть');
    const need = EX.minPayout;
    const cmp = EX.minPayoutStrict ? 'больше' : 'не меньше';
    if (pv == null && !EX.checkPayout) {
      // Выключена намеренно - не жалуемся и не отказываем.
    } else if (pv == null) {
      if (EX.requirePagePayout) {
        log(`пропуск ${sig.asset} ${sig.direction}: выплату на странице ${EX.title} прочитать не удалось, `
          + `а она обязательна (нужно ${cmp} ${need}%) - смотри ДАМП ниже`);
        await shot('payout-unknown');
        await dumpPage('payout-unknown');
        return { status: 'skip-payout-unknown' };
      }
      log('выплату на странице прочитать не удалось - иду дальше, порог проверял источник сигнала');
    } else if (EX.minPayoutStrict ? pv <= need : pv < need) {
      // Раньше этот исход писался только в bets.csv, и в логе ставка
      // просто обрывалась после «панель готова» - выглядело как зависание.
      log(`пропуск ${sig.asset} ${sig.direction}: выплата на странице ${pv}%, нужно ${cmp} ${need}%`);
      await shot('payout-low');
      return { status: 'skip-payout', payoutPage: pv };
    } else {
      const pair = lastPayouts
      ? ` [${EX.dirWords.UP || 'Up'} ${lastPayouts.UP}% / ${EX.dirWords.DOWN || 'Down'} ${lastPayouts.DOWN}%, ${lastPayouts.how}]`
      : '';
    payoutPair = lastPayouts ? `${lastPayouts.UP}/${lastPayouts.DOWN}` : '';
    log(`выплата на странице ${pv}% (нужно ${cmp} ${need}%)${pair}`);
    }

    // Поле суммы уже найдено при ожидании панели
    const amount = ready.loc;
    await humanFill(amount, betStake(sig));
    await page.waitForTimeout(randInt(250, 700));

    // кнопка Up / Down
    const btnSel = sig.direction === 'UP' ? EX.selectors.up : EX.selectors.down;
    const dirWord = EX.dirWords[sig.direction] || (sig.direction === 'UP' ? 'Up' : 'Down');
    // Сначала ТОЧНОЕ совпадение по тексту. По диагностике на странице
    // ровно одна кнопка "Up" и одна "Down", а :has-text() ищет подстроку
    // и поймал бы, например, "Upgrade", появись такая кнопка позже.
    // Если точного нет - откатываемся на селектор из конфига.
    let btn = page.locator('button').filter({ hasText: wordRe(dirWord) }).first();
    if (await btn.count() === 0) btn = page.locator(btnSel).first();
    // Третий заход: элемент с таким текстом, каким бы тегом он ни был. На
    // Toobit «кнопки» Up/Down - обычные div, и в списке кнопок страницы их
    // нет вовсе; getByText находит самый глубокий узел с точным текстом.
    if (await btn.count() === 0) {
      btn = page.getByText(wordRe(dirWord)).first();
      if (await btn.count() > 0) log(`кнопка ${dirWord} найдена по тексту, а не по селектору`);
    }
    if (await btn.count() === 0) {
      await shot('no-button');
      await dumpPage('no-button');
      throw new Error('кнопка не найдена: ' + btnSel + ' - смотри ДАМП выше');
    }

    // ── последняя проверка перед нажатием ──
    // Между началом ставки и кликом страницу могли увести: расписание
    // открывает вкладки, холостое действие бродит по бирже. Locator суммы
    // остаётся привязан к своей странице, а кнопка направления ищется
    // заново - и жать её можно было уже на чужой вкладке. Ровно так сигнал
    // по SPCX открыл позицию по BTC.
    if (page !== myPage) {
      log('!! вкладка подменилась во время ставки - возвращаю свою');
      page = myPage;
    }
    const seenNow = await pageAsset();
    const drift = !page.url().startsWith(url)
      ? `адрес стал ${page.url()} вместо ${url}`
      : (seenNow && seenNow !== sig.asset ? `на странице ${seenNow}, а сигнал по ${sig.asset}` : null);
    if (drift) {
      const moves = pageNav(page) - navAt;
      await shot('page-drifted');
      if (attempt < 3) {
        recover = attempt === 1 ? 'load' : 'ui';
        log(`страница уехала сама (${drift}; переходов после проверок: ${moves}) - `
          + (recover === 'ui' ? 'пробую выбрать актив на самой странице'
                              : 'возвращаю и играю ставку заново'));
        continue;
      }
      // Три захода подряд - это не случайность. Либо инструмент сейчас не
      // торгуется и биржа уводит на соседний, либо в конфиге не тот адрес.
      // Различить помогает список символов, которые биржа показывает.
      // Отказ, а НЕ ошибка: серия ошибок загоняет исполнитель в DRY-RUN,
      // а тут виновата биржа, а не поломка.
      const syms = await pageSymbols(true);
      log(`пропуск ${sig.asset} ${sig.direction}: биржа трижды увела со своего адреса (${drift}).`
        + ' Символы, которые она сейчас показывает: '
        + (syms.length ? syms.join(', ') : 'прочитать не удалось')
        + `. Если ${sig.asset} среди них нет, инструмент сейчас не торгуется;`
        + ' если есть - проверь URL актива в конфиге.');
      await dumpPage('page-drifted');
      return { status: 'skip-redirect', payoutPage: pv, note: drift };
    }

    // ── выплата не сдвинулась, пока мы собирались ──
    // Последняя и самая надёжная проверка экспирации: она смотрит не на
    // чипы, а на условия, по которым ставка реально откроется. Если
    // страница между чтением выплаты и нажатием переехала на другую
    // экспирацию - хоть сама, хоть из-за нашего промаха, - выплата
    // изменится на десятки пунктов, и мы это увидим. Ровно так ставка
    // ушла на 5 минут с 66%, пока журнал писал 10 минут и 80%.
    if (pv != null && EX.checkPayout) {
      const pvNow = await pagePayout(sig.direction);
      if (pvNow != null && Math.abs(pvNow - pv) > payoutDriftPts()) {
        log(`пропуск ${sig.asset} ${sig.direction}: выплата поехала с ${pv}% на ${pvNow}% `
          + 'между проверкой и нажатием - это чужая экспирация, ставку не делаю');
        await shot('payout-moved');
        await dumpPage('payout-moved');
        forgetTf();
        return { status: 'skip-payout-moved', payoutPage: pvNow,
                 note: `выплата ${pv}% → ${pvNow}%` };
      }
    }

    // ── цена входа ──
    // От сигнала до нажатия проходит от десяти секунд до минуты: пачка
    // ждёт своё окно, страница собирается, экспирация подтверждается.
    // За это время цена успевает откатиться, и вход получается хуже того,
    // на который сигнал рассчитывали. Ставка вверх тем лучше, чем ниже
    // цена входа; вниз - наоборот. Сравнение стоит один вызов и делается
    // последним, чтобы цена была самой свежей.
    let entryPrice = null, advPct = null;
    if (guard.enabled !== false && refPrice) {
      entryPrice = await pagePrice();
      if (entryPrice == null) {
        if (guard.strict) {
          log(`пропуск ${sig.asset} ${sig.direction}: цену перед нажатием прочитать не удалось, `
            + 'а проверка цены обязательна');
          return { status: 'skip-price-unknown' };
        }
        log('цену перед нажатием прочитать не удалось - иду дальше без проверки');
      } else if (entryPrice / refPrice > 1.2 || refPrice / entryPrice > 1.2) {
        // Две цены одной страницы, снятые с разницей в секунды, не могут
        // отличаться в разы. Значит одно из чтений - мусор: заголовок ещё
        // не прорисовался или поймалось чужое число. Сравнивать их
        // нельзя - отсюда в журнале взялось «цена лучше на 99921%».
        // Ставку из-за этого не отменяем: виновата проверка, а не сигнал.
        log(`цена входа ${entryPrice}, а точка отсчёта ${refPrice} (${refFrom}) - `
          + 'это разные величины, проверку цены пропускаю');
        entryPrice = null;
      } else {
        // Насколько цена ушла ПРОТИВ нас, в процентах.
        advPct = ((entryPrice - refPrice) / refPrice) * 100 * (sig.direction === 'UP' ? 1 : -1);
        const lim = guard.requireBetter ? 0 : Math.abs(guard.maxAdversePct ?? 0.05);
        const moved = advPct > 0
          ? `хуже на ${advPct.toFixed(3)}%`
          : `лучше на ${(-advPct).toFixed(3)}%`;
        if (advPct > lim) {
          log(`пропуск ${sig.asset} ${sig.direction}: цена входа ${entryPrice} против ${refPrice} `
            + `(${refFrom}) - ${moved}, порог ${lim}%`);
          await shot('price-worse');
          return { status: 'skip-price', payoutPage: pv, entryPrice, advPct };
        }
        log(`цена входа ${entryPrice} против ${refPrice} (${refFrom}) - ${moved}, порог ${lim}%`);
      }
    }

    if (state.dryRun) {
      await shot(`dryrun-${sig.asset}-${sig.direction}`);
      log(`DRY-RUN: дошёл до кнопки ${sig.direction}, ставка ${betStake(sig)} USDT, payout ${pv}% - не нажимаю`);
      return { status: 'dry-run', payoutPage: pv, entryPrice, advPct, tfHow, payoutPair };
    }

    const posBefore = await openPositionsCount();
    await humanClick(btn);
    await page.waitForTimeout(randInt(500, 900));
    // возможное окно подтверждения
    if (EX.selectors.confirm) {
      const c = page.locator(EX.selectors.confirm).first();
      if (await c.count() > 0 && await c.isVisible().catch(() => false)) await humanClick(c);
    }

    // Клик сам по себе не доказывает, что ставка открылась: он мог не
    // дойти, форма могла отклонить сумму, могло всплыть окно. Считаем
    // ставку размещённой только когда выросло число открытых позиций.
    const posAfter = await waitPositionsGrow(posBefore, CFG.confirmTimeoutMs ?? 9000);
    await shot(`bet-${sig.asset}-${sig.direction}`);

    if (posBefore == null) {
      log(`ставка отправлена за ${Date.now() - t0}мс, счётчик позиций прочитать не удалось`);
      return { status: 'placed-unverified', payoutPage: pv };
    }
    if (posAfter == null) {
      log(`!! клик прошёл, но позиций как было ${posBefore}, так и осталось`);
      await dumpPage('not-confirmed');
      await tgAlert(`клик по ${sig.asset} ${sig.direction} прошёл, но позиция НЕ появилась - проверь биржу вручную`);
      return { status: 'placed-unconfirmed', payoutPage: pv };
    }
    log(`ставка открыта за ${Date.now() - t0}мс, позиций: ${posBefore} -> ${posAfter}`);
    return { status: 'placed', payoutPage: pv, entryPrice, advPct, tfHow, payoutPair };
  }
  // Сюда не приходим: обе попытки заканчиваются возвратом или отказом.
  throw new Error('ставка не доиграна');
}

// ── источник: лист MEXCsignal ──
// Вебхук через туннель - самое хрупкое место всей схемы: адрес меняется
// при каждом запуске cloudflared, а на время обрыва сигналы теряются
// НАВСЕГДА (Apps Script шлёт и забывает, очереди нет). При этом лист
// MEXCsignal и так система записи - каждый принятый веткой сигнал в нём
// уже лежит. Поэтому исполнитель просто ходит за ними сам.
//
// Метка прочитанного - количество строк данных, а не дата: формат даты
// в gviz зависит от локали таблицы, а число строк не зависит ни от чего.
// На старте метка ставится по текущему количеству, иначе первый же опрос
// отыграл бы всю историю сигналов.
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// "dd.mm.yyyy HH:MM:SS" (формат листа) либо что-то, что понимает Date.
function parseSheetTime(v) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})[ ,]+(\d{1,2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

async function pollSheet() {
  const S = CFG.sheet || {};
  if ((CFG.source || 'webhook') !== 'sheet' || !S.id) return;
  const url = `https://docs.google.com/spreadsheets/d/${S.id}/gviz/tq?tqx=out:csv&sheet=`
            + encodeURIComponent(S.tab || 'MEXCsignal');
  let rows;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    rows = csvRows(await r.text());
  } catch (e) {
    state.sheetError = e.message;
    // Не шумим на каждый неудачный опрос: сеть моргает, а опрос частый.
    if (!state.sheetErrorLogged) { log('лист не прочитался: ' + e.message); state.sheetErrorLogged = true; }
    return;
  }
  state.sheetError = null;
  state.sheetErrorLogged = false;
  state.sheetPolledAt = Date.now();

  const data = rows.slice(1).filter(r => r.length > 2 && (r[1] || '').trim());
  if (state.sheetRows == null) {
    state.sheetRows = data.length;
    saveState();
    log(`лист ${S.tab || 'MEXCsignal'}: ${data.length} строк, слежу за новыми`);
    return;
  }
  if (data.length <= state.sheetRows) {
    // Строк стало меньше - лист правили руками. Просто переставляем метку.
    if (data.length < state.sheetRows) {
      log(`лист укоротился (${state.sheetRows} -> ${data.length}), метка переставлена`);
      state.sheetRows = data.length;
      saveState();
    }
    return;
  }

  const fresh = data.slice(state.sheetRows);
  state.sheetRows = data.length;
  saveState();
  for (let i = 0; i < fresh.length; i++) {
    const r = fresh[i];
    // Колонки листа: A Time, B Ticker, C Direction, ... J Payout, K Timing
    // Цена сигнала, если она в листе есть. Колонку называешь сам:
    // sheet.priceCol - буква ("D") или номер с нуля. Не задана - точкой
    // отсчёта для проверки цены станет цена на начало ставки.
    const pc = (CFG.sheet || {}).priceCol;
    const pi = typeof pc === 'string' && /^[A-Za-z]$/.test(pc)
      ? pc.toUpperCase().charCodeAt(0) - 65
      : (Number.isInteger(pc) ? pc : null);
    const sig = {
      ticker: r[1], direction: r[2], payout: parseFloat(r[9]) || null,
      price: pi == null ? undefined : r[pi],
      timing: r[10] || 'MEXC _10m',
      receivedAt: parseSheetTime(r[0]) || Date.now(),
      // Номер строки - естественный уникальный ключ: повторный опрос той
      // же строки не создаст вторую ставку даже при сбое метки.
      dedupKey: 'row' + (state.sheetRows - fresh.length + i + 1),
    };
    if (!normalizeSignal(sig)) { log('строка листа непонятна: ' + JSON.stringify(r.slice(0, 3))); continue; }
    acceptSignal(sig, 'лист');
  }
}

// ── приём сигнала ──
// Один набор правил на оба источника. Раньше проверки жили внутри
// обработчика HTTP, и сигнал из таблицы прошёл бы мимо тихих часов,
// лимитов и дедупа - то есть мимо всего, ради чего они существуют.
// Биржа, названная в самом сигнале: поле exchange или префикс тикера
// вида "TOOBIT:ETHUSDT". Пусто - значит не сказано.
function namedExchange(sig) {
  const names = exNames();
  const raw = String(sig.exchange || sig.ex || '').toLowerCase().trim();
  if (raw) {
    const hit = names.find(n => n.toLowerCase() === raw)
             || names.find(n => raw.includes(n.toLowerCase()));
    if (hit) return hit;
  }
  const t = String(sig.ticker || '').toLowerCase();
  return names.find(n => t.includes(n.toLowerCase())) || '';
}
// Биржа по метке потока в поле "timing": "10m" - PRO, "MEXC _10m" -
// ветка MEXC. Метку сравниваем целиком, поэтому "ALT10m" ничего не
// заденет. Если биржа этой метки не торгует таким активом - молчим и
// пропускаем ход дальше, чем ставить ETH туда, где его нет.
function exchangeByTiming(sig, asset) {
  const raw = String(sig.timing ?? '').toLowerCase().trim();
  if (!raw) return '';
  let hit = exNames().find(n => exCfg(n).signalTimings.includes(raw));
  // Метка вида "TOOBIT_10m" / "MEXC_30m" называет биржу прямо в себе.
  // Разбираем префикс, даже если такую метку не успели прописать в
  // signalTimings: источник может завести новую в любой момент.
  if (!hit) {
    const pre = raw.split(/[ _:-]/)[0];
    hit = exNames().find(n => n.toLowerCase() === pre);
  }
  if (!hit) return '';
  if (asset && !(exCfg(hit).urls || {})[asset]) return '';
  return hit;
}
function allAssets() {
  const out = new Set();
  for (const n of exNames()) for (const a of Object.keys(exCfg(n).urls || {})) out.add(a);
  return [...out];
}

function normalizeSignal(sig) {
  // Сначала биржа: если она названа, актив ищем только среди её активов.
  let ex = namedExchange(sig);
  // Актив определяем по ключам urls, а не по зашитому списку: добавить
  // новый актив должно быть можно одной строкой в конфиге. Длинные
  // тикеры проверяем первыми, иначе короткий совпал бы как подстрока.
  if (!sig.asset) {
    const t = String(sig.ticker || '').toUpperCase();
    const pool = ex ? Object.keys(exCfg(ex).urls || {}) : allAssets();
    // Тикер бывает написан и ключом, и биржевым символом: "NVDA/USDT" и
    // "NVIDIA_USDT" - один актив, а общих букв у них нет вовсе. Поэтому
    // у каждого ключа проверяем оба написания.
    const names = k => {
      const out = new Set([String(k).toUpperCase()]);
      for (const n of (ex ? [ex] : exNames())) {
        const sym = (exCfg(n).symbols || {})[k];
        if (sym) out.add(String(sym).toUpperCase());
      }
      return [...out];
    };
    sig.asset = pool
      .map(k => [k, Math.max(...names(k).map(x => x.length))])
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .find(k => names(k).some(x => t.includes(x))) || '';
  }
  // Биржу не назвали - смотрим на метку потока, потом на актив: если он
  // торгуется ровно на одной бирже, вопрос решён. Иначе биржа по
  // умолчанию. Молча раскидывать один и тот же тикер по двум биржам
  // нельзя - это разные деньги и разные лимиты.
  if (!ex) ex = exchangeByTiming(sig, sig.asset);
  if (!ex) {
    const own = exOfAsset(sig.asset);
    ex = own.length === 1 ? own[0] : defaultEx();
    // Метка потока есть, но её никто не заявил. Ставку не отменяем -
    // она уйдёт на биржу по умолчанию, как было до маршрутизации по
    // меткам, - но в логе это должно быть видно: чужой поток, случайно
    // направленный в исполнитель, иначе торговал бы молча.
    const raw = String(sig.timing ?? '').trim();
    if (raw && exNames().some(n => exCfg(n).signalTimings.length)
        && !exNames().some(n => exCfg(n).signalTimings.includes(raw.toLowerCase()))) {
      log(`!! метка потока "${raw}" не заявлена ни одной биржей - `
        + `${sig.asset || 'сигнал'} идёт на ${exCfg(ex).title} по умолчанию`);
    }
  }
  sig.ex = ex;
  sig.direction = String(sig.direction || '').toUpperCase();
  if (sig.direction === 'BUY') sig.direction = 'UP';
  if (sig.direction === 'SELL') sig.direction = 'DOWN';
  // Метку потока запоминаем ДО того, как timing превратится в число:
  // в журнале «10» и «30» не отвечают на вопрос, из какой ветки пришёл
  // сигнал, а разбираться приходится именно по ней.
  const rawTag = String(sig.timing ?? '').trim();
  if (rawTag) sig.tag = rawTag;
  // Метка обычно сама говорит минуты: "MEXC_30m", "ALT10m". Если не
  // говорит ни того, ни другого, а активу разрешена ровно одна
  // экспирация - берём её: молчание метки не то же самое, что "10m", и
  // отбивать из-за него ставку по активу, у которого другого времени и
  // не бывает, значит терять сигнал на пустом месте. Явное "10" в метке
  // при этом остаётся явным: его не переписываем, такая ставка честно
  // отобьётся по списку активa.
  if (/30/.test(rawTag)) sig.timing = 30;
  else if (/10/.test(rawTag)) sig.timing = 10;
  else {
    const only = timingsFor(sig.asset, ex);
    sig.timing = only.length === 1 ? Number(only[0]) : 10;
    if (only.length === 1 && sig.timing !== 10) {
      log(`метка "${rawTag || '-'}" о минутах молчит, у ${sig.asset} разрешена одна `
        + `экспирация - беру ${sig.timing}м`);
    }
  }
  // Цена из сигнала. TradingView шлёт её как {{close}}; поле называют
  // по-разному, поэтому принимаем любое из привычных имён. Нет цены -
  // не беда: за точку отсчёта возьмём цену на момент начала ставки.
  const px = parsePrice(sig.price ?? sig.close ?? sig.entry ?? sig.signalPrice ?? sig.px);
  if (px) sig.price = px; else delete sig.price;
  return !!(exCfg(ex).urls || {})[sig.asset]
      && (sig.direction === 'UP' || sig.direction === 'DOWN');
}

// ── пробуждение вне смены ──
// Расписание задумывалось как жёсткие ворота: вне смены сигналы
// отклоняются. Но половина отказов приходилась именно на них, и часть из
// них - хорошие сигналы с высокой выплатой. Пробуждение оставляет ворота
// на месте, но даёт им щёлку: биржа открывается ПОД КОНКРЕТНЫЙ сигнал,
// проходит все обычные проверки (актив, экспирация, выплата, цена) и,
// если всё сошлось, ставит - а потом закрывается обратно по расписанию.
//
// Щёлка узкая намеренно. Аккаунт, который просыпается на каждый сигнал
// круглые сутки, - это ровно тот след, ради которого расписание и
// заводили: смысла в нём тогда не остаётся вовсе. Поэтому пробуждений
// считанное число в сутки и между ними обязательная пауза.
function wakesToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return (state.wakes || []).filter(t => t >= start.getTime());
}
function wakeCheck(ex) {
  const W = exCfg(ex).wakeOnSignal || {};
  if (W.enabled !== true) return { ok: false };
  const max = Math.max(0, Math.round(W.maxPerDay ?? 6));
  const done = wakesToday();
  if (done.length >= max) {
    return { ok: false, why: `пробуждений сегодня уже ${done.length}/${max}` };
  }
  const gapMin = Math.max(0, W.minGapMin ?? 20);
  const last = done.length ? Math.max(...done) : 0;
  const waited = (Date.now() - last) / 60000;
  if (last && waited < gapMin) {
    return { ok: false, why: `прошлое пробуждение ${waited.toFixed(0)} мин назад, нужно ${gapMin}` };
  }
  return { ok: true, left: max - done.length, max };
}
function markWake(ex) {
  state.wakes = [...wakesToday(), Date.now()];
  saveState();
  const W = exCfg(ex).wakeOnSignal || {};
  const max = Math.max(0, Math.round(W.maxPerDay ?? 6));
  log(`${exCfg(ex).title}: пробуждение вне смены ${state.wakes.length}/${max} за сутки`
    + ' - открываю биржу под сигнал');
}

// Возвращает 'queued' | 'merged' | причину отказа.
function acceptSignal(sig, src) {
  const mode = state.dryRun ? 'DRY' : 'LIVE';
  const skip = (reason, status, msg) => {
    if (msg) log(`пропуск (${src}): ${msg}`);
    if (status) logBet({ ...sig, stake: stakeFor(sig.asset, sig.ex), mode, status });
    return reason;
  };

  const allow = timingsFor(sig.asset, sig.ex);
  if (allow.indexOf(sig.timing) < 0) {
    const own = (exCfg(sig.ex).assetTimings || {})[sig.asset];
    return skip('timing', null,
      `${exCfg(sig.ex).title}: экспирация ${sig.timing}м не в списке `
      + `(${allow.length ? allow.join(', ') + 'м' : 'разрешённых не осталось'}`
      + `${own ? `; у ${sig.asset} свой список ${own.join(', ')}м, общий `
        + `${exCfg(sig.ex).execTimings.join(', ')}м` : ''})`);
  }
  if (!inActiveHours(null, sig.ex)) {
    // Пробуждение проверяем ДО отказа: может быть, эту ставку всё-таки
    // стоит сыграть. Счётчик тратится не здесь, а перед самой ставкой -
    // иначе пачка из трёх сигналов сожгла бы три пробуждения на одну.
    const w = wakeCheck(sig.ex);
    if (!w.ok) {
      return skip('quiet-hours', 'skip-quiet',
        `${exCfg(sig.ex).title}: тихие часы (сегодня ${todayWindows(sig.ex)})`
        + (w.why ? `; ${w.why}` : ''));
    }
    sig.wake = true;
  }
  if (state.paused) {
    return skip('paused', null, 'исполнитель на паузе');
  }
  const dirBusy = dirSlots(sig.direction, sig.asset, sig.ex)
    + state.queue.filter(q => q.direction === sig.direction && q.asset === sig.asset && q.ex === sig.ex).length;
  if (dirBusy >= dirLimit(sig.direction)) {
    return skip('dir-limit', 'skip-dir-limit',
      `${sig.asset} ${sig.direction} уже ${dirBusy}/${dirLimit(sig.direction)} в окне`);
  }
  // Слоты - ограничение самой биржи, поэтому и очередь считаем по ней же.
  const capacity = exCfg(sig.ex).maxOpenBets;
  const busySlots = openSlots(sig.ex) + state.queue.filter(q => q.ex === sig.ex).length;
  if (busySlots >= capacity) {
    return skip('slots', 'skip-slots', `${exCfg(sig.ex).title}: занято слотов ${busySlots}/${capacity}`);
  }

  // новый день - сброс дневного счётчика
  const today = new Date().toDateString();
  if (today !== state.day) { state.day = today; state.betsToday = 0; }
  if (!state.dryRun && state.betsToday >= (CFG.maxBetsPerDay ?? 40)) {
    return skip('daily-limit', null, 'дневной лимит ставок достигнут');
  }

  // Дедуп повторных доставок. Ключ - ВРЕМЯ ДОСТАВКИ, а не свеча:
  // Apps Script умеет повторить отправку при таймауте, и тело у повтора
  // побайтово то же, включая receivedAt. А два настоящих сигнала по
  // одной свече приходят с разным receivedAt - раньше ключ по bartime
  // считал их одним и молча выбрасывал второй и третий.
  const now = Date.now();
  // Биржа входит в ключ: ETH UP на MEXC и ETH UP на Toobit - две разные
  // ставки разными деньгами, и вторая не повтор первой. Без этого при
  // двух биржах второй сигнал молча пропадал бы как дубль.
  const key = `${sig.ex}|${sig.asset}|${sig.direction}|${sig.timing}`
    + `|${sig.dedupKey || sig.receivedAt || sig.bartime || sig.sentAt}`;
  state.recent = state.recent.filter(r => now - r.t < 120000);
  if (state.recent.some(r => r.key === key)) return 'duplicate';
  state.recent.push({ key, t: now });

  sig.receivedAt = sig.receivedAt && !isNaN(Date.parse(sig.receivedAt))
    ? Math.min(Date.parse(sig.receivedAt), now) : now;
  state.lastSignalAt = now;
  state.silenceAlerted = false;
  saveState();
  log(`сигнал принят (${src}): ${exCfg(sig.ex).title} ${sig.asset} ${sig.direction} ${sig.timing}м payout=${sig.payout}`);
  return enqueueSignal(sig);
}

// ── пачки сигналов ──
// Несколько сигналов одного направления подряд - это один и тот же
// заход. Три отдельные ставки по нему проигрывают одной тройной: вход
// размазывается на десяток секунд (ставки идут строго по одной), а три
// биржевых слота из пяти оказываются заняты на всю экспирацию. Поэтому
// первые burst.windowSec секунд собираем пачку и ставим один раз суммой.
//
// Ждать приходится по необходимости: узнать, что сигналов три, можно
// только дав им прийти. Ценой этого одиночный вход тоже задерживается
// на окно сбора.
const groups = new Map();
function burstCfg() {
  const b = CFG.burst || {};
  return {
    enabled: b.enabled !== false,
    windowMs: Math.max(0, b.windowSec ?? 3) * 1000,
    max: Math.max(1, Math.round(b.maxMultiplier ?? 3)),
  };
}
// Ставка с учётом множителя, прижатая к потолку поля ввода на бирже.
function betStake(sig) {
  // Считаем ОДИН раз на сигнал и запоминаем. Раньше функция была чистой,
  // и звать её сколько угодно раз было безопасно; с разбросом каждый
  // вызов давал бы своё число - в журнал попало бы одно, в поле биржи
  // другое, и сверить их стало бы невозможно.
  if (sig._stake != null) return sig._stake;
  // Сумма, названная явно (ручная ставка из панели), важнее настройки:
  // человек нажал её сам, и трогать её разбросом нельзя. Границы всё
  // равно биржевые.
  if (sig.stake) {
    return (sig._stake = Math.round(clamp(sig.stake, MANUAL_STAKE_MIN, stakeMax(sig.asset, sig.ex), stakeFor(sig.asset, sig.ex))));
  }
  const base = stakeFor(sig.asset, sig.ex);
  const m = Math.max(1, Math.min(sig.mult || 1, burstCfg().max));
  // Разброс. Ровно 20.00 USDT изо дня в день - самое машинное, что есть
  // в схеме: живой человек то добавит, то убавит. Процент свой у каждой
  // биржи; ноль - как было, ровная сумма.
  const jit = Math.abs(exCfg(sig.ex).stakeJitterPct ?? 0);
  const k = jit ? 1 + (Math.random() * 2 - 1) * jit / 100 : 1;
  const want = Math.round(base * m * k);
  // Границы биржи важнее разброса: единица снизу (меньше не примут) и
  // потолок поля ввода сверху. Множитель пачки считаем от РОВНОЙ суммы,
  // чтобы разброс не превращал x3 в x2.6.
  const top = stakeMax(sig.asset, sig.ex);
  return (sig._stake = Math.max(1, Math.min(want, top)));
}
function enqueueSignal(sig) {
  const B = burstCfg();
  if (!B.enabled || !B.windowMs) {
    sig.mult = 1; sig.burstCount = 1;
    state.queue.push(sig);
    setImmediate(pump);
    return 'queued';
  }
  // Ключ пачки включает биржу И время экспирации. Биржу - потому что
  // один и тот же ETH UP на MEXC и на Toobit это разные деньги.
  // Экспирацию - потому что 10-минутный и 30-минутный сигналы это разные
  // ставки на разные свечи: без неё они складывались в одну, и ставка
  // уходила на экспирацию того сигнала, что пришёл первым.
  const k = `${sig.ex}|${sig.asset}|${sig.direction}|${sig.timing}`;
  const g = groups.get(k);
  if (g) {
    g.count++;
    log(`пачка ${k}: сигнал ${g.count} присоединён к текущей`);
    logBet({ ...sig, stake: stakeFor(sig.asset, sig.ex), mode: state.dryRun ? 'DRY' : 'LIVE',
             // Время МЕСТНОЕ, как и весь остальной журнал. В UTC запись
             // «в пачку с 17:55:04» стояла рядом со строкой 19:55:07, и
             // выглядело это так, будто сигнал приклеили к двухчасовой
             // давности пачке.
             status: 'merged', note: `в пачку с ${new Date(g.sig.receivedAt).toLocaleTimeString('ru-RU', { hour12: false })}` });
    return 'merged';
  }
  const ng = { sig, count: 1 };
  groups.set(k, ng);
  const t = setTimeout(() => {
    groups.delete(k);
    ng.sig.burstCount = ng.count;
    ng.sig.mult = Math.min(ng.count, B.max);
    state.queue.push(ng.sig);
    if (ng.count > 1) {
      log(`пачка ${k}: сигналов ${ng.count}, ставка x${ng.sig.mult} = ${betStake(ng.sig)} USDT`);
    }
    setImmediate(pump);
  }, B.windowMs);
  if (t.unref) t.unref();
  return 'queued';
}

// ── очередь (ставки строго по одной) ──
async function pump() {
  if (state.busy) return;
  const sig = state.queue.shift();
  if (!sig) return;
  state.busy = true;
  const mode = state.dryRun ? 'DRY' : 'LIVE';
  try {
    // свежесть: 10-минутная ставка старше N сек не имеет смысла
    const age = (Date.now() - sig.receivedAt) / 1000;
    if (age > (CFG.maxSignalAgeSec ?? 90)) {
      log(`пропуск: сигнал устарел (${age.toFixed(0)}с) ${sig.asset} ${sig.direction}`);
      logBet({ ...sig, stake: betStake(sig), mode, status: 'skip-stale' });
    } else if (process.env.TEST_MODE === '1') {
      logBet({ ...sig, stake: stakeFor(sig.asset, sig.ex), mode, status: 'test-mode' });
    } else {
      // Пробуждение тратится ровно на ту ставку, что сейчас пойдёт: пачка
      // уже собрана в один сигнал, отказ по свежести остался позади.
      if (sig.wake) {
        markWake(sig.ex);
        if (!browserOpen()) log('биржа спала - холодный старт займёт лишние секунды');
      }
      const r = await placeBet(sig);
      // Заметка складывается: множитель пачки и, если цена участвовала в
      // решении, насколько вход отличался от сигнала. Без этого пропуск
      // по цене выглядел бы в журнале необъяснимым.
      const notes = [];
      if (sig.mult > 1) notes.push(`x${sig.mult} из ${sig.burstCount} сигналов`);
      if (r.advPct != null) {
        notes.push(`цена ${r.entryPrice} ${r.advPct > 0 ? 'хуже' : 'лучше'} на ${Math.abs(r.advPct).toFixed(3)}%`);
      }
      if (r.note) notes.push(r.note);
      // Способ подтверждения экспирации пишем только когда он не самый
      // надёжный: разметка сомнений не вызывает, а «по памяти» и «по
      // смене выплат» - те два пути, на которых ставка когда-то уходила
      // на чужие минуты.
      if (r.tfHow && r.tfHow !== 'по разметке' && r.tfHow !== 'мышью') notes.push(`экспирация ${r.tfHow}`);
      if (r.payoutPair) notes.push(`выплаты ${r.payoutPair}`);
      logBet({ ...sig, stake: betStake(sig), mode, status: r.status, payoutPage: r.payoutPage,
               note: notes.join('; ') });
      // Слот занимаем и в dry-run: иначе прогон не покажет, сколько
      // сигналов реально упрётся в биржевой лимит.
      // 'placed-unconfirmed' и '-unverified' тоже занимают слот и лимит:
      // позиция могла открыться, и считать иначе значило бы рисковать
      // превышением биржевого лимита.
      const counts = ['placed', 'placed-unconfirmed', 'placed-unverified'];
      if (counts.includes(r.status) || r.status === 'dry-run') {
        state.placed.push({ t: Date.now(), dir: sig.direction, asset: sig.asset,
                            timing: sig.timing, ex: sig.ex });
      }
      if (counts.includes(r.status)) state.betsToday++;
      saveState();
      state.consecutiveErrors = 0;
    }
  } catch (e) {
    state.consecutiveErrors++;
    log(`ОШИБКА ставки ${exCfg(sig.ex).title} ${sig.asset} ${sig.direction}: ${e.message}`);
    logBet({ ...sig, stake: betStake(sig), mode, status: 'error', note: e.message });
    await tgAlert(`ошибка ставки ${sig.asset} ${sig.direction}: ${e.message}`);
    if (state.consecutiveErrors >= (CFG.maxConsecutiveErrors ?? 3) && !state.dryRun) {
      state.dryRun = true;
      log('!! авто-переход в DRY-RUN после серии ошибок');
      await tgAlert('серия ошибок - перешёл в DRY-RUN, ставки остановлены');
    }
  } finally {
    state.busy = false;
    if (state.queue.length) setImmediate(pump);
    else setImmediate(() => afterBetHome(sig));
  }
}

// Вернуться на рабочий актив СРАЗУ после ставки, а не когда-нибудь потом
// с холостым действием. Ставка по BTC оставляла вкладку на BTC, и
// следующий сигнал по ETH начинался с полной перезагрузки страницы -
// девятнадцать секунд из сорока, на которые опаздывал вход. Пока сигнала
// нет, время бесплатное; как только он появился, возврат отменяется и
// страница достаётся ставке.
async function afterBetHome(sig) {
  if (process.env.TEST_MODE === '1') return;
  // Ставка по пробуждению: вкладку всё равно закроет расписание, и
  // возвращать её на рабочий актив незачем - это лишняя минута жизни
  // окна там, где биржа должна спать.
  if (sig.wake) return;
  if (state.busy || state.queue.length || state.paused) return;
  if (!browserOpen() || !inActiveHours(null, sig.ex)) return;
  const E = exCfg(sig.ex);
  const home = homeUrl(E);
  if (!home) return;
  state.busy = true;
  try {
    const p = await pageFor(sig.ex);
    if (p.isClosed() || p.url().startsWith(home)) return;
    // Пауза не для маскировки, а по делу: подряд идущие сигналы одной
    // пачки приходят с разбросом в секунды, и уводить страницу под ними
    // нельзя. idleWait сам прервётся, если в очереди что-то появилось.
    if (!(await idleWait(randInt(4000, 9000)))) return;
    if (state.queue.length) return;
    EX = E; page = p;
    await restoreHome('после ставки');
  } catch (e) {
    log('возврат после ставки не удался: ' + e.message);
  } finally {
    state.busy = false;
    if (state.queue.length) setImmediate(pump);
  }
}

// Рабочее состояние биржи: первый актив из urls и первое время экспирации из
// execTimings. Именно к нему возвращаемся после блужданий.
function homeAsset(E) {
  const all = Object.keys(E.urls || {});
  return E.homeAsset && all.includes(E.homeAsset) ? E.homeAsset : all[0];
}
function homeUrl(E) {
  const a = homeAsset(E);
  return a ? E.urls[a] : null;
}
// Вернуть текущую вкладку к рабочему активу и экспирации. Ошибки глотаем:
// это подготовка к будущей ставке, а не условие текущей.
async function restoreHome(why) {
  try {
    const url = homeUrl(EX);
    if (!page || page.isClosed() || !url) return;
    if (!page.url().startsWith(url)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
      await waitForPanel();
    }
    const tfText = EX.timeUnitText[String((EX.execTimings || [10])[0])] || '10m';
    const r = await ensureTimeframe(tfText);
    log(`${EX.title}: возврат к ${homeAsset(EX)} ${tfText} ${why} - `
      + (r.ok ? 'готово' : `не вышло (выбран ${r.cur ?? 'неизвестно'})`));
  } catch (e) {
    log('возврат в рабочее состояние не удался: ' + e.message);
  }
}

// ── холостая активность ──
// Аккаунт, который заходит на страницу ровно за секунду до ставки и тут
// же уходит, выглядит роботом. Между ставками делаем то, что делает
// живой человек: смотрит другой актив, открывает историю, листает,
// щёлкает время экспирации. Ставок это не касается - только «шум» вокруг них.
// Холостое действие держит ту же блокировку, что и ставка, - иначе они
// дрались бы за страницу. Значит, любая его пауза откладывает пришедший
// сигнал. Поэтому ждём не сплошняком, а поглядывая на очередь: как
// только там что-то появилось, сворачиваемся и отдаём страницу ставке.
const IDLE_ACTIONS = ['switch-asset', 'history', 'scroll', 'timeframe', 'chart'];

async function idleWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state.queue.length) return false;
    await sleep(Math.min(250, until - Date.now()));
  }
  return true;
}

// Живой человек смотрит на график: водит по нему курсором (за курсором
// идёт перекрестье с ценой), приближает и отдаляет, иногда переключает
// интервал. У нас же страница стояла неподвижно между ставками - и
// каждый раз в одном и том же виде.
//
// Интервал графика трогаем ТОЛЬКО если он точно не задевает экспирацию.
// На Toobit подписи совпадают: «5m» и «30m» есть и там, и там, и промах
// означал бы ставку на чужие минуты. Поэтому группа интервалов должна
// быть найдена отдельно от группы экспирации и не содержать ни одной её
// подписи - иначе ограничиваемся курсором и колесом.
async function idleChart() {
  // 1. Полотно графика. У всех бирж он рисуется на canvas, и это самый
  // надёжный способ найти его, не зная вёрстки.
  const box = await page.evaluate(() => {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) continue;
      if (r.width * r.height <= area) continue;
      area = r.width * r.height;
      best = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return best;
  }).catch(() => null);

  if (box) {
    // Перекрестье: ведём курсор по нескольким точкам внутри графика с
    // остановками, как будто разглядываем свечи.
    for (let i = 0, n = randInt(2, 4); i < n; i++) {
      await mouseGlide(page, box.x + rand(box.w * 0.15, box.w * 0.9),
                             box.y + rand(box.h * 0.2, box.h * 0.8));
      if (!(await idleWait(randInt(500, 1800)))) return;
    }
    // Колесо на графике - это масштаб. Возвращаем как было: оставлять
    // чужой масштаб перед ставкой незачем.
    if (Math.random() < 0.5) {
      const n = randInt(1, 3);
      await page.mouse.wheel(0, -n * 120);
      if (!(await idleWait(randInt(700, 2500)))) return;
      await page.mouse.wheel(0, n * 120);
    }
  }

  // 2. Интервал графика - только если он найден отдельно от экспирации.
  const names = EX.chartIntervals || [];
  if (!names.length) return;
  const tfNames = Object.values(EX.timeUnitText).map(t => String(t).toLowerCase());
  const want = names[randInt(0, names.length - 1)];
  const grp = await chipScan(want, names).catch(() => null);
  if (!grp || !grp.box) return;
  // Подпись экспирации внутри группы интервалов - повод не трогать её
  // вовсе: промах означал бы ставку на чужие минуты. Ищем по всему
  // тексту группы, а не по найденным подписям: в ряду «5m 10m 30m 1h»
  // при поиске интервалов графика нашлись бы только 5m и 1h.
  const inText = new RegExp('(^|[^a-z0-9])(' + tfNames.map(t =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')([^a-z0-9]|$)', 'i');
  if ((grp.labels || []).some(l => tfNames.includes(String(l).toLowerCase()))
      || (grp.text && inText.test(grp.text))) {
    if (!chartWarned.has(EX.name)) {
      chartWarned.add(EX.name);
      log(`${EX.title}: рядом с интервалами графика лежат подписи экспирации `
        + `(${JSON.stringify(grp.text)}) - интервал не трогаю, только курсор`);
    }
    return;
  }
  const back = names[0];
  await clickChipByMouse(want, names).catch(() => {});
  if (!(await idleWait(randInt(2000, 6000)))) return;
  // Возвращаем привычный интервал: график, оставшийся на случайном
  // масштабе, - такой же след, как и неподвижный.
  await clickChipByMouse(back, names).catch(() => {});
}
const chartWarned = new Set();

async function idleAction() {
  const I = CFG.idleRotation || {};
  if (I.enabled === false) return;
  // не лезем под руку: идёт ставка / что-то в очереди / пауза / ночь
  if (state.busy || state.queue.length || state.paused) return;
  if (!anyActive()) return;
  if (process.env.TEST_MODE === '1') return;

  // Набор действий выбирается в панели: не всякий вариант уместен
  // (историю, например, можно смотреть и вручную).
  const pool = (Array.isArray(I.actions) && I.actions.length ? I.actions : IDLE_ACTIONS)
    .filter(a => IDLE_ACTIONS.includes(a));
  if (!pool.length) return;

  state.busy = true;
  const act = pool[randInt(0, pool.length - 1)];
  try {
    // Ходим только по биржам, которые сейчас в смене: активность на
    // спящей бирже - ровно тот след, которого мы избегаем. И работаем в
    // ЕЁ вкладке: раньше бралась последняя использованная, то есть
    // холостое действие могло бродить по чужой бирже.
    const names = activeExchanges();
    if (!names.length) return;
    const name = names[randInt(0, names.length - 1)];
    EX = exCfg(name);
    // На бирже, где выбранный чип не читается разметкой, «посмотреть
    // соседнюю экспирацию» - самое дорогое из холостых действий:
    // вернуться обратно удаётся не всегда, и следующая ставка приходит
    // на страницу с неизвестной экспирацией. Именно этим объяснялась
    // половина пропусков Toobit. Такой бирже оставляем остальные три.
    let act2 = act;
    if (act2 === 'timeframe' && tfBlind.has(name)) {
      const rest = pool.filter(a => a !== 'timeframe');
      if (!rest.length) return;
      act2 = rest[randInt(0, rest.length - 1)];
    }
    page = await pageFor(name);
    const home = homeUrl(EX);
    if (!home) return;
    if (!Object.values(EX.urls).some(u => page.url().startsWith(u))) {
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(1500, 3000));
    }

    if (act2 === 'switch-asset') {
      // Список берём из конфига: захардкоженные ETH/BTC делали вид, что
      // третьего актива не существует, и со SPCX уводили страницу на ETH.
      const all = Object.keys(EX.urls || {});
      const cur = all.find(a => page.url().startsWith(EX.urls[a]));
      const rest = all.filter(a => a !== cur);
      const other = rest.length ? rest[randInt(0, rest.length - 1)] : all[0];
      await page.goto(EX.urls[other], { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(2000, 6000));

    } else if (act2 === 'history') {
      const tab = page.locator(EX.selectors.timeUnit)
        .filter({ hasText: /^\s*(Position History|Order History|History|Positions)\s*$/i }).first();
      if (await tab.isVisible().catch(() => false)) {
        await humanClick(tab);
        await idleWait(randInt(2000, 7000));
      }

    } else if (act2 === 'scroll') {
      await page.mouse.move(randInt(300, 1000), randInt(200, 700), { steps: randInt(5, 15) });
      await page.mouse.wheel(0, randInt(150, 700));
      await idleWait(randInt(800, 3000));
      await page.mouse.wheel(0, -randInt(150, 700));

    } else if (act2 === 'chart') {
      await idleChart();

    } else if (act2 === 'timeframe') {
      // Смотрим соседнюю экспирацию и возвращаемся. Возврат делает
      // restoreHome ниже - раньше он был частью самого действия, и если
      // клик не срабатывал, страница оставалась на чужой экспирации.
      const names = Object.values(EX.timeUnitText);
      const other = names.filter(t => t !== EX.timeUnitText[String((EX.execTimings || [10])[0])]);
      if (other.length) {
        await ensureTimeframe(other[randInt(0, other.length - 1)]).catch(() => {});
        await idleWait(randInt(1200, 4000));
      }
    }
    state.lastIdle = { act: act2, at: Date.now() };
    log(`холостое действие: ${act2}`);

    // ── возврат в рабочее состояние ──
    // Холостое действие уводит страницу на другой актив и экспирацию, а
    // сигнал приходит внезапно и должен успеть в свою свечу. Раньше
    // возврат ложился на саму ставку, и в журнале копились «экспирация не
    // переключился» и пропуски. Теперь страница возвращается к рабочему
    // активу и экспирации сразу после блуждания - времени сколько угодно.
    await restoreHome('после холостого действия');
  } catch (e) {
    // Намеренно не трогаем consecutiveErrors: это шум, а не ставка,
    // и его сбои не должны загонять исполнитель в dry-run.
    log(`холостое действие "${act}" не удалось: ${e.message}`);
  } finally {
    state.busy = false;
    if (state.queue.length) setImmediate(pump);
  }
}

// ── сводка доходности с биржи ──
// Журнал ставок знает, СКОЛЬКО мы поставили, но не знает, чем дело
// кончилось: результат живёт на бирже. У MEXC он собран в окне «PNL
// History» с вкладками Today / Yesterday / Monthly / All - оттуда и
// берём, раз в сутки за прошедший день.
//
// Раз в сутки, а не чаще, потому что за вчера цифра уже не меняется:
// перечитывать её каждый час значит ходить по бирже без повода.
const PNL_HEAD = 'date,exchange,pnl,profit,loss,contracts,win_rate,amount,collected_at';
const PNL_PATH = () => path.join(LOGS, 'pnl.csv');

function pnlRows() {
  const f = PNL_PATH();
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  const head = (lines.shift() || '').split(',');
  return lines.filter(l => l.trim()).map(l => {
    const c = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}
function pnlSave(rec) {
  const f = PNL_PATH();
  if (!fs.existsSync(f)) fs.writeFileSync(f, PNL_HEAD + '\n');
  // День пересобираем, а не дублируем: ручной сбор поверх ночного должен
  // заменить строку, иначе один день посчитается дважды.
  const rows = pnlRows().filter(r => !(r.date === rec.date && r.exchange === rec.exchange));
  rows.push(rec);
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const body = rows.map(r => PNL_HEAD.split(',').map(h => r[h] ?? '').join(',')).join('\n');
  fs.writeFileSync(f, PNL_HEAD + '\n' + body + '\n');
}

// Вчерашняя дата в местном времени: биржа считает сутки по своему
// поясу, но и мы, и она смотрим на одну и ту же «вчерашнюю» вкладку.
function yesterdayStamp() {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Числа из окна сводки. Подписи ищем по тексту, а не по разметке: у
// биржи она меняется чаще, чем слова, а слова здесь короткие и
// однозначные. Проценты и знаки убираем, минус сохраняем.
const PNL_FIELDS = [
  ['pnl',       /Total\s*PNL/i],
  ['profit',    /Total\s*Profit/i],
  ['loss',      /Total\s*Loss/i],
  ['contracts', /^\s*Contracts/i],
  ['win_rate',  /Profitable\s*Contracts/i],
  ['amount',    /Contract\s*Amount/i],
];

async function readPnlDialog() {
  return await page.evaluate((fields) => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight);
    // Окно сводки: ближайший предок, где есть и заголовок, и подписи.
    let box = null;
    for (const el of document.querySelectorAll('*')) {
      if (!vis(el)) continue;
      const t = el.innerText || '';
      if (!/PNL\s*History/i.test(t)) continue;
      if (!/Total\s*PNL/i.test(t)) continue;
      if (t.length > 1200) continue;
      if (!box || t.length < (box.innerText || '').length) box = el;
    }
    if (!box) return null;
    const lines = (box.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
    const out = { raw: lines.slice(0, 24) };
    for (const [key, reSrc] of fields) {
      const re = new RegExp(reSrc.source, reSrc.flags);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        // Значение бывает в той же строке и в следующей. Шаблон числа
        // строгий: «-?[\d\s.,]+» съедал пробел ПЕРЕД минусом и возвращал
        // из « -11.4 USDT» один пробел, то есть NaN.
        const num = /[-+]?\d{1,3}(?:[\s ]\d{3})*(?:[.,]\d+)?/;
        const here = lines[i].replace(re, '');
        const m = (here.match(num) || [])[0] || ((lines[i + 1] || '').match(num) || [])[0];
        if (m == null) break;
        const v = parseFloat(String(m).replace(/[\s ]/g, '').replace(',', '.'));
        if (Number.isFinite(v)) out[key] = v;
        break;
      }
    }
    return out;
  }, PNL_FIELDS.map(([k, re]) => [k, { source: re.source, flags: re.flags }]));
}

// Открыть окно сводки и переключить его на «вчера». Селектор кнопки у
// биржи не задан - ищем по смыслу: сначала явный selectors.pnlOpen, если
// его прописали, потом любой мелкий значок рядом с заголовком позиций.
async function openPnlDialog() {
  const E = curEx();
  const already = await page.evaluate(() =>
    /PNL\s*History/i.test(document.body.innerText || ''));
  if (!already) {
    const sel = (E.selectors || {}).pnlOpen;
    if (sel) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) await humanClick(loc).catch(() => {});
    } else {
      // Значок сводки стоит в одной строке с «Open Positions». Кандидатов
      // перебираем справа налево: значок обычно крайний, но рядом бывают
      // и другие. После каждого нажатия смотрим, не появилось ли окно.
      const spots = await page.evaluate(() => {
        // getBoundingClientRect, а не offsetWidth: у SVG его нет вовсе, и
        // именно поэтому значок сводки раньше не находился.
        const vis = el => { const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0; };
        let head = null;
        for (const el of document.querySelectorAll('*')) {
          if (!vis(el) || el.children.length > 6) continue;
          const t = (el.innerText || '').trim();
          if (/Open\s*Positions/i.test(t) && t.length < 120) { head = el; break; }
        }
        if (!head) return [];
        const row = head.parentElement || head;
        const out = [];
        for (const el of row.querySelectorAll('svg,img,button,i,span,div')) {
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          // Значок мелкий; крупные блоки - это сами подписи вкладок.
          if (r.width > 48 || r.height > 48) continue;
          if ((el.innerText || '').trim().length > 3) continue;
          out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
        return out.sort((a, b) => b.x - a.x).slice(0, 4);
      });
      let opened = false;
      for (const sp of spots) {
        await mouseGlide(page, sp.x, sp.y);
        await sleep(randInt(60, 160));
        await page.mouse.down(); await sleep(randInt(45, 110)); await page.mouse.up();
        await page.waitForTimeout(900);
        opened = await page.evaluate(() => /PNL\s*History/i.test(document.body.innerText || ''));
        if (opened) break;
      }
      if (!opened) {
        log(`сводка: не нашёл, чем открыть окно (кандидатов рядом с «Open Positions»: ${spots.length})`);
        return false;
      }
    }
    await page.waitForTimeout(600);
  }
  // Вкладка «Yesterday».
  const tab = page.getByText(/^\s*Yesterday\s*$/i).first();
  if (await tab.count() > 0 && await tab.isVisible().catch(() => false)) {
    await humanClick(tab).catch(() => {});
    await page.waitForTimeout(1200);
  } else {
    log('в окне сводки не нашлась вкладка «Yesterday» - читаю то, что открыто');
  }
  return await page.evaluate(() => /PNL\s*History/i.test(document.body.innerText || ''));
}

// Второй способ сбора: у биржи нет сводного окна, зато есть список
// закрытых позиций. Toobit устроен так - вкладка «Past positions» рядом с
// «Current Positions», и каждая строка несёт дату, объём и результат.
// Складываем сами: за вчера, по строкам.
//
// Разбор нарочно грубый - по тексту строки, а не по колонкам: разметку
// таблицы биржа меняет чаще, чем формат даты и знак числа. Что именно
// прочиталось, видно по `node executor.js pnl toobit`.
async function readClosedPositions(dayStamp) {
  // Открываем вкладку закрытых позиций.
  const tab = page.getByText(/(Past|Closed|History)\s*positions/i).first();
  if (await tab.count() > 0 && await tab.isVisible().catch(() => false)) {
    await humanClick(tab).catch(() => {});
    await page.waitForTimeout(1600);
  } else {
    log('вкладка закрытых позиций не найдена');
    return null;
  }
  return await page.evaluate(({ stamp }) => {
    const vis = el => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0; };
    // Дата в строке бывает «2026-08-31 01:45:15» и «08-31 01:45».
    const dateRe = /(\d{4}-\d{2}-\d{2})|(?:^|[^\d])(\d{2}-\d{2})(?:[^\d]|$)/;
    const seen = new Set();
    const rows = [];
    for (const el of document.querySelectorAll('tr,[role=row],li,div')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < 20 || t.length > 260) continue;
      if (!dateRe.test(t)) continue;
      if (!/USDT/i.test(t)) continue;
      // Один и тот же ряд ловится и на строке, и на её обёртке.
      if (seen.has(t)) continue;
      seen.add(t);
      rows.push(t);
      if (rows.length >= 200) break;
    }
    const mine = [];
    for (const t of rows) {
      const m = t.match(dateRe);
      const d = m && (m[1] || (stamp.slice(0, 5) === '' ? null : stamp.slice(0, 4) + '-' + m[2]));
      if (!d || d !== stamp) continue;
      // Результат: число со знаком рядом с USDT. Берём ПОСЛЕДНЕЕ такое -
      // объём стоит раньше результата во всех виденных раскладках.
      const nums = [...t.matchAll(/([+-]?\d+(?:[.,]\d+)?)\s*USDT/gi)]
        .map(x => parseFloat(x[1].replace(',', '.')))
        .filter(Number.isFinite);
      if (!nums.length) continue;
      mine.push({ text: t, amount: nums[0], pnl: nums[nums.length - 1] });
    }
    return { rows: rows.slice(0, 6), matched: mine };
  }, { stamp: dayStamp });
}

// ── сводка из блока «Trade History» под кнопками ставки ──
//
// У Toobit прямо на странице торговли, под Higher/Lower, биржа сама
// считает итоги: вкладки Today / Last day / 30D / All и четыре числа.
// Это надёжнее, чем складывать список закрытых позиций: считает сама
// биржа, разбирать нечего, и лишних вкладок открывать не надо.
const HIST_FIELDS = [
  ['amount',    /Trade\s*amount/i],
  ['win_rate',  /Win\s*rate/i],
  ['contracts', /Total\s*trades/i],
  ['pnl',       /Total\s*P\s*&?\s*L/i],
];

// Снимок блока: и числа, и то, какая вкладка выглядит выбранной.
async function histSnap() {
  return await page.evaluate((fields) => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let box = null;
    for (const el of document.querySelectorAll('*')) {
      if (!vis(el)) continue;
      const t = el.innerText || '';
      if (!/Trade\s*History/i.test(t)) continue;
      if (!/Win\s*rate/i.test(t)) continue;
      if (t.length > 900) continue;
      if (!box || t.length < (box.innerText || '').length) box = el;
    }
    if (!box) return null;
    const lines = (box.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
    const out = { raw: lines.slice(0, 20), tab: '' };
    for (const [key, reSrc] of fields) {
      const re = new RegExp(reSrc.source, reSrc.flags);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const num = /[-+]?\d{1,3}(?:[\s ]\d{3})*(?:[.,]\d+)?/;
        const here = lines[i].replace(re, '');
        const m = (here.match(num) || [])[0] || ((lines[i + 1] || '').match(num) || [])[0];
        if (m == null) break;
        const v = parseFloat(String(m).replace(/[\s ]/g, '').replace(',', '.'));
        if (Number.isFinite(v)) out[key] = v;
        break;
      }
    }
    // Какая вкладка активна: разметка у биржи разная, поэтому смотрим и
    // aria, и классы, и жирность с цветом - что-нибудь да выдаст выбор.
    for (const el of box.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (!/^(Today|Last\s*day|Yesterday|30D|All)$/i.test(t)) continue;
      if (el.children.length) continue;
      if (!vis(el)) continue;
      const cs = getComputedStyle(el);
      const cls = (el.className && el.className.baseVal !== undefined
        ? el.className.baseVal : String(el.className || ''));
      const on = el.getAttribute('aria-selected') === 'true'
        || /active|selected|current|\bon\b|checked/i.test(cls)
        || parseInt(cs.fontWeight, 10) >= 600;
      if (on) out.tab = t;
    }
    out.sig = fields.map(([k]) => out[k]).join(',');
    return out;
  }, HIST_FIELDS.map(([k, re]) => [k, { source: re.source, flags: re.flags }]));
}

async function readTradeHistory() {
  const before = await histSnap();
  if (!before) { log('блок «Trade History» на странице не найден'); return null; }
  const tab = page.getByText(/^\s*(Last\s*day|Yesterday)\s*$/i).first();
  if (!(await tab.count()) || !(await tab.isVisible().catch(() => false))) {
    log('вкладка «Last day» в блоке «Trade History» не найдена');
    return null;
  }
  await humanClick(tab).catch(() => {});
  // Переключение надо доказать, а не понадеяться на паузу: молча
  // записать сегодняшние числа под вчерашней датой - худшее, что тут
  // может случиться. Доказательство любое из двух: вкладка отметилась
  // выбранной или числа в блоке сменились.
  const until = Date.now() + 5000;
  let now = before;
  while (Date.now() < until) {
    await page.waitForTimeout(300);
    now = await histSnap() || now;
    if (/last\s*day|yesterday/i.test(now.tab) || now.sig !== before.sig) break;
  }
  if (!/last\s*day|yesterday/i.test(now.tab) && now.sig === before.sig) {
    log('вкладка «Last day» не отметилась выбранной и числа не изменились'
      + ` - сводку не пишу (что видно: ${JSON.stringify(now.raw)})`);
    await shot('pnl-tab-unproven');
    return null;
  }
  return now;
}

async function collectHistory(name) {
  const got = await readTradeHistory();
  if (!got) return null;
  if (got.pnl === undefined || got.contracts === undefined) {
    log(`сводка ${exCfg(name).title}: числа из блока не прочитались`
      + ` (что видно: ${JSON.stringify(got.raw)})`);
    await shot('pnl-history-unreadable');
    return null;
  }
  // Прибыль и убыток биржа тут не разделяет: из четырёх чисел их не
  // достать, ставки разного размера. Оставляем пустыми - в панели они и
  // не показываются, а выдумывать их значило бы врать в отчёте.
  return {
    date: yesterdayStamp(), exchange: name,
    pnl: got.pnl, profit: '', loss: '',
    contracts: got.contracts,
    win_rate: got.win_rate ?? '',
    amount: got.amount ?? '',
    collected_at: new Date().toISOString(),
  };
}

async function collectClosed(name) {
  const stamp = yesterdayStamp();
  const got = await readClosedPositions(stamp);
  if (!got) return null;
  if (!got.matched.length) {
    log(`сводка ${exCfg(name).title}: строк за ${stamp} в списке закрытых позиций не нашлось`
      + ` (первые строки, что видно: ${JSON.stringify(got.rows)})`);
    await shot('pnl-no-rows');
    return null;
  }
  // Результат «0 USDT» у события - это проигрыш: ставка списана целиком.
  // Прибыльной считаем строку со строго положительным результатом.
  const win = got.matched.filter(r => r.pnl > 0).length;
  const pnl = got.matched.reduce((n, r) => n + (r.pnl > 0 ? r.pnl : -Math.abs(r.amount)), 0);
  const profit = got.matched.filter(r => r.pnl > 0).reduce((n, r) => n + r.pnl, 0);
  const amount = got.matched.reduce((n, r) => n + Math.abs(r.amount), 0);
  return {
    date: stamp, exchange: name,
    pnl: Math.round(pnl * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    loss: Math.round((pnl - profit) * 100) / 100,
    contracts: got.matched.length,
    win_rate: Math.round(win / got.matched.length * 1000) / 10,
    amount: Math.round(amount * 100) / 100,
    collected_at: new Date().toISOString(),
  };
}

// Собрать сводку за вчера. Возвращает запись или null.
async function collectPnl(exName) {
  const name = exName || defaultEx();
  const E = exCfg(name);
  const url = homeUrl(E);
  if (!url) { log(`сводка ${E.title}: не задан ни один адрес актива`); return null; }
  EX = E;
  page = await pageFor(name);
  await page.bringToFront().catch(() => {});
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
  }
  await waitForPanel();

  // У биржи может не быть сводного окна - тогда складываем сами по
  // списку закрытых позиций.
  const src = E.pnlSource || 'dialog';
  if (src === 'history' || src === 'positions') {
    const rec = src === 'history' ? await collectHistory(name) : await collectClosed(name);
    if (!rec) return null;
    pnlSave(rec);
    log(`сводка ${E.title} за ${rec.date}: PNL ${rec.pnl} USDT, `
      + `${src === 'history' ? 'сделок' : 'позиций'} ${rec.contracts}, `
      + `прибыльных ${rec.win_rate}%, оборот ${rec.amount} USDT`);
    return rec;
  }

  if (!(await openPnlDialog())) {
    log(`сводка ${E.title}: окно «PNL History» не открылось`);
    await shot('pnl-not-open');
    await dumpPage('pnl-not-open');
    return null;
  }
  const got = await readPnlDialog();
  // Окно закрываем за собой: оставленное поверх страницы оно помешает
  // следующей ставке найти кнопки.
  const close = page.getByText(/^\s*(Confirm|OK|Подтвердить)\s*$/i).first();
  if (await close.count() > 0 && await close.isVisible().catch(() => false)) {
    await humanClick(close).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(500);

  if (!got || got.pnl === undefined) {
    log(`сводка ${E.title}: числа из окна прочитать не удалось`
      + (got ? ` (что видно: ${JSON.stringify(got.raw)})` : ''));
    await shot('pnl-unreadable');
    return null;
  }
  const rec = {
    date: yesterdayStamp(), exchange: name,
    pnl: got.pnl ?? '', profit: got.profit ?? '', loss: got.loss ?? '',
    contracts: got.contracts ?? '', win_rate: got.win_rate ?? '',
    amount: got.amount ?? '', collected_at: new Date().toISOString(),
  };
  pnlSave(rec);
  log(`сводка ${E.title} за ${rec.date}: PNL ${rec.pnl} USDT, контрактов ${rec.contracts}, `
    + `прибыльных ${rec.win_rate}%, оборот ${rec.amount} USDT`);
  return rec;
}

// Раз в сутки в назначенную минуту. Время местное - исполнитель и так
// живёт в том поясе, из которого на биржу смотрят.
// Час в виде «ЧЧ:ММ». Опечатку не проглатываем молча: «ерунда» с
// разбором «0:00» тихо переехала бы на полночь, и заметить это можно
// было бы только по пропавшим строкам.
const badAt = new Set();
function hhmm(v, def) {
  const at = String(v ?? '').trim();
  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  const h = m && +m[1], mi = m && +m[2];
  if (m && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return { at, hour: h, min: mi };
  if (at && !badAt.has(at)) { badAt.add(at); log(`час сбора «${at}» не разобрать - беру ${def}`); }
  const d = String(def).match(/^(\d{1,2}):(\d{2})$/);
  return d ? { at: String(def), hour: +d[1], min: +d[2] } : { at: '18:08', hour: 18, min: 8 };
}
function pnlDailyCfg() {
  const d = CFG.pnlDaily || {};
  const base = hhmm(d.at, '18:08');
  const names = Array.isArray(d.exchanges) && d.exchanges.length ? d.exchanges : ['mexc'];
  // Час у каждой биржи свой: сутки они режут по-разному, и собирать надо
  // тогда, когда «вчера» у биржи уже закрыто. Час задаётся рядом с
  // pnlSource, в блоке самой биржи; не задан - берётся общий.
  const plan = names.map(n => ({ name: n, ...hhmm((CFG.exchanges?.[n] || {}).pnlAt, base.at) }));
  return {
    enabled: d.enabled !== false,
    hour: base.hour, min: base.min, at: base.at,
    exchanges: names,
    plan,
    atOf: n => (plan.find(x => x.name === n) || base).at,
  };
}
async function pnlTick() {
  const C = pnlDailyCfg();
  if (!C.enabled) return;
  const now = new Date();
  const due = C.plan.filter(x => x.hour === now.getHours() && x.min === now.getMinutes()
    && exNames().includes(x.name));
  if (!due.length) return;
  // Отметка на каждую биржу своя: часы у них разные, одна общая метка
  // съедала бы вторую сводку.
  if (typeof state.pnlDone !== 'object' || !state.pnlDone) state.pnlDone = {};
  const stamp = x => `${now.toDateString()}|${x.at}`;
  const todo = due.filter(x => state.pnlDone[x.name] !== stamp(x));
  if (!todo.length) return;                 // минута длится 60 секунд, тик раз в 30
  for (const x of todo) state.pnlDone[x.name] = stamp(x);
  saveState();
  if (state.busy || state.queue.length) {
    log('время сводки, но идёт ставка - соберу при следующем запуске');
    for (const x of todo) delete state.pnlDone[x.name];
    return;
  }
  state.busy = true;
  try {
    for (const x of todo) {
      await collectPnl(x.name).catch(e => log(`сводка ${x.name} не собралась: ${e.message}`));
    }
    await restoreHome('после сводки');
  } finally {
    state.busy = false;
    if (state.queue.length) setImmediate(pump);
  }
}

// ── сторож тишины ──
// Упавший туннель, снятый деплой Apps Script, выключенный хук - всё это
// выглядит одинаково: сигналы просто перестают приходить. Заметить
// такое по журналу невозможно, там ничего не появляется. Поэтому
// молчание в активные часы само по себе повод для алерта.
function silenceMinutes() {
  const since = state.lastSignalAt || state.startedAt;
  return Math.floor((Date.now() - since) / 60000);
}
function checkSilence() {
  const lim = CFG.signalSilenceMin ?? 0;
  if (!lim || state.silenceAlerted || !anyActive()) return;
  if (silenceMinutes() < lim) return;
  state.silenceAlerted = true;
  const what = state.lastSignalAt ? 'последний сигнал' : 'с запуска';
  log(`!! тишина: сигналов нет ${silenceMinutes()} мин (${what})`);
  tgAlert(`сигналов нет ${silenceMinutes()} мин в активные часы - проверь туннель и вебхук Apps Script`);
}

// ── окно биржи по расписанию ──
// Две задачи сразу. Первая - человечность: живой трейдер не держит
// терминал открытым круглые сутки, окно появляется утром и исчезает
// ночью. Вторая - скорость: холодный старт съедает секунды (запуск
// Chromium, логин из профиля, отрисовка SPA), и первая ставка после
// ночи рискует не уложиться в свою свечу. Поэтому окно открывается
// заранее, к началу активных часов, а не по приходу сигнала.
async function windowBySchedule() {
  if (CFG.autoWindow === false) return;
  if (process.env.TEST_MODE === '1') return;
  // Под руку не лезем: идёт ставка, что-то в очереди - не наше время.
  if (state.busy || state.queue.length) return;
  const active = activeExchanges();
  const open = openExchanges();

  // Никто не в смене - закрываем окно целиком.
  if (!active.length) {
    if (!browserOpen() || state.windowManual) return;
    await closeBrowser();
    state.windowAt = Date.now();
    log('окно биржи закрыто: начались тихие часы');
    return;
  }
  if (state.paused) return;   // пауза - «не трогай биржу»

  // Занятость держим на ВЕСЬ проход. Раньше она ставилась и снималась
  // внутри цикла - и между двумя биржами успевала начаться ставка. Она
  // работает с общей переменной страницы, которую следующий виток цикла
  // тут же переводил на чужую вкладку: сумма набиралась на своей
  // странице, а кнопку направления жали уже на чужой. Так сигнал по SPCX
  // и открыл позицию по BTC.
  state.busy = true;
  try {
    // Своя вкладка КАЖДОЙ бирже в смене.
    for (const n of active) {
      if (open.includes(n)) continue;
      if (state.queue.length) break;   // пришёл сигнал - уступаем ему
      try {
        EX = exCfg(n);
        page = await pageFor(n);
        const url = homeUrl(EX);
        if (!url) continue;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
        await waitForPanel();
        state.windowAt = Date.now();
        log(`вкладка ${EX.title} открыта заранее (${homeAsset(EX)}): началась смена`);
        // Сразу ставим рабочую экспирацию: к приходу сигнала всё готово.
        await restoreHome('к началу смены');
      } catch (e) {
        log(`вкладка ${exCfg(n).title} не открылась: ${e.message}`);
        await closePageOf(n);
      }
    }
  } finally {
    state.busy = false;
    if (state.queue.length) setImmediate(pump);
  }

  // Сдавшие смену вкладки закрываем: открытая биржа без торговли - тот
  // самый круглосуточный след. Открытое руками не трогаем.
  if (state.windowManual) return;
  for (const n of openExchanges()) {
    if (active.includes(n)) continue;
    await closePageOf(n);
    state.windowAt = Date.now();
    log(`вкладка ${exCfg(n).title} закрыта: смена закончилась`);
  }
  if (!openExchanges().length && browserOpen()) await closeBrowser();
}

function scheduleIdle() {
  const I = CFG.idleRotation || {};
  if (I.enabled === false) return;
  const lo = (I.everyMinFrom ?? 7) * 60000;
  const hi = (I.everyMinTo ?? 26) * 60000;
  const t = setTimeout(() => { idleAction().finally(scheduleIdle); }, randInt(lo, Math.max(lo, hi)));
  if (t.unref) t.unref();
}

// ── HTTP ──
// Последние строки CSV со ставками - для панели
function recentBets(n) {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  const head = (lines.shift() || '').split(',');
  return lines.slice(-n).reverse().map(l => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    // Заметка - последний столбец, и в ней бывают запятые: «экспирация не
    // переключился на 10m, на странице выбран 30m». Разбиение по запятой
    // оставляло от такой заметки только начало - то есть ровно ту часть,
    // где ещё не сказано, что именно пошло не так. Хвост собираем назад.
    const last = head[head.length - 1];
    if (cells.length > head.length) o[last] = cells.slice(head.length - 1).join(',');
    return o;
  });
}

// ── ряд доходности по дням ──
// Две величины из разных источников: PNL приходит с биржи (мы его не
// считаем сами, чтобы не расходиться с её арифметикой), а число ставок
// берётся из нашего журнала.
function pnlSeries(days, only) {
  // Биржи НЕ объединяем: у каждой свои сутки, свои выплаты и свой размер
  // ставки, и общий итог не отвечает ни на один вопрос - ни «как идёт
  // MEXC», ни «как идёт Toobit». Поэтому ряд всегда по одной бирже.
  const rows = pnlRows().filter(r => !only || r.exchange === only);
  // Ставки по дням: только те, что действительно ушли на биржу.
  const bets = new Map();
  const f = path.join(LOGS, 'bets.csv');
  if (fs.existsSync(f)) {
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    const head = (lines.shift() || '').split(',');
    const iT = head.indexOf('time'), iS = head.indexOf('status'), iE = head.indexOf('exchange');
    const real = new Set(['placed', 'placed-unconfirmed', 'placed-unverified']);
    for (const l of lines) {
      if (!l.trim()) continue;
      const c = l.split(',');
      if (!real.has(c[iS])) continue;
      const d = new Date(c[iT]);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
        + `${String(d.getDate()).padStart(2, '0')}|${c[iE] || ''}`;
      bets.set(key, (bets.get(key) || 0) + 1);
    }
  }
  const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const byDay = new Map();
  for (const r of rows) {
    const o = byDay.get(r.date) || { date: r.date, pnl: 0, contracts: 0, amount: 0, bets: 0, ex: {} };
    o.pnl += num(r.pnl);
    o.contracts += num(r.contracts);
    o.amount += num(r.amount);
    o.bets += bets.get(`${r.date}|${r.exchange}`) || 0;
    o.ex[r.exchange] = { pnl: num(r.pnl), winRate: num(r.win_rate), contracts: num(r.contracts) };
    byDay.set(r.date, o);
  }
  let all = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (days) {
    const since = new Date(Date.now() - days * 86400000);
    const cut = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-`
      + `${String(since.getDate()).padStart(2, '0')}`;
    all = all.filter(d => d.date >= cut);
  }
  // Накопленный итог: по нему и видно, растёт счёт или проседает.
  let acc = 0;
  for (const d of all) { acc = Math.round((acc + d.pnl) * 100) / 100; d.cum = acc; }
  const sum = k => all.reduce((n, d) => n + (d[k] || 0), 0);
  const win = all.reduce((n, d) =>
    n + Object.values(d.ex).reduce((m, e) => m + e.winRate * e.contracts, 0), 0);
  const cn = sum('contracts');
  const C = pnlDailyCfg();
  return {
    days: all,
    total: Math.round(sum('pnl') * 100) / 100,
    contracts: cn,
    bets: sum('bets'),
    amount: Math.round(sum('amount') * 100) / 100,
    winRate: cn ? Math.round(win / cn * 10) / 10 : null,
    best: all.length ? all.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null,
    worst: all.length ? all.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null,
    at: only ? C.atOf(only) : C.at,
    enabled: C.enabled,
    exchange: only || null,
    source: only ? exCfg(only).pnlSource : null,
    // Список бирж, по которым вообще есть строки, плюс те, что собираются
    // по расписанию: кнопка должна появиться до первого сбора.
    exchanges: [...new Set([...pnlRows().map(r => r.exchange), ...C.exchanges])]
      .filter(n => exNames().includes(n))
      .map(n => ({ name: n, title: exCfg(n).title })),
  };
}

// ── сводка: почему не сыграло ──
// Три разговора подряд начинались с того, что нужно было прислать лог и
// я по нему считал причины пропусков руками. Считать их умеет и сам
// исполнитель, а панель - показать. Результат кешируется по времени
// изменения файла: журнал перечитывается каждые несколько секунд.
let statsCache = { key: '', val: null };
function betStats(days) {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) return { days, total: 0, reasons: [], lag: null };
  const st = fs.statSync(f);
  const key = `${days}|${st.mtimeMs}|${st.size}`;
  if (statsCache.key === key) return statsCache.val;

  const since = Date.now() - days * 86400000;
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  const head = (lines.shift() || '').split(',');
  const iTime = head.indexOf('time');
  const iStatus = head.indexOf('status');
  const iLag = head.indexOf('lag_ms');
  const counts = new Map();
  const lags = [];
  let total = 0, placed = 0;
  // Что считать состоявшейся ставкой: dry-run тоже дошёл до кнопки, и
  // его задержка так же показательна.
  const isBet = st => st === 'placed' || st === 'dry-run'
    || st === 'placed-unconfirmed' || st === 'placed-unverified';
  for (const l of lines) {
    if (!l.trim()) continue;
    const c = l.split(',');
    const t = Date.parse(c[iTime]);
    if (!t || t < since) continue;
    const status = c[iStatus] || '?';
    // merged и duplicate - служебные строки одного и того же захода, а не
    // отдельные сигналы: в сводке причин они только мешают.
    if (status === 'merged' || status === 'duplicate') continue;
    total++;
    counts.set(status, (counts.get(status) || 0) + 1);
    if (isBet(status)) {
      placed++;
      const lag = iLag >= 0 ? Number(c[iLag]) : NaN;
      if (Number.isFinite(lag) && lag > 0) lags.push(lag);
    }
  }
  lags.sort((a, b) => a - b);
  const at = q => lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * q))] : null;
  const val = {
    days, total, placed,
    reasons: [...counts.entries()].map(([status, n]) => ({ status, n }))
      .sort((a, b) => b.n - a.n),
    lag: lags.length ? { n: lags.length, median: at(0.5), p90: at(0.9), max: lags[lags.length - 1] } : null,
  };
  statsCache = { key, val };
  return val;
}

function snapshot() {
  return {
    dryRun: state.dryRun,
    paused: state.paused,
    betsToday: state.betsToday,
    maxBetsPerDay: CFG.maxBetsPerDay ?? 40,
    slots: openSlots(),
    maxOpenBets: exNames().reduce((n, e) => n + exCfg(e).maxOpenBets, 0),
    queue: state.queue.length,
    consecutiveErrors: state.consecutiveErrors,
    execTimings: CFG.execTimings || [10],
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    humanize: CFG.humanize !== false,
    lastIdle: state.lastIdle,
    activeNow: anyActive(),
    todayWindows: todayWindows(),
    browserOpen: browserOpen(),
    openTabs: openExchanges().map(n => exCfg(n).title),
    busy: state.busy,
    // всё, что редактируется в панели, отдаём одним куском
    settings: {
      // Биржи: всё, что панели нужно знать про каждую, одним куском.
      // assets/stakes/stakeLimits верхнего уровня оставлены как сводка
      // по всем биржам сразу - по ним строятся общие подсказки.
      exchanges: exNames().map(n => {
        const e = exCfg(n);
        const assets = Object.keys(e.urls || {});
        return {
          name: n, title: e.title, assets,
          stakes: Object.fromEntries(assets.map(a => [a, stakeFor(a, n)])),
          stakeLimits: Object.fromEntries(assets.map(a => [a, stakeMax(a, n)])),
          // Какие минуты реально играются по каждому активу. Панель
          // рисует их галочками: до сих пор это была единственная
          // настройка актива, которую нельзя было увидеть, не открыв
          // config.json.
          assetTimings: Object.fromEntries(assets.map(a => [a, timingsFor(a, n)])),
          minPayout: e.minPayout,
          minPayoutStrict: e.minPayoutStrict,
          stakeJitterPct: e.stakeJitterPct,
          wake: {
            enabled: (e.wakeOnSignal || {}).enabled === true,
            maxPerDay: Math.max(0, Math.round((e.wakeOnSignal || {}).maxPerDay ?? 6)),
            minGapMin: Math.max(0, (e.wakeOnSignal || {}).minGapMin ?? 20),
          },
          priceGuard: {
            enabled: (e.priceGuard || {}).enabled !== false,
            maxAdversePct: Math.abs((e.priceGuard || {}).maxAdversePct ?? 0.05),
            requireBetter: (e.priceGuard || {}).requireBetter === true,
          },
          execTimings: e.execTimings,
          // Часы у каждой биржи свои: пока работает одна, вторая молчит.
          // Сетки нет - показываем общую, по ней биржа и живёт.
          hours: (((CFG.exchanges[n] || {}).schedule || {}).hours
                  || (CFG.schedule || {}).hours || Array(7).fill('1'.repeat(24))),
          ownHours: !!gridOf(((CFG.exchanges[n] || {}).schedule || {}).hours),
          activeNow: inActiveHours(null, n),
          todayWindows: todayWindows(n),
          requirePagePayout: e.requirePagePayout,
          checkPayout: e.checkPayout,
          maxOpenBets: e.maxOpenBets,
          slots: openSlots(n),
        };
      }),
      defaultExchange: defaultEx(),
      assets: allAssets(),
      stakes: Object.fromEntries(allAssets().map(a => [a, stakeFor(a, exOfAsset(a)[0])])),
      stakeLimits: Object.fromEntries(allAssets().map(a => [a, stakeMax(a, exOfAsset(a)[0])])),
      execTimings: CFG.execTimings || [10],
      dirLimits: { UP: dirLimit('UP'), DOWN: dirLimit('DOWN') },
      maxOpenBets: exNames().reduce((n, e) => n + exCfg(e).maxOpenBets, 0),
      maxBetsPerDay: CFG.maxBetsPerDay ?? 40,
      minPayout: exCfg(defaultEx()).minPayout,
      slotMarginMin: CFG.slotMarginMin ?? 1,
      humanize: CFG.humanize !== false,
      schedule: {
        enabled: !!(CFG.schedule || {}).enabled,
        hours: scheduleGrid() || (Array.isArray((CFG.schedule || {}).hours) && CFG.schedule.hours.length === 7
          ? CFG.schedule.hours : Array(7).fill('1'.repeat(24))),
        jitterMin: (CFG.schedule || {}).jitterMin ?? 0,
      },
      signalSilenceMin: CFG.signalSilenceMin ?? 0,
      autoWindow: CFG.autoWindow !== false,
      priceGuard: {
        enabled: (CFG.priceGuard || {}).enabled !== false,
        maxAdversePct: Math.abs((CFG.priceGuard || {}).maxAdversePct ?? 0.05),
        requireBetter: (CFG.priceGuard || {}).requireBetter === true,
      },
      burst: {
        enabled: (CFG.burst || {}).enabled !== false,
        windowSec: (CFG.burst || {}).windowSec ?? 3,
        maxMultiplier: (CFG.burst || {}).maxMultiplier ?? 3,
      },
      idleRotation: {
        enabled: (CFG.idleRotation || {}).enabled !== false,
        everyMinFrom: (CFG.idleRotation || {}).everyMinFrom ?? 7,
        everyMinTo: (CFG.idleRotation || {}).everyMinTo ?? 26,
        actions: (CFG.idleRotation || {}).actions || IDLE_ACTIONS,
        allActions: IDLE_ACTIONS,
      },
    },
    wakesToday: wakesToday().length,
    stats: betStats(CFG.statsDays ?? 7),
    dirUsed: { UP: dirSlots('UP'), DOWN: dirSlots('DOWN') },
    dayNames: DAY_NAMES,
    source: CFG.source || 'webhook',
    sheetRows: state.sheetRows ?? null,
    sheetPolledAt: state.sheetPolledAt ?? null,
    sheetError: state.sheetError ?? null,
    lastSignalAt: state.lastSignalAt,
    silenceMin: silenceMinutes(),
    sinceStart: !state.lastSignalAt,
  };
}

// Настройки из панели. Каждое поле проверяем и зажимаем в границы:
// в панель ходят через туннель, да и промахнуться в поле легко, а
// «ставка 100000» или «лимит -3» сломали бы исполнение молча.
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function applySettings(s) {
  const changed = [];
  // Ставки приходят по биржам: { mexc: {ETH: 150}, toobit: {ETH: 20} }.
  // Плоский вид { ETH: 150 } из старой панели тоже понимаем - он ложится
  // на биржу по умолчанию.
  if (s.stakes) {
    const byEx = exNames().some(n => s.stakes[n] && typeof s.stakes[n] === 'object')
      ? s.stakes : { [defaultEx()]: s.stakes };
    for (const n of exNames()) {
      const want = byEx[n];
      if (!want) continue;
      const e = CFG.exchanges[n];
      const own = e.stakes ? e.stakes : (e.stakes = { ...(exCfg(n).stakes || {}) });
      for (const a of Object.keys(exCfg(n).urls || {})) {
        if (want[a] == null) continue;
        const v = Math.round(clamp(want[a], 1, stakeMax(a, n), stakeFor(a, n)));
        if (v !== stakeFor(a, n)) changed.push(`ставка ${exCfg(n).title} ${a} ${stakeFor(a, n)}→${v}`);
        own[a] = v;
      }
      exReset();
    }
  }
  // Порог выплаты - тоже по биржам: на MEXC он страховка поверх сигнала,
  // на Toobit единственная проверка.
  if (s.minPayouts) {
    for (const n of exNames()) {
      if (s.minPayouts[n] == null) continue;
      const was = exCfg(n).minPayout;
      const v = clamp(s.minPayouts[n], 50, 100, was);
      if (v !== was) changed.push(`выплата ${exCfg(n).title} ${was}→${v}%`);
      CFG.exchanges[n].minPayout = v;
      exReset();
    }
  }
  // Пробуждение вне смены - по биржам: у каждой свои часы, и щёлка в
  // ночных воротах нужна не обязательно обеим.
  if (s.wakes) {
    for (const n of exNames()) {
      const w = s.wakes[n];
      if (w == null) continue;
      const cur = exCfg(n).wakeOnSignal || {};
      const next = { ...cur };
      if (w.enabled != null) {
        next.enabled = !!w.enabled;
        if (next.enabled !== (cur.enabled === true)) {
          changed.push(`пробуждение ${exCfg(n).title} ${next.enabled ? 'вкл' : 'выкл'}`);
        }
      }
      if (w.maxPerDay != null) {
        const v = Math.round(clamp(w.maxPerDay, 0, 50, cur.maxPerDay ?? 6));
        if (v !== (cur.maxPerDay ?? 6)) changed.push(`пробуждений в сутки ${exCfg(n).title} ${cur.maxPerDay ?? 6}→${v}`);
        next.maxPerDay = v;
      }
      // Паузу панель не спрашивает, но в конфиге она должна быть видна:
      // иначе правило «не чаще чем раз в двадцать минут» существует
      // только в коде, и найти его, читая config.json, невозможно.
      next.minGapMin = w.minGapMin != null
        ? Math.round(clamp(w.minGapMin, 0, 720, cur.minGapMin ?? 20))
        : (cur.minGapMin ?? 20);
      CFG.exchanges[n].wakeOnSignal = next;
      exReset();
    }
  }
  // Проверка выплаты на странице - по биржам: на одной сигналы приходят
  // уже отобранными по проценту, на другой нет.
  if (s.checkPayouts) {
    for (const n of exNames()) {
      if (s.checkPayouts[n] == null) continue;
      const was = exCfg(n).checkPayout;
      const v = !!s.checkPayouts[n];
      if (v !== was) changed.push(`проверка выплаты ${exCfg(n).title} ${v ? 'вкл' : 'выкл'}`);
      CFG.exchanges[n].checkPayout = v;
      exReset();
    }
  }
  // Разброс суммы ставки - по биржам: потолки полей ввода разные, и
  // десять процентов от 20 USDT на Toobit это совсем не то же, что от
  // 250 на MEXC.
  if (s.stakeJitters) {
    for (const n of exNames()) {
      if (s.stakeJitters[n] == null) continue;
      const was = exCfg(n).stakeJitterPct;
      const v = Math.round(clamp(s.stakeJitters[n], 0, 50, was));
      if (v !== was) changed.push(`разброс суммы ${exCfg(n).title} ${was}→${v}%`);
      CFG.exchanges[n].stakeJitterPct = v;
      exReset();
    }
  }
  // Порог цены входа: общий выключатель и свой процент у каждой биржи.
  // На разных инструментах «нормальный» откат разный, поэтому один
  // процент на всех был бы либо слишком строгим, либо бесполезным.
  if (s.priceGuard) {
    CFG.priceGuard = CFG.priceGuard || {};
    if (s.priceGuard.enabled != null) {
      const v = !!s.priceGuard.enabled;
      if (v !== ((CFG.priceGuard.enabled) !== false)) changed.push(`проверка цены ${v ? 'вкл' : 'выкл'}`);
      CFG.priceGuard.enabled = v;
    }
    if (s.priceGuard.requireBetter != null) CFG.priceGuard.requireBetter = !!s.priceGuard.requireBetter;
    exReset();
  }
  if (s.priceGuards) {
    for (const n of exNames()) {
      if (s.priceGuards[n] == null) continue;
      const was = Math.abs((exCfg(n).priceGuard || {}).maxAdversePct ?? 0.05);
      // Ноль - осмысленное значение: «только строго лучше сигнала».
      const v = Math.round(clamp(s.priceGuards[n], 0, 5, was) * 1000) / 1000;
      if (v !== was) changed.push(`цена ${exCfg(n).title} ${was}→${v}%`);
      CFG.exchanges[n].priceGuard = { ...(CFG.exchanges[n].priceGuard || {}), maxAdversePct: v };
      exReset();
    }
  }
  if (s.dirLimits) {
    CFG.dirLimits = CFG.dirLimits || {};
    for (const d of ['UP', 'DOWN']) {
      if (s.dirLimits[d] == null) continue;
      const v = Math.round(clamp(s.dirLimits[d], 1, 5, dirLimit(d)));
      if (v !== dirLimit(d)) changed.push(`лимит ${d} ${dirLimit(d)}→${v}`);
      CFG.dirLimits[d] = v;
    }
  }
  // Плоский minPayout из старой панели - это порог биржи по умолчанию.
  if (s.minPayout != null) {
    const n = defaultEx(), was = exCfg(n).minPayout;
    const v = clamp(s.minPayout, 50, 100, was);
    if (v !== was) changed.push(`выплата ${exCfg(n).title} ${was}→${v}%`);
    CFG.minPayout = v;
    CFG.exchanges[n].minPayout = v;
    exReset();
  }
  if (s.maxBetsPerDay != null) {
    const v = Math.round(clamp(s.maxBetsPerDay, 1, 500, CFG.maxBetsPerDay ?? 40));
    if (v !== (CFG.maxBetsPerDay ?? 40)) changed.push(`ставок в день ${CFG.maxBetsPerDay ?? 40}→${v}`);
    CFG.maxBetsPerDay = v;
  }
  if (s.burst) {
    CFG.burst = CFG.burst || {};
    if (s.burst.enabled != null) {
      CFG.burst.enabled = !!s.burst.enabled;
      changed.push('пачки ' + (CFG.burst.enabled ? 'вкл' : 'выкл'));
    }
    if (s.burst.windowSec != null) {
      const v = clamp(s.burst.windowSec, 0, 60, 3);
      if (v !== (CFG.burst.windowSec ?? 3)) changed.push(`окно пачки ${CFG.burst.windowSec ?? 3}→${v}с`);
      CFG.burst.windowSec = v;
    }
    if (s.burst.maxMultiplier != null) {
      const v = Math.round(clamp(s.burst.maxMultiplier, 1, 10, 3));
      if (v !== (CFG.burst.maxMultiplier ?? 3)) changed.push(`множитель ${CFG.burst.maxMultiplier ?? 3}→${v}`);
      CFG.burst.maxMultiplier = v;
    }
  }
  if (s.signalSilenceMin != null) {
    const v = Math.round(clamp(s.signalSilenceMin, 0, 1440, CFG.signalSilenceMin ?? 0));
    if (v !== (CFG.signalSilenceMin ?? 0)) changed.push(`тишина ${CFG.signalSilenceMin ?? 0}→${v} мин`);
    CFG.signalSilenceMin = v;
  }
  if (Array.isArray(s.execTimings)) {
    const v = s.execTimings.map(Number).filter(x => x === 10 || x === 30);
    if (v.length) {
      if (String(v) !== String(CFG.execTimings || [10])) changed.push('время экспирации: ' + v.join(', ') + 'м');
      CFG.execTimings = v;
    }
  }
  if (s.autoWindow != null) {
    const v = !!s.autoWindow;
    if (v !== (CFG.autoWindow !== false)) changed.push('окно по расписанию ' + (v ? 'вкл' : 'выкл'));
    CFG.autoWindow = v;
    // Сразу приводим окно в соответствие: включил - открылось, выключил -
    // осталось как есть, но больше не закроется само.
    setImmediate(() => windowBySchedule().catch(() => {}));
  }
  if (s.humanize != null) {
    CFG.humanize = !!s.humanize;
    changed.push('человечный клик ' + (CFG.humanize ? 'вкл' : 'выкл'));
  }
  // Часы по биржам: { mexc: {hours:[...]}, toobit: {hours:[...]} }.
  if (s.schedules) {
    for (const n of exNames()) {
      const w = s.schedules[n];
      if (!w || !Array.isArray(w.hours) || w.hours.length !== 7) continue;
      const rows = w.hours.map(r => String(r || '').replace(/[^01]/g, '0').padEnd(24, '0').slice(0, 24));
      const was = JSON.stringify(((CFG.exchanges[n] || {}).schedule || {}).hours || []);
      CFG.exchanges[n].schedule = { ...(CFG.exchanges[n].schedule || {}), hours: rows };
      if (was !== JSON.stringify(rows)) changed.push(`часы ${exCfg(n).title}`);
      exReset();
    }
    setImmediate(() => windowBySchedule().catch(() => {}));
  }
  if (s.schedule) {
    CFG.schedule = CFG.schedule || {};
    if (s.schedule.enabled != null) {
      CFG.schedule.enabled = !!s.schedule.enabled;
      changed.push('расписание ' + (CFG.schedule.enabled ? 'вкл' : 'выкл'));
    }
    if (Array.isArray(s.schedule.hours) && s.schedule.hours.length === 7) {
      // только '0'/'1', ровно 24 символа - иначе сетка молча съедет
      CFG.schedule.hours = s.schedule.hours.map(r =>
        String(r).replace(/[^01]/g, '0').padEnd(24, '0').slice(0, 24));
      changed.push('сетка часов обновлена');
    }
    if (s.schedule.jitterMin != null) {
      CFG.schedule.jitterMin = Math.round(clamp(s.schedule.jitterMin, 0, 59, 0));
    }
  }
  if (s.idleRotation) {
    CFG.idleRotation = CFG.idleRotation || {};
    const I = CFG.idleRotation;
    if (s.idleRotation.enabled != null) {
      I.enabled = !!s.idleRotation.enabled;
      changed.push('холостые действия ' + (I.enabled ? 'вкл' : 'выкл'));
    }
    if (s.idleRotation.everyMinFrom != null) I.everyMinFrom = clamp(s.idleRotation.everyMinFrom, 1, 240, 7);
    if (s.idleRotation.everyMinTo != null) I.everyMinTo = clamp(s.idleRotation.everyMinTo, 1, 240, 26);
    // «от» больше «до» - интервал был бы пустым, меняем местами
    if (I.everyMinFrom > I.everyMinTo) { const t = I.everyMinFrom; I.everyMinFrom = I.everyMinTo; I.everyMinTo = t; }
    if (Array.isArray(s.idleRotation.actions)) {
      I.actions = s.idleRotation.actions.filter(a => IDLE_ACTIONS.includes(a));
      changed.push('набор холостых действий: ' + (I.actions.join(', ') || 'пусто'));
    }
  }
  saveConfig();
  if (changed.length) log('панель: ' + changed.join('; '));
  return changed;
}

const server = http.createServer((req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  // браузер сам просит favicon - отвечаем пустым, чтобы не сорить 404
  if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  // ── Панель. Секрет обязателен: сервер смотрит наружу через туннель,
  // и без него любой, кто знает адрес, управлял бы ставками. ──
  const pm = req.url.match(/^\/panel\/([^/?]+)/);
  if (req.method === 'GET' && pm) {
    if (pm[1] !== CFG.secret) { res.writeHead(403); res.end('forbidden'); return; }
    const f = path.join(ROOT, 'panel.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('panel.html не найден'); return; }
    // no-store: панель обновляется вместе с исполнителем, и старая
    // версия из кэша браузера выглядит как «правки не приехали».
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(f));
    return;
  }

  // ── Подложка панели. Файл кладут рядом с panel.html под именем
  // panel-bg с любым из привычных расширений; нет файла - панель рисует
  // фон сама, и ничего не ломается. Секрет тут не спрашиваем: это
  // картинка, а не управление, и требовать его значило бы усложнять
  // адрес в стилях без единой выгоды. ──
  if (req.method === 'GET' && /^\/panel-bg(\?|$)/.test(req.url)) {
    const kinds = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.webp': 'image/webp', '.avif': 'image/avif' };
    const hit = Object.keys(kinds).map(e => path.join(ROOT, 'panel-bg' + e)).find(fs.existsSync);
    if (!hit) { res.writeHead(404); res.end('нет файла panel-bg'); return; }
    res.writeHead(200, {
      'Content-Type': kinds[path.extname(hit).toLowerCase()],
      // Подложку меняют редко, а грузится она на каждом обновлении
      // панели - раз в несколько секунд.
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(fs.readFileSync(hit));
    return;
  }

  const am = req.url.match(/^\/api\/([^/?]+)\/([a-z-]+)/);
  if (am) {
    if (am[1] !== CFG.secret) { res.writeHead(403); res.end('forbidden'); return; }
    const action = am[2];
    if (action === 'state') return sendJson(200, { ...snapshot(), bets: recentBets(150) });
    // Ряд доходности запрашивается отдельно: он меняется раз в сутки, и
    // тащить его в каждое обновление панели незачем.
    if (action === 'pnl') {
      const q = new URL(req.url, 'http://x').searchParams;
      const d = parseInt(q.get('days') || '0', 10);
      const ex = q.get('ex') || '';
      return sendJson(200, pnlSeries(Number.isFinite(d) && d > 0 ? d : null,
        exNames().includes(ex) ? ex : defaultEx()));
    }
    // Собрать сводку прямо сейчас, не дожидаясь назначенного часа.
    if (req.method === 'POST' && action === 'pnl-now') {
      if (state.busy || state.queue.length) return sendJson(200, { ok: false, why: 'идёт ставка' });
      state.busy = true;
      collectPnl(new URL(req.url, 'http://x').searchParams.get('ex') || undefined)
        .catch(e => log('ручной сбор сводки упал: ' + e.message))
        .finally(async () => { await restoreHome('после сводки').catch(() => {});
                               state.busy = false; if (state.queue.length) setImmediate(pump); });
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && action === 'pause')  { state.paused = true;  log('панель: пауза'); return sendJson(200, snapshot()); }
    if (req.method === 'POST' && action === 'resume') { state.paused = false; log('панель: снято с паузы'); return sendJson(200, snapshot()); }
    if (req.method === 'POST' && action === 'dry-on')  { state.dryRun = true;  log('панель: DRY-RUN включён'); return sendJson(200, snapshot()); }
    if (req.method === 'POST' && action === 'dry-off') {
      state.dryRun = false; state.consecutiveErrors = 0;
      log('панель: БОЕВОЙ режим включён');
      return sendJson(200, snapshot());
    }
    if (req.method === 'POST' && action === 'manual') {
      let b = '';
      req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
      req.on('end', () => {
        let m; try { m = JSON.parse(b); } catch (e) { return sendJson(400, { error: 'bad json' }); }
        // Биржа: названа явно или та единственная, где есть такой актив.
        // Молча подставлять первую попавшуюся нельзя - это чужие деньги.
        const exWant = String(m.exchange || '').toLowerCase();
        const ex = exNames().includes(exWant) ? exWant
          : (exOfAsset(m.asset).length === 1 ? exOfAsset(m.asset)[0] : defaultEx());
        if (exWant && !exNames().includes(exWant)) {
          return sendJson(400, { error: 'неизвестная биржа: ' + m.exchange, known: exNames() });
        }
        // Раньше неизвестный актив молча подменялся первым из списка -
        // то есть опечатка в запросе открывала ставку по чужой монете.
        const known = Object.keys(exCfg(ex).urls || {});
        if (!known.includes(m.asset)) {
          return sendJson(400, { error: `актив ${m.asset} не торгуется на ${exCfg(ex).title}`, known });
        }
        const asset = m.asset;
        const direction = String(m.direction).toUpperCase() === 'DOWN' ? 'DOWN' : 'UP';
        const timing = Number(m.timing) === 30 ? 30 : 10;
        // Ручная ставка идёт мимо приёма сигналов, а значит и мимо его
        // проверки экспирации. У акций MEXC десятиминутного события на
        // бирже нет вовсе: такая ставка ушла бы в никуда.
        const allow = timingsFor(asset, ex);
        if (!allow.includes(timing)) {
          return sendJson(400, {
            error: `${asset} на ${exCfg(ex).title} не играется по ${timing} минутам`,
            known: allow,
          });
        }
        // Сумму присылает панель. Клампим здесь, а не только в панели:
        // запрос можно отправить и мимо неё, а верхняя граница - биржевая.
        const stake = m.stake == null ? null
          : Math.round(clamp(m.stake, MANUAL_STAKE_MIN, stakeMax(asset, ex), stakeFor(asset, ex)));
        state.queue.push({ ex, asset, direction, timing, stake, receivedAt: Date.now(),
          label: 'manual', mult: 1, burstCount: 1 });
        log(`панель: ручная ставка ${exCfg(ex).title} ${asset} ${direction} ${timing}м `
          + `на ${stake ?? stakeFor(asset, ex)} USDT`);
        setImmediate(pump);
        sendJson(200, { ok: true });
      });
      return;
    }
    if (req.method === 'POST' && action === 'settings') {
      let b = '';
      req.on('data', d => { b += d; if (b.length > 16384) req.destroy(); });
      req.on('end', () => {
        let m; try { m = JSON.parse(b); } catch (e) { return sendJson(400, { error: 'bad json' }); }
        try { sendJson(200, { ok: true, changed: applySettings(m), ...snapshot() }); }
        catch (e) { log('не удалось сохранить настройки: ' + e.message); sendJson(500, { error: e.message }); }
      });
      return;
    }
    // Окно биржи открываем/закрываем руками: держать его сутками не
    // обязательно, а посмотреть глазами иногда нужно.
    if (req.method === 'POST' && action === 'browser-open') {
      if (state.busy) return sendJson(409, { error: 'исполнитель занят' });
      // Какую биржу открывать: названную панелью, иначе ту, что сейчас в
      // смене, иначе биржу по умолчанию. Раньше здесь стоял адрес MEXC
      // прямо в коде - кнопка «Открыть» всегда вела на него, какую биржу
      // ни выбирай, и посмотреть на Toobit глазами было нельзя.
      const want = String(new URL(req.url, 'http://x').searchParams.get('ex') || '').toLowerCase();
      const name = exNames().includes(want) ? want : (activeExchanges()[0] || defaultEx());
      const E = exCfg(name);
      const first = Object.values(E.urls || {})[0];
      if (!first) return sendJson(400, { error: `у биржи ${E.title} не задан ни один адрес` });
      pageFor(name).then(async (p) => {
        EX = E; page = p;
        // Уже стоим на нужной бирже - не дёргаем страницу.
        const here = Object.values(E.urls).some(u => p.url().startsWith(u));
        if (!here) await p.goto(first, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await p.bringToFront().catch(() => {});
        state.windowManual = true;
        log(`панель: вкладка биржи открыта (${E.title})`);
        sendJson(200, { ok: true, exchange: name });
      }).catch(e => { log('окно биржи не открылось: ' + e.message); sendJson(500, { error: e.message }); });
      return;
    }
    if (req.method === 'POST' && action === 'browser-close') {
      if (state.busy) return sendJson(409, { error: 'исполнитель занят' });
      closeBrowser().then(() => {
        state.windowManual = false;
        log('панель: окно биржи закрыто');
        sendJson(200, { ok: true });
      });
      return;
    }
    return sendJson(404, { error: 'unknown action' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, dryRun: state.dryRun, betsToday: state.betsToday,
      queue: state.queue.length, consecutiveErrors: state.consecutiveErrors,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    }));
    return;
  }
  const u = new URL(req.url, 'http://x');
  if (req.method !== 'POST' || u.pathname !== '/signal') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    let sig;
    try { sig = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
    // секрет: либо в URL (?secret=...), либо в теле - вебхук шлёт
    // партнёрский формат без секрета, поэтому URL-вариант основной
    const qsecret = u.searchParams.get('secret');
    if (!CFG.secret || (sig.secret !== CFG.secret && qsecret !== CFG.secret)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!normalizeSignal(sig)) { res.writeHead(400); res.end('bad asset or direction'); return; }

    // Когда источник - таблица, вебхук молчит: иначе один и тот же сигнал
    // пришёл бы дважды разными путями и открыл бы две ставки. ?force=1
    // оставлен для ручной проверки пути снаружи.
    if ((CFG.source || 'webhook') === 'sheet' && u.searchParams.get('force') !== '1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'source-sheet' }));
      return;
    }

    const r = acceptSignal(sig, 'вебхук');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: r === 'queued', merged: r === 'merged',
                             skipped: (r === 'queued' || r === 'merged') ? undefined : r,
                             dryRun: state.dryRun }));
  });
});

// ── режим migrate: старый плоский конфиг → раздел exchanges ──
// Руками это правится долго и с ошибками: половина ключей переезжает
// внутрь биржи, половина остаётся снаружи. Команда делает то же самое,
// сохраняя все твои значения и складывая копию старого файла рядом.
function migrateMode() {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const had = raw.exchanges && Object.keys(raw.exchanges).length;
  const out = {};
  // Часы. Если расписание уже было настроено, оно остаётся у MEXC как
  // есть, а Toobit получает зеркало - работает ровно тогда, когда MEXC
  // молчит. Иначе делим сутки пополам: 08-20 и 20-08.
  const oldRows = Array.isArray((raw.schedule || {}).hours) && raw.schedule.hours.length === 7
    ? raw.schedule.hours.map(r => String(r || '').replace(/[^01]/g, '0').padEnd(24, '0').slice(0, 24))
    : null;
  const useOld = !!(oldRows && (raw.schedule || {}).enabled
    && oldRows.some(r => r.includes('0')) && oldRows.some(r => r.includes('1')));
  const mexcHours = useOld ? oldRows : Array(7).fill('0'.repeat(8) + '1'.repeat(12) + '0'.repeat(4));
  const toobitHours = mexcHours.map(r => r.replace(/[01]/g, c => (c === '1' ? '0' : '1')));
  // Ключи, которые переезжают ВНУТРЬ биржи по умолчанию.
  const MOVE = ['stakes', 'stakeLimits', 'urls', 'timeUnitText',
                'marketClosedText', 'openPositionsLabel', 'minPayout', 'maxOpenBets'];
  // Описание бирж берём из config.example.json - он рядом и всегда
  // свежий. Держать вторую копию прямо здесь уже пробовали: она разошлась
  // с примером через два дня (там появились dirWords и payoutList, а
  // здесь остался устаревший набор), и миграция выдавала конфиг хуже
  // примера.
  let sample = {}, sampleTop = {};
  try {
    sampleTop = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')
      .replace(/^\uFEFF/, ''));
    sample = sampleTop.exchanges || {};
  } catch (e) {
    console.log('config.example.json рядом не найден - беру минимальные значения');
  }
  // Повторный запуск ДОПОЛНЯЕТ уже описанную биржу недостающими
  // ключами из примера, не трогая твои значения. Без этого после
  // обновления кода (в примере появились dirWords, payoutList и прочее)
  // пришлось бы дописывать их в config.json руками.
  const added = [], fixed = [];
  // Значения, которые я сам когда-то положил в пример и которые оказались
  // неверными. Заменяем ТОЛЬКО точное совпадение с ними: если ты правил
  // ключ руками, значение останется твоим.
  const STALE = {
    mexc: {
      // Источник перешёл на именные метки потока.
      signalTimings: [JSON.stringify(['MEXC _10m', 'MEXC _30m', 'MEXC_10m', 'MEXC_30m'])],
      // У MEXC акции подписаны иначе: символ SPCX там называется
      // SPCXSTOCK_USDT. Такого символа, как SPCX_USDT, биржа не знает и
      // молча открывает свой по умолчанию - BTC. Отсюда полтора месяца
      // «страница показывает BTC, а сигнал по SPCX».
      urls: [JSON.stringify({
        BTC: 'https://www.mexc.com/futures/event-futures/BTC_USDT',
        ETH: 'https://www.mexc.com/futures/event-futures/ETH_USDT',
        SPCX: 'https://www.mexc.com/futures/event-futures/SPCX_USDT',
      })],
    },
    toobit: {
      // Искал процент ПОСЛЕ слова направления, а на Toobit подпись стоит
      // над кнопкой - для Higher приезжала выплата Lower.
      payoutRe: ['{DIR}[^%]{0,80}?([0-9.]+)\\s*%',
                 '{DIR}\\s*(?:Payout|Return|Profit)?\\s*[:\\s]\\s*([0-9.]+)\\s*%'],
      // «30m на Toobit нет» - это был промах селектора, а не отсутствие чипа.
      timeUnitText: [JSON.stringify({ 10: '10m' })],
      // На Toobit счётчик подписан «Current Positions», и со старой
      // меткой ставка не подтверждалась: уходила как placed-unverified.
      openPositionsLabel: ['Open Positions'],
      // Адрес вида ?symbol=ETHUSDT биржа ИГНОРИРУЕТ и открывает
      // последний просмотренный символ. Пока им был ETH, всё сходилось;
      // стоило странице побывать на BTC - и каждая ставка по ETH стала
      // отбиваться проверкой актива. Правильный вид - путь.
      urls: [
        // Параметр ?symbol=... биржа игнорирует и открывает последний
        // просмотренный символ - отсюда ставки по чужому активу.
        JSON.stringify({
          ETH: 'https://www.toobit.com/en-US/event-futures?symbol=ETHUSDT',
          BTC: 'https://www.toobit.com/en-US/event-futures?symbol=BTCUSDT',
        }),
        // Было только два актива - добавились SOL и XRP.
        JSON.stringify({
          ETH: 'https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT',
          BTC: 'https://www.toobit.com/en-US/event-futures/BTC-SWAP-USDT',
        }),
      ],
      // Toobit получил и 30-минутные сигналы.
      execTimings: [JSON.stringify([10])],
      // Метки потока стали именными: TOOBIT_10m / TOOBIT_30m.
      signalTimings: [JSON.stringify(['10m']), JSON.stringify(['10m', '30m'])],
    },
  };
  const fill = (cur, def, who) => {
    for (const k of Object.keys(def || {})) {
      if (cur[k] === undefined) { cur[k] = def[k]; added.push(`${who}.${k}`); continue; }
      const stale = (STALE[who] || {})[k];
      if (!stale || def[k] === undefined) continue;
      const asText = typeof cur[k] === 'object' ? JSON.stringify(cur[k]) : String(cur[k]);
      if (stale.includes(asText) && asText !== (typeof def[k] === 'object' ? JSON.stringify(def[k]) : String(def[k]))) {
        cur[k] = def[k];
        fixed.push(`${who}.${k}`);
      }
    }
    return cur;
  };
  // Новый актив в urls без записи в stakes/stakeLimits молча получил бы
  // ставку 5 USDT и ЧУЖОЙ потолок 150 - на Toobit биржа принимает не
  // больше 50. Дописываем недостающие активы из примера, а если и там их
  // нет - берём значения соседнего актива этой же биржи.
  const fillAssets = (cur, def, who) => {
    for (const key of ['stakes', 'stakeLimits']) {
      const assets = Object.keys(cur.urls || {});
      if (!assets.length) continue;
      cur[key] = cur[key] || {};
      const vals = Object.values(cur[key]);
      for (const a of assets) {
        if (cur[key][a] != null) continue;
        const from = ((def || {})[key] || {})[a];
        const v = from != null ? from : vals[0];
        if (v == null) continue;
        cur[key][a] = v;
        added.push(`${who}.${key}.${a}`);
      }
    }
    return cur;
  };
  const mexc = (had && raw.exchanges.mexc) ? fillAssets(fill({ ...raw.exchanges.mexc }, sample.mexc, 'mexc'), sample.mexc, 'mexc') : {
    ...(sample.mexc || { title: 'MEXC', enabled: true }),
    // Пользовательские значения важнее примера: это его настройки.
    maxOpenBets: raw.maxOpenBets ?? (sample.mexc || {}).maxOpenBets ?? 5,
    minPayout: raw.minPayout ?? (sample.mexc || {}).minPayout ?? 80,
    stakes: raw.stakes || (sample.mexc || {}).stakes || {},
    stakeLimits: raw.stakeLimits || (sample.mexc || {}).stakeLimits || {},
    urls: raw.urls || (sample.mexc || {}).urls || {},
    timeUnitText: raw.timeUnitText || (sample.mexc || {}).timeUnitText || { 10: '10m', 30: '30m' },
    marketClosedText: raw.marketClosedText || (sample.mexc || {}).marketClosedText || 'Market Closed',
    openPositionsLabel: raw.openPositionsLabel || (sample.mexc || {}).openPositionsLabel || 'Open Positions',
    schedule: { hours: mexcHours },
  };
  const toobit = (had && raw.exchanges.toobit) ? fillAssets(fill({ ...raw.exchanges.toobit }, sample.toobit, 'toobit'), sample.toobit, 'toobit') : {
    ...(sample.toobit || {
      title: 'Toobit', enabled: true, minPayout: 75,
      minPayoutStrict: true, requirePagePayout: true,
      signalTimings: ['10m'], execTimings: [10],
      stakes: { ETH: 20, BTC: 20 }, stakeLimits: { ETH: 50, BTC: 50 },
      urls: {
        ETH: 'https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT',
        BTC: 'https://www.toobit.com/en-US/event-futures/BTC-SWAP-USDT',
      },
    }),
    schedule: { hours: toobitHours },
  };
  // Порядок ключей сохраняем: конфиг читают глазами.
  for (const [k, v] of Object.entries(raw)) {
    if (MOVE.includes(k) || k === 'exchanges' || k === 'defaultExchange') continue;
    out[k] = v;
    if (k === 'dryRun') {
      out.defaultExchange = raw.defaultExchange || 'mexc';
      out.exchanges = { mexc, toobit, ...(had ? raw.exchanges : {}) };
      out.exchanges.mexc = mexc; out.exchanges.toobit = toobit;
    }
  }
  if (!out.exchanges) { out.defaultExchange = 'mexc'; out.exchanges = { mexc, toobit }; }
  // Общее расписание остаётся выключателем для сеток бирж.
  out.schedule = out.schedule || { enabled: false, jitterMin: 20, hours: Array(7).fill('1'.repeat(24)) };
  // Настройки не про биржу, а про исполнитель целиком: проверка цены
  // входа, срок памяти об экспирации. Код умеет работать и без них, но в
  // конфиге их не хватало бы под рукой - и панель не смогла бы их
  // сохранить обратно.
  for (const k of ['priceGuard', 'tfMemoMinutes', 'payoutSwitchMs', 'payoutDriftPts', 'statsDays',
                   'pnlDaily']) {
    if (out[k] === undefined && sampleTop[k] !== undefined) {
      out[k] = sampleTop[k];
      added.push(k);
    }
  }

  const bak = CFG_PATH.replace(/\.json$/, '.pre-exchanges.json');
  fs.copyFileSync(CFG_PATH, bak);
  fs.writeFileSync(CFG_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(had ? 'config.json дополнен недостающими ключами.'
                  : 'config.json переписан в формат с биржами.');
  if (added.length) console.log('добавлено: ' + added.join(', '));
  if (fixed.length) console.log('исправлено устаревшее: ' + fixed.join(', '));
  if (had && !added.length && !fixed.length) console.log('менять было нечего - всё уже на месте.');
  console.log('копия старого: ' + bak);
  console.log('биржи: ' + Object.keys(out.exchanges).join(', ') + ' | по умолчанию: ' + out.defaultExchange);
  console.log(useOld
    ? 'часы: у MEXC оставлено твоё расписание, Toobit работает в зеркальные часы'
    : 'часы: смена 12/12 - MEXC 08:00-20:00, Toobit 20:00-08:00'
      + ((raw.schedule || {}).enabled ? '' : ' (расписание пока выключено - включи в панели)'));
  console.log('\nПроверь ставки и часы в панели, потом:');
  console.log('  node executor.js login toobit');
  console.log('  node executor.js diag ETH toobit');
}

// ── режим login ──
async function loginMode() {
  // node executor.js login [биржа] - профиль браузера общий, но войти
  // надо в каждую биржу отдельно.
  const E = exCfg((process.argv[3] || '').toLowerCase() || defaultEx());
  console.log(`Открываю окно браузера. Войди в аккаунт ${E.title}, реши капчу,`);
  console.log('убедись что видишь страницу Event Futures, затем закрой окно.');
  const c = await playwright.chromium.launchPersistentContext(PROFILE, launchOpts(false));
  const p = c.pages()[0] || await c.newPage();
  const first = Object.values(E.urls)[0];
  if (!first) { console.error(`у биржи ${E.title} не задан ни один адрес в urls`); process.exit(1); }
  await p.goto(first, { waitUntil: 'domcontentloaded' });
  await new Promise(resolve => c.on('close', resolve));

  // Раньше здесь просто печаталось «профиль сохранён» - независимо от
  // того, вошёл ты или закрыл окно, ничего не сделав. Узнать правду
  // получалось только на diag через несколько шагов. Проверяем сразу:
  // открываем ту же страницу заново и смотрим, осталась ли кнопка входа.
  console.log('\nПроверяю, сохранился ли вход...');
  let still = null;
  try {
    const c2 = await playwright.chromium.launchPersistentContext(PROFILE, launchOpts(true));
    const p2 = c2.pages()[0] || await c2.newPage();
    await p2.goto(first, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await p2.waitForTimeout(CFG.pageSettleMs ?? 2500);
    still = await p2.locator(E.selectors.loginMarker).first().isVisible().catch(() => false);
    await c2.close();
  } catch (e) {
    console.log('проверить не удалось: ' + e.message);
  }
  if (still === false) {
    console.log(`Вход в ${E.title} на месте. Дальше: node executor.js diag <актив> ${E.name}`);
  } else if (still === true) {
    console.log(`!! ВХОД НЕ СОХРАНИЛСЯ: на странице ${E.title} снова видна кнопка входа.`);
    console.log('   Проверь, что входил именно в открывшемся окне (не в своём обычном браузере),');
    console.log('   что дошёл до конца - почта, 2FA, капча - и что перед закрытием окна');
    console.log('   на странице был виден баланс аккаунта, а не кнопка Log in.');
    process.exitCode = 1;
  }
}

// ── режим diag: открыть страницу и рассказать, что на ней, без ставки ──
// Ручной сбор: чтобы не ждать назначенного часа и увидеть, что именно
// прочиталось из окна биржи.
async function pnlMode(exName) {
  const name = exName || defaultEx();
  console.log(`Открываю ${exCfg(name).title} и собираю сводку за вчера. Ставки НЕ делаются.`);
  const rec = await collectPnl(name);
  if (rec) {
    console.log('\nЗаписано в logs/pnl.csv:');
    console.log(PNL_HEAD);
    console.log(PNL_HEAD.split(',').map(h => rec[h]).join(','));
  } else {
    console.log('\nСобрать не удалось - смотри строки выше и снимок в logs/shots.');
    console.log('Если окно «PNL History» открывается другой кнопкой, пропиши её так:');
    console.log('  "exchanges": { "mexc": { "selectors": { "pnlOpen": "ТУТ_СЕЛЕКТОР" } } }');
  }
  await closeBrowser().catch(() => {});
  process.exit(rec ? 0 : 1);
}

async function diagMode() {
  // node executor.js diag [актив] [биржа] - вторую биржу иначе не
  // осмотреть, а именно её селекторы и надо подобрать.
  EX = exCfg((process.argv[4] || '').toLowerCase() || defaultEx());
  const assets = Object.keys(EX.urls || {});
  const want = String(process.argv[3] || assets[0] || '').toUpperCase();
  const asset = assets.includes(want) ? want : assets[0];
  if (!asset) { console.error(`у биржи ${EX.title} не задан ни один адрес в urls`); process.exit(1); }
  console.log(`Открываю ${EX.title} ${asset} и смотрю, что на странице. Ставка НЕ делается.`);
  page = await pageFor(EX.name);
  await page.goto(EX.urls[asset], { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(CFG.pageSettleMs ?? 2500);

  const loginBtn = page.locator(EX.selectors.loginMarker).first();
  const notLogged = await loginBtn.isVisible().catch(() => false);
  log(notLogged ? 'ВНИМАНИЕ: похоже, НЕ залогинен (видна кнопка Log In)' : 'логин на месте');
  if (notLogged) {
    log(`!! разлогиненный осмотр показывает НЕ ВСЮ страницу: кнопок Up/Down и выплаты`
      + ` на ней обычно просто нет. Сначала: node executor.js login ${EX.name}`);
  }

  // Ждём отрисовку, иначе дамп опишет пустую страницу и введёт в заблуждение
  const ready = await waitForPanel();
  log(ready ? ('панель готова, поле суммы: ' + ready.sel)
            : 'панель НЕ отрисовалась за отведённое время');
  await dumpPage(`diag-${EX.name}-${asset}`);

  // Чипы проверяем ОБОИМИ способами, которыми их ищет боевой код.
  // Раньше печатался только счёт по селектору из конфига, и ноль по нему
  // читался как «чипа нет на странице» - хотя чип есть, просто он не той
  // разметки. По такому нулю я и выкинул 30m из конфига Toobit зря.
  for (const tfText of Object.values(EX.timeUnitText)) {
    const re = new RegExp('^\\s*' + tfText + '\\s*$');
    const n = await page.locator(EX.selectors.timeUnit).filter({ hasText: re }).count().catch(() => -1);
    const byText = await page.getByText(re).count().catch(() => -1);
    log(`чип экспирации "${tfText}": по селектору ${n}, по тексту ${byText}`
      + (n === 0 && byText > 0 ? ' - берётся по тексту' : '')
      + (n === 0 && byText === 0 ? ' - НЕ НАЙДЕН' : ''));
  }
  // Какая группа чипов найдена: на странице те же подписи бывают у
  // интервалов графика, и важно видеть, что взята именно строка
  // экспирации (по якорю timeUnitAnchor).
  const grp = await chipScan(Object.values(EX.timeUnitText)[0]);
  log('  группа чипов: ' + (grp
    ? `подписи ${JSON.stringify(grp.labels)}, якорь ${grp.anchored ? 'совпал' : 'не искали/не совпал'}`
      + `, выбран сейчас: ${grp.active ?? 'не определить по виду'}`
      + `, координаты первой подписи: ${grp.box ? 'есть' : 'НЕ НАЙДЕНЫ'}`
    : 'НЕ НАЙДЕНА - подписи чипов не сложились в один блок'));

  // Чем разметка отмечает ВЫБРАННЫЙ чип. Без этого проверка «экспирация
  // действительно переключился» на Toobit не работает: она пишет
  // «проверить выбор нечем», и ставка может уйти на 5m вместо 10m -
  // ровно та ошибка, что уже случалась на MEXC. По классам из этого
  // дампа настраивается признак активного чипа.
  try {
    const marks = await page.evaluate(names => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 1) continue;
        const t = (el.innerText || '').trim();
        if (!names.includes(t)) continue;
        const cs = getComputedStyle(el);
        out.push({
          t,
          cls: String(el.className || '').slice(0, 70),
          up: String((el.parentElement || {}).className || '').slice(0, 70),
          aria: el.getAttribute('aria-selected') || (el.parentElement || el).getAttribute('aria-selected') || '',
          bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight,
        });
        if (out.length >= 8) break;
      }
      return out;
    }, Object.values(EX.timeUnitText));
    log('  чипы, чем отмечен выбранный: ' + JSON.stringify(marks));
  } catch (e) { log('  разбор чипов не удался: ' + e.message); }
  for (const dir of ['UP', 'DOWN']) {
    const v = await pagePayout(dir);
    log(`выплата ${dir} по текущему шаблону: ${v == null ? 'НЕ ПРОЧИТАНА' : v + '%'}`
      + (EX.requirePagePayout && v == null ? ' - с requirePagePayout ставок по этой бирже не будет' : ''));
  }
  // Цена: по ней отсекается вход хуже сигнала, и если она читается
  // неверно, отсекаться будет наугад. Показываем и заголовок вкладки -
  // из него цену берут в первую очередь.
  // Холостое действие «график» водит курсором по полотну графика.
  // Нашлось ли оно вообще - видно только отсюда.
  const canv = await page.evaluate(() => [...document.querySelectorAll('canvas')]
    .map(c => { const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(r => r.w > 200 && r.h > 120)).catch(() => []);
  log('  полотно графика: ' + (canv.length
    ? JSON.stringify(canv) + ' - курсор по графику работает'
    : 'НЕ НАЙДЕНО - холостое действие «график» ограничится прокруткой'));
  // Своя память приложения: если биржа хранит выбранную экспирацию в
  // localStorage, читать её оттуда надёжнее и мгновеннее, чем доказывать
  // сменой выплат. Показываем ключи целиком - по ним и настраивается
  // чтение, если нужный найдётся.
  try {
    const store = await page.evaluate(() => {
      const out = [];
      for (const [name, st] of [['local', localStorage], ['session', sessionStorage]]) {
        try {
          for (let i = 0; i < st.length && out.length < 60; i++) {
            const k = st.key(i);
            const v = String(st.getItem(k) ?? '');
            out.push(`${name}:${k}=${v.length > 90 ? v.slice(0, 90) + '…' : v}`);
          }
        } catch (e) { /* хранилище закрыто */ }
      }
      return out;
    });
    const hot = store.filter(x => /(time|increment|period|duration|expir|minute|interval|10|30)/i.test(x));
    log(`память приложения (${store.length} ключей), похожее на экспирацию (${hot.length}):`);
    for (const x of hot.slice(0, 15)) log('    ' + x);
    if (!hot.length && store.length) log('    ничего похожего; все ключи: ' + JSON.stringify(store.slice(0, 20)));
  } catch (e) { log('память приложения прочитать не удалось: ' + e.message); }

  const syms = await pageSymbols(true);
  log(`символы, доступные на бирже сейчас (${syms.length}): `
    + (syms.length ? syms.slice(0, 30).join(', ') : 'прочитать не удалось')
    + ` | нужный актив ${asset}: `
    + (syms.some(x => x.startsWith(asset.toUpperCase())) ? 'ЕСТЬ' : 'НЕ ВИДНО'));
  const px = await pagePrice();
  log(`цена на странице: ${px == null ? 'НЕ ПРОЧИТАНА - проверка цены входа будет пропускаться'
    : px + ' (сверь с тем, что видно на графике)'}`);
  log('  заголовок вкладки: ' + JSON.stringify(await page.title().catch(() => '')));
  const f = await shot(`diag-${EX.name}-${asset}`);
  log('скриншот: ' + f);
  console.log('\nГотово. Пришли последние строки logs/executor.log и этот скриншот.');
  await ctx.close();
  process.exit(0);
}

// ── режим add-asset: новый инструмент в конфиг ──
// Актив живёт сразу в четырёх местах: urls, symbols, stakes,
// stakeLimits, и иногда в assetTimings. Сводить их руками в JSON - ровно
// та операция, на которой уже был SPCX: адрес написали, символ забыли, и
// полтора месяца ставки уходили на BTC. Панель тут не помощник: строки
// она строит ПО конфигу, придумать адрес ей неоткуда.
//
//   node executor.js add-asset mexc MU MUSTOCK 30 30
//                              биржа ключ символ ставка минуты
//
// Адрес не спрашиваем: берём его у соседнего актива этой же биржи и
// подставляем новый символ. Так новый адрес получается той же формы, что
// и работающие, - а форма у бирж разная (у MEXC «/BTC_USDT», у Toobit
// «/BTC-SWAP-USDT»), и именно на ней легче всего ошибиться.
function addAssetMode(exName, key, symbol, stake, minutes) {
  const die = (m) => { console.error(m); process.exit(1); };
  if (!exName || !key) {
    die('как звать: node executor.js add-asset <биржа> <ключ> [символ] [ставка] [минуты]\n'
      + 'пример:   node executor.js add-asset mexc MU MUSTOCK 30 30');
  }
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const E = (raw.exchanges || {})[exName];
  if (!E) die(`биржи «${exName}» в конфиге нет; есть: ${Object.keys(raw.exchanges || {}).join(', ')}`);
  key = String(key).toUpperCase();
  const sym = String(symbol || key).toUpperCase();
  E.urls = E.urls || {};
  if (E.urls[key]) die(`актив ${key} у биржи ${E.title || exName} уже есть: ${E.urls[key]}`);

  // Образец адреса: сосед, чей символ в адресе действительно виден.
  let sample = null, sampleSym = '';
  for (const [k, u] of Object.entries(E.urls)) {
    const ks = String((E.symbols || {})[k] || k).toUpperCase();
    if (String(u).toUpperCase().includes(ks)) { sample = u; sampleSym = ks; break; }
  }
  if (!sample) die(`у биржи ${E.title || exName} нет ни одного адреса, с которого можно взять образец`);
  const i = String(sample).toUpperCase().lastIndexOf(sampleSym);
  const url = sample.slice(0, i) + sym + sample.slice(i + sampleSym.length);

  E.urls[key] = url;
  if (sym !== key) { E.symbols = E.symbols || {}; E.symbols[key] = sym; }
  // Ставку и потолок берём у соседа, если не сказано иначе: пятёрка по
  // умолчанию - не то, чем стоит начинать торговать молча. Из соседей
  // берём САМОГО скромного: у MEXC потолки разъехались от 150 до 250, и
  // новый инструмент лучше начать с меньшего - поднять его в панели
  // проще, чем заметить, что он стоит больше задуманного.
  const near = (o) => {
    const v = Object.values(o || {}).map(Number).filter(Number.isFinite);
    return v.length ? Math.min(...v) : null;
  };
  E.stakes = E.stakes || {};
  E.stakes[key] = stake != null && stake !== '' ? Number(stake) : (near(E.stakes) ?? 5);
  E.stakeLimits = E.stakeLimits || {};
  E.stakeLimits[key] = near(E.stakeLimits) ?? 150;
  const mins = String(minutes || '').split(/[^0-9]+/).map(Number).filter(x => x === 10 || x === 30);
  if (mins.length) { E.assetTimings = E.assetTimings || {}; E.assetTimings[key] = mins; }

  const bak = path.join(ROOT, `config.pre-${key}.json`);
  fs.copyFileSync(CFG_PATH, bak);
  fs.writeFileSync(CFG_PATH, JSON.stringify(raw, null, 2) + '\n');
  JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));   // читаем обратно: писать битый конфиг нельзя
  console.log(`${E.title || exName}: добавлен ${key}`);
  console.log(`  адрес   ${url}`);
  if (sym !== key) console.log(`  символ  ${sym}`);
  console.log(`  ставка  ${E.stakes[key]} USDT, потолок ${E.stakeLimits[key]}`);
  console.log(`  минуты  ${mins.length ? mins.join(', ') : 'как у всей биржи'}`);
  console.log(`  копия старого конфига: ${path.basename(bak)}`);
  console.log(`Проверь адрес глазами и перезапусти исполнитель - актив появится и в панели.`);
}

if (process.argv[2] === 'add-asset') {
  addAssetMode(process.argv[3], process.argv[4], process.argv[5], process.argv[6], process.argv[7]);
} else if (process.argv[2] === 'migrate') {
  migrateMode();
} else if (process.argv[2] === 'login') {
  loginMode();
} else if (process.argv[2] === 'diag') {
  diagMode().catch(e => { console.error('diag упал:', e.message); process.exit(1); });
} else if (process.argv[2] === 'pnl') {
  pnlMode(process.argv[3]).catch(e => { console.error('сбор сводки упал:', e.message); process.exit(1); });
} else {
  // Ctrl+C и обычное завершение должны закрывать за собой браузер и
  // отпускать порт. Без этого после остановки оставались висеть окна
  // Chromium, а следующий запуск падал на EADDRINUSE.
  let closing = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (closing) process.exit(0);
      closing = true;
      log(`получен ${sig}, закрываюсь`);
      try { server.close(); } catch (e) {}
      await closeBrowser();
      process.exit(0);
    });
  }
  loadState();
  migrateBetsCsv();
  server.listen(CFG.port ?? 8787, () => {
    log(`Executor слушает :${CFG.port ?? 8787} | режим: ${state.dryRun ? 'DRY-RUN (без реальных ставок)' : 'LIVE'}`);
    for (const n of exNames()) {
      const e = exCfg(n);
      const assets = Object.keys(e.urls || {});
      log(`  биржа ${e.title}${n === defaultEx() ? ' (по умолчанию)' : ''}: `
        + `${assets.map(a => `${a} ${stakeFor(a, n)}`).join(' / ') || 'активов нет'} USDT `
        + `| выплата ${e.minPayoutStrict ? '>' : '>='} ${e.minPayout}%`
        + `${e.requirePagePayout ? ', обязательна со страницы' : ''} | слотов ${e.maxOpenBets}`);
      const tw = todayWindows(n);
      log(`    часы сегодня: ${tw || 'круглосуточно'}`
        + ` | сейчас ${inActiveHours(null, n) ? 'в смене' : 'молчит'}`);
    }
    log(`панель: http://127.0.0.1:${CFG.port ?? 8787}/panel/${CFG.secret}`);
    log('туннель: cloudflared tunnel --url http://localhost:' + (CFG.port ?? 8787));
    log(`человечный клик: ${CFG.humanize !== false ? 'вкл' : 'выкл'}`
      + ` | холостая активность: ${(CFG.idleRotation || {}).enabled !== false ? 'вкл' : 'выкл'}`
      + ` | окно по расписанию: ${CFG.autoWindow === false ? 'выкл' : 'вкл'}`);
    scheduleIdle();
    if ((CFG.source || 'webhook') === 'sheet') {
      const every = Math.max(2, (CFG.sheet || {}).pollSec ?? 5) * 1000;
      pollSheet();
      const sp = setInterval(() => pollSheet().catch(e => log('опрос листа упал: ' + e.message)), every);
      if (sp.unref) sp.unref();
    }
    // Сторож тишины: раз в минуту, дешевле некуда.
    const sil = setInterval(checkSilence, 60000);
    // Раз в полминуты: минута назначенного часа не должна проскочить
    // между тиками, а сама проверка стоит одно сравнение чисел.
    const pnlT = setInterval(() => pnlTick().catch(e => log('сводка не собралась: ' + e.message)), 30000);
    if (pnlT.unref) pnlT.unref();
    if (sil.unref) sil.unref();
    // Окно биржи по расписанию - тем же тиком.
    const win = setInterval(() => windowBySchedule().catch(e =>
      log('окно по расписанию: ' + e.message)), 60000);
    if (win.unref) win.unref();
    windowBySchedule().catch(() => {});
  });
}
