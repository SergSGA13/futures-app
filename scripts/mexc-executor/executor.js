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
  console.error('Playwright не установлен. В папке mexc-executor выполни:\n  npm install playwright && npx playwright install chromium');
  process.exit(1);
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
};

// ── мелочи для «человечности» ──
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ставка зависит от актива: на MEXC это ETH 150 / BTC 250.
// Старый плоский stakeUSDT продолжает работать как запасной вариант.
function stakeFor(asset) {
  const t = CFG.stakes || {};
  return t[asset] != null ? t[asset] : (CFG.stakeUSDT ?? 5);
}
// Потолок ставки по активу: у поля ввода на бирже свой лимит
// (на ETH видно "1～150 USDT"), и панель не должна давать выйти за него.
function stakeMax(asset) {
  const l = CFG.stakeLimits || {};
  return l[asset] != null ? l[asset] : 150;
}

// Биржа держит не больше 5 ставок одновременно. Окно берём ДЛИННЕЕ
// экспирации (10 мин), иначе слот освободится в учёте раньше, чем на бирже.
// Храним не только время, но и направление: лимиты бывают отдельные
// на UP и на DOWN.
function prunePlaced() {
  const winMs = (CFG.slotWindowMin ?? 11) * 60000;
  const now = Date.now();
  state.placed = state.placed.filter(p => now - p.t < winMs);
  return state.placed;
}
function openSlots() { return prunePlaced().length; }
function dirSlots(dir) { return prunePlaced().filter(p => p.dir === dir).length; }
// Сколько ставок одного направления пускаем в окно. Смысл в том, что
// подряд идущие сигналы одной стороны - обычно один и тот же заход,
// и ставить на него пять раз значит просто впятеро увеличить ставку.
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
function scheduleGrid() {
  const S = CFG.schedule || {};
  if (!S.enabled) return null;
  const rows = Array.isArray(S.hours) ? S.hours : [];
  if (rows.length !== 7) return null;
  return rows.map(r => String(r || '').padEnd(24, '0').slice(0, 24));
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
function inActiveHours(when) {
  const grid = scheduleGrid();
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
// Человекочитаемое расписание на сегодня - для панели и лога.
function todayWindows() {
  const grid = scheduleGrid();
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
function logBet(rec) {
  const f = path.join(LOGS, 'bets.csv');
  if (!fs.existsSync(f)) fs.writeFileSync(f, 'time,asset,direction,timing,stake,payout_page,mode,status,note\n');
  fs.appendFileSync(f, [new Date().toISOString(), rec.asset, rec.direction, rec.timing,
    rec.stake, rec.payoutPage ?? '', rec.mode, rec.status, JSON.stringify(rec.note || '')].join(',') + '\n');
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
async function humanClick(loc, timeout = 5000) {
  if (CFG.humanize === false) return loc.click({ timeout });
  await sleep(randInt(120, 480));
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
      };
    });
    log(`ДАМП [${tag}] url=${info.url} | фреймов на странице: ${page.frames().length}`);
    log(`  поля ввода (${info.inputs.length}): ` + JSON.stringify(info.inputs.slice(0, 12)));
    log(`  кнопки (${info.buttons.length}): ` + JSON.stringify(info.buttons.slice(0, 30)));
    log(`  строки с Payout: ` + JSON.stringify(info.payoutText));
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
    CFG.selectors.amount,
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
    const label = (CFG.openPositionsLabel || 'Open Positions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// Достаём payout со страницы: "Up Payout 80%" / "Down Payout 80%"
async function pagePayout(direction) {
  try {
    const body = await page.evaluate(() => document.body.innerText);
    const re = new RegExp((direction === 'UP' ? 'Up' : 'Down') + '\\s*Payout\\s*([0-9.]+)\\s*%', 'i');
    const m = body.match(re);
    return m ? parseFloat(m[1]) : null;
  } catch (e) { return null; }
}

// ── ставка ──
async function placeBet(sig) {
  const t0 = Date.now();
  const url = CFG.urls[sig.asset];
  if (!url) throw new Error('нет URL для актива ' + sig.asset);
  await browser();
  // На передний план - тот же разговор про фоновое окно: невидимой
  // вкладке браузер отдаёт кадры по остаточному принципу.
  await page.bringToFront().catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
  let ready = await waitForPanel();
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

  // залогинены ли мы: на странице не должно быть кнопки Log In
  const loginBtn = page.locator(CFG.selectors.loginMarker).first();
  if (await loginBtn.count() > 0 && await loginBtn.isVisible().catch(() => false)) {
    await shot('not-logged-in');
    throw new Error('НЕ ЗАЛОГИНЕН - выполни: node executor.js login');
  }

  // таймфрейм (10m / 30m)
  const tfText = CFG.timeUnitText[String(sig.timing)] || '10m';
  // ВАЖНО: раньше строка склеивалась в
  //   'button, div[role=button], span:has-text("10m")'
  // а CSS читает это как СПИСОК через запятую - :has-text() относился
  // только к span. Локатор совпадал с ЛЮБОЙ кнопкой страницы, и .first()
  // хватал то скрытый ant-tabs-nav-more, то кнопку Deposit в шапке.
  // filter() применяет условие ко всему набору, как и задумано.
  const tf = page.locator(CFG.selectors.timeUnit)
    .filter({ hasText: new RegExp('^\\s*' + tfText + '\\s*$') }).first();
  // именно visible: селектор широкий и легко цепляет скрытый элемент,
  // клик по которому висел бы до таймаута
  if (await tf.isVisible().catch(() => false)) {
    await humanClick(tf).catch(e => log('чип таймфрейма не кликнулся: ' + e.message));
  }
  await page.waitForTimeout(randInt(400, 900));

  // страховка: payout на странице (вебхук уже проверял, но payout плавает)
  const pv = await pagePayout(sig.direction);
  if (pv != null && pv < (CFG.minPayout ?? 80)) {
    await shot('payout-low');
    return { status: 'skip-payout', payoutPage: pv };
  }

  // Поле суммы уже найдено при ожидании панели
  const amount = ready.loc;
  await humanFill(amount, stakeFor(sig.asset));
  await page.waitForTimeout(randInt(250, 700));

  // кнопка Up / Down
  const btnSel = sig.direction === 'UP' ? CFG.selectors.up : CFG.selectors.down;
  const dirWord = sig.direction === 'UP' ? 'Up' : 'Down';
  // Сначала ТОЧНОЕ совпадение по тексту. По диагностике на странице
  // ровно одна кнопка "Up" и одна "Down", а :has-text() ищет подстроку
  // и поймал бы, например, "Upgrade", появись такая кнопка позже.
  // Если точного нет - откатываемся на селектор из конфига.
  let btn = page.locator('button')
    .filter({ hasText: new RegExp('^\\s*' + dirWord + '\\s*$') }).first();
  if (await btn.count() === 0) btn = page.locator(btnSel).first();
  if (await btn.count() === 0) {
    await shot('no-button');
    await dumpPage('no-button');
    throw new Error('кнопка не найдена: ' + btnSel + ' - смотри ДАМП выше');
  }

  if (state.dryRun) {
    await shot(`dryrun-${sig.asset}-${sig.direction}`);
    return { status: 'dry-run', payoutPage: pv };
  }

  const posBefore = await openPositionsCount();
  await humanClick(btn);
  await page.waitForTimeout(randInt(500, 900));
  // возможное окно подтверждения
  if (CFG.selectors.confirm) {
    const c = page.locator(CFG.selectors.confirm).first();
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
      logBet({ ...sig, stake: stakeFor(sig.asset), mode, status: 'skip-stale' });
    } else if (process.env.TEST_MODE === '1') {
      logBet({ ...sig, stake: stakeFor(sig.asset), mode, status: 'test-mode' });
    } else {
      const r = await placeBet(sig);
      logBet({ ...sig, stake: stakeFor(sig.asset), mode, status: r.status, payoutPage: r.payoutPage });
      // Слот занимаем и в dry-run: иначе прогон не покажет, сколько
      // сигналов реально упрётся в биржевой лимит.
      // 'placed-unconfirmed' и '-unverified' тоже занимают слот и лимит:
      // позиция могла открыться, и считать иначе значило бы рисковать
      // превышением биржевого лимита.
      const counts = ['placed', 'placed-unconfirmed', 'placed-unverified'];
      if (counts.includes(r.status) || r.status === 'dry-run') {
        state.placed.push({ t: Date.now(), dir: sig.direction });
      }
      if (counts.includes(r.status)) state.betsToday++;
      state.consecutiveErrors = 0;
    }
  } catch (e) {
    state.consecutiveErrors++;
    log(`ОШИБКА ставки ${sig.asset} ${sig.direction}: ${e.message}`);
    logBet({ ...sig, stake: stakeFor(sig.asset), mode, status: 'error', note: e.message });
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
  if (!inActiveHours()) return;
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
    if (!/mexc\.com/.test(page.url())) {
      await page.goto(CFG.urls.ETH, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(1500, 3000));
    }

    if (act === 'switch-asset') {
      const other = /BTC/.test(page.url()) ? 'ETH' : 'BTC';
      await page.goto(CFG.urls[other], { waitUntil: 'domcontentloaded', timeout: 15000 });
      await idleWait(randInt(2000, 6000));

    } else if (act === 'history') {
      const tab = page.locator(CFG.selectors.timeUnit)
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
        const chip = page.locator(CFG.selectors.timeUnit)
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
    maxOpenBets: CFG.maxOpenBets ?? 5,
    queue: state.queue.length,
    consecutiveErrors: state.consecutiveErrors,
    stakes: { ETH: stakeFor('ETH'), BTC: stakeFor('BTC') },
    minPayout: CFG.minPayout ?? 80,
    execTimings: CFG.execTimings || [10],
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    humanize: CFG.humanize !== false,
    lastIdle: state.lastIdle,
    activeNow: inActiveHours(),
    todayWindows: todayWindows(),
    browserOpen: browserOpen(),
    busy: state.busy,
    // всё, что редактируется в панели, отдаём одним куском
    settings: {
      stakes: { ETH: stakeFor('ETH'), BTC: stakeFor('BTC') },
      stakeLimits: { ETH: stakeMax('ETH'), BTC: stakeMax('BTC') },
      dirLimits: { UP: dirLimit('UP'), DOWN: dirLimit('DOWN') },
      maxOpenBets: CFG.maxOpenBets ?? 5,
      maxBetsPerDay: CFG.maxBetsPerDay ?? 40,
      minPayout: CFG.minPayout ?? 80,
      slotWindowMin: CFG.slotWindowMin ?? 11,
      humanize: CFG.humanize !== false,
      schedule: {
        enabled: !!(CFG.schedule || {}).enabled,
        hours: scheduleGrid() || (Array.isArray((CFG.schedule || {}).hours) && CFG.schedule.hours.length === 7
          ? CFG.schedule.hours : Array(7).fill('1'.repeat(24))),
        jitterMin: (CFG.schedule || {}).jitterMin ?? 0,
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
  if (s.stakes) {
    CFG.stakes = CFG.stakes || {};
    for (const a of ['ETH', 'BTC']) {
      if (s.stakes[a] == null) continue;
      const v = Math.round(clamp(s.stakes[a], 1, stakeMax(a), stakeFor(a)));
      if (v !== stakeFor(a)) changed.push(`ставка ${a} ${stakeFor(a)}→${v}`);
      CFG.stakes[a] = v;
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
  if (s.minPayout != null) {
    const v = clamp(s.minPayout, 50, 100, CFG.minPayout ?? 80);
    if (v !== (CFG.minPayout ?? 80)) changed.push(`payout ${CFG.minPayout ?? 80}→${v}`);
    CFG.minPayout = v;
  }
  if (s.maxBetsPerDay != null) {
    const v = Math.round(clamp(s.maxBetsPerDay, 1, 500, CFG.maxBetsPerDay ?? 40));
    if (v !== (CFG.maxBetsPerDay ?? 40)) changed.push(`ставок в день ${CFG.maxBetsPerDay ?? 40}→${v}`);
    CFG.maxBetsPerDay = v;
  }
  if (s.humanize != null) {
    CFG.humanize = !!s.humanize;
    changed.push('человечный клик ' + (CFG.humanize ? 'вкл' : 'выкл'));
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
    return;
  }

  const am = req.url.match(/^\/api\/([^/?]+)\/([a-z-]+)/);
  if (am) {
    if (am[1] !== CFG.secret) { res.writeHead(403); res.end('forbidden'); return; }
    const action = am[2];
    if (action === 'state') return sendJson(200, { ...snapshot(), bets: recentBets(40) });
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
        const asset = m.asset === 'BTC' ? 'BTC' : 'ETH';
        const direction = String(m.direction).toUpperCase() === 'DOWN' ? 'DOWN' : 'UP';
        state.queue.push({ asset, direction, timing: 10, receivedAt: Date.now(), label: 'manual' });
        log(`панель: ручная ставка ${asset} ${direction}`);
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
      browser().then(async () => {
        if (!/mexc\.com/.test(page.url())) {
          await page.goto(CFG.urls.ETH, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        }
        log('панель: окно биржи открыто');
        sendJson(200, { ok: true });
      }).catch(e => { log('окно биржи не открылось: ' + e.message); sendJson(500, { error: e.message }); });
      return;
    }
    if (req.method === 'POST' && action === 'browser-close') {
      if (state.busy) return sendJson(409, { error: 'исполнитель занят' });
      closeBrowser().then(() => { log('панель: окно биржи закрыто'); sendJson(200, { ok: true }); });
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
    // актив: из ticker ("ETHUSDT.P"/"BTCUSDT.P") или явного поля
    sig.asset = sig.asset || ((sig.ticker || '').includes('BTC') ? 'BTC' :
                              ((sig.ticker || '').includes('ETH') ? 'ETH' : ''));
    sig.direction = String(sig.direction || '').toUpperCase();
    if (sig.direction === 'BUY') sig.direction = 'UP';
    if (sig.direction === 'SELL') sig.direction = 'DOWN';
    // тайминг: из метки "MEXC _10m"/"MEXC _30m" (или числа)
    sig.timing = /30/.test(String(sig.timing ?? '')) ? 30 : 10;
    if (sig.asset !== 'ETH' && sig.asset !== 'BTC') { res.writeHead(400); res.end('bad asset'); return; }
    if (sig.direction !== 'UP' && sig.direction !== 'DOWN') { res.writeHead(400); res.end('bad direction'); return; }
    // исполняем только разрешённые таймфреймы (по умолчанию 10m)
    const execTimings = CFG.execTimings || [10];
    if (execTimings.indexOf(sig.timing) < 0) {
      log(`пропуск: тайминг ${sig.timing}м не в execTimings`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'timing' }));
      return;
    }

    // тихие часы: аккаунт не торгует круглосуточно
    if (!inActiveHours()) {
      log(`пропуск: тихие часы (сегодня ${todayWindows()})`);
      logBet({ ...sig, stake: stakeFor(sig.asset), mode: state.dryRun ? 'DRY' : 'LIVE', status: 'skip-quiet' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'quiet-hours' }));
      return;
    }

    // пауза с панели
    if (state.paused) {
      log('пропуск: исполнитель на паузе');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'paused' }));
      return;
    }

    // лимит ставок одного направления в окне
    const dirBusy = dirSlots(sig.direction) + state.queue.filter(q => q.direction === sig.direction).length;
    if (dirBusy >= dirLimit(sig.direction)) {
      log(`пропуск: ${sig.direction} уже ${dirBusy}/${dirLimit(sig.direction)} в окне ${CFG.slotWindowMin ?? 11}мин`);
      logBet({ ...sig, timing: sig.timing, stake: stakeFor(sig.asset), mode: state.dryRun ? 'DRY' : 'LIVE', status: 'skip-dir-limit' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'dir-limit' }));
      return;
    }

    // биржевой лимит одновременных ставок
    const busySlots = openSlots() + state.queue.length;
    if (busySlots >= (CFG.maxOpenBets ?? 5)) {
      log(`пропуск: занято слотов ${busySlots}/${CFG.maxOpenBets ?? 5}`);
      logBet({ ...sig, timing: sig.timing, stake: stakeFor(sig.asset), mode: state.dryRun ? 'DRY' : 'LIVE', status: 'skip-slots' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'slots' }));
      return;
    }

    // новый день - сброс дневного счётчика
    const today = new Date().toDateString();
    if (today !== state.day) { state.day = today; state.betsToday = 0; }

    // дневной лимит ставок
    if (!state.dryRun && state.betsToday >= (CFG.maxBetsPerDay ?? 40)) {
      log('дневной лимит ставок достигнут - пропуск');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'daily-limit' }));
      return;
    }

    // дедуп повторных доставок (тот же сигнал в течение 2 минут)
    const key = `${sig.asset}|${sig.direction}|${sig.bartime || sig.sentAt}`;
    const now = Date.now();
    state.recent = state.recent.filter(r => now - r.t < 120000);
    if (state.recent.some(r => r.key === key)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'duplicate' }));
      return;
    }
    state.recent.push({ key, t: now });

    sig.receivedAt = now;
    state.queue.push(sig);
    log(`сигнал принят: ${sig.asset} ${sig.direction} ${sig.label || sig.timing} payout=${sig.payout}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: true, dryRun: state.dryRun }));
    setImmediate(pump);
  });
});

// ── режим login ──
async function loginMode() {
  console.log('Открываю окно браузера. Войди в аккаунт MEXC, реши капчу,');
  console.log('убедись что видишь страницу Event Futures, затем закрой окно.');
  const c = await playwright.chromium.launchPersistentContext(PROFILE, launchOpts(false));
  const p = c.pages()[0] || await c.newPage();
  await p.goto(CFG.urls.BTC, { waitUntil: 'domcontentloaded' });
  await new Promise(resolve => c.on('close', resolve));
  console.log('Профиль сохранён. Теперь запускай: node executor.js');
}

// ── режим diag: открыть страницу и рассказать, что на ней, без ставки ──
async function diagMode() {
  const asset = (process.argv[3] || 'ETH').toUpperCase() === 'BTC' ? 'BTC' : 'ETH';
  console.log(`Открываю ${asset} и смотрю, что на странице. Ставка НЕ делается.`);
  await browser();
  await page.goto(CFG.urls[asset], { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(CFG.pageSettleMs ?? 2500);

  const loginBtn = page.locator(CFG.selectors.loginMarker).first();
  const notLogged = await loginBtn.isVisible().catch(() => false);
  log(notLogged ? 'ВНИМАНИЕ: похоже, НЕ залогинен (видна кнопка Log In)' : 'логин на месте');

  // Ждём отрисовку, иначе дамп опишет пустую страницу и введёт в заблуждение
  const ready = await waitForPanel();
  log(ready ? ('панель готова, поле суммы: ' + ready.sel)
            : 'панель НЕ отрисовалась за отведённое время');
  await dumpPage('diag-' + asset);

  // Проверяем чип таймфрейма тем же способом, что и боевой код
  for (const tfText of Object.values(CFG.timeUnitText || { 10: '10m' })) {
    const n = await page.locator(CFG.selectors.timeUnit)
      .filter({ hasText: new RegExp('^\\s*' + tfText + '\\s*$') }).count().catch(() => -1);
    log(`чип "${tfText}": найдено элементов ${n}`);
  }
  for (const dir of ['UP', 'DOWN']) {
    log(`payout ${dir} по текущему селектору: ${await pagePayout(dir)}`);
  }
  const f = await shot('diag-' + asset);
  log('скриншот: ' + f);
  console.log('\nГотово. Пришли последние строки logs/executor.log и этот скриншот.');
  await ctx.close();
  process.exit(0);
}

if (process.argv[2] === 'login') {
  loginMode();
} else if (process.argv[2] === 'diag') {
  diagMode().catch(e => { console.error('diag упал:', e.message); process.exit(1); });
} else {
  server.listen(CFG.port ?? 8787, () => {
    log(`MEXC Executor слушает :${CFG.port ?? 8787} | режим: ${state.dryRun ? 'DRY-RUN (без реальных ставок)' : 'LIVE'} | ставки: ETH ${stakeFor('ETH')} / BTC ${stakeFor('BTC')} USDT`);
    log(`панель: http://127.0.0.1:${CFG.port ?? 8787}/panel/${CFG.secret}`);
    log('туннель: cloudflared tunnel --url http://localhost:' + (CFG.port ?? 8787));
    const tw = todayWindows();
    log(`расписание сегодня: ${tw ? tw + ' (местное время)' : 'круглосуточно'}`
      + ` | человечный клик: ${CFG.humanize !== false ? 'вкл' : 'выкл'}`
      + ` | холостая активность: ${(CFG.idleRotation || {}).enabled !== false ? 'вкл' : 'выкл'}`);
    scheduleIdle();
  });
}
