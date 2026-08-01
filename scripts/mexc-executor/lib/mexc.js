// ============================================================
// lib/mexc.js — драйвер событийных фьючерсов MEXC.
//
// Payout: ПЕРВИЧНО читается с публичного REST-эндпоинта
//   /api/platform/futures/api/v1/event_contract/detail
// (тот же, что использует монитор в Apps Script v3.9.6), парсинг
// идентичен: узел с symbol → массив MINUTE → {val, upPayRate,
// downPayRate}. Если REST недоступен — фолбэк на чтение DOM.
//
// Ставка: Playwright с постоянным профилем браузера (в него нужно
// один раз залогиниться через `npm run login`), вкладка Pro на
// mexc.com/futures/event-futures/<SYMBOL>: выбрать единицу
// времени (10m/30m), вписать сумму, нажать Up/Down.
//
// Селекторы завязаны на ТЕКСТЫ интерфейса (config.ui) — при смене
// локали или редизайна MEXC правится config.json, не код.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = "https://www.mexc.com/futures/event-futures/";

// 0.8 → 80; 80 → 80 (та же нормализация, что norm1 в Apps Script)
function normPct(v) {
  if (typeof v !== "number" || isNaN(v)) return null;
  return v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
}

function findNodeWithSymbol(node, symbol) {
  if (node == null || typeof node !== "object") return null;
  if (node.symbol === symbol) return node;
  for (const k in node) {
    const r = findNodeWithSymbol(node[k], symbol);
    if (r) return r;
  }
  return null;
}

function findUnitArray(node, unit) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node[unit])) return node[unit];
  for (const k in node) {
    const r = findUnitArray(node[k], unit);
    if (r) return r;
  }
  return null;
}

class MexcEventFutures {
  constructor(config) {
    this.cfg = config;
    this.context = null;
    this.pages = new Map();     // symbol -> Page
    this.timeUnit = new Map();  // symbol -> выбранный чип ("10m"/"30m")
  }

  async start() {
    if (this.context) return;
    const userDataDir = path.resolve(this.cfg.userDataDir || "./mexc-profile");
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: !!this.cfg.headless,
      viewport: { width: 1440, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  async stop() {
    if (this.context) await this.context.close();
    this.context = null;
    this.pages.clear();
    this.timeUnit.clear();
  }

  // ── Payout по REST (первичный путь; работает и без браузера) ──
  // Возвращает { up, down } в процентах или null.
  async fetchPayoutRest(symbol, timingMin) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.payoutTimeoutMs || 4000);
    try {
      const resp = await fetch(this.cfg.payoutUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" },
      });
      if (!resp.ok) return null;
      const root = await resp.json();
      const contract = findNodeWithSymbol(root, symbol);
      if (!contract) return null;
      const arr = findUnitArray(contract, "MINUTE");
      if (!arr) return null;
      const el = arr.find((o) => o && o.val === timingMin && typeof o.upPayRate === "number");
      if (!el) return null;
      return {
        up: normPct(el.upPayRate),
        down: normPct(typeof el.downPayRate === "number" ? el.downPayRate : el.upPayRate),
        source: "rest",
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async openSymbol(symbol, timingMin) {
    await this.start();
    let page = this.pages.get(symbol);
    if (!page || page.isClosed()) {
      page = await this.context.newPage();
      await page.goto(BASE_URL + symbol, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Вкладка Pro (панель с payout, суммой и кнопками Up/Down)
      try {
        await page.getByText(this.cfg.ui.proTab, { exact: true }).first().click({ timeout: 8000 });
      } catch (_) { /* уже активна или иная разметка — проверит readPayoutsDom */ }
      this.pages.set(symbol, page);
      this.timeUnit.delete(symbol);
    }
    // Единица времени: кликаем чип, только если требуемая сменилась
    const wanted = (this.cfg.ui.timeUnitText || {})[String(timingMin)] || "10m";
    if (this.timeUnit.get(symbol) !== wanted) {
      try {
        await page.getByText(wanted, { exact: true }).first().click({ timeout: 5000 });
      } catch (_) { /* чип может быть уже выбран */ }
      this.timeUnit.set(symbol, wanted);
    }
    return page;
  }

  // ── Payout из DOM (фолбэк, если REST не ответил) ──
  async readPayoutsDom(symbol, timingMin) {
    const page = await this.openSymbol(symbol, timingMin);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const grab = (reStr) => {
      const re = new RegExp(reStr, "g");
      let m, last = null;
      while ((m = re.exec(text)) !== null) last = parseFloat(m[1]);
      return last; // последнее вхождение = панель ордера (первое — шапка графика)
    };
    return {
      up: grab(this.cfg.ui.upPayoutRegex),
      down: grab(this.cfg.ui.downPayoutRegex),
      source: "dom",
    };
  }

  async getPayout(symbol, timingMin) {
    const rest = await this.fetchPayoutRest(symbol, timingMin);
    if (rest && rest.up != null) return rest;
    return this.readPayoutsDom(symbol, timingMin);
  }

  // direction: "UP" | "DOWN". Возвращает объект-отчёт для лога.
  async placeBet(symbol, direction, timingMin, stakeUsdt, { dryRun = true } = {}) {
    const dir = String(direction).toUpperCase() === "UP" ? "UP" : "DOWN";

    // EV-контроль прямо перед кликом: payout мог упасть после FM-фильтра
    const payouts = await this.getPayout(symbol, timingMin);
    const payout = dir === "UP" ? payouts.up : payouts.down;
    if (payout == null) {
      return { ok: false, reason: "payout-not-found", payouts };
    }
    if (payout < this.cfg.minPayoutPct) {
      return { ok: false, reason: `payout ${payout}% < min ${this.cfg.minPayoutPct}% (EV<0)`, payout, payouts };
    }

    const page = await this.openSymbol(symbol, timingMin);

    // Сумма ставки
    const amount = page.locator(`input[placeholder*="${this.cfg.ui.amountPlaceholderContains}"]`).first();
    await amount.waitFor({ state: "visible", timeout: 8000 });
    await amount.fill(String(stakeUsdt));

    // Кнопка направления
    const btnRe = new RegExp(dir === "UP" ? this.cfg.ui.upButton : this.cfg.ui.downButton);
    const button = page.getByRole("button").filter({ hasText: btnRe }).first();
    await button.waitFor({ state: "visible", timeout: 8000 });

    if (dryRun) {
      const shot = await this._screenshot(page, symbol, dir, "dryrun");
      return { ok: true, dryRun: true, payout, payouts, stake: stakeUsdt, screenshot: shot };
    }

    await button.click();

    // Возможное окно подтверждения
    for (const label of this.cfg.ui.confirmButtons || []) {
      const confirm = page.getByRole("button", { name: label }).first();
      try {
        await confirm.click({ timeout: 2500 });
        break;
      } catch (_) { /* окна нет — ок */ }
    }

    await page.waitForTimeout(1500);
    const shot = await this._screenshot(page, symbol, dir, "placed");
    return { ok: true, dryRun: false, payout, payouts, stake: stakeUsdt, screenshot: shot };
  }

  async _screenshot(page, symbol, dir, tag) {
    try {
      const dirPath = path.resolve(this.cfg.screenshotsDir || "./screenshots");
      fs.mkdirSync(dirPath, { recursive: true });
      const file = path.join(dirPath, `${Date.now()}_${symbol}_${dir}_${tag}.png`);
      await page.screenshot({ path: file });
      return file;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { MexcEventFutures, normPct };
