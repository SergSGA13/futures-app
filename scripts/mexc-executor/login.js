// ============================================================
// login.js — разовый вход в MEXC.
//
// Открывает окно браузера с тем же постоянным профилем, которым
// потом пользуется server.js. Логинитесь руками (включая 2FA),
// нажимаете Enter в терминале — сессия остаётся в профиле, и
// сервер дальше работает без пароля.
//
// Пароль и 2FA НЕ хранятся в конфиге и нигде не логируются:
// в профиле лежат только куки браузера.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CFG_PATH = process.env.EXECUTOR_CONFIG || path.join(__dirname, "config.json");
const cfg = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) : {};
const userDataDir = path.resolve(cfg.userDataDir || "./mexc-profile");

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://www.mexc.com/login", { waitUntil: "domcontentloaded" });

  console.log("\n1) Войдите в аккаунт в открывшемся окне.");
  console.log("2) Откройте раздел Futures → Event Futures и убедитесь, что видите ETHUSDT.");
  console.log("3) Вернитесь сюда и нажмите Enter.\n");

  await new Promise((resolve) => process.stdin.once("data", resolve));

  // Проверяем, что сессия действительно записалась
  await page.goto("https://www.mexc.com/futures/event-futures/ETH_USDT", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  const looksLoggedIn = /Wallets|Orders|Assets|Кошел|Активы/i.test(text);
  console.log(looksLoggedIn
    ? `Профиль сохранён: ${userDataDir}\nМожно запускать: npm start`
    : `Не вижу признаков входа. Проверьте, что залогинились, и повторите.\nПрофиль: ${userDataDir}`);

  await context.close();
  process.exit(0);
})();
