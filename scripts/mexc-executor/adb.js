// Ставки через телефон: Binance Events есть только в приложении, веб-версии
// у них нет. Телефон подключён к компьютеру по USB с включённой отладкой,
// и исполнитель говорит с ним через adb (тот же, что у scrcpy):
//   uiautomator dump - список элементов экрана с текстами и координатами,
//   input tap / text / keyevent - нажатия и ввод.
// Элементы ищем по ТЕКСТУ («Higher», «Payout», «Opened (N)»), а не по
// служебным номерам: номера в приложении Binance меняются с каждой
// версией, а надписи - нет.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// ── adb ──
function adbArgs(A, args) {
  return [...(A.serial ? ['-s', String(A.serial)] : []), ...args];
}
function adbRun(A, args, { timeout = 15000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(A.path || 'adb', adbArgs(A, args), {
      timeout, maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true,
    }, (err, out, errOut) => {
      if (err) {
        const why = String(errOut || err.message || '').trim().split('\n')[0];
        return reject(new Error(err.code === 'ENOENT'
          ? `adb не найден (${A.path || 'adb'}) - укажи путь в "adb": {"path": ...}` : `adb: ${why}`));
      }
      resolve(out);
    });
  });
}

// ── разбор снимка экрана ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
function parseDump(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = {};
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = p[2];
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds || '');
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({
      text: unxml(a.text).trim(), id: a['resource-id'] || '', cls: a.class || '', pkg: a.package || '',
      clickable: a.clickable === 'true', enabled: a.enabled !== 'false', focused: a.focused === 'true',
      selected: a.selected === 'true', x1, y1, x2, y2, w: x2 - x1, h: y2 - y1,
    });
  }
  return out;
}
const idIs = (n, name) => n.id === name || n.id.endsWith('/' + name);
const inside = (a, b) => a.x1 >= b.x1 && a.y1 >= b.y1 && a.x2 <= b.x2 && a.y2 <= b.y2;
// Кнопка вокруг надписи: у Binance «Higher» - это текст внутри
// нажимаемого блока, и нажимать надёжнее сам блок, по всей его площади.
function clickableAround(nodes, n) {
  if (n.clickable) return n;
  let best = null;
  for (const c of nodes) {
    if (!c.clickable || !c.w || !c.h || !inside(n, c)) continue;
    if (!best || c.w * c.h < best.w * best.h) best = c;
  }
  return best || n;
}

// ── экран Binance Events ──
const PCT = /^(\d+(?:\.\d+)?)\s*%$/;
const MIN_TEXT = { 10: '10 min', 30: '30 min', 60: '1 hour', 1440: '1 day' };
const scr = {
  ours: nodes => nodes.some(n => n.pkg.startsWith('com.binance')),
  confirmBtn: nodes => nodes.find(n => n.text === 'Confirm' && /Button/.test(n.cls) && n.enabled),
  timeList: nodes => nodes.some(n => n.text === 'Time Increment' && idIs(n, 'tv_title')),
  symbolList: nodes => nodes.some(n => n.text === 'Higher Payout Ratio'),
  main: nodes => nodes.some(n => n.text === 'Higher') && nodes.some(n => n.text === 'Lower')
    && nodes.some(n => idIs(n, 'tv_time_increment_b') || n.text === 'Time Increment'),
  // Актив на основном экране - нажимаемая надпись вверху.
  symbol: nodes => nodes.find(n => idIs(n, 'tv_symbol') && n.clickable),
  time: nodes => nodes.find(n => idIs(n, 'tv_time_increment_b'))
    || nodes.find(n => /^\d+\s*(min|hour|day)s?$/i.test(n.text) && n.clickable),
  amount: nodes => nodes.find(n => /EditText/.test(n.cls)),
  opened: nodes => {
    const n = nodes.find(x => /^Opened\s*\((\d+)\)$/.test(x.text));
    return n ? Number(/\((\d+)\)/.exec(n.text)[1]) : null;
  },
  balance: nodes => {
    const i = nodes.findIndex(n => n.text === 'Avbl');
    const n = i < 0 ? null : nodes.slice(i).find(x => /^[\d,.]+\s*USDT$/.test(x.text));
    return n ? parseFloat(n.text.replace(/,/g, '')) : null;
  },
  // Выплаты: за каждой надписью «Payout» следующим идёт её процент.
  // Левая пара - Higher, правая - Lower.
  payouts: nodes => {
    const got = [];
    nodes.forEach((n, i) => {
      if (n.text !== 'Payout') return;
      const v = nodes.slice(i + 1, i + 4).find(x => PCT.test(x.text));
      if (v) got.push({ x: n.x1, v: Number(PCT.exec(v.text)[1]) });
    });
    got.sort((a, b) => a.x - b.x);
    if (got.length >= 2) return { UP: got[0].v, DOWN: got[1].v, how: 'Payout' };
    const h = nodes.find(n => /^H:\s*[\d.]+%$/.test(n.text));
    const l = nodes.find(n => /^L:\s*[\d.]+%$/.test(n.text));
    if (h && l) return { UP: parseFloat(h.text.slice(2)), DOWN: parseFloat(l.text.slice(2)), how: 'H/L' };
    return null;
  },
  dirButton: (nodes, dir) => {
    const t = nodes.find(n => n.text === (dir === 'UP' ? 'Higher' : 'Lower'));
    return t ? clickableAround(nodes, t) : null;
  },
  // Строки окна подтверждения: подпись слева, значение справа.
  sheet: nodes => {
    const val = label => {
      const i = nodes.findIndex(n => n.text === label);
      return i < 0 ? '' : ((nodes.slice(i + 1, i + 3).find(x => x.text) || {}).text || '');
    };
    const sym = nodes.find(n => idIs(n, 'tv_symbol'));
    return { symbol: sym ? sym.text : '', time: val('Time Increment'), amount: val('Amount'),
             ratio: val('Payout Ratio'), payout: val('Payout Amount') };
  },
};

function makePhone(A, env) {
  const log = env.log || (() => {});
  const tapAt = (x, y) => adbRun(A, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  // Нажатие в случайную точку средней части элемента, а не ровно в центр.
  const tap = n => tapAt(n.x1 + n.w * (0.3 + Math.random() * 0.4), n.y1 + n.h * (0.3 + Math.random() * 0.4));
  const key = (...codes) => adbRun(A, ['shell', 'input', 'keyevent', ...codes.map(String)]);
  async function dump() {
    let last = '';
    for (let i = 0; i < 4; i++) {
      try {
        // Прямо в вывод - без файла на телефоне и второй команды.
        const out = await adbRun(A, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20000 });
        const s = out.indexOf('<?xml'), e = out.lastIndexOf('</hierarchy>');
        if (s >= 0 && e > s) { const xml = out.slice(s, e + 12); return { xml, nodes: parseDump(xml) }; }
        // Запасной путь: через файл. Нужен на прошивках, где /dev/tty не пишется.
        await adbRun(A, ['shell', 'uiautomator', 'dump', '/sdcard/exec-ui.xml'], { timeout: 20000 });
        const xml = await adbRun(A, ['exec-out', 'cat', '/sdcard/exec-ui.xml']);
        if (xml.includes('</hierarchy>')) return { xml, nodes: parseDump(xml) };
        last = out.trim().split('\n').pop();
      } catch (e) { last = e.message; }
      // «could not get idle state» - на экране анимация; со второго раза проходит.
      await sleep(250 + i * 250);
    }
    throw new Error(`снимок экрана телефона не снялся: ${last}`);
  }
  async function shot(tag, xml) {
    if (!env.shotsDir) return;
    const base = path.join(env.shotsDir, `${Date.now()}-adb-${tag}`);
    try {
      if (xml) fs.writeFileSync(base + '.xml', xml);
      const png = await adbRun(A, ['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
      fs.writeFileSync(base + '.png', png);
    } catch (e) { /* снимок - дело добровольное */ }
  }
  async function keyboardShown() {
    try {
      const out = await adbRun(A, ['shell', 'dumpsys', 'input_method']);
      return /mInputShown=true/.test(out);
    } catch (e) { return false; }
  }
  // Довести телефон до основного экрана Events: закрыть открытые списки
  // и окна, вернуть приложение на передний план.
  async function toMain() {
    let d = null;
    for (let i = 0; i < 5; i++) {
      d = await dump();
      const n = d.nodes;
      if (!scr.ours(n)) {
        if (n.length && n.every(x => x.pkg === 'com.android.systemui')) {
          throw new Error('экран телефона выключен или заблокирован');
        }
        log('телефон: Binance не на экране - открываю приложение');
        await key(224); // разбудить экран, если погас
        await adbRun(A, ['shell', 'monkey', '-p', A.package || 'com.binance.dev',
          '-c', 'android.intent.category.LAUNCHER', '1']);
        await sleep(2500);
        continue;
      }
      if (scr.main(n) && !scr.confirmBtn(n) && !scr.timeList(n) && !scr.symbolList(n)) return d;
      if (scr.confirmBtn(n) || scr.timeList(n) || scr.symbolList(n)) {
        log('телефон: открыто окно поверх экрана - закрываю');
        await key(4); await sleep(600); continue;
      }
      // Другой раздел приложения: вкладка Events вверху.
      const ev = n.find(x => x.text === 'Events' && x.clickable);
      if (ev) { log('телефон: перехожу на вкладку Events'); await tap(ev); await sleep(1200); continue; }
      log('телефон: не тот экран - шаг назад');
      await key(4); await sleep(800);
    }
    await shot('not-events', d && d.xml);
    throw new Error('не удалось вывести телефон на экран Binance Events');
  }
  return { tap, tapAt, key, dump, shot, keyboardShown, toMain,
    text: t => adbRun(A, ['shell', 'input', 'text', String(t)]),
    state: () => adbRun(A, ['get-state'], { timeout: 8000 }).then(s => s.trim()) };
}

// ── ставка ──
// env: { E, log, mark, stake, dryRun, lagSec, lateSec, confirmTimeoutMs, shotsDir }
async function placeBet(sig, env) {
  const t0 = Date.now();
  const { E, log } = env;
  const A = E.adb || {};
  const P = makePhone(A, env);
  const mark = env.mark || (() => {});
  const want = (E.urls || {})[sig.asset];
  if (!want) throw new Error(`нет символа для ${sig.asset} у ${E.title}`);
  const minText = MIN_TEXT[sig.timing];
  if (!minText) throw new Error(`экспирации ${sig.timing}м в Binance Events нет`);

  // Опоздавший сигнал отбиваем сразу, не трогая телефон: цену там не
  // прочитать, а вход вслепую по ушедшей цене хуже пропуска.
  const late = () => env.lateSec > 0 && env.lagSec + (Date.now() - t0) / 1000 > env.lateSec;
  if (late()) {
    log(`пропуск ${sig.asset} ${sig.direction}: вход опоздал на ${env.lagSec.toFixed(0)}с, `
      + 'а цену на телефоне не проверить');
    return { status: 'skip-price-unknown', note: `опоздание ${env.lagSec.toFixed(0)}с` };
  }
  let d = await P.toMain();
  mark('страница');

  // Актив
  let sym = scr.symbol(d.nodes);
  if (!sym || sym.text !== want) {
    log(`телефон: актив ${sym ? sym.text : '?'} → ${want}`);
    await P.tap(sym || d.nodes.find(n => idIs(n, 'iv_switch_symbol')));
    await sleep(700);
    const l = await P.dump();
    const row = l.nodes.find(n => idIs(n, 'tv_symbol') && n.text === want && !n.clickable);
    if (!row) { await P.shot('no-symbol', l.xml); await P.key(4); return { status: 'skip-asset', note: `${want} нет в списке` }; }
    await P.tap(clickableAround(l.nodes, row));
    await sleep(900);
    d = await P.toMain();
    sym = scr.symbol(d.nodes);
    if (!sym || sym.text !== want) {
      await P.shot('symbol-stuck', d.xml);
      throw new Error(`актив не переключился: на экране ${sym ? sym.text : '?'}, нужен ${want}`);
    }
  }
  mark('актив');

  // Экспирация
  let tm = scr.time(d.nodes);
  if (!tm || tm.text !== minText) {
    log(`телефон: экспирация ${tm ? tm.text : '?'} → ${minText}`);
    if (!tm) throw new Error('поле Time Increment не найдено');
    await P.tap(tm);
    await sleep(700);
    const l = await P.dump();
    const row = l.nodes.find(n => n.text === minText && !idIs(n, 'tv_time_increment_b'));
    if (!row) { await P.shot('no-time', l.xml); await P.key(4); return { status: 'timing', note: `${minText} нет в списке` }; }
    await P.tap(clickableAround(l.nodes, row));
    await sleep(900);
    d = await P.toMain();
    tm = scr.time(d.nodes);
    if (!tm || tm.text !== minText) {
      await P.shot('time-stuck', d.xml);
      throw new Error(`экспирация не переключилась: на экране ${tm ? tm.text : '?'}, нужно ${minText}`);
    }
  }
  mark('экспирация');

  // Выплата
  const pays = scr.payouts(d.nodes);
  const pv = pays ? pays[sig.direction] : null;
  const pair = pays ? `Higher ${pays.UP}% / Lower ${pays.DOWN}%` : '';
  const readPayout = E.checkPayout || E.requirePagePayout;
  if (readPayout) {
    const need = E.minPayout;
    if (pv == null) {
      if (E.requirePagePayout) {
        await P.shot('payout-unknown', d.xml);
        return { status: 'skip-payout-unknown' };
      }
      log('телефон: выплату прочитать не удалось - иду дальше, порог проверял источник');
    } else if (E.minPayoutStrict ? pv <= need : pv < need) {
      log(`пропуск ${sig.asset} ${sig.direction}: выплата ${pv}% (${pair}), нужно `
        + `${E.minPayoutStrict ? 'больше' : 'не меньше'} ${need}%`);
      return { status: 'skip-payout', payoutPage: pv, payoutPair: pair };
    }
  }
  mark('выплата');

  // Сумма
  const stake = env.stake;
  let amt = scr.amount(d.nodes);
  if (!amt) throw new Error('поле суммы не найдено');
  if (parseFloat(amt.text) !== stake) {
    await P.tap(amt);
    await sleep(randInt(250, 450));
    await P.key(123);                                   // в конец поля
    await P.key(...Array((amt.text || '').length + 3).fill(67)); // стереть
    await P.text(stake);
    await sleep(randInt(200, 400));
    if (await P.keyboardShown()) { await P.key(4); await sleep(500); }
    d = await P.toMain();
    amt = scr.amount(d.nodes);
    if (!amt || parseFloat(amt.text) !== stake) {
      await P.shot('amount', d.xml);
      throw new Error(`сумма не встала: в поле «${amt ? amt.text : '?'}», нужно ${stake}`);
    }
  }
  mark('сумма');

  // Опоздание: цену на телефоне не прочитать, а вход вслепую по ушедшей
  // цене хуже, чем пропуск.
  if (late()) {
    const lag = env.lagSec + (Date.now() - t0) / 1000;
    log(`пропуск ${sig.asset} ${sig.direction}: пока готовил ставку, опоздание дошло до ${lag.toFixed(0)}с`);
    return { status: 'skip-price-unknown', payoutPage: pv, note: `опоздание ${lag.toFixed(0)}с` };
  }
  mark('цена');

  const before = scr.opened(d.nodes);
  if (env.dryRun) {
    await P.shot(`dryrun-${sig.asset}-${sig.direction}`, d.xml);
    log(`DRY-RUN: телефон готов - ${want} ${minText}, сумма ${stake}, ${sig.direction === 'UP' ? 'Higher' : 'Lower'} `
      + `${pv != null ? pv + '%' : ''} - не нажимаю`);
    return { status: 'dry-run', payoutPage: pv, payoutPair: pair };
  }

  // Нажатие направления → окно подтверждения
  const btn = scr.dirButton(d.nodes, sig.direction);
  if (!btn) throw new Error(`кнопка ${sig.direction === 'UP' ? 'Higher' : 'Lower'} не найдена`);
  await P.tap(btn);
  mark('нажатие');
  let s = null;
  for (let i = 0; i < 4 && !s; i++) {
    await sleep(i ? 400 : 600);
    const x = await P.dump();
    if (scr.confirmBtn(x.nodes)) s = x;
  }
  if (!s) {
    await P.shot('no-confirm', null);
    throw new Error('окно подтверждения не появилось');
  }
  // Сверяем окно с тем, что задумано: актив, минуты, сумма, выплата.
  const sh = scr.sheet(s.nodes);
  const bad = [];
  if (sh.symbol && sh.symbol !== want) bad.push(`актив ${sh.symbol}`);
  if (sh.time && sh.time !== minText) bad.push(`время ${sh.time}`);
  if (sh.amount && parseFloat(sh.amount) !== stake) bad.push(`сумма ${sh.amount}`);
  const ratio = PCT.test(sh.ratio) ? Number(PCT.exec(sh.ratio)[1]) : null;
  if (readPayout && ratio != null && (E.minPayoutStrict ? ratio <= E.minPayout : ratio < E.minPayout)) {
    bad.push(`выплата ${ratio}%`);
  }
  if (bad.length) {
    log(`телефон: окно подтверждения не совпало (${bad.join(', ')}) - отменяю`);
    await P.shot('confirm-mismatch', s.xml);
    await P.key(4);
    return { status: bad.some(b => b.startsWith('выплата')) ? 'skip-payout' : 'error',
             payoutPage: ratio ?? pv, note: `окно: ${bad.join(', ')}` };
  }

  await P.tap(scr.confirmBtn(s.nodes));
  // Ставка открыта, когда вырос счётчик Opened (N).
  const deadline = Date.now() + (env.confirmTimeoutMs || 9000);
  let after = null, again = 0, last = null;
  while (Date.now() < deadline) {
    await sleep(500);
    last = await P.dump();
    const o = scr.opened(last.nodes);
    if (before != null && o != null && o > before) { after = o; break; }
    const c = scr.confirmBtn(last.nodes);
    if (c && again < 2 && Date.now() > deadline - (env.confirmTimeoutMs || 9000) + 1500) {
      again++; log('телефон: окно подтверждения висит - нажимаю Confirm ещё раз'); await P.tap(c);
    }
    if (before == null && !c && scr.main(last.nodes)) break;
  }
  mark('подтверждение');
  const payoutPage = ratio ?? pv;
  if (after != null) {
    log(`телефон: ставка открыта, Opened ${before} → ${after}`);
    return { status: 'placed', payoutPage, payoutPair: pair };
  }
  await P.shot('not-confirmed', last && last.xml);
  if (before == null) return { status: 'placed-unverified', payoutPage, note: 'счётчик Opened не читается' };
  if (last && scr.confirmBtn(last.nodes)) await P.key(4);
  return { status: 'placed-unconfirmed', payoutPage, note: `Opened как было ${before}` };
}

// ── проверка: что исполнитель видит на телефоне ──
async function diag(E, env) {
  const A = E.adb || {};
  const P = makePhone(A, env);
  const say = env.say || console.log;
  let st = '';
  try { st = await P.state(); } catch (e) { say('adb: ' + e.message); return false; }
  say(`телефон: ${st}${A.serial ? ` (${A.serial})` : ''}`);
  if (st !== 'device') { say('Нужно состояние "device": проверь кабель и разрешение отладки на телефоне.'); return false; }
  const d = await P.dump();
  await P.shot('diag', d.xml);
  const n = d.nodes;
  if (!scr.ours(n)) { say('На экране не Binance. Открой Binance → Futures → Events и повтори.'); return false; }
  const pays = scr.payouts(n);
  const rows = [
    ['экран Events', scr.main(n) ? 'да' : 'НЕТ'],
    ['актив', (scr.symbol(n) || {}).text || 'не найден'],
    ['экспирация', (scr.time(n) || {}).text || 'не найдена'],
    ['выплата Higher / Lower', pays ? `${pays.UP}% / ${pays.DOWN}% (${pays.how})` : 'не найдена'],
    ['поле суммы', scr.amount(n) ? `есть («${scr.amount(n).text}»)` : 'НЕТ'],
    ['кнопки Higher / Lower', (scr.dirButton(n, 'UP') ? 'есть' : 'НЕТ') + ' / ' + (scr.dirButton(n, 'DOWN') ? 'есть' : 'НЕТ')],
    ['открыто ставок (Opened)', scr.opened(n) ?? 'не видно'],
    ['баланс', scr.balance(n) != null ? scr.balance(n) + ' USDT' : 'не виден'],
    ['окно поверх', scr.confirmBtn(n) ? 'окно подтверждения' : scr.timeList(n) ? 'список времени'
      : scr.symbolList(n) ? 'список активов' : 'нет'],
  ];
  for (const [k, v] of rows) say(`  ${k.padEnd(24)} ${v}`);
  return scr.main(n);
}

module.exports = { placeBet, diag, parseDump, scr, makePhone };
