/* =========================================================================
   futures-strategy.js - лидерборд фьючерсных стратегий (бэктест v.29.1)
     • карточки пар: PNL / WIN% / сеты / позиция
     • избранное (♥, как в Лаборатории) + фильтр по избранному
     • сортировка PNL / WIN% / Сигналы + ползунок-фильтр по значению
     • тап по карточке → детальный экран: график с сигналами, набранные
       позиции (входы усреднения + средняя), история сетов, статус
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
    { t: 'Карточка монеты', b: 'PNL - суммарная доходность от депозита. WIN% - доля прибыльных сетов (зелёный ≥62%, жёлтый 55.6-62%, красный ниже; «~X%» - статистики пока мало). Снизу - статус: в лонге/шорте с числом долей или «ждёт входа».' },
    { t: 'Сортировка', b: 'Переключай показатель сортировки: PNL, WIN% или число сигналов. Список мгновенно пересортируется по убыванию выбранного значения.' },
    { t: 'Ползунок-фильтр', b: 'Ползунок под сортировкой отсекает карточки, у которых выбранный показатель ниже его значения. Быстрый способ оставить только сильные по PNL или WIN%.' },
    { t: 'Избранное ★', b: 'Звезда на карточке добавляет монету в избранное (хранится на устройстве). Кнопка «★ Избранное» в панели оставляет на экране только избранные.' },
    { t: 'Скрыть слабые', b: 'Кнопка «Скрыть слабые» одним тапом убирает заведомо плохие сетапы: мало статистики (менее 5 сетов), отрицательный PNL или WIN% ниже безубытка (55.6%).' },
    { t: 'Детальный экран', b: 'Тап по карточке открывает монету: статы (сеты / WIN% / PNL), лента истории сетов (#1 WIN +18.7% …), текущая позиция и живой график.' },
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

  // синтетическая история сетов для демо (из числа wins/losses)
  function synthSets(wins, losses) {
    const out = [];
    for (let i = 0; i < wins; i++) out.push(+(4 + (i * 37 % 16)).toFixed(1));
    for (let i = 0; i < losses; i++) out.push(-(3 + (i * 53 % 9)).toFixed(1));
    // псевдо-перемешивание для реалистичного порядка
    return out.sort(() => ((Math.sin(out.length) + 1) % 1) - 0.5);
  }

  // ---- ДЕМО-данные --------------------------------------------------------
  const SAMPLE = [
    ['SOLUSDT', 24, 11, 8, 3, 72.7, 58.4, 'long', 2], ['SUIUSDT', 19, 9, 6, 3, 66.7, 41.2, 'short', 1],
    ['DOGEUSDT', 31, 14, 9, 5, 64.3, 33.7, '—', 0], ['AVAXUSDT', 17, 8, 5, 3, 62.5, 27.9, 'long', 3],
    ['LINKUSDT', 22, 10, 6, 4, 60.0, 18.4, 'long', 1], ['TONUSDT', 15, 7, 4, 3, 57.1, 12.1, '—', 0],
    ['BNBUSDT', 20, 9, 5, 4, 55.6, 9.8, 'short', 2], ['XRPUSDT', 26, 12, 6, 6, 50.0, 4.3, 'long', 4],
    ['ETHUSDT', 18, 8, 4, 4, 50.0, -2.6, 'short', 1], ['BTCUSDT', 14, 6, 3, 3, 50.0, -5.1, '—', 0],
    ['ADAUSDT', 23, 10, 5, 5, 50.0, -8.7, 'short', 3], ['NEARUSDT', 16, 7, 3, 4, 42.9, -14.2, 'long', 2],
    ['APTUSDT', 21, 9, 4, 5, 44.4, -16.8, 'short', 5], ['ARBUSDT', 19, 8, 3, 5, 37.5, -22.4, 'short', 6],
    ['OPUSDT', 13, 4, 3, 1, 75.0, 19.5, 'long', 1], ['INJUSDT', 11, 3, 2, 1, 66.7, 8.2, '—', 0],
    ['PEPEUSDT', 28, 13, 8, 5, 61.5, 24.6, 'long', 2], ['WIFUSDT', 25, 11, 7, 4, 63.6, 31.0, 'short', 3],
    ['TIAUSDT', 17, 7, 4, 3, 57.1, 6.4, '—', 0], ['SEIUSDT', 20, 9, 4, 5, 44.4, -11.3, 'short', 4],
    ['LTCUSDT', 18, 8, 5, 3, 62.5, 22.1, 'long', 2], ['ATOMUSDT', 16, 7, 4, 3, 57.1, 7.9, '—', 0],
    ['FILUSDT', 21, 9, 5, 4, 55.6, 11.2, 'short', 1], ['HBARUSDT', 19, 8, 5, 3, 62.5, 26.3, 'long', 2],
    ['RUNEUSDT', 23, 10, 6, 4, 60.0, 17.5, 'short', 3], ['ORDIUSDT', 22, 10, 4, 6, 40.0, -19.6, 'long', 5],
    ['JTOUSDT', 15, 6, 4, 2, 66.7, 14.8, '—', 0], ['ENAUSDT', 26, 12, 8, 4, 66.7, 38.9, 'long', 2],
    ['FETUSDT', 20, 9, 5, 4, 55.6, 5.7, 'short', 2], ['RNDRUSDT', 18, 8, 5, 3, 62.5, 20.4, 'long', 1],
  ].map(r => ({
    symbol: r[0], tf: '15m', signals: r[1], sets: r[2], wins: r[3], losses: r[4],
    winrate: r[5], pnl_pct: r[6], pos_side: r[7], pos_lots: r[8],
    pos_avg: 0, lot_entries: [], sets_pct: synthSets(r[3], r[4]),
  }));

  // ---- Чтение FUT_STRAT ----------------------------------------------------
  async function fetchRows() {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('http');
      const text = await r.text();
      if (/setResponse/.test(text) || /^.{0,200}error/i.test(text)) throw new Error('no tab');
      const grid = (window.parseCSV || localParse)(text);
      if (!grid || grid.length < 2) throw new Error('empty');
      const head = grid[0].map(h => String(h).trim().toLowerCase());
      const ix = n => head.indexOf(n);
      const jp = s => { try { return JSON.parse(s); } catch (e) { return []; } };
      const rows = grid.slice(1).filter(r => r[ix('symbol')]).map(r => ({
        symbol: r[ix('symbol')], tf: r[ix('tf')] || '15m',
        signals: +r[ix('signals')] || 0, sets: +r[ix('sets')] || 0,
        wins: +r[ix('wins')] || 0, losses: +r[ix('losses')] || 0,
        winrate: (r[ix('winrate')] === '' || r[ix('winrate')] == null) ? null : +r[ix('winrate')],
        pnl_pct: +r[ix('pnl_pct')] || 0,
        pos_side: r[ix('pos_side')] || '—', pos_lots: +r[ix('pos_lots')] || 0,
        pos_avg: ix('pos_avg') > -1 ? +r[ix('pos_avg')] || 0 : 0,
        lot_entries: ix('lot_entries') > -1 ? jp(r[ix('lot_entries')]) : [],
        sets_pct: ix('sets_json') > -1 ? jp(r[ix('sets_json')]) : [],
      }));
      if (!rows.length) throw new Error('empty');
      return { rows, demo: false };
    } catch (e) {
      return { rows: SAMPLE.slice(), demo: true };
    }
  }
  function localParse(text) {
    return text.trim().split('\n').map(line => {
      const out = []; let c = '', q = false;
      for (let i = 0; i < line.length; i++) { const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { out.push(c); c = ''; } else c += ch; }
      out.push(c); return out;
    });
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
          const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=1500&startTime=${start}`;
          const r = await fetch(u); if (!r.ok) throw new Error('fapi ' + r.status);
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
        const r = await fetch(u); if (!r.ok) continue;
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
    return {
      sets,
      position: { side: pside, lots: plots, avg: pavg, entries, t0: pt0, unrealPct: unreal / SIM.capital * 100 },
      stats: { sets: sets.length, wins, losses, winrate: closed ? wins / closed * 100 : null, pnlPct: (eq + unreal - SIM.capital) / SIM.capital * 100 },
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

  function renderList(host, S) {
    const sortDef = SORTS.find(s => s.key === S.sort);
    const rng = metricRange(S.rows, S.sort);
    if (S.sliderVal == null || S.sliderResetFor !== S.sort) { S.sliderVal = rng.min; S.sliderResetFor = S.sort; }

    let rows = S.rows.slice();
    if (S.favOnly) rows = rows.filter(r => favHas(r.symbol));
    if (S.hideWeak) rows = rows.filter(r => !isWeak(r));
    rows = rows.filter(r => (r[S.sort] == null ? -1e9 : r[S.sort]) >= S.sliderVal);
    rows.sort((a, b) => (b[S.sort] == null ? -1e9 : b[S.sort]) - (a[S.sort] == null ? -1e9 : a[S.sort]));

    const all = S.rows;
    const pairs = all.length, totalSets = all.reduce((s, r) => s + r.sets, 0);
    const inTrade = all.filter(r => r.pos_side === 'long' || r.pos_side === 'short').length;

    const cards = rows.map(r => {
      const sym = r.symbol.replace(/USDT$/, ''), st = statusInfo(r), fav = favHas(r.symbol);
      const wrTxt = r.winrate == null ? '-' : (r.sets < MIN_SETS ? '~' + Math.round(r.winrate) : Math.round(r.winrate)) + '%';
      return `
        <div class="fs-card ${r.pnl_pct >= 0 ? 'pos' : 'neg'}" data-sym="${r.symbol}">
          <button class="fs-fav ${fav ? 'on' : ''}" data-fav="${r.symbol}" title="В избранное">${fav ? '★' : '☆'}</button>
          <div class="fs-card-top"><span class="fs-sym">${sym}</span><span class="fs-tf">${r.tf}</span></div>
          <div class="fs-pnl" style="color:${pnlHex(r.pnl_pct)}">${fmtPct(r.pnl_pct)}</div>
          <div class="fs-meta"><span class="fs-wr" style="color:${wrHex(r.winrate, r.sets)}">WIN ${wrTxt}</span><span class="fs-sets">${r.sets} сетов</span></div>
          <div class="fs-status ${st.cls}">${st.txt}</div>
        </div>`;
    }).join('') || `<div class="fs-empty">Ничего не найдено под текущим фильтром</div>`;

    host.innerHTML = `
      <div class="fs-header">
        <div>
          <div class="fs-title">Futures-стратегии</div>
          <div class="fs-sub">Бэктест индикатора 🟣 v.29.1 · 15m${S.demo ? ' · <span class="fs-demo">демо-данные</span>' : ''}</div>
        </div>
        <button class="fs-guidebtn" data-guide>🎓 Гайд</button>
      </div>
      <div class="fs-stats">
        <div class="fs-stat"><div class="fs-stat-val">${pairs}</div><div class="fs-stat-lbl">пар</div></div>
        <div class="fs-stat"><div class="fs-stat-val">${totalSets}</div><div class="fs-stat-lbl">сетов</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.green}">${inTrade}</div><div class="fs-stat-lbl">в сделке</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.yellow}">${pairs - inTrade}</div><div class="fs-stat-lbl">ждут</div></div>
      </div>
      <div class="fs-sortbar">
        <span class="fs-sortlbl">Сортировка:</span>
        ${SORTS.map(s => `<button class="fs-sortpill ${S.sort === s.key ? 'active' : ''}" data-sort="${s.key}">${s.label}</button>`).join('')}
        <button class="fs-favbtn ${S.favOnly ? 'active' : ''}" data-favonly>★ Избранное</button>
        <button class="fs-favbtn qual ${S.hideWeak ? 'active' : ''}" data-hideweak>✓ Скрыть слабые</button>
      </div>
      <div class="fs-sliderbar">
        <input type="range" class="fs-slider" min="${rng.min}" max="${rng.max}" value="${S.sliderVal}" step="${sortDef.unit === '%' ? 1 : 1}">
        <span class="fs-sliderval">${sortDef.label} ≥ ${S.sliderVal}${sortDef.unit}</span>
      </div>
      <div class="fs-grid">${cards}</div>
      ${S.demo ? `<div class="fs-hint">Демо-набор для предпросмотра. Не используйте информацию изложенную тут для торговли на реальные средства.</div>` : ''}`;

    host.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { S.sort = b.dataset.sort; S.sliderResetFor = null; renderList(host, S); }));
    host.querySelector('[data-favonly]').addEventListener('click', () => { S.favOnly = !S.favOnly; renderList(host, S); });
    host.querySelector('[data-hideweak]').addEventListener('click', () => { S.hideWeak = !S.hideWeak; renderList(host, S); });
    host.querySelector('[data-guide]').addEventListener('click', () => renderGuide(0));
    const sl = host.querySelector('.fs-slider');
    sl.addEventListener('input', () => { S.sliderVal = +sl.value; host.querySelector('.fs-sliderval').textContent = `${sortDef.label} ≥ ${S.sliderVal}${sortDef.unit}`; });
    sl.addEventListener('change', () => { S.sliderVal = +sl.value; renderList(host, S); });
    host.querySelectorAll('[data-fav]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); favToggle(b.dataset.fav); renderList(host, S); }));
    host.querySelectorAll('.fs-card').forEach(c => c.addEventListener('click', () => openDetail(host, S, c.dataset.sym)));
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
    const headRow = `<div class="fd-head-row"><button class="fd-back" data-back>\u2190</button><button class="fd-name" data-picker>${sym} <span class="fd-caret">\u25be</span></button><span class="fd-tf">15m</span>${favBtn()}</div>`;
    const headLoading = `<div class="fd-head">${headRow}</div>`;
    const wireBar = () => {
      const bk = host.querySelector('[data-back]'); if (bk) bk.addEventListener('click', () => renderList(host, S));
      const fb = host.querySelector('[data-fav]'); if (fb) fb.addEventListener('click', e => { e.stopPropagation(); const on = favToggle(symbol); e.currentTarget.classList.toggle('on', on); e.currentTarget.textContent = on ? '\u2605' : '\u2606'; });
      const pk = host.querySelector('[data-picker]'); if (pk) pk.addEventListener('click', () => togglePicker(host, S, symbol));
    };

    host.innerHTML = headLoading + '<div class="fd-loading">\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u0438\u0441\u0442\u043e\u0440\u0438\u0438 \u0438 \u0440\u0430\u0441\u0447\u0451\u0442 \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0438\u2026</div>';
    wireBar();

    let candles, sim, markers;
    try {
      candles = await fetchFutHistory(symbol, 90);
      if (!candles || candles.length < 60) throw new Error('empty');
      const sigs = window.LiveChart.computeSignalList(candles, 15);
      sim = simulateJS(candles, sigs);
      markers = window.LiveChart.computeSignals(candles, 15);
    } catch (err) {
      host.innerHTML = headLoading + `<div class="fd-overlay err" style="position:static;padding:30px 16px">\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0433\u0440\u0430\u0444\u0438\u043a \u043f\u0430\u0440\u044b ${sym}.<br>\u0412\u043e\u0437\u043c\u043e\u0436\u043d\u043e, \u0435\u0451 \u043d\u0435\u0442 \u043d\u0430 \u0444\u044c\u044e\u0447\u0435\u0440\u0441\u0430\u0445 Binance.<br><button class="lc-retry" data-retry>\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c</button></div>`;
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

    const view = sim.sets.map((s, i) => ({ i, s })).slice(-12).reverse();
    const chips = view.map(({ i, s }) =>
      `<div class="fd-chip ${s.pnl >= 0 ? 'win' : 'loss'}" data-set="${i}"><div class="fd-chip-n">#${i + 1} ${s.pnl >= 0 ? 'WIN' : 'LOSS'}</div><div class="fd-chip-v">${fmtPct(s.pnl)}</div></div>`).join('');
    const isOpen = p.side === 'long' || p.side === 'short';
    const openChip = isOpen
      ? `<div class="fd-chip open" data-set="open"><div class="fd-chip-n">\u0421\u0415\u0419\u0427\u0410\u0421 ${p.side === 'long' ? '\u25b2 LONG' : '\u25bc SHORT'}</div><div class="fd-chip-v">\u00d7${p.lots}</div></div>` : '';

    const head = `<div class="fd-head">${headRow}
        <div class="fd-head-stats"><span><b>${sim.stats.sets}</b> \u0441\u0435\u0442\u043e\u0432</span><span class="fd-dot">\u00b7</span><span><b style="color:${wrHex(wr, sim.stats.sets)}">${wrTxt}</b> WR</span><span class="fd-dot">\u00b7</span><span><b style="color:${pnlHex(sim.stats.pnlPct)}">${fmtPct(sim.stats.pnlPct)}</b> PNL</span></div>
      </div>`;

    host.innerHTML = head + `
      <div class="fd-pos ${st.cls}">${st.txt}${avgTxt}</div>
      <div class="fd-chips">${openChip}${chips}${(!chips && !openChip) ? '<span class="fs-sets">\u043d\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d\u043d\u044b\u0445 \u0441\u0435\u0442\u043e\u0432</span>' : ''}</div>
      <div class="fd-chartwrap"><div class="fd-chart" id="fdChart"></div></div>
      <div class="fd-legend"><span><i style="background:${COL.green}"></i>BUY</span><span><i style="background:${COL.red}"></i>SELL</span><span class="fd-note">\u0442\u0430\u043f \u043f\u043e \u0441\u0435\u0442\u0443 - \u043f\u043e\u0434\u0441\u0432\u0435\u0442\u0438\u0442\u044c \u043d\u0430 \u0433\u0440\u0430\u0444\u0438\u043a\u0435</span></div>
      <div class="fs-hint">\u041c\u043e\u0434\u0435\u043b\u044c v.29.1: \u0432\u0445\u043e\u0434 10% \u0434\u0435\u043f\u043e \u043d\u0430 \u0441\u0438\u0433\u043d\u0430\u043b, \u0443\u0441\u0440\u0435\u0434\u043d\u0435\u043d\u0438\u0435 \u0432 \u0442\u0443 \u0436\u0435 \u0441\u0442\u043e\u0440\u043e\u043d\u0443, \u043e\u0431\u0440\u0430\u0442\u043d\u044b\u0439 \u0441\u0438\u0433\u043d\u0430\u043b \u0437\u0430\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0432\u0441\u0435 \u0434\u043e\u043b\u0438 \u0438 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u0440\u0435\u0432\u0435\u0440\u0441 \u043d\u0430 10%. \u041d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0432\u0445\u043e\u0434\u043e\u0432 \u043e\u0434\u043d\u043e\u0433\u043e \u0441\u0435\u0442\u0430 - \u044d\u0442\u043e \u043e\u0434\u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0430. \u0423\u0440\u043e\u0432\u043d\u0438 \u043d\u0430 \u0433\u0440\u0430\u0444\u0438\u043a\u0435 - \u0444\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0435 \u0437\u0430\u043b\u0438\u0432\u043a\u0438 \u0443\u0441\u0440\u0435\u0434\u043d\u0435\u043d\u0438\u044f (TP/STOP \u0432 \u044d\u0442\u043e\u0439 \u043c\u043e\u0434\u0435\u043b\u0438 \u043d\u0435\u0442).</div>`;
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
        { price: s.entryAvg, color: COL.yellow, title: '\u0432\u0445\u043e\u0434 \u0441\u0435\u0442\u0430', width: 2, style: 2 },
        { price: s.exitPrice, color: s.pnl >= 0 ? COL.green : COL.red, title: '\u0432\u044b\u0445\u043e\u0434', width: 2, style: 2 },
      ];
      window.LiveChart.renderInto(el, { candles, markers, priceLines: lines, precision: prec, visibleRange: { from: s.t0 - pad, to: s.t1 + pad } });
    }));
  }

  // ---- Публичный API -------------------------------------------------------
  const state = {};
  async function mount(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    if (state[containerId]) return;
    host.innerHTML = '<div class="fs-loading">Загрузка стратегий…</div>';
    const { rows, demo } = await fetchRows();
    const S = { rows, demo, sort: 'pnl_pct', sliderVal: null, sliderResetFor: null, favOnly: false, hideWeak: false };
    state[containerId] = S;
    renderList(host, S);
    // авто-открытие гайда при первом заходе
    let seen = false; try { seen = localStorage.getItem('futStrat_guide_seen') === '1'; } catch (e) {}
    if (!seen) setTimeout(() => renderGuide(0), 400);
  }

  window.FutStrat = { mount, simulateJS, fetchFutHistory };
})();
