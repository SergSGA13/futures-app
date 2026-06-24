/* =========================================================================
   futures-strategy.js - лидерборд фьючерсных стратегий (бэктест v.29.1)
     • карточки пар: PNL / WIN% / сеты / позиция
     • избранное (♥, как в Лаборатории) + фильтр по избранному
     • сортировка PNL / WIN% / Сигналы + ползунок-фильтр по значению
     • тап по карточке → детальный экран: график с сигналами, набранные
       позиции (входы усреднения + средняя), история сделок, статус
   Данные: вкладка FUT_STRAT (backtest_v29.py). Нет вкладки → демо-данные.
   ========================================================================= */
(function () {
  'use strict';

  const SHEET_ID = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
  const TAB = 'FUT_STRAT';
  const FAV_KEY = 'futStrat_fav';

  const WR_RED = 55.6, WR_YELLOW = 61.9, MIN_SETS = 5;
  const COL = { green: '#4EFFA0', red: '#FF5272', yellow: '#FFD166', muted: '#7B84B0', blue: '#66A3FF', purple: '#9D50FF' };

  const wrHex = (wr, sets) => (wr == null || sets < MIN_SETS) ? COL.muted : (wr < WR_RED ? COL.red : wr < WR_YELLOW ? COL.yellow : COL.green);
  const pnlHex = v => (v >= 0 ? COL.green : COL.red);
  const fmtPct = v => (v >= 0 ? '+' : '') + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '%';

  // ---- Избранное (localStorage) -------------------------------------------
  function favGet() { try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; } }
  function favHas(s) { return favGet().indexOf(s) !== -1; }
  function favToggle(s) {
    let f = favGet(); const i = f.indexOf(s);
    if (i === -1) f.push(s); else f.splice(i, 1);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch (e) {}
    return f.indexOf(s) !== -1;
  }

  // ---- Фильтр «слабых» сетапов --------------------------------------------
  // слабый = мало статистики, минусовой PNL или WIN% ниже безубытка
  function isWeak(r) {
    if (r.sets < MIN_SETS) return true;
    if (r.pnl_pct <= 0) return true;
    if (r.winrate != null && r.winrate < WR_RED) return true;
    return false;
  }

  // ---- Гайд (обучение) ----------------------------------------------------
  const GUIDE = [
    { t: 'Лидерборд стратегий', b: 'Здесь - результаты бэктеста индикатора v.29.1 по фьючерсам Binance на 15m. Каждая карточка = одна монета со своей статистикой отработки сигналов.' },
    { t: 'Карточка монеты', b: 'PNL - суммарная доходность от депозита. WIN% - доля прибыльных сделок (зелёный ≥62%, жёлтый 55.6-62%, красный ниже; «~X%» - статистики пока мало). Снизу - статус: в лонге/шорте с числом долей или «ждёт входа».' },
    { t: 'Сортировка', b: 'Переключай показатель сортировки: PNL, WIN% или число сигналов. Список мгновенно пересортируется по убыванию выбранного значения.' },
    { t: 'Ползунок-фильтр', b: 'Ползунок под сортировкой отсекает карточки, у которых выбранный показатель ниже его значения. Быстрый способ оставить только сильные по PNL или WIN%.' },
    { t: 'Избранное ★', b: 'Звезда на карточке добавляет монету в избранное (хранится на устройстве). Кнопка «★ Избранное» в панели оставляет на экране только избранные.' },
    { t: 'Скрыть слабые', b: 'Кнопка «Скрыть слабые» одним тапом убирает заведомо плохие сетапы: мало статистики (менее 5 сделок), отрицательный PNL или WIN% ниже безубытка (55.6%).' },
    { t: 'Детальный экран', b: 'Тап по карточке открывает монету: статы (сделки / WIN% / PNL), лента истории сделок (#1 WIN +18.7% …), текущая позиция и живой график.' },
    { t: 'График и модель', b: 'На графике - фьючерсные свечи, сигналы BUY/SELL индикатора и линии фактических входов усреднения со средней ценой. Модель: вход 10% депозита на сигнал, усреднение в ту же сторону, обратный сигнал закрывает все доли и открывает реверс на 10%. TP/STOP в этой модели нет. Данные обновляет backtest_v29.py.' },
  ];
  function closeGuide() {
    const ov = document.getElementById('fgOverlay'); if (ov) ov.remove();
    try { localStorage.setItem('futStrat_guide_seen', '1'); } catch (e) {}
  }
  function renderGuide(idx) {
    let ov = document.getElementById('fgOverlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'fgOverlay'; ov.className = 'fg-overlay'; document.body.appendChild(ov); }
    const g = GUIDE[idx], n = GUIDE.length;
    ov.innerHTML = `
      <div class="fg-card">
        <div class="fg-head"><span class="fg-title">🎓 ${g.t}</span><button class="fg-x" data-x>×</button></div>
        <div class="fg-body">${g.b}</div>
        <div class="fg-foot">
          <span class="fg-step">${idx + 1} / ${n}</span>
          <div class="fg-btns">
            ${idx > 0 ? '<button class="fg-btn sec" data-prev>НАЗАД</button>' : ''}
            <button class="fg-btn pri" data-next>${idx < n - 1 ? 'ДАЛЕЕ' : 'ГОТОВО'}</button>
          </div>
        </div>
      </div>`;
    ov.querySelector('[data-x]').addEventListener('click', closeGuide);
    const prev = ov.querySelector('[data-prev]'); if (prev) prev.addEventListener('click', () => renderGuide(idx - 1));
    ov.querySelector('[data-next]').addEventListener('click', () => { idx < n - 1 ? renderGuide(idx + 1) : closeGuide(); });
  }

  // ---- Список монет по умолчанию (если FUT_STRAT недоступен) --------------
  const DEFAULT_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','SUIUSDT','TONUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','1000PEPEUSDT','WIFUSDT','TIAUSDT','SEIUSDT','LTCUSDT','ATOMUSDT','FILUSDT','HBARUSDT','RUNEUSDT','ORDIUSDT','JTOUSDT','ENAUSDT','FETUSDT','RENDERUSDT'];
  const HIST_DAYS = 90;

  function localParse(text) {
    return text.trim().split('\n').map(line => {
      const out = []; let c = '', q = false;
      for (let i = 0; i < line.length; i++) { const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { out.push(c); c = ''; } else c += ch; }
      out.push(c); return out;
    });
  }
  function normSym(s) {
    s = String(s || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    if (!/USDT$/.test(s) && !/USD$/.test(s) && !/PERP$/.test(s)) s += 'USDT';
    return s;
  }
  // ---- Чтение списка монет из FUT_STRAT (первый столбец или 'symbol') ------
  function splitSmart(s) { const out = []; let c = '', d = 0; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === '[') d++; else if (ch === ']') d--; if (ch === ',' && d <= 0) { out.push(c); c = ''; } else c += ch; } out.push(c); return out; }
  function explodeRows(grid) { return grid.map(row => (row.length === 1 && /,/.test(row[0])) ? splitSmart(row[0]) : row); }
  const BT_ORDER = ['symbol', 'tf', 'signals', 'sets', 'wins', 'losses', 'winrate', 'pnl_pct', 'realized_pct', 'unreal_pct', 'pos_side', 'pos_lots', 'pos_avg', 'last_side', 'quote_volume', 'updated', 'lot_entries', 'sets_json', 'max_dd', 'expectancy'];
  function num(v) { v = String(v == null ? '' : v).trim(); return v === '' ? null : +v; }
  function parseStatsRow(arr, ix) {
    const g = k => { const i = ix(k); return i > -1 ? arr[i] : undefined; };
    const sym = normSym(g('symbol')); if (!sym) return null;
    const side = String(g('pos_side') || '').trim().toLowerCase();
    let sj = []; try { const j = JSON.parse(g('sets_json')); if (Array.isArray(j)) sj = j; } catch (e) {}
    return {
      symbol: sym, tf: String(g('tf') || '15m').trim() || '15m', computed: true,
      signals: num(g('signals')) || 0, sets: num(g('sets')) || 0, wins: num(g('wins')) || 0, losses: num(g('losses')) || 0,
      winrate: num(g('winrate')), pnl_pct: num(g('pnl_pct')) || 0,
      pos_side: (side === 'long' || side === 'short') ? side : '\u2014', pos_lots: num(g('pos_lots')) || 0, pos_avg: num(g('pos_avg')) || 0,
      max_dd: num(g('max_dd')), expectancy: num(g('expectancy')),
      sets_json: sj,
    };
  }

  // ---- Чтение FUT_STRAT: готовая статистика (мгновенно) или список монет ---
  async function readSheet(tab, allowDefault) {
    tab = tab || TAB; if (allowDefault === undefined) allowDefault = true;
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
      const r = await tfetch(url, 12000); if (!r.ok) throw 0;
      const text = await r.text();
      if (/setResponse/.test(text) || /error/i.test(text.slice(0, 200))) throw 0;
      let grid = localParse(text);
      if (!grid || !grid.length) throw 0;
      grid = explodeRows(grid).filter(row => row.some(c => String(c).trim() !== ''));
      if (!grid.length) throw 0;

      const head0 = grid[0].map(h => String(h).trim().toLowerCase());
      const isHeaderWord = w => ['symbol', 'ticker', 'pair', 'symbols', 'tf'].indexOf(w) !== -1;

      // 1) есть заголовок со столбцами статистики -> читаем готовое (быстро)
      if (head0.indexOf('pnl_pct') !== -1 || head0.indexOf('sets') !== -1) {
        const ix = k => head0.indexOf(k);
        const rows = grid.slice(1).map(a => parseStatsRow(a, ix)).filter(Boolean);
        if (rows.length) return { mode: 'stats', rows, source: 'sheet' };
      }
      // 2) нет заголовка, но строки в формате бэктеста (символ, tf, числа...) -> по позициям
      const f0 = String(grid[0][0] || '').trim();
      const looksBacktest = grid[0].length >= 8 && /^[A-Z0-9]{2,15}$/i.test(f0) && !isHeaderWord(f0.toLowerCase()) && (/^\d/.test(String(grid[0][2] || '')) || /^\d/.test(String(grid[0][3] || '')));
      if (looksBacktest) {
        const ix = k => BT_ORDER.indexOf(k);
        const rows = grid.map(a => parseStatsRow(a, ix)).filter(Boolean);
        if (rows.length) return { mode: 'stats', rows, source: 'sheet' };
      }
      // 3) иначе это просто список монет -> считаем в браузере
      const named = ['symbol', 'ticker', 'pair', 'symbols', '\u0442\u0438\u043a\u0435\u0440', '\u043c\u043e\u043d\u0435\u0442\u0430'];
      let col = head0.findIndex(h => named.indexOf(h) !== -1);
      let dataRows = grid.slice(1);
      if (col === -1) { col = 0; if (/^[A-Z0-9]{2,15}$/.test(f0.toUpperCase()) && named.indexOf(f0.toLowerCase()) === -1) dataRows = grid; }
      const seen = {}, syms = [];
      dataRows.forEach(rw => { let cell = String(rw[col] || ''); if (/,/.test(cell)) cell = splitSmart(cell)[0]; const s = normSym(cell); if (s && !seen[s]) { seen[s] = 1; syms.push(s); } });
      if (syms.length) return { mode: 'compute', symbols: syms, source: 'sheet' };
      throw 0;
    } catch (e) { return allowDefault ? { mode: 'compute', symbols: DEFAULT_SYMS.slice(), source: 'default' } : { mode: 'error', tab: tab }; }
  }

  // ---- Кэш расчётов (localStorage, TTL 6ч) --------------------------------
  const CACHE_KEY = 'futStrat_cache_v1', CACHE_TTL = 6 * 3600 * 1000;
  function cacheGet(sym) { try { const e = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[sym]; if (e && Date.now() - e.ts < CACHE_TTL) return e.s; } catch (e) {} return null; }
  function cacheSet(sym, s) { try { const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); all[sym] = { ts: Date.now(), s }; localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) {} }

  // ---- Троттлинг запросов к бирже (60 монет, лимиты Binance) ---------------
  let PACE_MS = 0, _lastReq = 0;
  async function rateGate() { const now = Date.now(), wait = Math.max(0, _lastReq + PACE_MS - now); _lastReq = now + wait; if (wait) await new Promise(r => setTimeout(r, wait)); }
  async function tfetch(u, ms) { const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null; const t = ac ? setTimeout(() => ac.abort(), ms) : null; try { return await fetch(u, ac ? { signal: ac.signal } : {}); } finally { if (t) clearTimeout(t); } }

  // ---- Расчёт одной монеты в браузере (90 дней, тот же движок, что в детали)
  function placeholderRow(sym) { return { symbol: sym, tf: '15m', computed: false, signals: 0, sets: 0, wins: 0, losses: 0, winrate: null, pnl_pct: 0, pos_side: '\u2014', pos_lots: 0, pos_avg: 0 }; }
  async function computeRow(sym) {
    const cached = cacheGet(sym);
    if (cached) return Object.assign({ symbol: sym, tf: '15m', computed: true }, cached);
    const candles = await fetchFutHistory(sym, HIST_DAYS);
    if (!candles || candles.length < 60) throw new Error('thin');
    const sigs = window.LiveChart.computeSignalList(candles, 15);
    const sim = simulateJS(candles, sigs); const p = sim.position;
    const sj = sim.sets.map(st => [st.t1, +st.pnl.toFixed(4)]);
    const s = { signals: sigs.length, sets: sim.stats.sets, wins: sim.stats.wins, losses: sim.stats.losses, winrate: sim.stats.winrate, pnl_pct: sim.stats.pnlPct, pos_side: p.side, pos_lots: p.lots, pos_avg: p.avg, sets_json: sj };
    cacheSet(sym, s);
    return Object.assign({ symbol: sym, tf: '15m', computed: true }, s);
  }
  async function computeAll(symbols, onOne, concurrency) {
    PACE_MS = 260; let idx = 0, done = 0;
    async function worker() {
      while (idx < symbols.length) {
        const my = idx++, sym = symbols[my];
        let row; try { row = await computeRow(sym); } catch (e) { row = Object.assign(placeholderRow(sym), { computed: true, error: true }); }
        onOne(my, row, ++done, symbols.length);
      }
    }
    const ws = []; for (let i = 0; i < concurrency; i++) ws.push(worker());
    await Promise.all(ws); PACE_MS = 0;
  }

  // ---- Свечи фьючерсов: история за N дней (fapi -> bybit) ------------------
  // Пробуем имя символа и его 1000-вариант (мем-коины на фьючерсах: 1000PEPE и т.п.)
  function symVariants(sym) { return [sym, '1000' + sym]; }

  async function fetchFutHistory(baseSym, days) {
    const map15 = '15';
    for (const sym of symVariants(baseSym)) {
      try {
        const end = Date.now(); let start = end - days * 864e5; const out = [];
        for (let it = 0; it < 7 && start < end; it++) {
          if (PACE_MS) await rateGate();
          const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=1500&startTime=${start}`;
          const r = await tfetch(u, 9000); if (!r.ok) throw new Error("fapi " + r.status);
          const chunk = await r.json(); if (!chunk.length) break;
          out.push(...chunk); start = chunk[chunk.length - 1][0] + 1;
          if (chunk.length < 1500) break;
        }
        if (out.length) return out.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
      } catch (e) { /* пробуем следующий вариант имени */ }
    }
    // фолбэк Bybit (только последние ~1000 свечей)
    for (const sym of symVariants(baseSym)) {
      try {
        const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${map15}&limit=1000`;
        const r = await tfetch(u, 9000); if (!r.ok) continue;
        const j = await r.json(); const list = (j.result && j.result.list) || [];
        if (list.length) return list.slice().reverse().map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
      } catch (e) {}
    }
    throw new Error('no klines');
  }

  // ---- Браузерная симуляция позиций (та же модель, что в backtest_v29.py) --
  const SIM = { capital: 100, lotFrac: 0.10, fee: 0.0008, lev: 1, cap: 10, reinvest: true };
  function simulateJS(candles, sigs) {
    const close = candles.map(c => c.close);
    let eq = SIM.capital, setPnl = 0, eqOpen = eq, pos = null;
    const sets = [];
    const lotNote = () => SIM.lotFrac * (SIM.reinvest ? eq : SIM.capital) * SIM.lev;
    function openPos(side, i) { eqOpen = eq; const note = lotNote(), qty = note / close[i]; eq -= note * SIM.fee; setPnl = -note * SIM.fee; pos = { side, lots: [{ p: close[i], q: qty }], t0: candles[i].time }; }
    for (const s of sigs) {
      const i = s.i, price = close[i];
      if (!pos) { openPos(s.side, i); continue; }
      if (pos.side === s.side) { if (pos.lots.length < SIM.cap) { const note = lotNote(), qty = note / price; eq -= note * SIM.fee; setPnl -= note * SIM.fee; pos.lots.push({ p: price, q: qty }); } continue; }
      // переворот: закрыть всё, зафиксировать сет, открыть реверс на 10%
      let realized = 0, closeNote = 0, totQ = 0, totCost = 0;
      for (const { p, q } of pos.lots) { realized += pos.side === 'long' ? q * (price - p) : q * (p - price); closeNote += q * price; totQ += q; totCost += p * q; }
      const cfee = closeNote * SIM.fee; eq += realized - cfee; setPnl += realized - cfee;
      sets.push({ pnl: eqOpen ? setPnl / eqOpen * 100 : 0, t0: pos.t0, t1: candles[i].time, entryAvg: totQ ? totCost / totQ : 0, exitPrice: price, side: pos.side });
      openPos(s.side, i);
    }
    let pside = '—', plots = 0, pavg = 0, entries = [], unreal = 0, pt0 = null;
    if (pos) {
      const last = close[close.length - 1]; let totQ = 0, totCost = 0;
      for (const { p, q } of pos.lots) { unreal += pos.side === 'long' ? q * (last - p) : q * (p - last); totQ += q; totCost += p * q; entries.push(p); }
      pside = pos.side; plots = pos.lots.length; pavg = totQ ? totCost / totQ : 0; pt0 = pos.t0;
    }
    const wins = sets.filter(s => s.pnl > 0).length, losses = sets.filter(s => s.pnl < 0).length, closed = wins + losses;
    const pnls = sets.map(s => s.pnl);
    let accm = 0, peak = 0, maxDD = 0; pnls.forEach(p => { accm += p; if (accm > peak) peak = accm; if (peak - accm > maxDD) maxDD = peak - accm; });
    const exp = pnls.length ? pnls.reduce((a, p) => a + p, 0) / pnls.length : 0;
    return {
      sets,
      position: { side: pside, lots: plots, avg: pavg, entries, t0: pt0, unrealPct: unreal / SIM.capital * 100 },
      stats: { sets: sets.length, wins, losses, winrate: closed ? wins / closed * 100 : null, pnlPct: (eq + unreal - SIM.capital) / SIM.capital * 100, maxDD, exp },
    };
  }
  function precisionFor(price) {
    if (price >= 100) return { precision: 2, minMove: 0.01 };
    if (price >= 1) return { precision: 4, minMove: 0.0001 };
    return { precision: 6, minMove: 0.000001 };
  }

  // ════════════════════════ ЛИДЕРБОРД ════════════════════════
  const SORTS = [{ key: 'pnl_pct', label: 'PNL', unit: '%' }, { key: 'winrate', label: 'WIN%', unit: '%' }, { key: 'signals', label: 'Сигналы', unit: '' }];

  function statusInfo(r) {
    if (r.pos_side === 'long') return { txt: 'В ЛОНГЕ ×' + r.pos_lots, cls: 'long' };
    if (r.pos_side === 'short') return { txt: 'В ШОРТЕ ×' + r.pos_lots, cls: 'short' };
    return { txt: 'ЖДЁТ ВХОДА', cls: 'wait' };
  }

  function metricRange(rows, key) {
    const vals = rows.map(r => r[key] == null ? 0 : r[key]);
    return { min: Math.floor(Math.min(...vals)), max: Math.ceil(Math.max(...vals)) };
  }

  function cardOuterClass(r) { return 'fs-card ' + (!r.computed ? 'loading' : (r.error ? 'neg' : (r.pnl_pct >= 0 ? 'pos' : 'neg'))); }
  function cardInner(r) {
    const sym = r.symbol.replace(/USDT$/, ''), fav = favHas(r.symbol);
    const favB = `<button class="fs-fav ${fav ? 'on' : ''}" data-fav="${r.symbol}" title="В избранное">${fav ? '★' : '☆'}</button>`;
    const top = `<div class="fs-card-top"><span class="fs-sym">${sym}</span><span class="fs-tf">15m</span></div>`;
    if (!r.computed) return `${favB}${top}<div class="fs-pnl fs-skel">•••</div><div class="fs-meta"><span class="fs-sets">считаю…</span></div>`;
    if (r.error) return `${favB}${top}<div class="fs-meta" style="margin-top:16px"><span class="fs-sets">нет данных по паре</span></div>`;
    const st = statusInfo(r);
    const wrTxt = r.winrate == null ? '-' : (r.sets < MIN_SETS ? '~' + Math.round(r.winrate) : Math.round(r.winrate)) + '%';
    return `${favB}${top}
      <div class="fs-pnl" style="color:${pnlHex(r.pnl_pct)}">${fmtPct(r.pnl_pct)}</div>
      <div class="fs-meta"><span class="fs-wr" style="color:${wrHex(r.winrate, r.sets)}">WIN ${wrTxt}</span><span class="fs-sets">${r.sets} сделок</span></div>
      <div class="fs-status ${st.cls}">${st.txt}</div>`;
  }
  function updateCard(host, r) { const el = host.querySelector(`.fs-card[data-sym="${r.symbol}"]`); if (el) { el.className = cardOuterClass(r); el.innerHTML = cardInner(r); } }
  function updateProgress(host, S) { const p = host.querySelector('#fsProg'); if (p) p.textContent = S.computing ? `считаю ${S.progress}/${S.total}` : ''; }

  function fmtDate(unixSec) { const d = new Date(unixSec * 1000); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2); }
  // кривая PNL: по датам (равновзвешенный портфель) либо по парам; с «что-если» стоп/тейк
  function pnlSeries(rows, opts) {
    opts = opts || {};
    const stop = opts.stop > 0 ? opts.stop : 0, tp = opts.tp > 0 ? opts.tp : 0;
    const clip = v => { let x = v; if (stop) x = Math.max(x, -stop); if (tp) x = Math.min(x, tp); return x; };
    const r = rows.filter(x => x.computed && !x.error);
    const haveTime = r.some(x => Array.isArray(x.sets_json) && x.sets_json.length && Array.isArray(x.sets_json[0]));
    if (haveTime && r.length) {
      const N = r.length, trades = [];
      r.forEach(x => (x.sets_json || []).forEach(e => { if (Array.isArray(e) && e.length >= 2) trades.push([+e[0], clip(+e[1])]); }));
      if (trades.length) {
        trades.sort((a, b) => a[0] - b[0]);
        const day = 86400, t1 = trades[trades.length - 1][0], start = Math.floor(trades[0][0] / day) * day;
        const labels = [], cum = []; let acc = 0, ti = 0, peak = 0, maxDD = 0;
        for (let dd = start; dd <= t1 + day; dd += day) {
          while (ti < trades.length && trades[ti][0] < dd + day) { acc += trades[ti][1]; ti++; }
          const v = acc / N; labels.push(fmtDate(dd)); cum.push(+v.toFixed(2));
          if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v;
        }
        const pnls = trades.map(t => t[1]);
        const wins = pnls.filter(p => p > 0).length, losses = pnls.filter(p => p < 0).length;
        const sum = pnls.reduce((a, p) => a + p, 0);
        return { mode: 'time', labels, cum, total: sum / N, coins: N, trades: trades.length,
          maxDD, exp: sum / pnls.length, wr: (wins + losses) ? wins / (wins + losses) * 100 : null,
          dateFrom: fmtDate(start), dateTo: fmtDate(t1) };
      }
    }
    let acc = 0; const labels = [], cum = [], per = [];
    r.forEach(x => { acc += (x.pnl_pct || 0); labels.push(x.symbol.replace(/USDT$/, '')); cum.push(+acc.toFixed(2)); per.push(x.pnl_pct || 0); });
    return { mode: 'coins', labels, cum, per, total: acc };
  }
  function pnlSvg(d) {
    const W = 340, H = 118, pad = 5, n = d.cum.length;
    if (n < 2) return '<div class="fs-pnl-empty">мало данных для кривой</div>';
    const min = Math.min(...d.cum, 0), max = Math.max(...d.cum, 0), span = (max - min) || 1;
    const X = i => pad + i / (n - 1) * (W - 2 * pad), Y = v => pad + (1 - (v - min) / span) * (H - 2 * pad);
    const up = d.total >= 0, col = up ? '#4EFFA0' : '#FF5272', gid = 'pg' + (up ? 'g' : 'r');
    const line = d.cum.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
    const area = line + ' L' + X(n - 1).toFixed(1) + ' ' + (H - pad) + ' L' + X(0).toFixed(1) + ' ' + (H - pad) + ' Z';
    const zY = (min < 0 && max > 0) ? Y(0).toFixed(1) : null;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="fs-pnl-svg">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.32"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      ${zY ? `<line x1="${pad}" y1="${zY}" x2="${W - pad}" y2="${zY}" stroke="rgba(123,132,176,0.45)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  function pnlCardInner(S, d, sortDef, filtered) {
    const isTime = d.mode === 'time';
    const title = isTime ? 'Кривая портфеля (равный вес)' : 'Накопленный PNL по парам';
    const totTxt = d.cum.length ? fmtPct(d.total) : '—';
    const xrow = isTime ? `<div class="fs-pnl-x"><span>${d.dateFrom}</span><span>${d.dateTo}</span></div>` : '';
    let metrics = '';
    if (isTime) {
      const wrTxt = d.wr == null ? '-' : Math.round(d.wr) + '%';
      metrics = `<div class="fs-pnl-metrics">
        <div><b style="color:${COL.red}">-${d.maxDD.toFixed(1)}%</b><span>макс. просадка</span></div>
        <div><b style="color:${pnlHex(d.exp)}">${fmtPct(d.exp)}</b><span>на сделку</span></div>
        <div><b>${wrTxt}</b><span>win rate</span></div>
        <div><b>${d.trades}</b><span>сделок</span></div>
      </div>`;
    }
    const sliders = isTime ? `
      <div class="fs-whatif">
        <div class="fs-wi-row"><span class="fs-wi-lbl">Стоп-лосс</span><input type="range" class="fs-slider fs-wi" data-wi="stop" min="0" max="30" step="1" value="${S.stop || 0}"><span class="fs-wi-val">${S.stop ? '-' + S.stop + '%' : 'выкл'}</span></div>
        <div class="fs-wi-row"><span class="fs-wi-lbl">Тейк-профит</span><input type="range" class="fs-slider fs-wi" data-wi="tp" min="0" max="30" step="1" value="${S.tp || 0}"><span class="fs-wi-val">${S.tp ? '+' + S.tp + '%' : 'выкл'}</span></div>
        <div class="fs-wi-note">что-если: ограничивает результат каждой сделки (грубая оценка правил без переторговки)</div>
      </div>` : '';
    const base = isTime
      ? `Кривая - средний результат на пару за 90 дней. Вход 10% депозита на сигнал.`
      : `сумма по ${d.labels.length} парам в порядке сортировки · ${sortDef.label}`;
    const dep = isTime ? `<div class="fs-pnl-dep">Вложено всего: <b>$${(d.coins * 100).toLocaleString('ru-RU')}</b> · по $100 на каждую из ${d.coins} пар</div>` : '';
    return `
      <div class="fs-pnlcard-top"><span class="fs-pnlcard-t">${title}${filtered ? ' (по фильтру)' : ''}</span><span class="fs-pnlcard-v" style="color:${pnlHex(d.total)}">${totTxt}</span></div>
      ${dep}
      <div class="fs-pnlcard-wrap">${pnlSvg(d)}</div>
      ${xrow}${metrics}${sliders}
      <div class="fs-pnlcard-cap">${base}</div>`;
  }
  function wirePnlCard(host, S) {
    host.querySelectorAll('.fs-wi').forEach(sl => {
      sl.addEventListener('input', () => { const k = sl.dataset.wi, v = +sl.value, lbl = sl.parentElement.querySelector('.fs-wi-val'); if (lbl) lbl.textContent = v ? (k === 'stop' ? '-' : '+') + v + '%' : 'выкл'; });
      sl.addEventListener('change', () => { S[sl.dataset.wi] = +sl.value; refreshPnlCard(host, S); });
    });
  }
  function refreshPnlCard(host, S) {
    const el = host.querySelector('#fsPnlCard'); if (!el) return;
    const sortDef = SORTS.find(s => s.key === S.sort);
    const filtered = S.favOnly || S.hideWeak;
    el.innerHTML = pnlCardInner(S, pnlSeries(S._shownRows || [], { stop: S.stop, tp: S.tp }), sortDef, filtered);
    wirePnlCard(host, S);
  }

  function renderList(host, S) {
    const sortDef = SORTS.find(s => s.key === S.sort);
    const done = S.rows.filter(r => r.computed && !r.error);
    const rng = metricRange(done.length ? done : S.rows, S.sort);
    if (S.sliderVal == null || S.sliderResetFor !== S.sort) { S.sliderVal = rng.min; S.sliderResetFor = S.sort; }

    let rows = S.rows.slice();
    if (S.favOnly) rows = rows.filter(r => favHas(r.symbol));
    if (S.hideWeak) rows = rows.filter(r => r.computed && !r.error && !isWeak(r));
    rows = rows.filter(r => !r.computed || (r[S.sort] == null ? -1e9 : r[S.sort]) >= S.sliderVal);
    rows.sort((a, b) => { if (a.computed !== b.computed) return a.computed ? -1 : 1; return (b[S.sort] == null ? -1e9 : b[S.sort]) - (a[S.sort] == null ? -1e9 : a[S.sort]); });

    const all = S.rows, pairs = all.length;
    S._shownRows = rows;
    const series = pnlSeries(rows, { stop: S.stop, tp: S.tp });
    const filtered = S.favOnly || S.hideWeak || (S.sliderVal != null && S.sliderVal > rng.min);
    const totalSets = done.reduce((s, r) => s + r.sets, 0);
    const inTrade = done.filter(r => r.pos_side === 'long' || r.pos_side === 'short').length;
    const srcNote = S.source === 'default' ? ' · <span class="fs-demo">демо-список</span>' : '';
    const progNote = ` · <span class="fs-demo" id="fsProg">${S.computing ? `считаю ${S.progress}/${S.total}` : ''}</span>`;
    const runPills = `<div class="fs-runbar"><span class="fs-runlbl">Прогон:</span>${RUNS.map(rn => `<button class="fs-runpill ${S.run === rn.key ? 'active' : ''}" data-run="${rn.key}">${rn.label}</button>`).join('')}</div>`;
    const wireCommon = () => {
      host.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => loadRun(host, S, b.dataset.run)));
      const g = host.querySelector('[data-guide]'); if (g) g.addEventListener('click', () => renderGuide(0));
    };
    if (S.runError) {
      host.innerHTML = `
        <div class="fs-header"><div><div class="fs-title">Futures-стратегии</div><div class="fs-sub">Бэктест индикатора 🟣 v.29.1 · 15m · 90 дней</div></div><button class="fs-guidebtn" data-guide>🎓 Гайд</button></div>
        ${runPills}
        <div class="fs-runerr">Прогон не найден: вкладка <b>${S.runError}</b> пуста или отсутствует.<br><br>Сделай бэктест с нужными правилами и вставь результат в эту вкладку. В терминале:<br><code>python backtest_v29.py ${S.run}</code></div>`;
      wireCommon();
      return;
    }

    const cards = rows.map(r => `<div class="${cardOuterClass(r)}" data-sym="${r.symbol}">${cardInner(r)}</div>`).join('') || `<div class="fs-empty">Ничего не найдено под текущим фильтром</div>`;

    host.innerHTML = `
      <div class="fs-header">
        <div>
          <div class="fs-title">Futures-стратегии</div>
          <div class="fs-sub">Бэктест индикатора 🟣 v.29.1 · 15m · 90 дней${srcNote}${progNote}</div>
        </div>
        <button class="fs-guidebtn" data-guide>🎓 Гайд</button>
      </div>
      ${runPills}
      <div class="fs-stats">
        <div class="fs-stat"><div class="fs-stat-val">${pairs}</div><div class="fs-stat-lbl">пар</div></div>
        <div class="fs-stat"><div class="fs-stat-val">${totalSets}</div><div class="fs-stat-lbl">сделок</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.green}">${inTrade}</div><div class="fs-stat-lbl">в сделке</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.yellow}">${done.length - inTrade}</div><div class="fs-stat-lbl">ждут</div></div>
      </div>
      <div class="fs-pnlcard" id="fsPnlCard">${pnlCardInner(S, series, sortDef, filtered)}</div>
      <div class="fs-sortbar">
        <span class="fs-sortlbl">Сортировка:</span>
        ${SORTS.map(s => `<button class="fs-sortpill ${S.sort === s.key ? 'active' : ''}" data-sort="${s.key}">${s.label}</button>`).join('')}
        <button class="fs-favbtn ${S.favOnly ? 'active' : ''}" data-favonly>★ Избранное</button>
        <button class="fs-favbtn qual ${S.hideWeak ? 'active' : ''}" data-hideweak>✓ Скрыть слабые</button>
      </div>
      <div class="fs-sliderbar">
        <input type="range" class="fs-slider" min="${rng.min}" max="${rng.max}" value="${S.sliderVal}" step="1">
        <span class="fs-sliderval">${sortDef.label} ≥ ${S.sliderVal}${sortDef.unit}</span>
      </div>
      <div class="fs-grid">${cards}</div>`;

    wirePnlCard(host, S);
    host.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => loadRun(host, S, b.dataset.run)));
    host.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { S.sort = b.dataset.sort; S.sliderResetFor = null; renderList(host, S); }));
    host.querySelector('[data-favonly]').addEventListener('click', () => { S.favOnly = !S.favOnly; renderList(host, S); });
    host.querySelector('[data-hideweak]').addEventListener('click', () => { S.hideWeak = !S.hideWeak; renderList(host, S); });
    host.querySelector('[data-guide]').addEventListener('click', () => renderGuide(0));
    const sl = host.querySelector('.fs-slider');
    sl.addEventListener('input', () => { S.sliderVal = +sl.value; host.querySelector('.fs-sliderval').textContent = `${sortDef.label} ≥ ${S.sliderVal}${sortDef.unit}`; });
    sl.addEventListener('change', () => { S.sliderVal = +sl.value; renderList(host, S); });
    const grid = host.querySelector('.fs-grid');
    grid.addEventListener('click', e => {
      const fb = e.target.closest('[data-fav]');
      if (fb) { e.stopPropagation(); favToggle(fb.dataset.fav); if (S.favOnly) renderList(host, S); else updateCard(host, S.rows.find(x => x.symbol === fb.dataset.fav)); return; }
      const card = e.target.closest('.fs-card');
      if (card && card.dataset.sym) { const r = S.rows.find(x => x.symbol === card.dataset.sym); if (r && r.computed && !r.error) openDetail(host, S, card.dataset.sym); }
    });
  }

  // ════════════════════════ ДЕТАЛЬНЫЙ ЭКРАН ════════════════════════
  // выпадающий список активов (как в Лаборатории)
  function togglePicker(host, S, currentSym) {
    const existing = host.querySelector('#fdPicker');
    const cr = host.querySelector('.fd-caret');
    if (existing) { existing.remove(); const bd = host.querySelector('#fdPickBd'); if (bd) bd.remove(); if (cr) cr.classList.remove('open'); return; }
    const rows = S.rows.slice().sort((a, b) => (b.pnl_pct == null ? -1e9 : b.pnl_pct) - (a.pnl_pct == null ? -1e9 : a.pnl_pct));
    const items = rows.map(r => {
      const nm = r.symbol.replace(/USDT$/, '');
      return `<button class="fd-pick-item ${r.symbol === currentSym ? 'cur' : ''}" data-pick="${r.symbol}"><span>${nm}</span><span style="color:${pnlHex(r.pnl_pct)}">${fmtPct(r.pnl_pct)}</span></button>`;
    }).join('');
    const head = host.querySelector('.fd-head');
    const bd = document.createElement('div'); bd.id = 'fdPickBd'; bd.className = 'fd-pick-backdrop';
    bd.addEventListener('click', () => togglePicker(host, S, currentSym));
    host.appendChild(bd);
    const div = document.createElement('div'); div.id = 'fdPicker'; div.className = 'fd-picker'; div.innerHTML = items;
    head.appendChild(div);
    if (cr) cr.classList.add('open');
    div.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => openDetail(host, S, b.dataset.pick)));
  }

  async function openDetail(host, S, symbol) {
    const row = S.rows.find(r => r.symbol === symbol);
    if (!row) return;
    const sym = symbol.replace(/USDT$/, '');
    const favBtn = () => `<button class="fs-fav ${favHas(symbol) ? 'on' : ''}" data-fav="${symbol}" style="position:static">${favHas(symbol) ? '\u2605' : '\u2606'}</button>`;
    const nameBtn = `<button class="fd-name" data-picker><span class="fd-name-t">${sym}</span><span class="fd-caret">\u25be</span></button>`;
    const headBare = `<div class="fd-head"><button class="fd-back" data-back>\u2190</button>${nameBtn}<span class="fd-tf">15m</span>${favBtn()}</div>`;
    const wireBar = () => {
      const bk = host.querySelector('[data-back]'); if (bk) bk.addEventListener('click', () => renderList(host, S));
      const fb = host.querySelector('[data-fav]'); if (fb) fb.addEventListener('click', e => { e.stopPropagation(); const on = favToggle(symbol); e.currentTarget.classList.toggle('on', on); e.currentTarget.textContent = on ? '\u2605' : '\u2606'; });
      const pk = host.querySelector('[data-picker]'); if (pk) pk.addEventListener('click', () => togglePicker(host, S, symbol));
    };

    host.innerHTML = headBare + '<div class="fd-loading">\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0438\u0441\u0442\u043e\u0440\u0438\u0438 \u0438 \u0440\u0430\u0441\u0447\u0451\u0442 \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0438\u2026</div>';
    wireBar();

    let candles, sim, markers;
    try {
      candles = await fetchFutHistory(symbol, 90);
      if (!candles || candles.length < 60) throw new Error('empty');
      const sigs = window.LiveChart.computeSignalList(candles, 15);
      sim = simulateJS(candles, sigs);
      markers = window.LiveChart.computeSignals(candles, 15);
    } catch (err) {
      host.innerHTML = headBare + `<div class="fd-overlay err" style="position:static;padding:30px 16px">\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0433\u0440\u0430\u0444\u0438\u043a \u043f\u0430\u0440\u044b ${sym}.<br>\u0412\u043e\u0437\u043c\u043e\u0436\u043d\u043e, \u0435\u0451 \u043d\u0435\u0442 \u043d\u0430 \u0444\u044c\u044e\u0447\u0435\u0440\u0441\u0430\u0445 Binance.<br><button class="lc-retry" data-retry>\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c</button></div>`;
      wireBar();
      const rt = host.querySelector('[data-retry]'); if (rt) rt.addEventListener('click', () => openDetail(host, S, symbol));
      return;
    }

    const p = sim.position;
    const st = p.side === 'long' ? { txt: '\u0412 \u041b\u041e\u041d\u0413\u0415 \u00d7' + p.lots, cls: 'long' }
      : p.side === 'short' ? { txt: '\u0412 \u0428\u041e\u0420\u0422\u0415 \u00d7' + p.lots, cls: 'short' }
      : { txt: '\u0416\u0414\u0401\u0422 \u0412\u0425\u041e\u0414\u0410', cls: 'wait' };
    const wr = sim.stats.winrate;
    const wrTxt = wr == null ? '-' : (sim.stats.sets < MIN_SETS ? '~' + Math.round(wr) : Math.round(wr)) + '%';
    const prec = precisionFor(candles[candles.length - 1].close);
    const avgTxt = p.avg ? ` \u00b7 \u0441\u0440\u0435\u0434\u043d\u044f\u044f ${p.avg.toFixed(prec.precision)}` : '';

    const view = sim.sets.map((s, i) => ({ i, s })).reverse();
    const chips = view.map(({ i, s }) =>
      `<div class="fd-chip ${s.pnl >= 0 ? 'win' : 'loss'}" data-set="${i}"><div class="fd-chip-n">#${i + 1} ${s.pnl >= 0 ? 'WIN' : 'LOSS'}</div><div class="fd-chip-v">${fmtPct(s.pnl)}</div></div>`).join('');
    const isOpen = p.side === 'long' || p.side === 'short';
    const openChip = isOpen
      ? `<div class="fd-chip open" data-set="open"><div class="fd-chip-n">\u0421\u0415\u0419\u0427\u0410\u0421 ${p.side === 'long' ? '\u25b2 LONG' : '\u25bc SHORT'}</div><div class="fd-chip-v">\u00d7${p.lots}</div></div>` : '';

    const head = `<div class="fd-head"><button class="fd-back" data-back>\u2190</button>${nameBtn}<div class="fd-hstats"><div class="fd-hstat"><b>${sim.stats.sets}</b><span>\u0421\u0414\u0415\u041b\u041e\u041a</span></div><div class="fd-hstat"><b style="color:${wrHex(wr, sim.stats.sets)}">${wrTxt}</b><span>WIN</span></div><div class="fd-hstat"><b style="color:${pnlHex(sim.stats.pnlPct)}">${fmtPct(sim.stats.pnlPct)}</b><span>PNL</span></div></div><span class="fd-tf">15m</span>${favBtn()}</div>`;

    host.innerHTML = head + `
      <div class="fd-pos ${st.cls}">${st.txt}${avgTxt}</div>
      <div class="fd-sub2"><span>макс. просадка <b style="color:${COL.red}">-${(sim.stats.maxDD || 0).toFixed(1)}%</b></span><span>ожидание <b style="color:${pnlHex(sim.stats.exp || 0)}">${fmtPct(sim.stats.exp || 0)}</b>/сделка</span></div>
      <div class="fd-chips">${openChip}${chips}${(!chips && !openChip) ? '<span class="fs-sets">\u043d\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d\u043d\u044b\u0445 \u0441\u0434\u0435\u043b\u043e\u043a</span>' : ''}</div>
      <div class="fd-chartwrap"><div class="fd-chart" id="fdChart"></div></div>
      <div class="fd-legend"><span><i style="background:${COL.green}"></i>BUY</span><span><i style="background:${COL.red}"></i>SELL</span><span class="fd-note">\u0442\u0430\u043f \u043f\u043e \u0441\u0434\u0435\u043b\u043a\u0435 - \u043f\u043e\u0434\u0441\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0433\u0440\u0430\u0444\u0438\u043a\u0435</span></div>
      <div class="fs-hint">\u041c\u043e\u0434\u0435\u043b\u044c v.29.1: \u0432\u0445\u043e\u0434 10% \u0434\u0435\u043f\u043e \u043d\u0430 \u0441\u0438\u0433\u043d\u0430\u043b, \u0443\u0441\u0440\u0435\u0434\u043d\u0435\u043d\u0438\u0435 \u0432 \u0442\u0443 \u0436\u0435 \u0441\u0442\u043e\u0440\u043e\u043d\u0443, \u043e\u0431\u0440\u0430\u0442\u043d\u044b\u0439 \u0441\u0438\u0433\u043d\u0430\u043b \u0437\u0430\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0432\u0441\u0435 \u0434\u043e\u043b\u0438 \u0438 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0440\u0435\u0432\u0435\u0440\u0441 \u043d\u0430 10%. \u041d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0432\u0445\u043e\u0434\u043e\u0432 \u0432 \u043e\u0434\u043d\u0443 \u0441\u0442\u043e\u0440\u043e\u043d\u0443 - \u044d\u0442\u043e \u043e\u0434\u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0430. \u0423\u0440\u043e\u0432\u043d\u0438 \u043d\u0430 \u0433\u0440\u0430\u0444\u0438\u043a\u0435 - \u0444\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0435 \u0437\u0430\u043b\u0438\u0432\u043a\u0438 \u0443\u0441\u0440\u0435\u0434\u043d\u0435\u043d\u0438\u044f (TP/STOP \u0432 \u044d\u0442\u043e\u0439 \u043c\u043e\u0434\u0435\u043b\u0438 \u043d\u0435\u0442).</div>`;
    wireBar();

    const el = host.querySelector('#fdChart');
    const last = candles[candles.length - 1].time;
    // линии текущей набранной позиции (по умолчанию и при переоткрытии)
    const posLines = [];
    if (isOpen) {
      const col = p.side === 'long' ? COL.green : COL.purple;
      p.entries.forEach((pr, i) => posLines.push({ price: pr, color: 'rgba(102,163,255,0.5)', title: '\u0432\u0445\u043e\u0434 ' + (i + 1), style: 2 }));
      if (p.avg) posLines.push({ price: p.avg, color: col, title: '\u0441\u0440\u0435\u0434\u043d\u044f\u044f', width: 2, style: 0 });
    }
    const baseView = () => window.LiveChart.renderInto(el, { candles, markers, priceLines: posLines, precision: prec, viewBars: 140 });
    baseView();

    let active = null;
    const chipEls = host.querySelectorAll('.fd-chip[data-set]');
    chipEls.forEach(c => c.addEventListener('click', () => {
      const ds = c.dataset.set;
      if (active === ds) { active = null; chipEls.forEach(x => x.classList.remove('sel')); baseView(); return; }
      active = ds; chipEls.forEach(x => x.classList.toggle('sel', x === c));
      if (ds === 'open') {
        const from = p.t0 || candles[Math.max(0, candles.length - 140)].time;
        const pad = Math.max(3600, (last - from) * 0.15);
        window.LiveChart.renderInto(el, { candles, markers, priceLines: posLines, precision: prec, visibleRange: { from: from - pad, to: last + pad } });
        return;
      }
      // выбран исторический сет: показываем ТОЛЬКО его (добор объединён в одну сделку)
      const s = sim.sets[+ds];
      const pad = Math.max(3600, (s.t1 - s.t0) * 0.35);
      const lines = [
        { price: s.entryAvg, color: COL.yellow, title: '\u0432\u0445\u043e\u0434 \u0441\u0434\u0435\u043b\u043a\u0438', width: 2, style: 2 },
        { price: s.exitPrice, color: s.pnl >= 0 ? COL.green : COL.red, title: '\u0432\u044b\u0445\u043e\u0434', width: 2, style: 2 },
      ];
      window.LiveChart.renderInto(el, { candles, markers, priceLines: lines, precision: prec, visibleRange: { from: s.t0 - pad, to: s.t1 + pad } });
    }));
  }

  // ---- Публичный API -------------------------------------------------------
  const state = {};
  const RUNS = [
    { key: 'base', label: 'Базовый', tab: 'FUT_STRAT' },
    { key: 'sl', label: 'Стоп', tab: 'FUT_STRAT_SL' },
    { key: 'sltrend', label: 'Стоп+Тренд', tab: 'FUT_STRAT_SLT' },
  ];

  async function loadRun(host, S, runKey) {
    const run = RUNS.find(r => r.key === runKey) || RUNS[0];
    S.run = run.key; S.runError = false; S.computing = false; S._chart = null;
    S._runCache = S._runCache || {};
    if (S._runCache[run.key]) { const c = S._runCache[run.key]; S.rows = c.rows; S.source = c.source; renderList(host, S); return; }
    host.innerHTML = `<div class="fs-loading">Загрузка прогона «${run.label}»…</div>`;
    const data = await readSheet(run.tab, run.key === 'base');
    if (data.mode === 'stats') {
      S.rows = data.rows; S.source = data.source; S.total = data.rows.length; S.progress = data.rows.length;
      S._runCache[run.key] = { rows: data.rows, source: data.source };
      renderList(host, S);
    } else if (data.mode === 'compute') {
      const symbols = data.symbols;
      S.rows = symbols.map(placeholderRow); S.source = data.source; S.computing = true; S.progress = 0; S.total = symbols.length;
      renderList(host, S);
      computeAll(symbols, (i, row, done, total) => {
        S.rows[i] = row; S.progress = done; updateCard(host, row); updateProgress(host, S);
        if (done === total) { S.computing = false; S._runCache[run.key] = { rows: S.rows, source: S.source }; renderList(host, S); }
      }, 3);
    } else {
      S.rows = []; S.runError = run.tab; renderList(host, S);
    }
  }

  async function mount(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    if (state[containerId]) { renderList(host, state[containerId]); return; }
    const S = { rows: [], run: 'base', source: 'sheet', sort: 'pnl_pct', sliderVal: null, sliderResetFor: null, favOnly: false, hideWeak: false, computing: false, progress: 0, total: 0, stop: 0, tp: 0 };
    state[containerId] = S;
    host.innerHTML = '<div class="fs-loading">Загрузка стратегий…</div>';
    await loadRun(host, S, 'base');
    let seen = false; try { seen = localStorage.getItem('futStrat_guide_seen') === '1'; } catch (e) {}
    if (!seen) setTimeout(() => renderGuide(0), 400);
  }

  window.FutStrat = { mount, simulateJS, fetchFutHistory };
})();
