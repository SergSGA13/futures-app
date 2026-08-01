// ============================================================
// test.js — проверка предохранителей (npm test). Браузер и сеть
// не нужны: логика из lib/guards.js чистая.
// ============================================================
"use strict";

const assert = require("assert");
const { parseTiming, parseAsset, parseDirection, dedupKey, BetWindow, checkAdmission } = require("./lib/guards");

const cfg = {
  symbols: { ETH: "ETH_USDT", BTC: "BTC_USDT" },
  minPayoutPct: 80,
  maxSignalAgeSec: 45,
};
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const fresh = (offsetSec = 0) => new Date(NOW - offsetSec * 1000).toISOString();

function payload(over = {}) {
  return {
    ticker: "ETHUSDT", direction: "UP", price: "1866.18",
    timing: "MEXC _10m", payout: 80, receivedAt: fresh(2), ...over,
  };
}
function ctx(over = {}) {
  return { nowMs: NOW, cfg, window: new BetWindow({ maxBets: 5, windowMinutes: 11 }), seen: new Map(), paused: false, ...over };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("Разбор полей хука Apps Script:");
check("timing 'MEXC _10m' → 10", () => assert.strictEqual(parseTiming("MEXC _10m"), 10));
check("timing 'MEXC _30m' → 30", () => assert.strictEqual(parseTiming("MEXC _30m"), 30));
check("тикер BTCUSDT → BTC", () => assert.strictEqual(parseAsset("BTCUSDT"), "BTC"));
check("тикер ETHUSDT → ETH", () => assert.strictEqual(parseAsset("ETHUSDT"), "ETH"));
check("BUY → UP, SELL → DOWN", () => {
  assert.strictEqual(parseDirection("BUY"), "UP");
  assert.strictEqual(parseDirection("SELL"), "DOWN");
  assert.strictEqual(parseDirection("хрень"), null);
});

console.log("\nДопуск сигнала:");
check("свежий валидный сигнал проходит", () => {
  const r = checkAdmission(payload(), ctx());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.asset, "ETH");
  assert.strictEqual(r.dir, "UP");
  assert.strictEqual(r.timing, 10);
});

check("протухший сигнал (60с) отклоняется", () => {
  const r = checkAdmission(payload({ receivedAt: fresh(60) }), ctx());
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /stale/);
});

check("payout ниже порога отклоняется", () => {
  const r = checkAdmission(payload({ payout: 70 }), ctx());
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /payout 70%/);
});

check("payout null (монитор молчал) не блокирует — решит проверка перед кликом", () => {
  assert.strictEqual(checkAdmission(payload({ payout: null }), ctx()).ok, true);
});

check("повторная доставка того же сигнала отклоняется", () => {
  const c = ctx();
  const p = payload();
  const first = checkAdmission(p, c);
  assert.strictEqual(first.ok, true);
  c.seen.set(first.key, NOW);
  const second = checkAdmission(p, c);
  assert.strictEqual(second.ok, false);
  assert.match(second.reason, /duplicate/);
});

check("разные сигналы не считаются дублями", () => {
  assert.notStrictEqual(dedupKey(payload()), dedupKey(payload({ direction: "DOWN" })));
  assert.notStrictEqual(dedupKey(payload()), dedupKey(payload({ price: "1870.00" })));
});

check("пауза блокирует всё", () => {
  const r = checkAdmission(payload(), ctx({ paused: true }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /paused/);
});

check("кривое направление отклоняется", () => {
  assert.match(checkAdmission(payload({ direction: "" }), ctx()).reason, /bad-direction/);
});

console.log("\nКап одновременных ставок (последний рубеж перед деньгами):");
check("6-я ставка в окне не проходит", () => {
  const c = ctx();
  for (let i = 0; i < 5; i++) c.window.record(NOW - i * 1000);
  const r = checkAdmission(payload(), c);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cap: 5\/5/);
});

check("ставки старше окна освобождают слот", () => {
  const c = ctx();
  for (let i = 0; i < 5; i++) c.window.record(NOW - 12 * 60 * 1000);  // 12 мин назад
  assert.strictEqual(checkAdmission(payload(), c).ok, true);
});

check("окно (11 мин) длиннее экспирации (10 мин)", () => {
  const w = new BetWindow({ maxBets: 5, windowMinutes: 11 });
  w.record(NOW - 10 * 60 * 1000 - 30 * 1000);   // ставка закрылась 30с назад
  assert.strictEqual(w.count(NOW), 1, "слот ещё занят — значит пересчёта в минус быть не может");
});

console.log(`\nВсе проверки пройдены: ${passed}`);
