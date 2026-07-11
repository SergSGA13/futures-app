#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Update Google Sheets tabs from backtest_v29.py.

Usage:
  python update_sheets.py --preset base --dry-run
  python update_sheets.py --preset all --spreadsheet-id 1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o

Credentials:
  Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_APPLICATION_CREDENTIALS to a
  Google service-account JSON file. Share the spreadsheet with the
  service-account email before running.
"""

import argparse
import os
import sys
import time
from http.client import RemoteDisconnected

import requests

from backtest_v29 import (
    HEADERS,
    PRESETS,
    build_config,
    portfolio_rows,
    run_backtest,
    write_csv,
    write_portfolio_csv,
)


DEFAULT_SPREADSHEET_ID = "1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o"
RETRYABLE_ERRORS = (
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    RemoteDisconnected,
)


def parse_symbols(value):
    if not value:
        return None
    return [s.strip().upper() for s in value.split(",") if s.strip()]


def open_spreadsheet(spreadsheet_id, credentials_file):
    try:
        import gspread
    except ImportError as exc:
        raise RuntimeError("Missing dependency: pip install gspread google-auth") from exc

    if not credentials_file:
        credentials_file = (
            os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE")
            or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        )
    if not credentials_file:
        raise RuntimeError(
            "Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_APPLICATION_CREDENTIALS "
            "to a service-account JSON file."
        )

    gc = gspread.service_account(filename=credentials_file)
    return gc.open_by_key(spreadsheet_id)


def with_retries(label, fn, attempts=5, delay=3.0):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except RETRYABLE_ERRORS as exc:
            last_error = exc
            if attempt == attempts:
                break
            progress(f"{label}: connection error, retry {attempt}/{attempts - 1} in {delay:.0f}s")
            time.sleep(delay)
            delay *= 1.6
    raise last_error


def worksheet(sh, title):
    import gspread

    def get_or_create():
        try:
            return sh.worksheet(title)
        except gspread.exceptions.WorksheetNotFound:
            return sh.add_worksheet(title=title, rows=1000, cols=32)

    return with_retries(f"Open worksheet {title}", get_or_create)


def sheet_value(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.12g}"
    return str(value)


def sheet_values(values):
    return [[sheet_value(cell) for cell in row] for row in values]


def update_tab(sh, title, values):
    ws = worksheet(sh, title)
    with_retries(f"Clear worksheet {title}", ws.clear)
    if values:
        values = sheet_values(values)
        with_retries(
            f"Update worksheet {title}",
            lambda: ws.update(values, value_input_option="RAW"),
        )


def progress(message):
    print(message, file=sys.stderr, flush=True)


def run_one(preset, args, spreadsheet=None):
    overrides = {}
    symbols = parse_symbols(args.symbols)
    if symbols is not None:
        overrides["symbols"] = symbols
    if args.top_n is not None:
        overrides["top_n"] = args.top_n
    if args.history_days is not None:
        overrides["history_days"] = args.history_days

    cfg = build_config(preset, overrides)
    result = run_backtest(cfg, progress=progress)

    if args.write_csv or args.dry_run:
        write_csv(result["out_file"], result["headers"], result["rows"])
        write_portfolio_csv(result["portfolio_file"], result["portfolio_curve"])
        progress(f"CSV written: {result['out_file']}, {result['portfolio_file']}")

    if args.dry_run:
        progress(f"Dry run: skipped Google Sheets update for {result['tab']}.")
        return result

    update_tab(spreadsheet, result["tab"], [HEADERS] + result["rows"])
    update_tab(spreadsheet, result["portfolio_tab"], portfolio_rows(result["portfolio_curve"]))
    progress(
        f"Updated Google Sheets tabs: {result['tab']} "
        f"({len(result['rows'])} rows), {result['portfolio_tab']} "
        f"({len(result['portfolio_curve'])} points)."
    )
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run futures backtests and update Google Sheets.")
    parser.add_argument("--preset", default="base", choices=list(PRESETS.keys()) + ["all"])
    parser.add_argument("--spreadsheet-id", default=os.getenv("GOOGLE_SHEET_ID", DEFAULT_SPREADSHEET_ID))
    parser.add_argument("--credentials-file", default=None)
    parser.add_argument("--symbols", default=os.getenv("BT_SYMBOLS", ""), help="Comma-separated symbols, e.g. BTC,ETH,SOL")
    parser.add_argument("--top-n", type=int, default=None)
    parser.add_argument("--history-days", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true", help="Run backtest and write CSV, but do not update Google Sheets.")
    parser.add_argument("--write-csv", action="store_true", help="Also write local CSV files when updating Sheets.")
    parser.add_argument("--sleep", type=float, default=2.0, help="Delay between presets when --preset all is used.")
    args = parser.parse_args(argv)

    # "all" = классические пресеты + honest_sltrend (форвард-наблюдение за
    # конфигом, прошедшим out-of-sample). Остальные honest* - только явно.
    if args.preset == "all":
        presets = [k for k in PRESETS.keys()
                   if not k.startswith("honest") or k == "honest_sltrend"]
    else:
        presets = [args.preset]
    spreadsheet = None
    if not args.dry_run:
        spreadsheet = open_spreadsheet(args.spreadsheet_id, args.credentials_file)

    results = []
    for i, preset in enumerate(presets):
        progress(f"=== {preset} ===")
        results.append(run_one(preset, args, spreadsheet))
        if i < len(presets) - 1 and args.sleep:
            time.sleep(args.sleep)

    progress("All done.")
    return results


if __name__ == "__main__":
    main()
