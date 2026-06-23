/* =========================================================================
   futures-strategy.js — лидерборд фьючерсных стратегий (бэктест v.29.1)
   Данные: вкладка FUT_STRAT в Google Sheets (заполняется backtest_v29.py).
   Пока вкладки нет — показываются ДЕМО-данные (помечены), чтобы видеть дизайн.
   ========================================================================= */
(function () {
  'use strict';

  const SHEET_ID = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
  const TAB = 'FUT_STRAT';

  // Пороги цвета WinRate (как в остальном приложении) + минимум сетов
  const WR_RED = 55.6, WR_YELLOW = 61.9, MIN_SETS = 5;
  const COL = { green: '#4EFFA0', red: '#FF5272', yellow: '#FFD166', muted: '#7B84B0' };

  function wrHex(wr, sets) {
    if (wr == null || sets < MIN_SETS) return COL.muted;
    if (wr < WR_RED) return COL.red;
    if (wr < WR_YELLOW) return COL.yellow;
    return COL.green;
  }
  const pnlHex = v => (v >= 0 ? COL.green : COL.red);
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(v <= -100 || v >= 100 ? 0 : 1) + '%';

  // ---- ДЕМО-данные (заменяются реальными из FUT_STRAT) --------------------
  const SAMPLE = [
    ['SOLUSDT', 24, 11, 8, 3, 72.7, 58.4, 'long', 2],
    ['SUIUSDT', 19, 9, 6, 3, 66.7, 41.2, 'short', 1],
    ['DOGEUSDT', 31, 14, 9, 5, 64.3, 33.7, '—', 0],
    ['AVAXUSDT', 17, 8, 5, 3, 62.5, 27.9, 'long', 3],
    ['LINKUSDT', 22, 10, 6, 4, 60.0, 18.4, 'long', 1],
    ['TONUSDT', 15, 7, 4, 3, 57.1, 12.1, '—', 0],
    ['BNBUSDT', 20, 9, 5, 4, 55.6, 9.8, 'short', 2],
    ['XRPUSDT', 26, 12, 6, 6, 50.0, 4.3, 'long', 4],
    ['ETHUSDT', 18, 8, 4, 4, 50.0, -2.6, 'short', 1],
    ['BTCUSDT', 14, 6, 3, 3, 50.0, -5.1, '—', 0],
    ['ADAUSDT', 23, 10, 5, 5, 50.0, -8.7, 'short', 3],
    ['NEARUSDT', 16, 7, 3, 4, 42.9, -14.2, 'long', 2],
    ['APTUSDT', 21, 9, 4, 5, 44.4, -16.8, 'short', 5],
    ['ARBUSDT', 19, 8, 3, 5, 37.5, -22.4, 'short', 6],
    ['OPUSDT', 13, 4, 3, 1, 75.0, 19.5, 'long', 1],   // <5 сетов → muted WR
    ['INJUSDT', 11, 3, 2, 1, 66.7, 8.2, '—', 0],      // <5 сетов
    ['PEPEUSDT', 28, 13, 8, 5, 61.5, 24.6, 'long', 2],
    ['WIFUSDT', 25, 11, 7, 4, 63.6, 31.0, 'short', 3],
    ['TIAUSDT', 17, 7, 4, 3, 57.1, 6.4, '—', 0],
    ['SEIUSDT', 20, 9, 4, 5, 44.4, -11.3, 'short', 4],
  ].map(r => ({
    symbol: r[0], tf: '15m', signals: r[1], sets: r[2], wins: r[3], losses: r[4],
    winrate: r[5], pnl_pct: r[6], pos_side: r[7], pos_lots: r[8],
  }));

  // ---- Чтение из Google Sheets --------------------------------------------
  async function fetchRows() {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('http ' + r.status);
      const text = await r.text();
      if (/google\.visualization\.Query\.setResponse/.test(text) || /error/i.test(text.slice(0, 200))) throw new Error('no tab');
      const parse = window.parseCSV || localParse;
      const grid = parse(text);
      if (!grid || grid.length < 2) throw new Error('empty');
      const head = grid[0].map(h => String(h).trim().toLowerCase());
      const ix = name => head.indexOf(name);
      const rows = grid.slice(1).filter(r => r[ix('symbol')]).map(r => ({
        symbol: r[ix('symbol')],
        tf: r[ix('tf')] || '15m',
        signals: +r[ix('signals')] || 0,
        sets: +r[ix('sets')] || 0,
        wins: +r[ix('wins')] || 0,
        losses: +r[ix('losses')] || 0,
        winrate: r[ix('winrate')] === '' || r[ix('winrate')] == null ? null : +r[ix('winrate')],
        pnl_pct: +r[ix('pnl_pct')] || 0,
        pos_side: r[ix('pos_side')] || '—',
        pos_lots: +r[ix('pos_lots')] || 0,
      }));
      if (!rows.length) throw new Error('empty');
      return { rows, demo: false };
    } catch (e) {
      return { rows: SAMPLE.slice(), demo: true };
    }
  }

  function localParse(text) {
    return text.trim().split('\n').map(line => {
      const out = []; let cell = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
        else if (c === '"') q = true;
        else if (c === ',') { out.push(cell); cell = ''; }
        else cell += c;
      }
      out.push(cell); return out;
    });
  }

  // ---- Рендер -------------------------------------------------------------
  const SORTS = [
    { key: 'pnl_pct', label: 'PNL' },
    { key: 'winrate', label: 'WIN%' },
    { key: 'signals', label: 'Сигналы' },
  ];

  function statusInfo(row) {
    if (row.pos_side === 'long') return { txt: 'В ЛОНГЕ ×' + row.pos_lots, cls: 'long' };
    if (row.pos_side === 'short') return { txt: 'В ШОРТЕ ×' + row.pos_lots, cls: 'short' };
    return { txt: 'ЖДЁТ ВХОДА', cls: 'wait' };
  }

  function render(host, state) {
    const rows = state.rows.slice().sort((a, b) => {
      const k = state.sort;
      const av = a[k] == null ? -1e9 : a[k], bv = b[k] == null ? -1e9 : b[k];
      return bv - av;
    });

    const pairs = rows.length;
    const totalSets = rows.reduce((s, r) => s + r.sets, 0);
    const inTrade = rows.filter(r => r.pos_side === 'long' || r.pos_side === 'short').length;
    const waiting = pairs - inTrade;

    const cards = rows.map(r => {
      const sym = r.symbol.replace(/USDT$/, '');
      const st = statusInfo(r);
      const wrTxt = r.winrate == null ? '—' : (r.sets < MIN_SETS ? '~' + Math.round(r.winrate) : Math.round(r.winrate)) + '%';
      return `
        <div class="fs-card ${r.pnl_pct >= 0 ? 'pos' : 'neg'}">
          <div class="fs-card-top">
            <span class="fs-sym">${sym}</span>
            <span class="fs-tf">${r.tf}</span>
          </div>
          <div class="fs-pnl" style="color:${pnlHex(r.pnl_pct)}">${fmtPct(r.pnl_pct)}</div>
          <div class="fs-meta">
            <span class="fs-wr" style="color:${wrHex(r.winrate, r.sets)}">WIN ${wrTxt}</span>
            <span class="fs-sets">${r.sets} сетов</span>
          </div>
          <div class="fs-status ${st.cls}">${st.txt}</div>
        </div>`;
    }).join('');

    host.innerHTML = `
      <div class="fs-header">
        <div class="fs-title">Futures-стратегии</div>
        <div class="fs-sub">Бэктест индикатора 🟣 v.29.1 · 15m${state.demo ? ' · <span class="fs-demo">демо-данные</span>' : ''}</div>
      </div>
      <div class="fs-stats">
        <div class="fs-stat"><div class="fs-stat-val">${pairs}</div><div class="fs-stat-lbl">пар</div></div>
        <div class="fs-stat"><div class="fs-stat-val">${totalSets}</div><div class="fs-stat-lbl">сетов</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.green}">${inTrade}</div><div class="fs-stat-lbl">в сделке</div></div>
        <div class="fs-stat"><div class="fs-stat-val" style="color:${COL.yellow}">${waiting}</div><div class="fs-stat-lbl">ждут</div></div>
      </div>
      <div class="fs-sortbar">
        <span class="fs-sortlbl">Сортировка:</span>
        ${SORTS.map(s => `<button class="fs-sortpill ${state.sort === s.key ? 'active' : ''}" data-sort="${s.key}">${s.label}</button>`).join('')}
      </div>
      <div class="fs-grid">${cards}</div>
      ${state.demo ? `<div class="fs-hint">Это демо-набор для предпросмотра дизайна. Запусти <b>backtest_v29.py</b> и залей результат во вкладку <b>FUT_STRAT</b> — карточки заполнятся реальными цифрами.</div>` : ''}`;

    host.querySelectorAll('[data-sort]').forEach(b =>
      b.addEventListener('click', () => { state.sort = b.dataset.sort; render(host, state); }));
  }

  // ---- Публичный API -------------------------------------------------------
  const mounted = {};
  async function mount(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    if (mounted[containerId]) return;           // уже отрисовано (страница скрыта, не пересоздаём)
    mounted[containerId] = true;
    host.innerHTML = '<div class="fs-loading">Загрузка стратегий…</div>';
    const { rows, demo } = await fetchRows();
    render(host, { rows, demo, sort: 'pnl_pct' });
  }

  window.FutStrat = { mount };
})();
