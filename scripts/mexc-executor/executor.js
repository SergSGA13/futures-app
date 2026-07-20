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
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
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
  startedAt: Date.now(),
};

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

  // залогинены ли мы: на странице не должно быть кнопки Log In
  const loginBtn = page.locator(CFG.selectors.loginMarker).first();
  if (await loginBtn.count() > 0 && await loginBtn.isVisible().catch(() => false)) {
    await shot('not-logged-in');
    throw new Error('НЕ ЗАЛОГИНЕН - выполни: node executor.js login');
  }

  // таймфрейм (10m / 30m)
  const tfText = CFG.timeUnitText[String(sig.timing)] || '10m';
  const tf = page.locator(`${CFG.selectors.timeUnit}:has-text("${tfText}")`).first();
  if (await tf.count() > 0) await tf.click({ timeout: 5000 });
  await page.waitForTimeout(500);

  // страховка: payout на странице (вебхук уже проверял, но payout плавает)
  const pv = await pagePayout(sig.direction);
  if (pv != null && pv < (CFG.minPayout ?? 80)) {
    await shot('payout-low');
    return { status: 'skip-payout', payoutPage: pv };
  }

  // сумма ставки
  const amount = page.locator(CFG.selectors.amount).first();
  await amount.click({ timeout: 5000 });
  await amount.fill(String(CFG.stakeUSDT), { timeout: 5000 });
  await page.waitForTimeout(300);

  // кнопка Up / Down
  const btnSel = sig.direction === 'UP' ? CFG.selectors.up : CFG.selectors.down;
  const btn = page.locator(btnSel).first();
  if (await btn.count() === 0) { await shot('no-button'); throw new Error('кнопка не найдена: ' + btnSel); }

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
      logBet({ ...sig, stake: CFG.stakeUSDT, mode, status: 'skip-stale' });
    } else if (process.env.TEST_MODE === '1') {
      logBet({ ...sig, stake: CFG.stakeUSDT, mode, status: 'test-mode' });
    } else {
      const r = await placeBet(sig);
      logBet({ ...sig, stake: CFG.stakeUSDT, mode, status: r.status, payoutPage: r.payoutPage });
      if (r.status === 'placed') state.betsToday++;
      state.consecutiveErrors = 0;
    }
  } catch (e) {
    state.consecutiveErrors++;
    log(`ОШИБКА ставки ${sig.asset} ${sig.direction}: ${e.message}`);
    logBet({ ...sig, stake: CFG.stakeUSDT, mode, status: 'error', note: e.message });
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
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, dryRun: state.dryRun, betsToday: state.betsToday,
      queue: state.queue.length, consecutiveErrors: state.consecutiveErrors,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/signal') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    let sig;
    try { sig = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
    if (!CFG.secret || sig.secret !== CFG.secret) { res.writeHead(403); res.end('forbidden'); return; }
    if (sig.asset !== 'ETH' && sig.asset !== 'BTC') { res.writeHead(400); res.end('bad asset'); return; }
    if (sig.direction !== 'UP' && sig.direction !== 'DOWN') { res.writeHead(400); res.end('bad direction'); return; }

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

if (process.argv[2] === 'login') {
  loginMode();
} else {
  server.listen(CFG.port ?? 8787, () => {
    log(`MEXC Executor слушает :${CFG.port ?? 8787} | режим: ${state.dryRun ? 'DRY-RUN (без реальных ставок)' : 'LIVE'} | ставка: ${CFG.stakeUSDT} USDT`);
    log('туннель: cloudflared tunnel --url http://localhost:' + (CFG.port ?? 8787));
  });
}
