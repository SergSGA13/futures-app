// ============================================================
// server.js — приёмник MEXC-хука из Apps Script v3.9.6.
//
// Подключение (в Apps Script):
//   CONFIG.MEXC.WEBHOOK_URL     = "https://<хост>/bet/<EXECUTOR_SECRET>"
//   CONFIG.MEXC.WEBHOOK_ENABLED = true
//
// Хук приходит ТОЛЬКО для сигналов со status==="sent" ветки MEXC
// (см. mexcDeliver_), то есть фильтры F4/F5/F7/F8/FM уже отработали.
// Тело: { ticker, direction, price, volume, text, bartime,
//         timing: "MEXC _10m"|"MEXC _30m", payout, receivedAt }
// Секрета в теле НЕТ — авторизация по токену в пути URL.
//
// Вся логика маршрута в lib/app.js (проверяется тестом),
// здесь только сборка: конфиг, драйвер, телеграм, запуск.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { MexcEventFutures } = require("./lib/mexc");
const { createApp } = require("./lib/app");

const CFG_PATH = process.env.EXECUTOR_CONFIG || path.join(__dirname, "config.json");
if (!fs.existsSync(CFG_PATH)) {
  console.error(`Нет файла конфигурации: ${CFG_PATH}\nСкопируйте config.example.json → config.json`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
cfg.secret = process.env.EXECUTOR_SECRET || cfg.secret;
if (cfg.telegram) {
  cfg.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram.botToken;
  cfg.telegram.chatId = process.env.TELEGRAM_CHAT_ID || cfg.telegram.chatId;
}
if (!cfg.secret || cfg.secret.startsWith("ПОМЕНЯЙТЕ")) {
  console.error("config.secret не задан. Придумайте длинную случайную строку.");
  process.exit(1);
}

async function notify(text) {
  const tg = cfg.telegram || {};
  if (!tg.botToken || !tg.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("telegram notify failed:", err.message);
  }
}

const driver = new MexcEventFutures(cfg);
const { app, betWindow } = createApp({ cfg, driver, notify });

const server = app.listen(cfg.port, async () => {
  console.log(`MEXC executor слушает :${cfg.port}`);
  console.log(`  режим: ${cfg.dryRun ? "DRY-RUN (кликов не будет)" : "БОЕВОЙ — ставки реальные"}`);
  console.log(`  ставка ${cfg.stakeUsdt} USDT, порог payout ${cfg.minPayoutPct}%, ` +
    `кап ${betWindow.maxBets}/${cfg.globalCap.windowMinutes}мин`);
  console.log(`  хук: POST /bet/<secret>`);
  try {
    await driver.start();
    console.log("  браузер поднят (профиль загружен)");
  } catch (err) {
    console.error("  браузер НЕ поднялся:", err.message, "— запустите `npm run login`");
  }
});

async function shutdown() {
  console.log("\nостановка…");
  server.close();
  await driver.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
