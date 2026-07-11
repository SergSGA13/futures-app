#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backtest_v29.py — бэктест индикатора v.29.1 для фьючерсной стратегии.

Что делает:
  1. Берёт топ-N перпетуалов Binance Futures по 24h-объёму (USDT-margined).
  2. Тянет 15m историю за N дней.
  3. Считает сигналы v.29.1 (логика 1:1 с live-charts.js → маркеры совпадут).
  4. Симулирует позиции по модели:
       • вход = 25% депозита на сигнал, депозит на монету = $100
       • сигнал в ту же сторону = усреднение (+25%), максимум 10 долей
       • противоположный сигнал = закрыть всё (зафиксировать PNL) + открыть новый лот
       • РЕИНВЕСТ (компаундинг): размер лота = 10% от текущего equity
       • комиссия 0.08% за сторону (taker), плечо 1x
       • открытая позиция в конце = доводится по последней цене (unrealized),
         входит в PNL, но НЕ в WIN% (только закрытые сеты)
  5. Пишет результат в fut_strat.csv (вставить во вкладку FUT_STRAT Google Sheets,
     либо включить запись через gspread — см. низ файла).
  6. Портфельная модель (боевой стандарт API): один общий депозит на все монеты,
     1 сигнал = port_risk_pct% (0.25%) от ТЕКУЩЕГО эквити (компаундинг), плечо 1x.
     Использует те же сделки, что per-coin движок (значит правила пресета соблюдены),
     исключает монеты с PNL ниже delist_pct% (делистинг). Пишет дневную кривую эквити
     в <out>_portfolio.csv (вкладка <TAB>_PF).

Запуск:  python3 backtest_v29.py
Зависимости:  pip install numpy requests
"""

import csv, time, sys, json, datetime as dt
from copy import deepcopy
import numpy as np

try:
    import requests
except ImportError:
    requests = None

# ════════════════════════════════ КОНФИГ ════════════════════════════════
CFG = dict(
    top_n=300,                # сколько пар брать из топа по объёму (если symbols пуст)
    symbols=[],              # СВОЙ список монет: напр. ["SOL","ENA","BTCUSDT"]. Пусто = авто-топ.
    interval="15m",
    tf_min=15,
    history_days=90,         # глубина истории
    capital=300.0,           # депозит на монету, $
    lot_frac=0.25,           # доля депозита на 1 сигнал (25%)
    reinvest=True,           # компаундинг: лот = 25% от ТЕКУЩЕГО equity
    fee_per_side=0.0008,     # 0.08% за сторону
    leverage=1.0,
    max_lots=10,             # потолок усреднения (10 долей = 100% депо)
    write_min_sets=0,        # не писать пары с числом сетов меньше этого (0 = писать все)
    # ── портфельная модель (один общий депозит на все монеты, как при API) ─
    portfolio_deposit=1000.0,  # общий депозит, $
    port_risk_pct=0.25,         # % депозита на 1 сигнал (на 1 лот). Стандарт = 0.25%
    delist_pct=-5.0,            # делистинг: монета с PNL за период ниже этого % исключается
    # ── переключаемые правила риска (0 / False = выключено) ──────────────
    stop_loss_pct=0.0,       # стоп: закрыть сделку, если её убыток достиг X% депо (напр. 5.0)
    take_profit_pct=0.0,     # тейк: закрыть сделку при прибыли X% депо (напр. 8.0)
    use_trend_filter=False,  # фильтр тренда: лонг только выше EMA, шорт только ниже
    trend_len=200,           # длина EMA для фильтра тренда
    # ── режим честности: убирает известные приукрашивания бэктеста ────────
    honest_fills=False,      # исполнение по open СЛЕДУЮЩЕЙ свечи (сигнал виден только по закрытию)
    slippage_pct=0.0,        # проскальзывание, % за сторону, всегда против нас (напр. 0.05)
    funding=False,           # учитывать funding перпетуалов (long платит при ставке > 0)
    rolling_delist=False,    # делистинг скользящим правилом (без знания будущего PNL)
    rank_at_start=False,     # топ-N по объёму на НАЧАЛО периода (без ошибки выжившего)
)

# Параметры сигналов v.29.1 (дефолты Pine — те же, что в live-charts.js)
IND = dict(
    len=200, h=8.0, mult_buy=3.0, mult_sell=3.0,
    impulse_on=True, impulse_thr=1.0, impulse_lb=5,
    sweep_on=True, sweep_bars=20,
    check_min=10,
)

BINANCE_FAPI = "https://fapi.binance.com"

# ════════════════════════════ СИГНАЛЫ v.29.1 ════════════════════════════
def _rolling_mean(a, w):
    c = np.cumsum(np.insert(a, 0, 0.0))
    out = np.full(len(a), np.nan)
    if len(a) >= w:
        out[w - 1:] = (c[w:] - c[:-w]) / w
    return out

def _rolling_lowest(a, w):
    out = np.full(len(a), np.nan)
    n = len(a)
    if n >= w:
        from numpy.lib.stride_tricks import sliding_window_view
        out[w - 1:] = sliding_window_view(a, w).min(axis=1)
    for i in range(min(w - 1, n)):
        out[i] = a[:i + 1].min()
    return out

def _rolling_highest(a, w):
    out = np.full(len(a), np.nan)
    n = len(a)
    if n >= w:
        from numpy.lib.stride_tricks import sliding_window_view
        out[w - 1:] = sliding_window_view(a, w).max(axis=1)
    for i in range(min(w - 1, n)):
        out[i] = a[:i + 1].max()
    return out

def compute_signals(close, high, low, tf_min):
    """Возвращает список (index, 'long'|'short') — порт computeSignals() из JS."""
    n = len(close)
    P = IND
    # гауссов канал
    idx = np.arange(P["len"])
    coefs = np.exp(-(idx ** 2) / (2 * P["h"] * P["h"]))
    den = coefs.sum()
    num = np.convolve(close, coefs)[:n]          # = sum close[b-i]*coefs[i]
    out = num / den if den != 0 else np.full(n, np.nan)
    mae = _rolling_mean(np.abs(close - out), P["len"])
    upper = out + mae * P["mult_sell"]
    lower = out - mae * P["mult_buy"]

    lo_lowest = _rolling_lowest(low, P["sweep_bars"])
    hi_highest = _rolling_highest(high, P["sweep_bars"])

    bars_to_check = max(1, round(P["check_min"] / tf_min))
    signals = []
    last_long = last_short = -10 ** 9
    sb = P["sweep_bars"]
    lb = P["impulse_lb"]
    for i in range(1, n):
        if np.isnan(upper[i]) or np.isnan(lower[i]) or np.isnan(upper[i - 1]) or np.isnan(lower[i - 1]):
            continue
        cross_under = close[i] < lower[i] and close[i - 1] >= lower[i - 1]
        cross_over = close[i] > upper[i] and close[i - 1] <= upper[i - 1]

        can_long = can_short = True
        if P["impulse_on"] and i >= lb:
            base = close[i - lb]
            delta = abs((close[i] - base) / base) * 100.0
            if delta >= P["impulse_thr"]:
                can_long = close[i] <= base
                can_short = close[i] >= base

        swept_low = i >= sb and lo_lowest[i] < lo_lowest[i - sb]
        swept_high = i >= sb and hi_highest[i] > hi_highest[i - sb]
        sweep_ok_long = (not P["sweep_on"]) or swept_low
        sweep_ok_short = (not P["sweep_on"]) or swept_high

        if cross_under and can_long and sweep_ok_long and (i - last_long) >= bars_to_check:
            last_long = i
            signals.append((i, "long"))
        if cross_over and can_short and sweep_ok_short and (i - last_short) >= bars_to_check:
            last_short = i
            signals.append((i, "short"))
    signals.sort(key=lambda s: s[0])
    return signals

# ═══════════════════════════ СИМУЛЯЦИЯ ПОЗИЦИЙ ═══════════════════════════
def _ema(arr, length):
    a = np.asarray(arr, dtype=float)
    out = np.empty_like(a)
    k = 2.0 / (length + 1.0)
    out[0] = a[0]
    for i in range(1, len(a)):
        out[i] = a[i] * k + out[i - 1] * (1.0 - k)
    return out


def simulate(close, signals, cfg, times=None, opens=None, funding=None):
    eq = cfg["capital"]; fee = cfg["fee_per_side"]; lev = cfg["leverage"]; cap = cfg["max_lots"]
    sl = cfg.get("stop_loss_pct", 0.0) or 0.0
    tp = cfg.get("take_profit_pct", 0.0) or 0.0
    use_trend = bool(cfg.get("use_trend_filter"))
    trend = _ema(close, int(cfg.get("trend_len", 200))) if use_trend else None

    # ── режим честности ──────────────────────────────────────────────────
    honest = bool(cfg.get("honest_fills")) and opens is not None
    slip = (cfg.get("slippage_pct", 0.0) or 0.0) / 100.0

    def adj(price, side, entering):
        """Проскальзывание всегда против нас: покупаем дороже, продаём дешевле."""
        if not slip:
            return price
        buying = (side == "long") == entering       # вход в лонг / выход из шорта = покупка
        return price * (1 + slip) if buying else price * (1 - slip)

    # funding: [(ts_ms, rate)] → индекс свечи, на которой начисляется
    fund_by_bar = {}
    fund_paid = 0.0
    if funding and times is not None and cfg.get("funding"):
        tarr = np.asarray(times)
        for ts_ms, rate in funding:
            b = int(np.searchsorted(tarr, ts_ms // 1000, side="right")) - 1
            if 0 <= b < len(tarr):
                fund_by_bar.setdefault(b, []).append(rate)

    pos = None; set_pnl = 0.0; eq_open = eq
    sets_pct = []; sets_ts = []
    sets_detail = []; cur_trade = None   # детали сделок для портфельной симуляции
    peak_eq = eq; max_dd = 0.0
    sig = {}
    for (i, side) in signals:
        # честный режим: сигнал виден только по закрытию свечи i,
        # исполнение - на открытии свечи i+1 (сигнал на последней свече пропадает)
        j = i + 1 if honest else i
        if j < len(close):
            sig[j] = side
    n = len(close)

    def exec_price(bar):
        return opens[bar] if honest else close[bar]

    def lot_notional():
        base = eq if cfg["reinvest"] else cfg["capital"]
        return cfg["lot_frac"] * base * lev

    def open_pos(side, raw_price, t=None):
        nonlocal eq, set_pnl, pos, eq_open, cur_trade
        price = adj(raw_price, side, entering=True)
        eq_open = eq
        note = lot_notional(); qty = note / price
        eq -= note * fee; set_pnl = -note * fee
        pos = {"side": side, "lots": [(price, qty)]}
        cur_trade = {"side": side, "entries": [(float(price), int(t) if t is not None else 0)], "exit": None}

    def cur_set_pct(price):
        if not pos or not eq_open:
            return 0.0
        g = 0.0
        for (p, q) in pos["lots"]:
            g += q * (price - p) if pos["side"] == "long" else q * (p - price)
        return (set_pnl + g) / eq_open * 100.0

    def close_pos(raw_price, t):
        nonlocal eq, set_pnl, pos, peak_eq, max_dd, cur_trade
        price = adj(raw_price, pos["side"], entering=False)
        realized = 0.0; close_note = 0.0
        for (p, q) in pos["lots"]:
            realized += q * (price - p) if pos["side"] == "long" else q * (p - price)
            close_note += q * price
        cfee = close_note * fee
        eq += realized - cfee; set_pnl += realized - cfee
        sets_pct.append(set_pnl / eq_open * 100.0 if eq_open else 0.0)
        sets_ts.append(int(t) if t is not None else 0)
        if cur_trade is not None:
            cur_trade["exit"] = (float(price), int(t) if t is not None else 0)
            sets_detail.append(cur_trade); cur_trade = None
        if eq > peak_eq:
            peak_eq = eq
        if peak_eq > 0:
            dd = (peak_eq - eq) / peak_eq * 100.0
            if dd > max_dd:
                max_dd = dd
        pos = None

    for i in range(n):
        price = close[i]
        t_i = times[i] if times is not None else None
        # funding: начисляется на открытую позицию (long платит при ставке > 0)
        if pos is not None and i in fund_by_bar:
            notional = sum(q * price for (_p, q) in pos["lots"])
            for rate in fund_by_bar[i]:
                cost = notional * rate if pos["side"] == "long" else -notional * rate
                eq -= cost; set_pnl -= cost; fund_paid += cost
        # интрабар стоп/тейк по текущему результату сделки
        if pos is not None and (sl or tp):
            c = cur_set_pct(price)
            if sl and c <= -sl:
                close_pos(price, t_i); continue
            if tp and c >= tp:
                close_pos(price, t_i); continue
        side = sig.get(i)
        if side is None:
            continue
        px = exec_price(i)   # честный режим: open этой свечи (сигнал был на прошлой)
        # фильтр тренда: вход только по сторонам EMA
        if use_trend:
            ok = (price > trend[i]) if side == "long" else (price < trend[i])
            if not ok:
                if pos is not None and pos["side"] != side:
                    close_pos(px, t_i)   # против тренда новый вход не открываем, но разворотом фиксируем
                continue
        if pos is None:
            open_pos(side, px, t_i)
        elif pos["side"] == side:
            if len(pos["lots"]) < cap:                       # усреднение
                apx = adj(px, side, entering=True)
                note = lot_notional(); qty = note / apx
                eq -= note * fee; set_pnl -= note * fee
                pos["lots"].append((apx, qty))
                if cur_trade is not None:
                    cur_trade["entries"].append((float(apx), int(t_i) if t_i is not None else 0))
        else:
            close_pos(px, t_i)                            # переворот
            open_pos(side, px, t_i)

    # незакрытая позиция → unrealized + детали
    unreal = 0.0
    pos_side = "—"; pos_lots = 0; pos_avg = 0.0; lot_entries = []
    if pos is not None:
        last = adj(close[-1], pos["side"], entering=False)   # доводка с учётом проскальзывания
        tot_qty = tot_cost = 0.0
        for (p, q) in pos["lots"]:
            unreal += q * (last - p) if pos["side"] == "long" else q * (p - last)
            tot_qty += q; tot_cost += p * q; lot_entries.append(round(p, 6))
        pos_side = pos["side"]; pos_lots = len(pos["lots"])
        pos_avg = round(tot_cost / tot_qty, 6) if tot_qty else 0.0
        if cur_trade is not None:                 # открытая сделка остаётся без exit (MTM в портфеле)
            sets_detail.append(cur_trade); cur_trade = None

    wins = sum(1 for s in sets_pct if s > 0)
    losses = sum(1 for s in sets_pct if s < 0)
    closed = wins + losses
    winrate = (wins / closed * 100.0) if closed > 0 else None
    total_eq = eq + unreal
    expectancy = (sum(sets_pct) / len(sets_pct)) if sets_pct else 0.0
    return dict(
        signals=len(signals), sets=len(sets_pct), wins=wins, losses=losses,
        winrate=winrate,
        pnl_pct=(total_eq - cfg["capital"]) / cfg["capital"] * 100.0,
        realized_pct=(eq - cfg["capital"]) / cfg["capital"] * 100.0,
        unreal_pct=unreal / cfg["capital"] * 100.0,
        pos_side=pos_side, pos_lots=pos_lots, pos_avg=pos_avg,
        lot_entries=lot_entries, sets_pct=[round(s, 2) for s in sets_pct],
        sets_tpnl=[[int(t), round(p, 2)] for t, p in zip(sets_ts, sets_pct)],
        last_side=(signals[-1][1] if signals else "—"),
        max_dd=round(max_dd, 2), expectancy=round(expectancy, 3),
        sets_detail=sets_detail,
        funding_pct=round(fund_paid / cfg["capital"] * 100.0, 3),
    )

# ═══════════════════════════════ BINANCE ════════════════════════════════
# Кэш на процесс: --preset all гоняет три пресета по одним и тем же свечам,
# кэш экономит ~2/3 запросов к Binance и выравнивает данные между пресетами.
_TOP_CACHE = {}
_KLINE_CACHE = {}

# ─────── Архив data.binance.vision: fallback при гео-блокировке fapi ────────
# US-хостинги (например, раннеры GitHub Actions) получают от fapi.binance.com
# HTTP 451. Официальный архив исторических данных Binance доступен отовсюду и
# содержит те же 15m свечи USDT-M фьючерсов с лагом ~1 день: полные прошедшие
# месяцы - помесячные zip, текущий месяц - подневные zip. Переключение
# происходит автоматически при первом 451/403 от fapi; с домашнего ПК
# всё работает по живому API, как раньше.
VISION_BASES = [
    "https://data.binance.vision",
    "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision",
]
VISION_S3_LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
_VISION_BASE = None      # выбранное рабочее зеркало
_USE_VISION = False      # переключились ли с fapi на архив
_VISION_SYMBOLS = None   # символы, по которым в архиве есть свечи

def _vision_get(path, attempts=4):
    """GET с ретраями: транзиентные обрывы соединения не должны ронять весь прогон."""
    global _VISION_BASE
    bases = ([_VISION_BASE] + [b for b in VISION_BASES if b != _VISION_BASE]) if _VISION_BASE else list(VISION_BASES)
    last_exc = None
    for attempt in range(attempts):
        base = bases[attempt % len(bases)]
        try:
            r = requests.get(base + path, timeout=60)
            _VISION_BASE = base          # любой HTTP-ответ = зеркало доступно
            return r
        except requests.exceptions.RequestException as e:
            last_exc = e
            time.sleep(1.0 + attempt)
    raise last_exc

def _vision_zip_rows(content):
    import io, zipfile
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        for name in z.namelist():
            for line in z.read(name).decode("utf-8", "replace").splitlines():
                if line and not line[0].isalpha():   # пропускаем заголовок open_time,...
                    yield line.split(",")

def _vision_symbols():
    """Все USDT-перпетуалы, по которым в архиве есть свечи (листинг S3-бакета)."""
    global _VISION_SYMBOLS
    if _VISION_SYMBOLS is not None:
        return _VISION_SYMBOLS
    import xml.etree.ElementTree as ET
    syms, marker = [], ""
    prefix = "data/futures/um/monthly/klines/"
    while True:
        url = f"{VISION_S3_LIST}?delimiter=/&prefix={prefix}" + (f"&marker={marker}" if marker else "")
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
        page = [p.find(ns + "Prefix").text.rstrip("/").split("/")[-1]
                for p in root.findall(ns + "CommonPrefixes")]
        syms += [s for s in page if s.endswith("USDT")]
        if (root.findtext(ns + "IsTruncated") or "false") != "true" or not page:
            break
        marker = root.findtext(ns + "NextMarker") or (prefix + page[-1] + "/")
    _VISION_SYMBOLS = set(syms)
    return _VISION_SYMBOLS

def _vision_top_symbols(n, on_date=None):
    """Ранжирование по объёму без живого API: quote_volume дневной 1d-свечи
    из архива (крошечный zip на символ). on_date - ранжировать по объёму
    конкретного дня (для честного отбора топа на начало периода)."""
    try:
        syms = sorted(_vision_symbols())
    except Exception as e:
        raise RuntimeError(f"Не удалось получить список символов из архива: {e}")
    base_day = on_date or (dt.datetime.now(dt.timezone.utc).date())
    days_try = [base_day - dt.timedelta(days=k) for k in (1, 2, 3)]
    vols = []
    for i, sym in enumerate(syms, 1):
        vol = 0.0
        try:
            for d in days_try:
                r = _vision_get(f"/data/futures/um/daily/klines/{sym}/1d/{sym}-1d-{d:%Y-%m-%d}.zip")
                if r.status_code != 200:
                    continue
                for p in _vision_zip_rows(r.content):
                    vol += float(p[7])               # quote_volume
                break
        except Exception:
            pass                                     # символ без данных не роняет ранжирование
        vols.append((sym, vol))
        if i % 100 == 0:
            print(f"  ранжирование по объёму: {i}/{len(syms)}", file=sys.stderr)
    vols.sort(key=lambda x: x[1], reverse=True)
    return vols[:n]

def _vision_fetch_klines(symbol, interval, days):
    syms = None
    try:
        syms = _vision_symbols()
    except Exception:
        pass                                          # без списка - просто пробуем качать
    if syms is not None and symbol not in syms:
        e = np.array([])
        return e, e, e, e, np.array([], dtype=int)

    today = dt.datetime.now(dt.timezone.utc).date()
    start = today - dt.timedelta(days=days)
    recs = {}
    m = dt.date(start.year, start.month, 1)
    while m <= today:
        next_m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        month_end = next_m - dt.timedelta(days=1)
        got_month = False
        if month_end < today:                         # полностью прошедший месяц
            r = _vision_get(f"/data/futures/um/monthly/klines/{symbol}/{interval}/"
                            f"{symbol}-{interval}-{m:%Y-%m}.zip")
            if r.status_code == 200:
                for p in _vision_zip_rows(r.content):
                    ts = int(p[0])
                    if ts > 10 ** 15:
                        ts //= 1000                   # µs → ms (формат менялся в спот-архиве)
                    recs[ts] = (ts, float(p[1]), float(p[2]), float(p[3]), float(p[4]))
                got_month = True
        if not got_month:                             # текущий месяц или нет помесячного zip
            d = max(m, start)
            last_d = min(month_end, today)
            while d <= last_d:
                r = _vision_get(f"/data/futures/um/daily/klines/{symbol}/{interval}/"
                                f"{symbol}-{interval}-{d:%Y-%m-%d}.zip")
                if r.status_code == 200:
                    for p in _vision_zip_rows(r.content):
                        ts = int(p[0])
                        if ts > 10 ** 15:
                            ts //= 1000
                        recs[ts] = (ts, float(p[1]), float(p[2]), float(p[3]), float(p[4]))
                d += dt.timedelta(days=1)
        m = next_m
    cut_ms = int(dt.datetime(start.year, start.month, start.day,
                             tzinfo=dt.timezone.utc).timestamp() * 1000)
    rows = sorted(v for k, v in recs.items() if k >= cut_ms)
    o = np.array([r[1] for r in rows])
    h = np.array([r[2] for r in rows])
    l = np.array([r[3] for r in rows])
    c = np.array([r[4] for r in rows])
    t = np.array([r[0] // 1000 for r in rows], dtype=int)
    return o, h, l, c, t

def _switch_to_vision(reason):
    global _USE_VISION
    if not _USE_VISION:
        _USE_VISION = True
        print(f"fapi.binance.com недоступен ({reason}) - переключаюсь на архив "
              f"data.binance.vision (лаг данных ~1 день)", file=sys.stderr)

def top_symbols(n, on_date=None):
    """on_date=None - топ по текущему 24h-объёму; иначе - по объёму на дату
    (исторический отбор всегда идёт через архив, даже при живом fapi)."""
    key = (n, on_date)
    if key in _TOP_CACHE:
        return _TOP_CACHE[key]
    if on_date is None and not _USE_VISION:
        try:
            r = requests.get(f"{BINANCE_FAPI}/fapi/v1/ticker/24hr", timeout=20)
            if r.status_code in (403, 451):
                _switch_to_vision(f"HTTP {r.status_code}")
            else:
                r.raise_for_status()
                data = [d for d in r.json() if d["symbol"].endswith("USDT")]
                data.sort(key=lambda d: float(d.get("quoteVolume", 0)), reverse=True)
                _TOP_CACHE[key] = [(d["symbol"], float(d["quoteVolume"])) for d in data[:n]]
                return _TOP_CACHE[key]
        except requests.exceptions.ProxyError:
            _switch_to_vision("прокси запретил соединение")
    _TOP_CACHE[key] = _vision_top_symbols(n, on_date)
    return _TOP_CACHE[key]

def _fapi_fetch_klines(symbol, interval, days):
    end = int(time.time() * 1000)
    start = end - days * 24 * 60 * 60 * 1000
    out = []
    cur = start
    while cur < end:
        r = requests.get(f"{BINANCE_FAPI}/fapi/v1/klines",
                         params=dict(symbol=symbol, interval=interval, startTime=cur, limit=1500),
                         timeout=20)
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        out.extend(chunk)
        cur = chunk[-1][0] + 1
        if len(chunk) < 1500:
            break
        time.sleep(0.25)   # бережём rate-limit
    o = np.array([float(k[1]) for k in out])
    h = np.array([float(k[2]) for k in out])
    l = np.array([float(k[3]) for k in out])
    c = np.array([float(k[4]) for k in out])
    t = np.array([int(k[0]) // 1000 for k in out])
    return o, h, l, c, t

def fetch_klines(symbol, interval, days):
    cache_key = (symbol, interval, days)
    if cache_key in _KLINE_CACHE:
        return _KLINE_CACHE[cache_key]
    result = None
    if not _USE_VISION:
        try:
            result = _fapi_fetch_klines(symbol, interval, days)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code in (403, 451):
                _switch_to_vision(f"HTTP {e.response.status_code}")
            else:
                raise
        except requests.exceptions.ProxyError:
            _switch_to_vision("прокси запретил соединение")
    if result is None:
        result = _vision_fetch_klines(symbol, interval, days)
    _KLINE_CACHE[cache_key] = result
    return result

# ─────────────────────────── FUNDING (перпетуалы) ───────────────────────────
_FUNDING_CACHE = {}
DEFAULT_FUNDING_RATE = 0.0001   # стандартная базовая ставка Binance 0.01% / 8ч

def _fapi_funding(symbol, days):
    end = int(time.time() * 1000)
    start = end - days * 24 * 60 * 60 * 1000
    out = []
    cur = start
    while cur < end:
        r = requests.get(f"{BINANCE_FAPI}/fapi/v1/fundingRate",
                         params=dict(symbol=symbol, startTime=cur, limit=1000),
                         timeout=20)
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        out += [(int(x["fundingTime"]), float(x["fundingRate"])) for x in chunk]
        cur = int(chunk[-1]["fundingTime"]) + 1
        if len(chunk) < 1000:
            break
        time.sleep(0.2)
    return out

def _vision_funding(symbol, days):
    """[(ts_ms, rate), ...]. Подневного архива фандинга не существует, поэтому
    хвост после последнего архивного месяца оценивается средней ставкой этого
    месяца с его же интервалом начислений - честнее, чем не учитывать вовсе."""
    now = dt.datetime.now(dt.timezone.utc)
    start = now - dt.timedelta(days=days)
    events = []
    interval_h = 8
    m = dt.date(start.year, start.month, 1)
    today = now.date()
    while m <= today:
        r = _vision_get(f"/data/futures/um/monthly/fundingRate/{symbol}/"
                        f"{symbol}-fundingRate-{m:%Y-%m}.zip")
        if r.status_code == 200:
            for p in _vision_zip_rows(r.content):
                events.append((int(p[0]), float(p[2])))
                try:
                    interval_h = int(float(p[1])) or interval_h
                except (ValueError, IndexError):
                    pass
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    events.sort()
    # оценка хвоста без архива (текущий месяц): средняя ставка последних ~30 дней
    now_ms = int(now.timestamp() * 1000)
    if events:
        tail = [rate for ts, rate in events[-31 * 24 // interval_h:]]
        est_rate = sum(tail) / len(tail)
        cur_ts = events[-1][0] + interval_h * 3600 * 1000
    else:
        est_rate = DEFAULT_FUNDING_RATE
        cur_ts = int(start.timestamp() * 1000)
    while cur_ts <= now_ms:
        events.append((cur_ts, est_rate))
        cur_ts += interval_h * 3600 * 1000
    cut = int(start.timestamp() * 1000)
    return [(ts, rate) for ts, rate in events if ts >= cut]

def fetch_funding(symbol, days):
    cache_key = (symbol, days)
    if cache_key in _FUNDING_CACHE:
        return _FUNDING_CACHE[cache_key]
    result = None
    if not _USE_VISION:
        try:
            result = _fapi_funding(symbol, days)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code in (403, 451):
                _switch_to_vision(f"HTTP {e.response.status_code}")
            else:
                raise
        except requests.exceptions.ProxyError:
            _switch_to_vision("прокси запретил соединение")
    if result is None:
        result = _vision_funding(symbol, days)
    _FUNDING_CACHE[cache_key] = result
    return result

# ═══════════════════════════════ ВЫВОД ══════════════════════════════════
HEADERS = ["symbol", "tf", "signals", "sets", "wins", "losses", "winrate",
           "pnl_pct", "realized_pct", "unreal_pct", "pos_side", "pos_lots", "pos_avg",
           "last_side", "quote_volume", "updated", "lot_entries", "sets_json", "max_dd", "expectancy"]

# Готовые наборы правил. Запуск: python backtest_v29.py <ключ>
# Каждый пишет свой CSV — вставь его в одноимённую вкладку Google Sheets.
_HONEST_RULES = dict(
    honest_fills=True,     # вход по open следующей свечи
    slippage_pct=0.05,     # 0.05% проскальзывание за сторону
    funding=True,          # funding перпетуалов из архива/API
    rolling_delist=True,   # делистинг без знания будущего
    rank_at_start=True,    # топ по объёму на начало периода
)

PRESETS = {
    "base":    dict(rules={}, out="fut_strat.csv", tab="FUT_STRAT", label="Базовый (без правил)"),
    "sl":      dict(rules=dict(stop_loss_pct=5.0), out="fut_strat_sl.csv", tab="FUT_STRAT_SL", label="Стоп -5%"),
    "sltrend": dict(rules=dict(stop_loss_pct=5.0, use_trend_filter=True, trend_len=200),
                    out="fut_strat_slt.csv", tab="FUT_STRAT_SLT", label="Стоп -5% + фильтр тренда"),
    # Честный режим: убраны look-ahead делистинга, ошибка выжившего, идеальное
    # исполнение; добавлены funding и проскальзывание. Ожидаемо хуже базовых -
    # зато ближе к тому, что покажет реальная торговля.
    "honest":    dict(rules=dict(_HONEST_RULES), out="fut_strat_h.csv", tab="FUT_STRAT_H",
                      label="Честный (без правил)"),
    "honest_sl": dict(rules=dict(_HONEST_RULES, stop_loss_pct=5.0), out="fut_strat_h_sl.csv",
                      tab="FUT_STRAT_H_SL", label="Честный + стоп -5%"),
    # Единственный конфиг, прошедший заранее зафиксированный критерий на двух
    # независимых 90-дневных окнах (in-sample +1.3%, out-of-sample +1.85%,
    # просадка <1% при ставке 0.25%): стоп -5% + фильтр тренда EMA200 в честном
    # режиме. Ставка поднята до 2% на сигнал: ожидание масштабируется примерно
    # линейно (~x8), просадка тоже - закладывайте ~4-8% вместо <1%.
    "honest_sltrend": dict(rules=dict(_HONEST_RULES, stop_loss_pct=5.0,
                                      use_trend_filter=True, trend_len=200,
                                      port_risk_pct=2.0),
                           out="fut_strat_h_slt.csv", tab="FUT_STRAT_H_SLT",
                           label="Честный + стоп -5% + тренд (2%/сигнал)"),
}


def build_config(preset="base", overrides=None):
    """Return an isolated config for a preset without mutating global CFG."""
    if preset not in PRESETS:
        raise ValueError("Available presets: " + ", ".join(PRESETS.keys()))
    cfg = deepcopy(CFG)
    cfg.update(PRESETS[preset]["rules"])
    if overrides:
        cfg.update(overrides)
    cfg["preset"] = preset
    cfg["out"] = PRESETS[preset]["out"]
    cfg["tab"] = PRESETS[preset]["tab"]
    cfg["label"] = PRESETS[preset]["label"]
    return cfg


def simulate_portfolio(coins, cfg):
    """Один общий депозит на все монеты, боевой стандарт API.

    Модель: 1 сигнал = port_risk_pct% от ТЕКУЩЕГО эквити (компаундинг), плечо 1x.
    Сделки берём из per-coin движка (значит правила пресета - стоп/тейк/тренд -
    уже применены: входы и выходы те же, отличается только долларовый сайзинг).
    Реверс = закрыть все доли монеты и открыть реверс на 1 долю. Усреднение - до max_lots
    (потолок уже соблюдён per-coin движком). Делистинг: монеты с автономным PNL ниже
    delist_pct% исключаются (как в дашборде - по ним позиции не открываются).

    coins: список dict {sym, sets_detail, last_price, last_t, standalone_pnl}.
      sets_detail: [{side, entries:[(price,t),...], exit:(price,t)|None}, ...]
    Возвращает итог %, макс. просадку, пик одновременных позиций/экспозиции,
    список исключённых монет и дневную кривую эквити [[ts, equity_usd, equity_pct], ...].
    """
    D0 = cfg["portfolio_deposit"]
    risk = cfg["port_risk_pct"] / 100.0
    fee = cfg["fee_per_side"]; lev = cfg["leverage"]
    delist = cfg.get("delist_pct", -5.0)
    rolling = bool(cfg.get("rolling_delist"))

    kept, dropped = [], []
    blocked_at = {}                 # sym -> ts, с которого новые входы запрещены
    if rolling:
        # ЧЕСТНЫЙ делистинг: без знания будущего. Монета блокируется с момента,
        # когда её НАКОПЛЕННЫЙ реализованный PNL (по её же таймлайну сетов)
        # впервые опустился ниже delist_pct - ровно то, что видно в моменте.
        for c in coins:
            kept.append(c["sym"])
            cum = 0.0
            for ts, pct in sorted(c.get("sets_tpnl") or []):
                cum += pct
                if cum < delist:
                    blocked_at[c["sym"]] = int(ts)
                    dropped.append(c["sym"])
                    break
        keep_set = set(kept)
    else:
        for c in coins:
            (dropped if c["standalone_pnl"] < delist else kept).append(c["sym"])
        keep_set = set(kept)

    # события входов/выходов/фандинга по всем монетам в единой ленте времени
    EV_X, EV_F, EV_E = 0, 1, 2      # выход раньше фандинга и входа в ту же метку (реверс)
    events = []
    last_px = {}                    # sym -> (last_price, last_t) для MTM открытых
    for c in coins:
        if c["sym"] not in keep_set:
            continue
        last_px[c["sym"]] = (float(c["last_price"]), int(c["last_t"]))
        for tr in c["sets_detail"]:
            for (price, t) in tr["entries"]:
                events.append((int(t), EV_E, c["sym"], tr["side"], float(price)))
            if tr["exit"] is not None:
                ex_p, ex_t = tr["exit"]
                events.append((int(ex_t), EV_X, c["sym"], tr["side"], float(ex_p)))
        for (t, rate, mark) in c.get("funding") or []:
            events.append((int(t), EV_F, c["sym"], rate, float(mark)))
    events.sort(key=lambda e: (e[0], e[1]))

    eq = D0
    pos = {}                        # sym -> {'side','lots':[(price,qty)]}
    peak_eq = eq; max_dd = 0.0; peak_conc = 0; peak_expo = 0.0
    curve = {}                      # day_ts -> equity_usd (реализованное на конец дня)
    day = 86400

    def exposure_pct():
        notional = sum(pp * qq for p in pos.values() for (pp, qq) in p["lots"])
        return notional / eq * 100.0 if eq > 0 else 0.0

    for (t, kind, sym, side, price) in events:
        if kind == EV_E:
            if rolling and sym in blocked_at and t >= blocked_at[sym]:
                continue                        # монета уже "делистнута" в моменте - вход пропущен
            note = risk * eq * lev
            qty = note / price
            eq -= note * fee
            p = pos.get(sym)
            if p is None or p["side"] != side:
                pos[sym] = {"side": side, "lots": [(price, qty)]}
            else:
                p["lots"].append((price, qty))
        elif kind == EV_F:                      # funding: side=ставка, price=марк-цена
            p = pos.get(sym)
            if p is not None:
                rate = side
                notional = sum(qq * price for (_pp, qq) in p["lots"])
                eq -= notional * rate if p["side"] == "long" else -notional * rate
        else:                                   # EV_X - закрыть все доли монеты
            p = pos.pop(sym, None)
            if p is not None:
                realized = 0.0; cnote = 0.0
                for (pp, qq) in p["lots"]:
                    realized += qq * (price - pp) if p["side"] == "long" else qq * (pp - price)
                    cnote += qq * price
                eq += realized - cnote * fee
        # просадка/пики по реализованному эквити
        if eq > peak_eq: peak_eq = eq
        if peak_eq > 0:
            dd = (peak_eq - eq) / peak_eq * 100.0
            if dd > max_dd: max_dd = dd
        conc = sum(1 for p in pos.values() if p["lots"])
        if conc > peak_conc: peak_conc = conc
        e = exposure_pct()
        if e > peak_expo: peak_expo = e
        curve[(t // day) * day] = eq            # последняя точка дня

    # MTM открытых позиций по последней цене монеты
    unreal = 0.0; last_t = 0
    for sym, p in pos.items():
        lp, lt = last_px.get(sym, (None, 0))
        if lp is None: continue
        last_t = max(last_t, lt)
        for (pp, qq) in p["lots"]:
            unreal += qq * (lp - pp) if p["side"] == "long" else qq * (pp - lp)
    final_eq = eq + unreal

    # дневная кривая: ступенчатое реализованное эквити, последняя точка с учётом MTM
    out_curve = []
    if curve:
        days = sorted(curve.keys())
        running = D0
        last_day = days[-1]
        d = days[0]
        di = 0
        while d <= last_day:
            if di < len(days) and days[di] == d:
                running = curve[d]; di += 1
            out_curve.append([int(d), round(running, 2), round((running - D0) / D0 * 100.0, 2)])
            d += day
        # финальная точка с нереализованным
        ft = max(last_day, last_t)
        out_curve.append([int(ft), round(final_eq, 2), round((final_eq - D0) / D0 * 100.0, 2)])

    return dict(
        final_pct=(final_eq - D0) / D0 * 100.0, max_dd=max_dd,
        peak_positions=peak_conc, peak_exposure=peak_expo,
        n_signals=sum(1 for e in events if e[1] != EV_F),
        n_coins=len(kept), dropped=dropped,
        curve=out_curve,
    )


def portfolio_rows(portfolio_curve):
    rows = [["date", "ts", "equity_usd", "equity_pct"]]
    for ts, usd, pct in portfolio_curve:
        rows.append([dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d"), ts, usd, pct])
    return rows


def write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(headers)
        w.writerows(rows)


def write_portfolio_csv(path, portfolio_curve):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerows(portfolio_rows(portfolio_curve))


def run_backtest(config=None, progress=None):
    """Run the strategy and return data instead of writing side-effect files.

    Returns a dict with:
      rows: rows for FUT_STRAT-like tabs, without header
      portfolio_curve: rows for <TAB>_PF, without header
      portfolio_stats: summary from simulate_portfolio()
    """
    if requests is None:
        raise RuntimeError("Missing dependency: pip install requests")

    if config is None:
        cfg = build_config("base")
    elif "tab" in config and "out" in config:
        cfg = deepcopy(config)
    else:
        cfg = build_config(config.get("preset", "base"), config)

    log = progress or (lambda message: None)
    log(f"Run: {cfg['label']} -> {cfg['out']} (sheet {cfg['tab']})")

    updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if cfg["symbols"]:
        syms = [((s if s.upper().endswith("USDT") else s.upper() + "USDT"), 0.0) for s in cfg["symbols"]]
    elif cfg.get("rank_at_start"):
        # честный отбор: топ по объёму на НАЧАЛО тестового периода, а не сегодня
        start_date = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=cfg["history_days"])
        log(f"Отбор топ-{cfg['top_n']} по объёму на {start_date} (без ошибки выжившего)")
        syms = top_symbols(cfg["top_n"], on_date=start_date)
    else:
        syms = top_symbols(cfg["top_n"])

    use_funding = bool(cfg.get("funding"))
    rows = []
    coins_pf = []
    for k, (sym, qvol) in enumerate(syms, 1):
        try:
            o, h, l, c, t = fetch_klines(sym, cfg["interval"], cfg["history_days"])
            if len(c) < IND["len"] + 50:
                log(f"[{k}/{len(syms)}] {sym}: not enough data, skipped")
                continue

            fund = fetch_funding(sym, cfg["history_days"]) if use_funding else None
            sigs = compute_signals(c, h, l, cfg["tf_min"])
            res = simulate(c, sigs, cfg, times=t, opens=o, funding=fund)
            # funding для портфельной модели: (t_сек, ставка, марк-цена ближайшей свечи)
            fund_pf = []
            if fund:
                for ts_ms, rate in fund:
                    b = int(np.searchsorted(t, ts_ms // 1000, side="right")) - 1
                    if 0 <= b < len(c):
                        fund_pf.append((int(t[b]), rate, float(c[b])))
            coins_pf.append(dict(
                sym=sym,
                sets_detail=res["sets_detail"],
                last_price=float(c[-1]),
                last_t=int(t[-1]),
                standalone_pnl=res["pnl_pct"],
                sets_tpnl=res["sets_tpnl"],
                funding=fund_pf,
            ))

            if res["sets"] < cfg["write_min_sets"]:
                log(f"[{k}/{len(syms)}] {sym}: sets={res['sets']} below threshold, skipped")
                continue

            rows.append([
                sym, cfg["interval"], res["signals"], res["sets"], res["wins"], res["losses"],
                "" if res["winrate"] is None else round(res["winrate"], 1),
                round(res["pnl_pct"], 2), round(res["realized_pct"], 2), round(res["unreal_pct"], 2),
                res["pos_side"], res["pos_lots"], res["pos_avg"], res["last_side"], round(qvol), updated,
                json.dumps(res["lot_entries"]), json.dumps(res["sets_tpnl"]),
                res["max_dd"], res["expectancy"],
            ])

            wr = "-" if res["winrate"] is None else f"{res['winrate']:.1f}%"
            log(f"[{k}/{len(syms)}] {sym}: sets={res['sets']} WR={wr} PNL={res['pnl_pct']:+.1f}%")
        except Exception as e:
            log(f"[{k}/{len(syms)}] {sym}: error {e}")

    rows.sort(key=lambda r: r[7], reverse=True)
    pf = simulate_portfolio(coins_pf, cfg) if coins_pf else None

    return dict(
        headers=HEADERS,
        rows=rows,
        portfolio_curve=(pf or {}).get("curve", []),
        portfolio_stats=pf,
        config=cfg,
        preset=cfg.get("preset", "base"),
        tab=cfg["tab"],
        portfolio_tab=f"{cfg['tab']}_PF",
        out_file=cfg["out"],
        portfolio_file=cfg["out"].replace(".csv", "_portfolio.csv"),
        updated=updated,
    )


def run(preset="base"):
    cfg = build_config(preset)
    result = run_backtest(cfg, progress=lambda message: print(message, file=sys.stderr))
    write_csv(result["out_file"], result["headers"], result["rows"])
    print(f"\nDone -> {result['out_file']} ({len(result['rows'])} pairs). "
          f"Upload it to Google Sheets tab '{result['tab']}'.", file=sys.stderr)

    if result["portfolio_stats"]:
        pf = result["portfolio_stats"]
        write_portfolio_csv(result["portfolio_file"], result["portfolio_curve"])
        print("\n--- PORTFOLIO (one shared deposit, API sizing model) ---", file=sys.stderr)
        print(f"  deposit ${cfg['portfolio_deposit']:.0f} | entry {cfg['port_risk_pct']:.2f}% per signal | leverage {cfg['leverage']:.0f}x",
              file=sys.stderr)
        print(f"  active coins: {pf['n_coins']}   delisted (<{cfg['delist_pct']:.0f}%): {len(pf['dropped'])}"
              + (f" [{', '.join(s.replace('USDT','') for s in pf['dropped'])}]" if pf['dropped'] else ""),
              file=sys.stderr)
        print(f"  result: {pf['final_pct']:+.1f}%   max drawdown: -{pf['max_dd']:.1f}%   signals: {pf['n_signals']}",
              file=sys.stderr)
        print(f"  equity curve -> {result['portfolio_file']} ({len(result['portfolio_curve'])} days), tab '{result['portfolio_tab']}'.",
              file=sys.stderr)
    return result


# ───── Запись прямо в Google Sheets (опционально) ─────
# pip install gspread google-auth
# import gspread
# gc = gspread.service_account(filename="creds.json")
# sh = gc.open_by_key("1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o")
# ws = sh.worksheet("FUT_STRAT")  # создай вкладку заранее
# ws.clear(); ws.update([HEADERS] + rows)

if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else "base"
    if key not in PRESETS:
        sys.exit("Доступные прогоны: " + ", ".join(PRESETS.keys()))
    run(key)
