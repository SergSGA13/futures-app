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
};

// Ставка зависит от актива: на MEXC это ETH 150 / BTC 250.
// Старый плоский stakeUSDT продолжает работать как запасной вариант.
function stakeFor(asset) {
  const t = CFG.stakes || {};
  return t[asset] != null ? t[asset] : (CFG.stakeUSDT ?? 5);
}

// Биржа держит не больше 5 ставок одновременно. Окно берём ДЛИННЕЕ
// экспирации (10 мин), иначе слот освободится в учёте раньше, чем на бирже.
function openSlots() {
  const winMs = (CFG.slotWindowMin ?? 11) * 60000;
  const now = Date.now();
  state.placed = state.placed.filter(t => now - t < winMs);
  return state.placed.length;
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
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
let ctx = null, page = null;
async function browser() {
  if (ctx) return;
  ctx = await playwright.chromium.launchPersistentContext(PROFILE, {
    headless: CFG.headless !== false,
    viewport: { width: 1280, height: 860 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  page = ctx.pages()[0] || await ctx.newPage();
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
  const deadline = Date.now() + (CFG.panelTimeoutMs ?? 25000);
  let found = null;
  while (Date.now() < deadline) {
    found = await findAmount(1200);
    if (found) return found;
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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(CFG.pageSettleMs ?? 2500);
  const ready = await waitForPanel();
  if (!ready) {
    await shot('panel-not-ready');
    await dumpPage('panel-not-ready');
    throw new Error('торговая панель не отрисовалась за ' + (CFG.panelTimeoutMs ?? 25000) + 'мс - смотри ДАМП выше');
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
    await tf.click({ timeout: 5000 }).catch(e => log('чип таймфрейма не кликнулся: ' + e.message));
  }
  await page.waitForTimeout(500);

  // страховка: payout на странице (вебхук уже проверял, но payout плавает)
  const pv = await pagePayout(sig.direction);
  if (pv != null && pv < (CFG.minPayout ?? 80)) {
    await shot('payout-low');
    return { status: 'skip-payout', payoutPage: pv };
  }

  // Поле суммы уже найдено при ожидании панели
  const amount = ready.loc;
  await amount.fill(String(stakeFor(sig.asset)), { timeout: 5000 });
  await page.waitForTimeout(300);

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

  await btn.click({ timeout: 5000 });
  await page.waitForTimeout(600);
  // возможное окно подтверждения
  if (CFG.selectors.confirm) {
    const c = page.locator(CFG.selectors.confirm).first();
    if (await c.count() > 0 && await c.isVisible().catch(() => false)) await c.click({ timeout: 5000 });
  }
  await page.waitForTimeout(800);
  await shot(`bet-${sig.asset}-${sig.direction}`);
  log(`ставка исполнена за ${Date.now() - t0}мс`);
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
      if (r.status === 'placed' || r.status === 'dry-run') state.placed.push(Date.now());
      if (r.status === 'placed') state.betsToday++;
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
  };
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

    // пауза с панели
    if (state.paused) {
      log('пропуск: исполнитель на паузе');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: 'paused' }));
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
  const c = await playwright.chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: { width: 1280, height: 860 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
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
  });
}
