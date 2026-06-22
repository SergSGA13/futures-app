/* =========================================================================
   live-charts.js  —  живые графики BTC/ETH с биржи (Binance + фолбэк Bybit)
   Рендер: TradingView Lightweight Charts v5.

   На графике: свечи (бирюза/фиолет) + сигналы BUY/SELL индикатора v.29.1.
   Канал Гаусса считается ВНУТРИ (нужен для сигналов), но НЕ рисуется.
   Market Oscillator отключён.
   ========================================================================= */
(function () {
  'use strict';

  // ---- Конфиг символов и таймфреймов --------------------------------------
  const SYMBOLS = [
    { key: 'BTC', binance: 'BTCUSDT', bybit: 'BTCUSDT', label: 'BTC' },
    { key: 'ETH', binance: 'ETHUSDT', bybit: 'ETHUSDT', label: 'ETH' },
  ];
  const TFS = [
    { key: '4h',  binance: '4h',  bybit: '240', label: '4H',  min: 240 },
    { key: '1h',  binance: '1h',  bybit: '60',  label: '1H',  min: 60  },
    { key: '15m', binance: '15m', bybit: '15',  label: '15m', min: 15  },
  ];
  const LIMIT = 1000;   // свечей за запрос (максимум Binance/Bybit)
  const VIEW  = 350;    // сколько свечей показываем по умолчанию (история; крутится скроллом)

  // ---- Параметры сигналов (дефолты Pine v.29.1) ---------------------------
  const IND = {
    len: 200, h: 8.0, multBuy: 3.0, multSell: 3.0,
    impulseOn: true, impulseThr: 1.0, impulseLb: 5,
    sweepOn: true, sweepBars: 20,
    checkMin: 10,
  };

  // ---- Палитра ------------------------------------------------------------
  // Цвета свечей — как на скрине. Меняются здесь:
  const C = {
    bg: 'transparent', text: '#7B84B0', grid: 'rgba(102,163,255,0.06)',
    up: '#15C2A0',     // бычья свеча — бирюзовый
    down: '#8B5CF6',   // медвежья свеча — фиолетовый
    buy: '#4EFFA0', sell: '#FF5272',   // треугольники сигналов
    lastLine: 'rgba(123,132,176,0.5)',
  };

  const instances = {};

  // ---- Получение свечей: Binance -> Bybit ---------------------------------
  async function fetchKlines(sym, tf) {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym.binance}&interval=${tf.binance}&limit=${LIMIT}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('binance ' + r.status);
      const raw = await r.json();
      return raw.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    } catch (e) {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym.bybit}&interval=${tf.bybit}&limit=${LIMIT}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('bybit ' + r.status);
      const j = await r.json();
      const list = (j.result && j.result.list) || [];
      return list.slice().reverse().map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    }
  }

  // ---- Утилиты -------------------------------------------------------------
  function sma(arr, period) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= period) sum -= arr[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function rollLowest(vals, period) {
    const out = new Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
      let m = Infinity;
      for (let k = Math.max(0, i - period + 1); k <= i; k++) if (vals[k] < m) m = vals[k];
      out[i] = m;
    }
    return out;
  }
  function rollHighest(vals, period) {
    const out = new Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
      let m = -Infinity;
      for (let k = Math.max(0, i - period + 1); k <= i; k++) if (vals[k] > m) m = vals[k];
      out[i] = m;
    }
    return out;
  }

  // ---- Сигналы BUY/SELL (v.29.1, без отрисовки канала) --------------------
  function computeSignals(candles, tfMin) {
    const n = candles.length;
    const close = candles.map(c => c.close);
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);

    // Гауссов канал (внутренний расчёт)
    const { len, h, multBuy, multSell } = IND;
    const coefs = []; let den = 0;
    for (let i = 0; i < len; i++) { const c = Math.exp(-(i * i) / (2 * h * h)); coefs.push(c); den += c; }
    const out = new Array(n).fill(null);
    for (let b = 0; b < n; b++) {
      const maxI = Math.min(b, len - 1);
      let s = 0;
      for (let i = 0; i <= maxI; i++) s += close[b - i] * coefs[i];
      out[b] = den !== 0 ? s / den : null;
    }
    const absd = close.map((c, i) => Math.abs(c - out[i]));
    const mae = sma(absd, len);
    const upper = out.map((o, i) => (mae[i] == null ? null : o + mae[i] * multSell));
    const lower = out.map((o, i) => (mae[i] == null ? null : o - mae[i] * multBuy));

    // Фильтр Liquidity Sweep
    const loLowest = rollLowest(low, IND.sweepBars);
    const hiHighest = rollHighest(high, IND.sweepBars);
    const sweptLow = i => i >= IND.sweepBars && loLowest[i] < loLowest[i - IND.sweepBars];
    const sweptHigh = i => i >= IND.sweepBars && hiHighest[i] > hiHighest[i - IND.sweepBars];

    const barsToCheck = Math.max(1, Math.round(IND.checkMin / tfMin));
    const markers = [];
    let lastLong = -1e9, lastShort = -1e9;
    for (let i = 1; i < n; i++) {
      if (upper[i] == null || lower[i] == null || upper[i - 1] == null || lower[i - 1] == null) continue;
      const crossUnder = close[i] < lower[i] && close[i - 1] >= lower[i - 1];
      const crossOver = close[i] > upper[i] && close[i - 1] <= upper[i - 1];

      let canLong = true, canShort = true;
      if (IND.impulseOn && i >= IND.impulseLb) {
        const base = close[i - IND.impulseLb];
        const delta = Math.abs((close[i] - base) / base) * 100;
        if (delta >= IND.impulseThr) { canLong = close[i] <= base; canShort = close[i] >= base; }
      }
      const sweepOkLong = !IND.sweepOn || sweptLow(i);
      const sweepOkShort = !IND.sweepOn || sweptHigh(i);

      if (crossUnder && canLong && sweepOkLong && (i - lastLong) >= barsToCheck) {
        lastLong = i;
        markers.push({ time: candles[i].time, position: 'belowBar', color: C.buy, shape: 'arrowUp', size: 1 });
      }
      if (crossOver && canShort && sweepOkShort && (i - lastShort) >= barsToCheck) {
        lastShort = i;
        markers.push({ time: candles[i].time, position: 'aboveBar', color: C.sell, shape: 'arrowDown', size: 1 });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    return markers;
  }

  // ---- Разметка ------------------------------------------------------------
  function buildShell(host, st) {
    host.innerHTML = `
      <div class="lc-head">
        <div class="lc-pills" data-role="symbols">
          ${SYMBOLS.map(s => `<button class="lc-pill" data-sym="${s.key}">${s.label}</button>`).join('')}
        </div>
        <div class="lc-status" data-role="status"><span class="lc-dot"></span><span data-role="status-text">…</span></div>
        <div class="lc-pills" data-role="tfs">
          ${TFS.map(t => `<button class="lc-pill" data-tf="${t.key}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="lc-chartwrap">
        <div class="lc-chart" data-role="chart"></div>
        <div class="lc-overlay" data-role="overlay"></div>
      </div>
      <div class="lc-foot">
        <span class="lc-legend"><i style="background:${C.buy}"></i>BUY</span>
        <span class="lc-legend"><i style="background:${C.sell}"></i>SELL</span>
        <span class="lc-note">🟣 v.29.1 · сигналы</span>
      </div>`;
    host.querySelectorAll('[data-sym]').forEach(b =>
      b.addEventListener('click', () => { st.sym = b.dataset.sym; syncPills(host, st); load(host, st); }));
    host.querySelectorAll('[data-tf]').forEach(b =>
      b.addEventListener('click', () => { st.tf = b.dataset.tf; syncPills(host, st); load(host, st); }));
  }
  function syncPills(host, st) {
    host.querySelectorAll('[data-sym]').forEach(b => b.classList.toggle('active', b.dataset.sym === st.sym));
    host.querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('active', b.dataset.tf === st.tf));
  }

  // ---- График --------------------------------------------------------------
  function createChart(host) {
    const LW = window.LightweightCharts;
    const el = host.querySelector('[data-role="chart"]');
    const chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: true },
      grid: { horzLines: { color: C.grid }, vertLines: { color: C.grid } },
      rightPriceScale: { borderColor: 'transparent' },
      timeScale: { borderColor: 'transparent', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LW.CrosshairMode ? LW.CrosshairMode.Normal : 0 },
    });

    const candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderVisible: false,
      wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      priceLineColor: C.lastLine, priceLineStyle: 1,   // пунктирная линия последней цены
    });

    let markers = null;
    try { if (LW.createSeriesMarkers) markers = LW.createSeriesMarkers(candle, []); } catch (e) {}

    return { chart, candle, markers };
  }

  function setMarkers(s, data) {
    try {
      if (s.markers && s.markers.setMarkers) s.markers.setMarkers(data);
      else if (window.LightweightCharts.createSeriesMarkers) s.markers = window.LightweightCharts.createSeriesMarkers(s.candle, data);
      else if (s.candle.setMarkers) s.candle.setMarkers(data);
    } catch (e) { console.warn('markers', e); }
  }

  // ---- Загрузка ------------------------------------------------------------
  async function load(host, st) {
    const overlay = host.querySelector('[data-role="overlay"]');
    const statusT = host.querySelector('[data-role="status-text"]');
    const dot = host.querySelector('.lc-dot');
    const sym = SYMBOLS.find(s => s.key === st.sym);
    const tf = TFS.find(t => t.key === st.tf);

    overlay.className = 'lc-overlay loading';
    overlay.textContent = 'Загрузка…';
    if (dot) dot.style.background = C.text;

    try {
      const candles = await fetchKlines(sym, tf);
      if (!candles.length) throw new Error('empty');
      const markers = computeSignals(candles, tf.min);

      st.s.candle.setData(candles);
      setMarkers(st.s, markers);

      const nn = candles.length;
      const fromIdx = Math.max(0, nn - VIEW);
      st.s.chart.timeScale().setVisibleLogicalRange({ from: fromIdx, to: nn + 3 });

      const first = candles[fromIdx], lastC = candles[nn - 1];
      const chg = ((lastC.close - first.open) / first.open) * 100;
      const sign = chg >= 0 ? '+' : '';
      statusT.innerHTML = `${sym.label}/USDT · <b>${lastC.close.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b> ` +
        `<span style="color:${chg >= 0 ? C.up : C.down}">${sign}${chg.toFixed(2)}%</span>`;
      if (dot) dot.style.background = C.up;
      overlay.className = 'lc-overlay';
      overlay.textContent = '';
    } catch (err) {
      if (dot) dot.style.background = C.down;
      statusT.textContent = sym.label + '/USDT';
      overlay.className = 'lc-overlay error';
      overlay.innerHTML = `Не удалось получить данные с биржи.<br><button class="lc-retry">Повторить</button>`;
      overlay.querySelector('.lc-retry').addEventListener('click', () => load(host, st));
    }
  }

  // ---- Публичный API -------------------------------------------------------
  function mount(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    if (instances[containerId]) { load(host, instances[containerId]); return; }
    if (!window.LightweightCharts) {
      host.innerHTML = '<div class="lc-overlay error" style="position:static">Библиотека графиков не загрузилась. Проверьте подключение.</div>';
      return;
    }
    const st = { sym: 'BTC', tf: '4h', s: null };
    buildShell(host, st);
    st.s = createChart(host);
    instances[containerId] = st;
    syncPills(host, st);
    load(host, st);
  }

  window.LiveChart = { mount };
})();
