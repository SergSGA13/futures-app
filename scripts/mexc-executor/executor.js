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
  // migrate только переписывает config.json - браузер ему не нужен, и
  // требовать установку Playwright ради правки файла незачем.
  if (process.argv[2] !== 'migrate') {
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
    marketClosedText: e.marketClosedText || CFG.marketClosedText || 'Market Closed',
    openPositionsLabel: e.openPositionsLabel || CFG.openPositionsLabel || 'Open Positions',
    // Порог выплаты у каждой биржи свой. minPayoutStrict - когда нужно
    // именно БОЛЬШЕ порога, а не «не меньше».
    minPayout: e.minPayout ?? CFG.minPayout ?? 80,
    minPayoutStrict: e.minPayoutStrict === true,
    // Главное отличие Toobit: сигналы приходят без выплаты, и проверить
    // её можно только на странице. Не прочитали - не ставим.
    requirePagePayout: e.requirePagePayout === true,
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
    // Какие таймфреймы биржа вообще отрабатывает. На Toobit идут только
    // 10-минутные сигналы PRO-ветки, и 30-минутка, попавшая туда по
    // ошибке маршрутизации, должна отбиться, а не открыться.
    execTimings: e.execTimings || CFG.execTimings || [10],
    // Метки потока в поле "timing" сигнала. Источник шлёт разные потоки
    // разными метками: PRO-ветка - "10m", ветка MEXC - "MEXC _10m" и
    // "MEXC _30m", ветка ALT - "ALT10m". По ним и различаем, куда
    // ставить, без отдельного поля в сигнале. Сравнение ТОЧНОЕ: "10m"
    // это подстрока и "ALT10m", и "MEXC_10m", и по вхождению PRO-поток
    // забрал бы чужие сигналы.
    signalTimings: (e.signalTimings || []).map(t => String(t).toLowerCase().trim()),
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
};

// ── состояние на диске ──
// Слоты и дневной счётчик обязаны переживать перезапуск: биржа держит
// максимум 5 одновременных ставок, а исполнитель после рестарта считал
// бы, что открыто ноль, и мог открыть шестую.
// Минимум биржи по сумме ставки. Максимум у каждого актива свой и лежит
// в stakeLimits, а нижняя граница общая.
const MANUAL_STAKE_MIN = 5;
const STATE_PATH = path.join(ROOT, 'state.json');
const PERSIST = ['betsToday', 'day', 'placed', 'lastSignalAt', 'sheetRows'];
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
    }
    if (!Array.isArray(state.placed)) state.placed = [];
    log(`состояние восстановлено: ставок сегодня ${state.betsToday}, слотов ${openSlots()}`);
  } catch (e) { log('состояние не прочиталось: ' + e.message); }
}

// ── мелочи для «человечности» ──
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ставка зависит от актива: на MEXC это ETH 150 / BTC 250.
// Старый плоский stakeUSDT продолжает работать как запасной вариант.
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
  const prevActive = hour === 0 ? activeAt(grid, day - 1, 23) : activeAt(grid, day, hour - 1);
  if (!prevActive && min < edgeJitter(`s${day}-${hour}`, jit)) return false;
  // Конец блока: заканчиваем чуть раньше :00
  const nextActive = hour === 23 ? activeAt(grid, day + 1, 0) : activeAt(grid, day, hour + 1);
  if (!nextActive && min >= 60 - edgeJitter(`e${day}-${hour}`, jit)) return false;
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
  return out.length ? out.join(', ') : 'сегодня выходной';
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
const BETS_HEAD = 'time,exchange,asset,direction,timing,stake,payout_page,mode,status,note';
const BETS_HEAD_OLD = 'time,asset,direction,timing,stake,payout_page,mode,status,note';
function logBet(rec) {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) fs.writeFileSync(f, BETS_HEAD + '\n');
  fs.appendFileSync(f, [new Date().toISOString(), rec.ex || defaultEx(), rec.asset, rec.direction,
    rec.timing, rec.stake, rec.payoutPage ?? '', rec.mode, rec.status,
    JSON.stringify(rec.note || '')].join(',') + '\n');
}

// Со второй биржей в журнале появился столбец exchange. Дописать его в
// конец было нельзя: заметка обязана оставаться последней, в ней бывают
// запятые. Поэтому старый файл переписываем один раз при старте,
// проставляя всем прежним строкам биржу по умолчанию - иначе история
// ставок читалась бы со сдвигом колонок.
function migrateBetsCsv() {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines[0] !== BETS_HEAD_OLD) return;
  const def = defaultEx();
  const out = [BETS_HEAD];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const c = l.split(',');
    // Заметка - всё, что после восьмой запятой (в ней бывают свои).
    const note = c.length > 9 ? c.slice(8).join(',') : (c[8] ?? '');
    out.push([c[0], def, ...c.slice(1, 8), note].join(','));
  }
  fs.copyFileSync(f, f.replace(/\.csv$/, '.pre-exchange.csv'));
  fs.writeFileSync(f, out.join('\n') + '\n');
  log(`журнал ставок переведён на формат с биржей: ${out.length - 1} строк, копия старого рядом`);
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
function launchOpts(headless) {
  const o = {
    headless,
    viewport: { width: 1280, height: 860 },
    args: [
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
async function browser() {
  if (ctx) return;
  ctx = await playwright.chromium.launchPersistentContext(PROFILE, launchOpts(CFG.headless !== false));
  page = ctx.pages()[0] || await ctx.newPage();
  // Окно могут закрыть крестиком - тогда ctx мёртв, и следующая ставка
  // должна поднять новый, а не биться в закрытый контекст.
  ctx.on('close', () => { ctx = null; page = null; });
}
async function closeBrowser() {
  if (!ctx) return;
  const c = ctx;
  ctx = null; page = null;
  await c.close().catch(() => {});
}
function browserOpen() { return !!ctx; }

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
let mousePos = null;

// Подвод курсора к точке по дуге. Прямая из точки в точку - такой же
// машинный след, как и мгновенный «телепорт» в кнопку: у человека
// траектория выгнута, скорость неравномерная (разгон и торможение), а
// рука подрагивает. Квадратичная кривая Безье с контрольной точкой
// сбоку от прямой даёт ровно это, и стоит десяток move-событий.
async function mouseGlide(pg, x, y) {
  const from = mousePos || { x: x + randInt(-320, 320), y: y + randInt(-220, 220) };
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
  mousePos = { x, y };
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
async function clickStubborn(loc, what) {
  try { await humanClick(loc, 6000); return 'обычный'; }
  catch (e1) {
    log(`${what}: обычный клик не прошёл (${String(e1.message).split('\n')[0]}), пробую с force`);
    try { await loc.click({ force: true, timeout: 4000 }); return 'force'; }
    catch (e2) {
      log(`${what}: force тоже не прошёл, кликаю через DOM`);
      await loc.evaluate(el => el.click());
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
function amountSelectors() {
  return [
    curEx().selectors.amount,
    'input[placeholder*="USDT"]',
    'input[placeholder*="~"]',
    'input[inputmode="decimal"]',
    'input[type="number"]',
  ].filter(Boolean);
}

async function findAmount(perTryMs) {
  for (const sel of amountSelectors()) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: perTryMs });
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
async function pagePayout(direction) {
  const E = curEx();
  const word = E.dirWords[direction] || (direction === 'UP' ? 'Up' : 'Down');
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
    return found[idx];
  } catch (e) { return null; }
}

// Какой актив показывает страница СЕЙЧАС - по заголовку документа.
// Адрес меняется мгновенно, а SPA перерисовывает панель позже, поэтому
// url тут не свидетель: он уже говорит BTC, когда на экране ещё ETH.
// Заголовок биржа переписывает вместе с контрактом.
// null - определить не удалось (нет символа или их несколько).
async function pageAsset() {
  const t = await page.title().catch(() => '');
  const keys = Object.keys(curEx().urls || {}).sort((a, b) => b.length - a.length);
  const hit = keys.filter(k => new RegExp(k + '\\s*[_/-]?\\s*USDT', 'i').test(t));
  return hit.length === 1 ? hit[0] : null;
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
  const keys = Object.keys(curEx().urls || {}).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  try {
    return await page.evaluate(ks => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      let best = null, bestSize = 0;
      for (const el of document.querySelectorAll('*')) {
        if (!vis(el) || el.children.length > 1) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 24) continue;
        for (const k of ks) {
          if (!new RegExp('^' + k + '\\s*[-_/]?\\s*USDT', 'i').test(t)) continue;
          const size = parseFloat(getComputedStyle(el).fontSize) || 0;
          if (size > bestSize) { bestSize = size; best = k; }
        }
      }
      // Мелкий текст - это лента, а не шапка: такому не верим.
      return bestSize >= 14 ? best : null;
    }, keys);
  } catch (e) { return null; }
}

// ── ставка ──
async function placeBet(sig) {
  const t0 = Date.now();
  // С этой строки и до конца ставки все страничные помощники смотрят в
  // конфиг ИМЕННО ЭТОЙ биржи: селекторы, тексты чипов, порог выплаты.
  EX = exCfg(sig.ex);
  const url = EX.urls[sig.asset];
  if (!url) throw new Error(`нет URL для актива ${sig.asset} на бирже ${EX.title}`);
  await browser();
  // На передний план - тот же разговор про фоновое окно: невидимой
  // вкладке браузер отдаёт кадры по остаточному принципу.
  await page.bringToFront().catch(() => {});

  // Если нужная страница УЖЕ открыта и панель на ней жива - не трогаем
  // её вовсе. Раньше каждая ставка начиналась с полной перезагрузки:
  // лишние секунды на десятиминутной ставке, мигающее окно и повторная
  // сборка SPA на ровном месте. Проверка стоит полторы секунды и в
  // обычном случае экономит десять.
  let ready = null;
  if (page.url().startsWith(url)) {
    ready = await findAmount(1500);
    if (ready) log('страница уже открыта, перезагрузка не нужна');
  }
  if (!ready) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
    ready = await waitForPanel();
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
    throw new Error(`страница показывает ${seen}, а сигнал по ${sig.asset}`
      + ` (адрес ${page.url()}) - ставку не делаю`);
  }
  // Определить не удалось - идём дальше с записью: жёсткий отказ на этом
  // основании остановил бы все ставки, если биржа сменит заголовок.
  log(seen ? `актив страницы ${seen} совпал` : 'актив страницы по заголовку не определить');

  // залогинены ли мы: на странице не должно быть кнопки Log In
  const loginBtn = page.locator(EX.selectors.loginMarker).first();
  if (await loginBtn.count() > 0 && await loginBtn.isVisible().catch(() => false)) {
    await shot('not-logged-in');
    throw new Error('НЕ ЗАЛОГИНЕН - выполни: node executor.js login');
  }

  // ── таймфрейм ──
  // Экспирация НЕ подтверждается ничем, кроме выбранного чипа, поэтому
  // ошибиться тут значит открыть ставку не на те минуты. Так и вышло:
  // .first() брал первое совпадение, оно оказывалось скрытым, клик
  // молча пропускался, и ставка уходила на тот таймфрейм, что стоял на
  // странице. Пока каждая ставка перезагружала страницу, чип сбрасывался
  // сам; после оптимизации «не перезагружать, если уже открыто» прежний
  // выбор стал сохраняться - и 10-минутные сигналы поехали на 30 минут.
  const tfText = EX.timeUnitText[String(sig.timing)] || '10m';
  const tfRe = new RegExp('^\\s*' + tfText + '\\s*$');

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

  // Какой чип отмечен выбранным сейчас. null - разметка не даёт этого
  // понять; тогда проверять нечего, но и ломать исполнение нельзя.
  async function activeChipName() {
    for (const t of Object.values(EX.timeUnitText)) {
      const c = await visibleChip(new RegExp('^\\s*' + t + '\\s*$'));
      if (c && await chipActive(c)) return t;
    }
    return null;
  }

  const tf = await visibleChip(tfRe);
  if (!tf) {
    await shot('no-timeframe');
    await dumpPage('no-timeframe');
    throw new Error(`чип таймфрейма "${tfText}" не найден - смотри ДАМП выше`);
  }
  const before = await activeChipName();
  if (before !== tfText) {
    const how = await clickStubborn(tf, `чип ${tfText}`)
      .catch(e => { throw new Error('чип таймфрейма не кликнулся: ' + e.message); });
    if (how !== 'обычный') log(`чип ${tfText} нажат способом «${how}»`);
    await page.waitForTimeout(randInt(500, 900));
  }
  // Проверяем РЕЗУЛЬТАТ, а не факт клика: клик мог не переключить вкладку,
  // и ставка ушла бы не на те минуты. Но если разметка вообще не отмечает
  // выбранный чип (activeChipName вернул null и до, и после), проверять
  // нечем - тогда идём дальше с записью в лог. Запрет на этом основании
  // остановил бы вообще все ставки, а это хуже исходной ошибки.
  const after = await activeChipName();
  if (after === tfText) {
    log(`таймфрейм ${tfText} выбран`);
  } else if (after == null && before == null) {
    log(`таймфрейм ${tfText}: кликнул, но проверить выбор нечем - разметка не отмечает активный чип`);
  } else {
    await shot('timeframe-mismatch');
    throw new Error(`таймфрейм не переключился на ${tfText}, на странице выбран ${after}`);
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
  const pv = await pagePayout(sig.direction);
  const need = EX.minPayout;
  const cmp = EX.minPayoutStrict ? 'больше' : 'не меньше';
  if (pv == null) {
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
    log(`выплата на странице ${pv}% (нужно ${cmp} ${need}%)`);
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

  if (state.dryRun) {
    await shot(`dryrun-${sig.asset}-${sig.direction}`);
    log(`DRY-RUN: дошёл до кнопки ${sig.direction}, ставка ${betStake(sig)} USDT, payout ${pv}% - не нажимаю`);
    return { status: 'dry-run', payoutPage: pv };
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
  return { status: 'placed', payoutPage: pv };
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
    const sig = {
      ticker: r[1], direction: r[2], payout: parseFloat(r[9]) || null,
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
  const hit = exNames().find(n => exCfg(n).signalTimings.includes(raw));
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
    sig.asset = pool.sort((a, b) => b.length - a.length)
      .find(k => t.includes(k.toUpperCase())) || '';
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
  sig.timing = /30/.test(String(sig.timing ?? '')) ? 30 : 10;
  return !!(exCfg(ex).urls || {})[sig.asset]
      && (sig.direction === 'UP' || sig.direction === 'DOWN');
}

// Возвращает 'queued' | 'merged' | причину отказа.
function acceptSignal(sig, src) {
  const mode = state.dryRun ? 'DRY' : 'LIVE';
  const skip = (reason, status, msg) => {
    if (msg) log(`пропуск (${src}): ${msg}`);
    if (status) logBet({ ...sig, stake: stakeFor(sig.asset, sig.ex), mode, status });
    return reason;
  };

  const execTimings = exCfg(sig.ex).execTimings;
  if (execTimings.indexOf(sig.timing) < 0) {
    return skip('timing', null,
      `${exCfg(sig.ex).title}: тайминг ${sig.timing}м не в списке (${execTimings.join(', ')}м)`);
  }
  if (!inActiveHours(null, sig.ex)) {
    return skip('quiet-hours', 'skip-quiet',
      `${exCfg(sig.ex).title}: тихие часы (сегодня ${todayWindows(sig.ex)})`);
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
  const key = `${sig.ex}|${sig.asset}|${sig.direction}|${sig.dedupKey || sig.receivedAt || sig.bartime || sig.sentAt}`;
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
  // Сумма, названная явно (ручная ставка из панели), важнее настройки:
  // человек нажал её сам. Границы всё равно биржевые.
  if (sig.stake) return Math.round(clamp(sig.stake, MANUAL_STAKE_MIN, stakeMax(sig.asset, sig.ex), stakeFor(sig.asset, sig.ex)));
  const base = stakeFor(sig.asset, sig.ex);
  const m = Math.max(1, Math.min(sig.mult || 1, burstCfg().max));
  return Math.min(Math.round(base * m), stakeMax(sig.asset, sig.ex));
}
function enqueueSignal(sig) {
  const B = burstCfg();
  if (!B.enabled || !B.windowMs) {
    sig.mult = 1; sig.burstCount = 1;
    state.queue.push(sig);
    setImmediate(pump);
    return 'queued';
  }
  // Ключ пачки включает биржу: один и тот же ETH UP на MEXC и на Toobit -
  // две разные ставки разными деньгами, складывать их в одну нельзя.
  const k = sig.ex + '|' + sig.asset + '|' + sig.direction;
  const g = groups.get(k);
  if (g) {
    g.count++;
    log(`пачка ${k}: сигнал ${g.count} присоединён к текущей`);
    logBet({ ...sig, stake: stakeFor(sig.asset, sig.ex), mode: state.dryRun ? 'DRY' : 'LIVE',
             status: 'merged', note: `в пачку с ${new Date(g.sig.receivedAt).toISOString().slice(11, 19)}` });
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
      const r = await placeBet(sig);
      logBet({ ...sig, stake: betStake(sig), mode, status: r.status, payoutPage: r.payoutPage,
               note: sig.mult > 1 ? `x${sig.mult} из ${sig.burstCount} сигналов` : '' });
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
  }
}

// ── холостая активность ──
// Аккаунт, который заходит на страницу ровно за секунду до ставки и тут
// же уходит, выглядит роботом. Между ставками делаем то, что делает
// живой человек: смотрит другой актив, открывает историю, листает,
// щёлкает таймфреймы. Ставок это не касается - только «шум» вокруг них.
// Холостое действие держит ту же блокировку, что и ставка, - иначе они
// дрались бы за страницу. Значит, любая его пауза откладывает пришедший
// сигнал. Поэтому ждём не сплошняком, а поглядывая на очередь: как
// только там что-то появилось, сворачиваемся и отдаём страницу ставке.
const IDLE_ACTIONS = ['switch-asset', 'history', 'scroll', 'timeframe'];

async function idleWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state.queue.length) return false;
    await sleep(Math.min(250, until - Date.now()));
  }
  return true;
}

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
    await browser();
    // Биржу для холостого захода выбираем ту, что уже открыта, иначе
    // случайную: гонять окно между биржами каждые десять минут - это
    // не «человечность», а метание.
    // Ходим только по биржам, которые сейчас в смене: активность на
    // спящей бирже - ровно тот след, которого мы избегаем.
    const names = activeExchanges();
    if (!names.length) return;
    const openOn = names.find(n => Object.values(exCfg(n).urls || {})
      .some(u => page.url().startsWith(u)));
    EX = exCfg(openOn || names[randInt(0, names.length - 1)]);
    if (!openOn) {
      const first = Object.values(EX.urls)[0];
      if (!first) return;
      await page.goto(first, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(1500, 3000));
    }

    if (act === 'switch-asset') {
      // Список берём из конфига: захардкоженные ETH/BTC делали вид, что
      // третьего актива не существует, и со SPCX уводили страницу на ETH.
      const all = Object.keys(EX.urls || {});
      const cur = all.find(a => page.url().startsWith(EX.urls[a]));
      const rest = all.filter(a => a !== cur);
      const other = rest.length ? rest[randInt(0, rest.length - 1)] : all[0];
      await page.goto(EX.urls[other], { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(2000, 6000));

    } else if (act === 'history') {
      const tab = page.locator(EX.selectors.timeUnit)
        .filter({ hasText: /^\s*(Position History|Order History|History|Positions)\s*$/i }).first();
      if (await tab.isVisible().catch(() => false)) {
        await humanClick(tab);
        await idleWait(randInt(2000, 7000));
      }

    } else if (act === 'scroll') {
      await page.mouse.move(randInt(300, 1000), randInt(200, 700), { steps: randInt(5, 15) });
      await page.mouse.wheel(0, randInt(150, 700));
      await idleWait(randInt(800, 3000));
      await page.mouse.wheel(0, -randInt(150, 700));

    } else if (act === 'timeframe') {
      // 30m и обратно на 10m. Безопасно: боевой код всё равно сам
      // выставляет нужный чип перед каждой ставкой.
      for (const t of ['30m', '10m']) {
        const chip = page.locator(EX.selectors.timeUnit)
          .filter({ hasText: new RegExp('^\\s*' + t + '\\s*$') }).first();
        if (await chip.isVisible().catch(() => false)) await humanClick(chip);
        if (!await idleWait(randInt(1200, 4000))) break;
      }
    }
    state.lastIdle = { act, at: Date.now() };
    log(`холостое действие: ${act}`);
  } catch (e) {
    // Намеренно не трогаем consecutiveErrors: это шум, а не ставка,
    // и его сбои не должны загонять исполнитель в dry-run.
    log(`холостое действие "${act}" не удалось: ${e.message}`);
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
  // Окно открыто на бирже, которая уже сдала смену? Это и есть
  // пересменка: страницу надо перевести на ту, что заступила.
  const openOn = browserOpen() && exNames().find(n => Object.values(exCfg(n).urls || {})
    .some(u => page.url().startsWith(u)));
  const shift = openOn && !active.includes(openOn) && active.length;

  if (active.length && (!browserOpen() || shift)) {
    // На паузе окно не открываем: пауза - это «не трогай биржу».
    if (state.paused) return;
    // Открытое руками не перетаскиваем на другую биржу: человек смотрит.
    if (shift && state.windowManual) return;
    state.busy = true;
    try {
      await browser();
      // Биржу и актив выбираем случайно среди работающих сейчас: одна и
      // та же стартовая страница каждое утро - такая же сигнатура, как
      // одинаковая точка клика. Держать открытыми обе биржи смысла нет,
      // вторую откроет сама ставка.
      EX = exCfg(active[randInt(0, active.length - 1)]);
      const all = Object.keys(EX.urls || {});
      if (!all.length) return;
      const a = all[randInt(0, all.length - 1)];
      await page.goto(EX.urls[a], { waitUntil: 'domcontentloaded', timeout: 25000 });
      state.windowAt = Date.now();
      log(shift
        ? `пересменка: ${exCfg(openOn).title} закончила, окно переведено на ${EX.title} ${a}`
        : `окно биржи открыто заранее (${EX.title} ${a}): начались активные часы`);
    } catch (e) {
      log('окно биржи не открылось по расписанию: ' + e.message);
      await closeBrowser();
    } finally { state.busy = false; }
    return;
  }

  if (!active.length && browserOpen()) {
    // Открытое руками не закрываем: человек смотрит на него сам.
    if (state.windowManual) return;
    await closeBrowser();
    state.windowAt = Date.now();
    log('окно биржи закрыто: начались тихие часы');
  }
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
    // Заметка - последний столбец, и в ней бывают запятые: «таймфрейм не
    // переключился на 10m, на странице выбран 30m». Разбиение по запятой
    // оставляло от такой заметки только начало - то есть ровно ту часть,
    // где ещё не сказано, что именно пошло не так. Хвост собираем назад.
    const last = head[head.length - 1];
    if (cells.length > head.length) o[last] = cells.slice(head.length - 1).join(',');
    return o;
  });
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
          minPayout: e.minPayout,
          minPayoutStrict: e.minPayoutStrict,
          execTimings: e.execTimings,
          // Часы у каждой биржи свои: пока работает одна, вторая молчит.
          // Сетки нет - показываем общую, по ней биржа и живёт.
          hours: (((CFG.exchanges[n] || {}).schedule || {}).hours
                  || (CFG.schedule || {}).hours || Array(7).fill('1'.repeat(24))),
          ownHours: !!gridOf(((CFG.exchanges[n] || {}).schedule || {}).hours),
          activeNow: inActiveHours(null, n),
          todayWindows: todayWindows(n),
          requirePagePayout: e.requirePagePayout,
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
      if (String(v) !== String(CFG.execTimings || [10])) changed.push('таймфреймы: ' + v.join(', ') + 'м');
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

  const am = req.url.match(/^\/api\/([^/?]+)\/([a-z-]+)/);
  if (am) {
    if (am[1] !== CFG.secret) { res.writeHead(403); res.end('forbidden'); return; }
    const action = am[2];
    if (action === 'state') return sendJson(200, { ...snapshot(), bets: recentBets(150) });
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
      browser().then(async () => {
        // Уже стоим на нужной бирже - не дёргаем страницу.
        const here = Object.values(E.urls).some(u => page.url().startsWith(u));
        if (!here) await page.goto(first, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        EX = E;
        state.windowManual = true;
        log(`панель: окно биржи открыто (${E.title})`);
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
  let sample = {};
  try {
    sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')
      .replace(/^\uFEFF/, '')).exchanges || {};
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
  const mexc = (had && raw.exchanges.mexc) ? fill({ ...raw.exchanges.mexc }, sample.mexc, 'mexc') : {
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
  const toobit = (had && raw.exchanges.toobit) ? fill({ ...raw.exchanges.toobit }, sample.toobit, 'toobit') : {
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
async function diagMode() {
  // node executor.js diag [актив] [биржа] - вторую биржу иначе не
  // осмотреть, а именно её селекторы и надо подобрать.
  EX = exCfg((process.argv[4] || '').toLowerCase() || defaultEx());
  const assets = Object.keys(EX.urls || {});
  const want = String(process.argv[3] || assets[0] || '').toUpperCase();
  const asset = assets.includes(want) ? want : assets[0];
  if (!asset) { console.error(`у биржи ${EX.title} не задан ни один адрес в urls`); process.exit(1); }
  console.log(`Открываю ${EX.title} ${asset} и смотрю, что на странице. Ставка НЕ делается.`);
  await browser();
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
    log(`чип "${tfText}": по селектору ${n}, по тексту ${byText}`
      + (n === 0 && byText > 0 ? ' - берётся по тексту' : '')
      + (n === 0 && byText === 0 ? ' - НЕ НАЙДЕН' : ''));
  }
  // Чем разметка отмечает ВЫБРАННЫЙ чип. Без этого проверка «таймфрейм
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
  const f = await shot(`diag-${EX.name}-${asset}`);
  log('скриншот: ' + f);
  console.log('\nГотово. Пришли последние строки logs/executor.log и этот скриншот.');
  await ctx.close();
  process.exit(0);
}

if (process.argv[2] === 'migrate') {
  migrateMode();
} else if (process.argv[2] === 'login') {
  loginMode();
} else if (process.argv[2] === 'diag') {
  diagMode().catch(e => { console.error('diag упал:', e.message); process.exit(1); });
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
    if (sil.unref) sil.unref();
    // Окно биржи по расписанию - тем же тиком.
    const win = setInterval(() => windowBySchedule().catch(e =>
      log('окно по расписанию: ' + e.message)), 60000);
    if (win.unref) win.unref();
    windowBySchedule().catch(() => {});
  });
}
