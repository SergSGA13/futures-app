// ============================================================
// monitor.js — диагностический логгер payout (браузер не нужен).
//
// Опрашивает тот же REST-эндпоинт, что и mexcPayoutMonitor()
// в Apps Script, и пишет CSV. Нужен для двух вещей:
//   1) проверить, что эндпоинт вообще отвечает с вашего сервера
//      (у Apps Script и вашей машины разные IP и лимиты);
//   2) собрать историю payout, чтобы посчитать, какую долю
//      времени payout держится на 80% — то есть сколько сигналов
//      фильтр FM отсекает не из-за стратегии, а из-за биржи.
//
// Ставок не делает. Запуск: npm run monitor
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { MexcEventFutures } = require("./lib/mexc");

const CFG_PATH = process.env.EXECUTOR_CONFIG || path.join(__dirname, "config.json");
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const driver = new MexcEventFutures(cfg);

const file = path.resolve(cfg.payoutCsv || "./payout_log.csv");
if (!fs.existsSync(file)) fs.writeFileSync(file, "ts,asset,timing,up,down,source\n");

const last = new Map();

async function tick() {
  for (const [asset, symbol] of Object.entries(cfg.symbols)) {
    for (const timing of [10, 30]) {
      const p = await driver.fetchPayoutRest(symbol, timing);
      if (!p || p.up == null) {
        console.error(`${new Date().toISOString()} ${asset}@${timing}: REST не ответил`);
        continue;
      }
      const key = `${asset}@${timing}`;
      const sig = `${p.up}/${p.down}`;
      if (last.get(key) === sig) continue;   // пишем только изменения
      last.set(key, sig);
      fs.appendFileSync(file, `${new Date().toISOString()},${asset},${timing},${p.up},${p.down},${p.source}\n`);
      const mark = Math.min(p.up, p.down) < cfg.minPayoutPct ? "⛔ ниже порога" : "✅";
      console.log(`${new Date().toISOString()} ${key}: up ${p.up}% / down ${p.down}% ${mark}`);
    }
  }
}

console.log(`Мониторинг payout, порог ${cfg.minPayoutPct}%, опрос каждые ${cfg.monitorPollSec}с → ${file}`);
tick();
setInterval(tick, (cfg.monitorPollSec || 20) * 1000);
