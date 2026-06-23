/* =========================================================================
   live-charts.js  —  рендерер свечного графика (TradingView Lightweight v5)
   + расчёт сигналов v.29.1 (для маркеров). Используется детальным экраном
   раздела Futures-стратегии.

   API:
     LiveChart.computeSignals(candles, tfMin)  -> массив маркеров BUY/SELL
     LiveChart.renderInto(el, { candles, markers, priceLines, precision, viewBars })
   ========================================================================= */
(function () {
  'use strict';

  const C = {
    bg: 'transparent', text: '#7B84B0', grid: 'rgba(102,163,255,0.06)',
    up: '#15C2A0', down: '#8B5CF6',
    buy: '#4EFFA0', sell: '#FF5272',
    lastLine: 'rgba(123,132,176,0.5)',
  };
  const IND = {
    len: 200, h: 8.0, multBuy: 3.0, multSell: 3.0,
    impulseOn: true, impulseThr: 1.0, impulseLb: 5,
    sweepOn: true, sweepBars: 20, checkMin: 10,
  };

  function sma(arr, period) {
    const out = new Array(arr.length).fill(null); let sum = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= period) sum -= arr[i - period]; if (i >= period - 1) out[i] = sum / period; }
    return out;
  }
  function rollLowest(v, p) { const o = new Array(v.length); for (let i = 0; i < v.length; i++) { let m = Infinity; for (let k = Math.max(0, i - p + 1); k <= i; k++) if (v[k] < m) m = v[k]; o[i] = m; } return o; }
  function rollHighest(v, p) { const o = new Array(v.length); for (let i = 0; i < v.length; i++) { let m = -Infinity; for (let k = Math.max(0, i - p + 1); k <= i; k++) if (v[k] > m) m = v[k]; o[i] = m; } return o; }

  function computeSignals(candles, tfMin) {
    const n = candles.length;
    const close = candles.map(c => c.close), high = candles.map(c => c.high), low = candles.map(c => c.low);
    const { len, h, multBuy, multSell } = IND;
    const coefs = []; let den = 0;
    for (let i = 0; i < len; i++) { const c = Math.exp(-(i * i) / (2 * h * h)); coefs.push(c); den += c; }
    const out = new Array(n).fill(null);
    for (let b = 0; b < n; b++) { const mx = Math.min(b, len - 1); let s = 0; for (let i = 0; i <= mx; i++) s += close[b - i] * coefs[i]; out[b] = den !== 0 ? s / den : null; }
    const absd = close.map((c, i) => Math.abs(c - out[i]));
    const mae = sma(absd, len);
    const upper = out.map((o, i) => (mae[i] == null ? null : o + mae[i] * multSell));
    const lower = out.map((o, i) => (mae[i] == null ? null : o - mae[i] * multBuy));
    const loL = rollLowest(low, IND.sweepBars), hiH = rollHighest(high, IND.sweepBars);
    const sweptLow = i => i >= IND.sweepBars && loL[i] < loL[i - IND.sweepBars];
    const sweptHigh = i => i >= IND.sweepBars && hiH[i] > hiH[i - IND.sweepBars];
    const btc = Math.max(1, Math.round(IND.checkMin / tfMin));
    const markers = []; let lastL = -1e9, lastS = -1e9;
    for (let i = 1; i < n; i++) {
      if (upper[i] == null || lower[i] == null || upper[i - 1] == null || lower[i - 1] == null) continue;
      const cu = close[i] < lower[i] && close[i - 1] >= lower[i - 1];
      const co = close[i] > upper[i] && close[i - 1] <= upper[i - 1];
      let cL = true, cS = true;
      if (IND.impulseOn && i >= IND.impulseLb) {
        const base = close[i - IND.impulseLb];
        if (Math.abs((close[i] - base) / base) * 100 >= IND.impulseThr) { cL = close[i] <= base; cS = close[i] >= base; }
      }
      const okL = !IND.sweepOn || sweptLow(i), okS = !IND.sweepOn || sweptHigh(i);
      if (cu && cL && okL && (i - lastL) >= btc) { lastL = i; markers.push({ time: candles[i].time, position: 'belowBar', color: C.buy, shape: 'arrowUp', size: 1 }); }
      if (co && cS && okS && (i - lastS) >= btc) { lastS = i; markers.push({ time: candles[i].time, position: 'aboveBar', color: C.sell, shape: 'arrowDown', size: 1 }); }
    }
    markers.sort((a, b) => a.time - b.time);
    return markers;
  }

  function renderInto(el, opts) {
    const LW = window.LightweightCharts;
    if (!LW) { el.innerHTML = '<div style="color:#7B84B0;text-align:center;padding:30px;font-size:13px">График недоступен — библиотека не загрузилась</div>'; return null; }
    if (el.__lc) { try { el.__lc.remove(); } catch (e) {} el.__lc = null; }
    el.innerHTML = '';
    const chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: true },
      grid: { horzLines: { color: C.grid }, vertLines: { color: C.grid } },
      rightPriceScale: { borderColor: 'transparent' },
      timeScale: { borderColor: 'transparent', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LW.CrosshairMode ? LW.CrosshairMode.Normal : 0 },
    });
    const prec = opts.precision || { precision: 2, minMove: 0.01 };
    const candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
      priceFormat: { type: 'price', precision: prec.precision, minMove: prec.minMove },
      priceLineColor: C.lastLine, priceLineStyle: 1,
    });
    candle.setData(opts.candles || []);
    (opts.priceLines || []).forEach(pl => candle.createPriceLine({
      price: pl.price, color: pl.color || C.text, lineWidth: pl.width || 1,
      lineStyle: pl.style == null ? 2 : pl.style, axisLabelVisible: true, title: pl.title || '',
    }));
    try { if (LW.createSeriesMarkers) LW.createSeriesMarkers(candle, opts.markers || []); else if (candle.setMarkers) candle.setMarkers(opts.markers || []); } catch (e) {}
    const n = (opts.candles || []).length, view = opts.viewBars || 200;
    if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - view), to: n + 3 });
    el.__lc = chart;
    return chart;
  }

  window.LiveChart = { computeSignals, renderInto, colors: C };
})();
