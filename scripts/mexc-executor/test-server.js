// ============================================================
// test-server.js — сквозная проверка маршрута «хук → ставка»
// с подставным драйвером. Браузер и биржа не нужны.
//
// Проверяется главное, что нельзя увидеть по коду глазами:
//   • ответ 202 приходит БЫСТРЕЕ, чем исполняется ставка
//     (иначе Apps Script упрётся в свой deadline 5с);
//   • ставки исполняются по одной, а не параллельно;
//   • отказ payout перед кликом не занимает слот;
//   • задание, протухшее в очереди, до биржи не доходит.
// ============================================================
"use strict";

const assert = require("assert");
const http = require("http");
const { createApp } = require("./lib/app");

const SECRET = "test-secret";
const cfg = {
  secret: SECRET,
  port: 0,
  dryRun: false,
  stakeUsdt: 125,
  minPayoutPct: 80,
  maxSignalAgeSec: 45,
  globalCap: { maxBets: 5, windowMinutes: 11 },
  symbols: { ETH: "ETH_USDT", BTC: "BTC_USDT" },
  logCsv: null,          // в тесте на диск не пишем
};

// Подставной драйвер: считает вызовы, эмулирует задержку клика
// и следит, что двух ставок одновременно не бывает.
function makeDriver({ delayMs = 300, payout = 80 } = {}) {
  const d = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    async placeBet(symbol, dir, timing, stake) {
      d.inFlight++;
      d.maxInFlight = Math.max(d.maxInFlight, d.inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      d.inFlight--;
      d.calls.push({ symbol, dir, timing, stake, at: Date.now() });
      if (payout < cfg.minPayoutPct)
        return { ok: false, reason: `payout ${payout}% < min ${cfg.minPayoutPct}% (EV<0)`, payout };
      return { ok: true, dryRun: false, payout, stake };
    },
  };
  return d;
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ code: res.statusCode, body: out ? JSON.parse(out) : null }));
      });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function signal(over = {}) {
  return {
    ticker: "ETHUSDT", direction: "UP", price: "1866.18", volume: "0",
    timing: "MEXC _10m", payout: 80, receivedAt: new Date().toISOString(), ...over,
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

(async () => {
  console.log("Сквозной маршрут хука:");

  // ── 1. Быстрый ответ + фактическая ставка ──
  {
    const driver = makeDriver({ delayMs: 400 });
    const { app, drain, state } = createApp({ cfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("неверный токен → 401, драйвер не трогаем", async () => {
      const r = await post(port, "/bet/wrong", signal());
      assert.strictEqual(r.code, 401);
      assert.strictEqual(driver.calls.length, 0);
    });

    await check("ответ 202 приходит быстрее 5с deadline Apps Script", async () => {
      const t0 = Date.now();
      const r = await post(port, `/bet/${SECRET}`, signal());
      const elapsed = Date.now() - t0;
      assert.strictEqual(r.code, 202);
      assert.strictEqual(r.body.status, "accepted");
      assert.ok(elapsed < 200, `ответ занял ${elapsed}мс — должен быть мгновенным`);
      assert.strictEqual(driver.calls.length, 0, "ставка не должна быть готова к моменту ответа");
    });

    await check("ставка доезжает до драйвера после ответа", async () => {
      await drain();
      assert.strictEqual(driver.calls.length, 1);
      assert.deepStrictEqual(
        { symbol: driver.calls[0].symbol, dir: driver.calls[0].dir, timing: driver.calls[0].timing, stake: driver.calls[0].stake },
        { symbol: "ETH_USDT", dir: "UP", timing: 10, stake: 125 });
      assert.strictEqual(state.placed, 1);
    });

    await check("BTC 30m разбирается правильно", async () => {
      await post(port, `/bet/${SECRET}`, signal({ ticker: "BTCUSDT", direction: "SELL", timing: "MEXC _30m", price: "63018.20" }));
      await drain();
      const last = driver.calls[driver.calls.length - 1];
      assert.deepStrictEqual({ symbol: last.symbol, dir: last.dir, timing: last.timing },
        { symbol: "BTC_USDT", dir: "DOWN", timing: 30 });
    });

    srv.close();
  }

  // ── 2. Очередь: пачка сигналов не идёт параллельно ──
  {
    const driver = makeDriver({ delayMs: 150 });
    const { app, drain } = createApp({ cfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("пачка из 4 сигналов исполняется строго по одному", async () => {
      await Promise.all([
        post(port, `/bet/${SECRET}`, signal({ price: "1866.10" })),
        post(port, `/bet/${SECRET}`, signal({ price: "1866.20" })),
        post(port, `/bet/${SECRET}`, signal({ price: "1866.30" })),
        post(port, `/bet/${SECRET}`, signal({ price: "1866.40" })),
      ]);
      await drain();
      assert.strictEqual(driver.calls.length, 4);
      assert.strictEqual(driver.maxInFlight, 1, `одновременно исполнялось ${driver.maxInFlight} ставок — форма суммы сломается`);
    });

    srv.close();
  }

  // ── 3. Кап слотов держится по фактически размещённым ──
  {
    const driver = makeDriver({ delayMs: 10 });
    const { app, drain, state } = createApp({ cfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("6-й сигнал в окне отклоняется (лимит биржи)", async () => {
      for (let i = 0; i < 5; i++) {
        await post(port, `/bet/${SECRET}`, signal({ price: `1866.${10 + i}` }));
        await drain();
      }
      const r = await post(port, `/bet/${SECRET}`, signal({ price: "1867.99" }));
      assert.strictEqual(r.body.status, "rejected");
      assert.match(r.body.reason, /cap: 5\/5/);
      assert.strictEqual(driver.calls.length, 5);
      assert.strictEqual(state.placed, 5);
    });

    srv.close();
  }

  // ── 4. Payout упал за время доставки: слот не занимаем ──
  {
    const driver = makeDriver({ delayMs: 10, payout: 70 });
    const { app, drain, state, betWindow } = createApp({ cfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("отказ по payout перед кликом не занимает слот", async () => {
      // хук сообщил 80% (прошёл FM), но живой payout уже 70%
      await post(port, `/bet/${SECRET}`, signal({ payout: 80 }));
      await drain();
      assert.strictEqual(driver.calls.length, 1, "драйвер вызван — он и должен перепроверить payout");
      assert.strictEqual(state.placed, 0, "ставка не размещена");
      assert.strictEqual(state.rejected, 1);
      assert.strictEqual(betWindow.count(Date.now()), 0, "слот свободен — следующий сигнал не должен упереться в кап");
    });

    srv.close();
  }

  // ── 5. Протухание в очереди ──
  {
    const driver = makeDriver({ delayMs: 900 });
    const slowCfg = { ...cfg, maxSignalAgeSec: 1 };
    const { app, drain, state } = createApp({ cfg: slowCfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("сигнал, протухший в очереди, до биржи не доходит", async () => {
      await post(port, `/bet/${SECRET}`, signal());   // займёт драйвер на 900мс
      // Возраст задаём явно, а не через тайминги планировщика: 0.8с на входе
      // (порог 1с — пропускаем), но после ожидания очереди уже ~1.7с — отбой.
      await post(port, `/bet/${SECRET}`, signal({
        price: "1866.55",
        receivedAt: new Date(Date.now() - 800).toISOString(),
      }));
      await drain();
      assert.strictEqual(driver.calls.length, 1, "второй сигнал должен быть отброшен по возрасту");
      assert.strictEqual(state.placed, 1);
    });

    srv.close();
  }

  // ── 6. Пауза ──
  {
    const driver = makeDriver({ delayMs: 10 });
    const { app, drain } = createApp({ cfg, driver });
    const srv = app.listen(0);
    const port = srv.address().port;

    await check("пауза останавливает поток, resume возвращает", async () => {
      await post(port, `/pause/${SECRET}`, {});
      const r = await post(port, `/bet/${SECRET}`, signal());
      assert.strictEqual(r.body.status, "rejected");
      assert.match(r.body.reason, /paused/);
      await post(port, `/resume/${SECRET}`, {});
      const r2 = await post(port, `/bet/${SECRET}`, signal({ price: "1866.77" }));
      assert.strictEqual(r2.body.status, "accepted");
      await drain();
      assert.strictEqual(driver.calls.length, 1);
    });

    srv.close();
  }

  console.log(`\nСквозные проверки пройдены: ${passed}`);
})().catch((err) => {
  console.error("\nТЕСТ УПАЛ:", err.message);
  process.exit(1);
});
