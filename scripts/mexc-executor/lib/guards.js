// ============================================================
// lib/guards.js — чистая логика предохранителей исполнителя.
// Без сети и браузера, поэтому проверяется тестом (npm test).
//
// ВАЖНО: это НЕ повтор фильтров Apps Script (F4/F5/F7/F8/FM).
// Те уже отработали до отправки хука. Здесь — последний рубеж
// перед РЕАЛЬНЫМИ деньгами, он ловит то, чего вебхук знать не
// может: задержку доставки, дубли ретраев, расхождение стейта
// Apps Script с фактическим числом открытых ставок на бирже.
// ============================================================
"use strict";

// "MEXC _10m" → 10, "MEXC _30m" → 30. Совместимо с mexcTimingLabel_.
function parseTiming(timingField) {
  return /30/.test(String(timingField || "")) ? 30 : 10;
}

function parseAsset(ticker) {
  return String(ticker || "").indexOf("BTC") >= 0 ? "BTC" : "ETH";
}

function parseDirection(direction) {
  const d = String(direction || "").toUpperCase();
  if (d === "UP" || d === "BUY") return "UP";
  if (d === "DOWN" || d === "SELL") return "DOWN";
  return null;
}

// Возраст сигнала в секундах. Считаем от receivedAt (момент прихода
// в Apps Script) — это честная точка отсчёта задержки доставки.
// Фолбэк на bartime, если receivedAt не пришёл.
function signalAgeSec(payload, nowMs) {
  const stamp = payload.receivedAt || payload.bartime;
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  if (isNaN(t)) return null;
  return (nowMs - t) / 1000;
}

// Ключ дедупликации: тот же сигнал, доставленный повторно
// (ретрай Apps Script, дубль партнёрского потока), не должен
// превращаться во вторую ставку.
function dedupKey(payload) {
  return [
    parseAsset(payload.ticker),
    parseDirection(payload.direction),
    parseTiming(payload.timing),
    String(payload.price || ""),
    String(payload.receivedAt || payload.bartime || ""),
  ].join("|");
}

// Скользящий кап открытых ставок. Окно ДОЛЬШЕ экспирации, поэтому
// ставка не может «исчезнуть» из счётчика раньше, чем закроется:
// та же логика, что F8 в Apps Script, но по ФАКТИЧЕСКИ размещённым.
// Причина дублировать: у Apps Script стейты веток раздельные
// (основная + MEXC), суммарно они могут выпустить больше 5.
class BetWindow {
  constructor({ maxBets = 5, windowMinutes = 11 } = {}) {
    this.maxBets = maxBets;
    this.windowMs = windowMinutes * 60 * 1000;
    this.placed = [];
  }

  prune(nowMs) {
    this.placed = this.placed.filter((t) => nowMs - t < this.windowMs);
  }

  count(nowMs) {
    this.prune(nowMs);
    return this.placed.length;
  }

  hasSlot(nowMs) {
    return this.count(nowMs) < this.maxBets;
  }

  record(nowMs) {
    this.placed.push(nowMs);
  }
}

// Единая проверка «пускать ли в исполнение».
// Возвращает { ok } либо { ok: false, reason }.
function checkAdmission(payload, ctx) {
  const { nowMs, cfg, window, seen, paused } = ctx;

  if (paused) return { ok: false, reason: "paused: исполнитель на паузе (kill switch)" };

  const dir = parseDirection(payload.direction);
  if (!dir) return { ok: false, reason: `bad-direction: "${payload.direction}"` };

  const asset = parseAsset(payload.ticker);
  if (!cfg.symbols[asset]) return { ok: false, reason: `unknown-asset: ${asset}` };

  const age = signalAgeSec(payload, nowMs);
  if (age == null) return { ok: false, reason: "no-timestamp: нет receivedAt/bartime" };
  if (age > cfg.maxSignalAgeSec)
    return { ok: false, reason: `stale: сигналу ${age.toFixed(1)}с > ${cfg.maxSignalAgeSec}с` };

  const key = dedupKey(payload);
  if (seen.has(key)) return { ok: false, reason: "duplicate: сигнал уже исполнялся" };

  if (!window.hasSlot(nowMs))
    return { ok: false, reason: `cap: ${window.count(nowMs)}/${window.maxBets} ставок в окне` };

  // payout из хука — предварительная отсечка; авторитетная проверка
  // делается ещё раз непосредственно перед кликом (lib/mexc.js),
  // потому что за время доставки payout мог упасть.
  if (typeof payload.payout === "number" && payload.payout < cfg.minPayoutPct)
    return { ok: false, reason: `payout ${payload.payout}% < ${cfg.minPayoutPct}% (по данным хука)` };

  return { ok: true, asset, dir, timing: parseTiming(payload.timing), key, ageSec: age };
}

module.exports = {
  parseTiming,
  parseAsset,
  parseDirection,
  signalAgeSec,
  dedupKey,
  BetWindow,
  checkAdmission,
};
