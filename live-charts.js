/* =========================================================================
   live-charts.js  —  живые графики BTC/ETH с биржи (Binance + фолбэк Bybit)
   Рендер: TradingView Lightweight Charts v5 (панели: цена + осциллятор RSI).

   ВАЖНО про индикаторы:
   Сейчас на графике показаны СТАНДАРТНЫЕ демо-индикаторы (EMA 9/21 + RSI 14)
   как заглушка, пока раздел в разработке. Когда будут готовы твои формулы,
   их логику нужно переписать на JS и подставить вместо computeIndicators()
   ниже — вся остальная обвязка (данные, отрисовка, панели) останется той же.
   ========================================================================= */
(function () {
  'use strict';

  // ---- Конфиг символов и таймфреймов --------------------------------------
  const SYMBOLS = [
    { key: 'BTC', binance: 'BTCUSDT', bybit: 'BTCUSDT', label: 'BTC' },
    { key: 'ETH', binance: 'ETHUSDT', bybit: 'ETHUSDT', label: 'ETH' },
  ];
  // Binance interval -> Bybit interval (Bybit: минуты числом)
  const TFS = [
    { key: '4h',  binance: '4h',  bybit: '240', label: '4H'  },
    { key: '1h',  binance: '1h',  bybit: '60',  label: '1H'  },
    { key: '15m', binance: '15m', bybit: '15',  label: '15m' },
  ];
  const LIMIT = 300; // сколько свечей грузим

  // ---- Палитра (из styles.css) --------------------------------------------
  const C = {
    bg: 'transparent',
    text: '#7B84B0',
    grid: 'rgba(102,163,255,0.06)',
    up: '#4EFFA0', down: '#FF5272',
    ema9: '#66A3FF', ema21: '#9D50FF',
    rsi: '#FFD166', rsiLevel: 'rgba(123,132,176,0.4)',
    last: 'rgba(102,163,255,0.5)',
  };

  // ---- Хранилище инстансов (по id контейнера) -----------------------------
  const instances = {};

  // ---- Получение свечей: Binance -> Bybit ---------------------------------
  async function fetchKlines(sym, tf) {
    // 1) Binance
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym.binance}&interval=${tf.binance}&limit=${LIMIT}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('binance ' + r.status);
      const raw = await r.json();
      // [ openTimeMs, open, high, low, close, volume, ... ]
      return raw.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      }));
    } catch (e) {
      // 2) Bybit (фолбэк, если Binance недоступен по гео/CORS)
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym.bybit}&interval=${tf.bybit}&limit=${LIMIT}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('bybit ' + r.status);
      const j = await r.json();
      const list = (j.result && j.result.list) || [];
      // Bybit отдаёт newest-first -> разворачиваем
      return list.slice().reverse().map(k => ({
        time: Math.floor(+k[0] / 1000),
        open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      }));
    }
  }

  // ---- Индикаторы (ДЕМО — заменить на свои) --------------------------------
  function ema(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev;
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }
  function rsi(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL));
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      const rs = avgL === 0 ? 100 : avgG / avgL;
      out[i] = 100 - 100 / (1 + rs);
    }
    return out;
  }
  function computeIndicators(candles) {
    const closes = candles.map(c => c.close);
    const e9 = ema(closes, 9), e21 = ema(closes, 21), r = rsi(closes, 14);
    const line = (arr) => candles.map((c, i) => arr[i] == null ? null : { time: c.time, value: arr[i] })
      .filter(Boolean);
    return { ema9: line(e9), ema21: line(e21), rsi: line(r) };
  }

  // ---- Построение разметки тулбара ----------------------------------------
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
      <div class="lc-chart" data-role="chart"></div>
      <div class="lc-foot">
        <span class="lc-legend"><i style="background:${C.ema9}"></i>EMA 9</span>
        <span class="lc-legend"><i style="background:${C.ema21}"></i>EMA 21</span>
        <span class="lc-legend"><i style="background:${C.rsi}"></i>RSI 14</span>
        <span class="lc-note">демо-индикаторы · скоро заменим на ваши</span>
      </div>
      <div class="lc-overlay" data-role="overlay"></div>`;
    // навешиваем обработчики
    host.querySelectorAll('[data-sym]').forEach(b =>
      b.addEventListener('click', () => { st.sym = b.dataset.sym; syncPills(host, st); load(host, st); }));
    host.querySelectorAll('[data-tf]').forEach(b =>
      b.addEventListener('click', () => { st.tf = b.dataset.tf; syncPills(host, st); load(host, st); }));
  }
  function syncPills(host, st) {
    host.querySelectorAll('[data-sym]').forEach(b =>
      b.classList.toggle('active', b.dataset.sym === st.sym));
    host.querySelectorAll('[data-tf]').forEach(b =>
      b.classList.toggle('active', b.dataset.tf === st.tf));
  }

  // ---- Создание графика ----------------------------------------------------
  function createChart(host) {
    const LW = window.LightweightCharts;
    const el = host.querySelector('[data-role="chart"]');
    const chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: C.bg }, textColor: C.text,
        fontSize: 11, attributionLogo: true,
        panes: { separatorColor: C.grid, enableResize: false } },
      grid: { horzLines: { color: C.grid }, vertLines: { color: C.grid } },
      rightPriceScale: { borderColor: 'transparent' },
      timeScale: { borderColor: 'transparent', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LW.CrosshairMode ? LW.CrosshairMode.Normal : 0 },
      handleScale: { axisPressedMouseMove: false },
    });

    const candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderVisible: false,
      wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const ema9 = chart.addSeries(LW.LineSeries, { color: C.ema9, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const ema21 = chart.addSeries(LW.LineSeries, { color: C.ema21, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    // RSI — отдельная нижняя панель (paneIndex = 1)
    const rsiS = chart.addSeries(LW.LineSeries, { color: C.rsi, lineWidth: 1.5, priceLineVisible: false }, 1);
    rsiS.createPriceLine({ price: 70, color: C.rsiLevel, lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    rsiS.createPriceLine({ price: 30, color: C.rsiLevel, lineWidth: 1, lineStyle: 2, axisLabelVisible: true });
    try { chart.panes()[1].setHeight(110); } catch (e) {}

    return { chart, candle, ema9, ema21, rsi: rsiS };
  }

  // ---- Загрузка и отрисовка ------------------------------------------------
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
      const ind = computeIndicators(candles);

      st.s.candle.setData(candles);
      st.s.ema9.setData(ind.ema9);
      st.s.ema21.setData(ind.ema21);
      st.s.rsi.setData(ind.rsi);
      st.s.chart.timeScale().fitContent();

      const first = candles[0], lastC = candles[candles.length - 1];
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

  // ---- Публичный API: mount(containerId) -----------------------------------
  function mount(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;

    // повторный заход на страницу — просто обновляем данные
    if (instances[containerId]) {
      const st = instances[containerId];
      st.s.chart.timeScale().fitContent();
      load(host, st);
      return;
    }
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
