#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DEV_BADLIST - утренний чек-лист конфигураций-кандидатов на удаление.

Портирует критерий отбора из Apps Script ConfigStats: активная конфигурация
(последний сигнал не старше ACTIVE_LAST_DAYS) попадает в список, если за
последние RECENT_DAYS дней её WR упал ниже безубытка (55.6% при пейауте 0.8 -
это же условие отрицательного EV) или PnL за окно отрицательный.

Источники: вкладки ALLsignal + BLOCKEDsignal (обе), группировка по детальной
строке настроек из колонки G вида
  "1min Binance ETH 🟣v.29.1🟣 · 4.0 (129, 5,2, 3, 6,7, 25, 2,1, 5, 10, 0, Bottom Left)"
Колонки определяются по содержимому, как в оригинальном скрипте.

Результат пишется во вкладку DEV_BADLIST; приложение показывает её в разделе
Last 30 Days · DEV. Запуск - GitHub Actions ежедневно в ~05:00 по Варшаве.

Тем же проходом строится вкладка DEV_TOPLIST - "кормильцы": активные
конфигурации с наибольшим положительным PnL за 30 дней (много сработок ×
высокий EV), ранжирование по PnL 30д, порог MIN_N_TOP сигналов.
"""

import datetime as dt
import re
import sys
from zoneinfo import ZoneInfo

from update_sheets import DEFAULT_SPREADSHEET_ID, open_spreadsheet, progress, update_tab

RECENT_DAYS = 4          # окно "свежей" статистики (пользователь: 3-4 дня)
WINDOW_DAYS = 30         # контекстное окно
ACTIVE_LAST_DAYS = 7     # конфиг активен, если сигнал был не позже N дней назад
BE_WR = 55.6             # безубыток при пейауте 0.8: WR < BE <=> EV < 0
MIN_N_RECENT = 6         # минимум решённых сигналов в свежем окне для вывода
SOURCE_SHEETS = ["ALLsignal", "BLOCKEDsignal"]
OUTPUT_TAB = "DEV_BADLIST"
WARSAW = ZoneInfo("Europe/Warsaw")

# "Кормильцы": топ прибыльных конфигураций за 30 дней (DEV_TOPLIST).
# Приоритет - много сработок И высокий PnL/EV: ранжируем по PnL 30д
# (он и есть N × EV), мелкие выборки отсекаем порогом MIN_N_TOP.
TOP_TAB = "DEV_TOPLIST"
MIN_N_TOP = 20           # минимум решённых сигналов за 30д для попадания в топ
TOP_LIMIT = 10           # сколько строк держим в топе

HEADERS = ["Конфигурация", "Сигналов 4д", "WR 4д %", "PnL 4д",
           "Сигналов 30д", "WR 30д %", "Последний сигнал", "Обновлено"]

TOP_HEADERS = ["Конфигурация", "Сигналов 30д", "WR 30д %", "PnL 30д", "EV/сигнал",
               "Сигналов 4д", "WR 4д %", "PnL 4д", "Последний сигнал", "Обновлено"]


def is_setting(s):
    return bool(re.search(r"\d+\s*min", s, re.I)) and bool(re.search(r"bybit|binance", s, re.I))


def classify_result(s):
    s = s.upper()
    if "WIN" in s and "LOSE" in s:
        return "push"
    if "WIN" in s:
        return "win"
    if "LOSE" in s:
        return "loss"
    return None


def parse_date(s):
    """ISO (2026-05-27T00:00:00Z) или dd.MM.yyyy HH:mm[:ss] -> naive UTC."""
    s = str(s or "").strip()
    if not s:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}T", s):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
            return d.astimezone(dt.timezone.utc).replace(tzinfo=None)
        except ValueError:
            return None
    m = re.match(r"(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?", s)
    if m:
        try:
            return dt.datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)),
                               int(m.group(4)), int(m.group(5)), int(m.group(6) or 0))
        except ValueError:
            return None
    return None


def parse_pnl(s):
    s = str(s or "").strip().replace(" ", "").replace(",", ".")
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return float(s)
    return None


def detect_columns(values):
    """Определение колонок по содержимому (как в Apps Script ConfigStats)."""
    ncols = max((len(r) for r in values), default=0)
    if not ncols:
        return None
    score = {k: [0] * ncols for k in ("timestamp", "settings", "result", "pnl")}
    for row in values[:30000]:
        for c in range(min(len(row), ncols)):
            s = str(row[c] or "").strip()
            if not s:
                continue
            d = parse_date(s)
            if d and d.year >= 2020:
                score["timestamp"][c] += 1
            if is_setting(s):
                score["settings"][c] += 1
            if re.fullmatch(r"(?i)win|lose|win\s*&\s*lose", s):
                score["result"][c] += 1
            p = parse_pnl(s)
            if p is not None and p < 0:
                score["pnl"][c] += 1   # PnL - единственная колонка с минусами

    def pick(k):
        best = max(score[k])
        return score[k].index(best) if best > 0 else -1

    col = {k: pick(k) for k in score}
    if col["timestamp"] < 0 or col["settings"] < 0:
        return None
    return col


def analyze(sheets_values, now):
    """sheets_values: [(имя, values), ...] -> отсортированный список плохих конфигов."""
    d_recent = now - dt.timedelta(days=RECENT_DAYS)
    d_window = now - dt.timedelta(days=WINDOW_DAYS)
    d_active = now - dt.timedelta(days=ACTIVE_LAST_DAYS)

    groups = {}
    for name, values in sheets_values:
        col = detect_columns(values)
        if col is None:
            progress(f"{name}: колонки не определены - вкладка пропущена")
            continue
        cnt = 0
        for row in values:
            def cell(i):
                return str(row[i] or "").strip() if 0 <= i < len(row) else ""
            setting = cell(col["settings"])
            if not is_setting(setting):
                continue
            ts = parse_date(cell(col["timestamp"]))
            if ts is None or ts.year < 2020:
                continue
            g = groups.setdefault(setting, dict(
                n4=0, w4=0, pnl4=0.0, has_pnl=False,
                n30=0, w30=0, pnl30=0.0, has_pnl30=False, last=None))
            if g["last"] is None or ts > g["last"]:
                g["last"] = ts
            outcome = classify_result(cell(col["result"])) if col["result"] >= 0 else None
            if outcome not in ("win", "loss"):
                continue   # push и строки без результата в WR не участвуют
            cnt += 1
            win = 1 if outcome == "win" else 0
            pnl = parse_pnl(cell(col["pnl"])) if col["pnl"] >= 0 else None
            if ts >= d_window:
                g["n30"] += 1
                g["w30"] += win
                if pnl is not None:
                    g["pnl30"] += pnl
                    g["has_pnl30"] = True
            if ts >= d_recent:
                g["n4"] += 1
                g["w4"] += win
                if pnl is not None:
                    g["pnl4"] += pnl
                    g["has_pnl"] = True
        progress(f"{name}: учтено решённых сигналов с конфигом: {cnt}")

    bad = []
    for setting, g in groups.items():
        if g["last"] is None or g["last"] < d_active:
            continue                       # конфиг неактивен - не трогаем
        if g["n4"] < MIN_N_RECENT:
            continue                       # мало свежих данных для вывода
        wr4 = g["w4"] / g["n4"] * 100.0
        losing = wr4 < BE_WR or (g["has_pnl"] and g["pnl4"] < 0)
        if not losing:
            continue
        wr30 = (g["w30"] / g["n30"] * 100.0) if g["n30"] else None
        bad.append(dict(setting=setting, n4=g["n4"], wr4=wr4,
                        pnl4=(round(g["pnl4"], 2) if g["has_pnl"] else ""),
                        n30=g["n30"], wr30=wr30, last=g["last"]))
    bad.sort(key=lambda x: x["wr4"])       # худшие сверху

    # ── Кормильцы: активные конфиги с большим положительным PnL 30д ──
    top = []
    for setting, g in groups.items():
        if g["last"] is None or g["last"] < d_active:
            continue                       # интересуют только работающие сейчас
        if g["n30"] < MIN_N_TOP:
            continue                       # мало сработок - не "кормилец"
        wr30 = g["w30"] / g["n30"] * 100.0
        if wr30 <= BE_WR:
            continue                       # ниже безубытка - не топ
        if g["has_pnl30"] and g["pnl30"] <= 0:
            continue
        wr4 = (g["w4"] / g["n4"] * 100.0) if g["n4"] else None
        top.append(dict(
            setting=setting, n30=g["n30"], wr30=wr30,
            pnl30=(round(g["pnl30"], 2) if g["has_pnl30"] else ""),
            ev30=(round(g["pnl30"] / g["n30"], 1) if g["has_pnl30"] else ""),
            n4=g["n4"], wr4=wr4,
            pnl4=(round(g["pnl4"], 2) if g["has_pnl"] else ""),
            last=g["last"]))
    # PnL 30д = N × EV: ранжирование сразу учитывает и объём, и кромку;
    # без PnL (нет колонки) - fallback на WR × N
    top.sort(key=lambda x: (x["pnl30"] if x["pnl30"] != "" else (x["wr30"] - BE_WR) * x["n30"]),
             reverse=True)
    return bad, top[:TOP_LIMIT]


def main():
    sh = open_spreadsheet(DEFAULT_SPREADSHEET_ID, None)
    now = dt.datetime.utcnow()
    sheets_values = []
    for name in SOURCE_SHEETS:
        try:
            ws = sh.worksheet(name)
            sheets_values.append((name, ws.get_all_values()))
        except Exception as e:
            progress(f"{name}: не прочитана ({e.__class__.__name__}) - пропуск")
    if not sheets_values:
        raise RuntimeError("Ни одна вкладка-источник не прочитана")

    bad, top = analyze(sheets_values, now)
    updated = dt.datetime.now(WARSAW).strftime("%d.%m.%Y %H:%M")

    rows = [HEADERS]
    if bad:
        for x in bad:
            rows.append([
                x["setting"], x["n4"], round(x["wr4"], 1), x["pnl4"],
                x["n30"], round(x["wr30"], 1) if x["wr30"] is not None else "",
                x["last"].strftime("%d.%m %H:%M"), updated,
            ])
    else:
        rows.append(["OK", "", "", "", "", "", "", updated])

    update_tab(sh, OUTPUT_TAB, rows)
    progress(f"DEV_BADLIST: {len(bad)} кандидатов на удаление (обновлено {updated} Варшава)")

    top_rows = [TOP_HEADERS]
    if top:
        for x in top:
            top_rows.append([
                x["setting"], x["n30"], round(x["wr30"], 1), x["pnl30"], x["ev30"],
                x["n4"], round(x["wr4"], 1) if x["wr4"] is not None else "", x["pnl4"],
                x["last"].strftime("%d.%m %H:%M"), updated,
            ])
    else:
        top_rows.append(["OK", "", "", "", "", "", "", "", "", updated])

    update_tab(sh, TOP_TAB, top_rows)
    progress(f"DEV_TOPLIST: {len(top)} кормильцев (обновлено {updated} Варшава)")


if __name__ == "__main__":
    main()
