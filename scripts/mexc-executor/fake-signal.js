// ============================================================
// fake-signal.js — отправить в СВОЙ запущенный сервер сигнал
// того же вида, что шлёт sendMexcWebhook_ из Apps Script.
//
// Нужно, чтобы проверить связку до подключения боевого хука:
// метка receivedAt ставится текущая, иначе сигнал отбраковывается
// по возрасту и руками такое curl'ом не соберёшь.
//
// Запуск:
//   node fake-signal.js                 # ETH UP 10м, payout 80
//   node fake-signal.js BTC DOWN 30 75  # актив, сторона, тайминг, payout
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const CFG_PATH = process.env.EXECUTOR_CONFIG || path.join(__dirname, "config.json");
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const secret = process.env.EXECUTOR_SECRET || cfg.secret;

const [asset = "ETH", dir = "UP", timing = "10", payout = "80"] = process.argv.slice(2);
const price = asset.toUpperCase() === "BTC" ? "63018.20" : "1866.18";

const body = {
  ticker: asset.toUpperCase() === "BTC" ? "BTCUSDT" : "ETHUSDT",
  direction: dir.toUpperCase(),
  price,
  volume: "0",
  text: "тестовый сигнал (fake-signal.js)",
  bartime: new Date().toISOString(),
  timing: `MEXC _${timing}m`,
  payout: Number(payout),
  receivedAt: new Date().toISOString(),
};

const url = `http://127.0.0.1:${cfg.port}/bet/${secret}`;
console.log(`→ POST /bet/*** ${body.ticker} ${body.direction} ${timing}м payout ${payout}%`);

fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
  .then(async (r) => {
    console.log(`← HTTP ${r.status}`, await r.text());
    console.log("\nЧто дальше: сервер отвечает сразу, ставка ставится следом.");
    console.log("Смотрите вывод сервера и executor_log.csv — там результат.");
  })
  .catch((err) => {
    console.error("Сервер не ответил:", err.message);
    console.error(`Проверьте, что запущен \`npm start\` и порт ${cfg.port} тот же.`);
    process.exit(1);
  });
