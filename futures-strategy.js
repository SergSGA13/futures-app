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

  // ---- Свечи фьючерсов (fapi -> bybit) ------------------------------------
  async function fetchFutKlines(symbol, interval, limit) {
    try {
      const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const r = await fetch(u); if (!r.ok) throw new Error('fapi');
      const raw = await r.json();
      return raw.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    } catch (e) {
      const bi = interval === '4h' ? '240' : interval === '1h' ? '60' : '15';
      const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bi}&limit=${limit}`;
      const r = await fetch(u); if (!r.ok) throw new Error('klines');
      const j = await r.json(); const list = (j.result && j.result.list) || [];
      return list.slice().reverse().map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    }
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
  async function openDetail(host, S, symbol) {
    const row = S.rows.find(r => r.symbol === symbol);
    if (!row) return;
    const sym = symbol.replace(/USDT$/, '');
    const fav = favHas(symbol);
    const st = statusInfo(row);
    const wrTxt = row.winrate == null ? '-' : (row.sets < MIN_SETS ? '~' + Math.round(row.winrate) : Math.round(row.winrate)) + '%';

    // чипы истории сетов: реальные номера, новейшие слева, текущая позиция первой
    const allSets = row.sets_pct || [];
    const recent = allSets.map((s, i) => ({ n: i + 1, s })).slice(-12).reverse();
    const chips = recent.map(({ n, s }) => {
      const win = s >= 0;
      return `<div class="fd-chip ${win ? 'win' : 'loss'}"><div class="fd-chip-n">#${n} ${win ? 'WIN' : 'LOSS'}</div><div class="fd-chip-v">${fmtPct(s)}</div></div>`;
    }).join('');
    const isOpen = (row.pos_side === 'long' || row.pos_side === 'short');
    const openChip = isOpen
      ? `<div class="fd-chip open"><div class="fd-chip-n">СЕЙЧАС ${row.pos_side === 'long' ? '▲ LONG' : '▼ SHORT'}</div><div class="fd-chip-v">×${row.pos_lots}</div></div>` : '';

    host.innerHTML = `
      <div class="fd-bar">
        <button class="fd-back" data-back>←</button>
        <span class="fd-sym">${sym}<span class="fd-tf">${row.tf}</span></span>
        <button class="fs-fav ${fav ? 'on' : ''}" data-fav="${symbol}" style="position:static">${fav ? '★' : '☆'}</button>
      </div>
      <div class="fd-stats">
        <div class="fd-stat"><div class="fd-stat-val">${row.sets}</div><div class="fd-stat-lbl">сетов</div></div>
        <div class="fd-stat"><div class="fd-stat-val" style="color:${wrHex(row.winrate, row.sets)}">${wrTxt}</div><div class="fd-stat-lbl">win rate</div></div>
        <div class="fd-stat"><div class="fd-stat-val" style="color:${pnlHex(row.pnl_pct)}">${fmtPct(row.pnl_pct)}</div><div class="fd-stat-lbl">pnl</div></div>
      </div>
      <div class="fd-pos ${st.cls}">${st.txt}${row.pos_avg ? ` · средняя ${row.pos_avg}` : ''}</div>
      <div class="fd-chips">${openChip}${chips}${(!chips && !openChip) ? '<span class="fs-sets">нет завершённых сетов</span>' : ''}</div>
      <div class="fd-chartwrap"><div class="fd-chart" id="fdChart"></div><div class="fd-overlay" id="fdOverlay">Загрузка графика…</div></div>
      <div class="fd-legend"><span><i style="background:${COL.green}"></i>BUY</span><span><i style="background:${COL.red}"></i>SELL</span><span class="fd-note">линии - набранные входы и средняя</span></div>
      <div class="fs-hint">Модель v.29.1: вход 10% депо на сигнал, усреднение в ту же сторону, обратный сигнал закрывает все доли и открывает реверс на 10%. Уровни на графике - фактические заливки усреднения (TP/STOP в этой модели нет).</div>`;

    host.querySelector('[data-back]').addEventListener('click', () => renderList(host, S));
    host.querySelector('[data-fav]').addEventListener('click', e => { e.stopPropagation(); const on = favToggle(symbol); e.currentTarget.classList.toggle('on', on); e.currentTarget.textContent = on ? '★' : '☆'; });

    // график
    try {
      const candles = await fetchFutKlines(symbol, '15m', 1000);
      if (!candles.length) throw new Error('empty');
      const markers = window.LiveChart ? LiveChart.computeSignals(candles, 15) : [];
      const last = candles[candles.length - 1].close;
      const prec = precisionFor(last);
      // линии набранных позиций (из бэктеста) + средняя
      const lines = [];
      if (row.pos_side === 'long' || row.pos_side === 'short') {
        const col = row.pos_side === 'long' ? COL.green : COL.purple;
        (row.lot_entries || []).forEach((p, i) => lines.push({ price: p, color: 'rgba(102,163,255,0.55)', title: 'вход ' + (i + 1), style: 2 }));
        if (row.pos_avg) lines.push({ price: row.pos_avg, color: col, title: 'средняя', width: 2, style: 0 });
      }
      const el = host.querySelector('#fdChart');
      if (window.LiveChart) LiveChart.renderInto(el, { candles, markers, priceLines: lines, precision: prec, viewBars: 140 });
      const ov = host.querySelector('#fdOverlay'); if (ov) ov.remove();
    } catch (err) {
      const ov = host.querySelector('#fdOverlay');
      if (ov) { ov.className = 'fd-overlay err'; ov.innerHTML = 'Не удалось загрузить график.<br><button class="lc-retry" data-retry>Повторить</button>'; ov.querySelector('[data-retry]').addEventListener('click', () => openDetail(host, S, symbol)); }
    }
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

  window.FutStrat = { mount };
})();
