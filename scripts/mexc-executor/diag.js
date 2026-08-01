// ============================================================
// diag.js — разбор одного конкретного расхождения: что именно
// видит исполнитель на странице и что отвечает REST.
//
// Отвечает на два вопроса, которые по логу не различить:
//   1) payout читается из REST или из DOM, и какие там числа —
//      разные значения из двух источников означают, что один
//      из них разбирается неверно;
//   2) что вообще есть на странице: поля ввода, кнопки, признаки
//      входа в аккаунт. Плюс снимок экрана.
//
// Ставок НЕ делает, ничего не нажимает. Запуск:
//   node diag.js            # ETH, 10 минут
//   node diag.js BTC 30
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { MexcEventFutures } = require("./lib/mexc");

const CFG_PATH = process.env.EXECUTOR_CONFIG || path.join(__dirname, "config.json");
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));

const [assetArg = "ETH", timingArg = "10"] = process.argv.slice(2);
const asset = assetArg.toUpperCase();
const timing = Number(timingArg);
const symbol = cfg.symbols[asset];
if (!symbol) {
  console.error(`Неизвестный актив: ${asset}. Есть: ${Object.keys(cfg.symbols).join(", ")}`);
  process.exit(1);
}

const driver = new MexcEventFutures(cfg);

(async () => {
  console.log(`=== Диагностика ${asset} (${symbol}), тайминг ${timing} мин ===\n`);

  // ── 1. REST ──
  console.log("1) REST-эндпоинт (тот же, что у mexcPayoutMonitor в Apps Script)");
  let raw = null;
  try {
    const resp = await fetch(cfg.payoutUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" },
    });
    console.log(`   HTTP ${resp.status}`);
    const body = await resp.text();
    console.log(`   размер ответа: ${body.length} байт`);
    try {
      raw = JSON.parse(body);
    } catch (_) {
      console.log(`   ОТВЕТ НЕ JSON, начало: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`   ЗАПРОС НЕ ПРОШЁЛ: ${err.message}`);
  }

  if (raw) {
    // Показываем сырой узел целиком: если разбор даёт странное число,
    // причина будет видна прямо здесь (другое поле, другой масштаб).
    const node = findSymbol(raw, symbol);
    if (!node) {
      console.log(`   символ ${symbol} в ответе НЕ НАЙДЕН`);
    } else {
      const arr = findUnit(node, "MINUTE");
      if (!arr) console.log("   массив MINUTE не найден");
      else {
        console.log(`   найдено вариантов MINUTE: ${arr.length}`);
        for (const o of arr) {
          const mark = o && o.val === timing ? "  <<< используется" : "";
          console.log(`     val=${o && o.val}  upPayRate=${o && o.upPayRate}  downPayRate=${o && o.downPayRate}${mark}`);
        }
      }
    }
  }

  const rest = await driver.fetchPayoutRest(symbol, timing);
  console.log(`   → после разбора: ${rest ? `up ${rest.up}% / down ${rest.down}%` : "null (сработает фолбэк на DOM)"}\n`);

  // ── 2. Страница ──
  console.log("2) Страница в браузере");
  let page;
  try {
    page = await driver.openSymbol(symbol, timing);
  } catch (err) {
    console.log(`   СТРАНИЦА НЕ ОТКРЫЛАСЬ: ${err.message}`);
    await driver.stop();
    process.exit(1);
  }

  console.log(`   URL: ${page.url()}`);
  console.log(`   заголовок: ${await page.title().catch(() => "?")}`);

  const info = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].map((i) => ({
      placeholder: i.placeholder || "",
      type: i.type || "",
      inputmode: i.getAttribute("inputmode") || "",
      visible: !!(i.offsetWidth || i.offsetHeight),
    }));
    const buttons = [...document.querySelectorAll("button")]
      .map((b) => (b.innerText || "").trim())
      .filter((t) => t && t.length < 40);
    return { inputs, buttons, text: document.body.innerText };
  }).catch(() => null);

  if (!info) {
    console.log("   не удалось прочитать содержимое страницы");
  } else {
    const loggedIn = /Wallets|Orders|Assets|Кошел|Активы/i.test(info.text);
    const loginPrompt = /Log ?In|Sign ?Up|Войти|Регистрац/i.test(info.text);
    console.log(`   признаки входа: ${loggedIn ? "ЕСТЬ" : "нет"}${loginPrompt ? " | на странице есть предложение войти" : ""}`);

    console.log(`   полей ввода: ${info.inputs.length}`);
    for (const i of info.inputs.slice(0, 12))
      console.log(`     placeholder="${i.placeholder}" type=${i.type} inputmode=${i.inputmode} видимое=${i.visible}`);

    const uniq = [...new Set(info.buttons)];
    console.log(`   кнопки (${uniq.length}): ${uniq.slice(0, 25).join(" | ")}`);

    // Что нашли бы регулярки payout из конфига
    for (const [name, re] of [["Up", cfg.ui.upPayoutRegex], ["Down", cfg.ui.downPayoutRegex]]) {
      const all = [...info.text.matchAll(new RegExp(re, "g"))].map((m) => m[1]);
      console.log(`   регулярка ${name} payout: ${all.length ? all.join(", ") + `  → берётся последнее: ${all[all.length - 1]}` : "НЕ СОВПАЛА НИ РАЗУ"}`);
    }
  }

  const found = await driver.findAmountInput(page);
  console.log(`   поле суммы: ${found ? `найдено по ${found.selector}` : "НЕ НАЙДЕНО"}`);

  for (const [name, re] of [["Up", cfg.ui.upButton], ["Down", cfg.ui.downButton]]) {
    const cnt = await page.getByRole("button").filter({ hasText: new RegExp(re) }).count().catch(() => -1);
    console.log(`   кнопка ${name} (${re}): найдено ${cnt}`);
  }

  const dom = await driver.readPayoutsDom(symbol, timing);
  console.log(`   → payout из DOM: up ${dom.up}% / down ${dom.down}%`);

  const shotDir = path.resolve(cfg.screenshotsDir || "./screenshots");
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `diag_${Date.now()}_${symbol}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(`\nСнимок экрана: ${shot}`);

  console.log("\n=== Итог ===");
  const restVal = rest ? rest.up : null;
  const domVal = dom.up;
  if (restVal != null && domVal != null && Math.abs(restVal - domVal) > 0.5)
    console.log(`РАСХОЖДЕНИЕ: REST даёт ${restVal}%, страница показывает ${domVal}%. Верить надо странице.`);
  else if (restVal == null)
    console.log("REST не отвечает или не разбирается — payout берётся со страницы.");
  else
    console.log(`Источники согласны: ${restVal}%.`);

  await driver.stop();
  process.exit(0);
})();

function findSymbol(node, symbol) {
  if (node == null || typeof node !== "object") return null;
  if (node.symbol === symbol) return node;
  for (const k in node) {
    const r = findSymbol(node[k], symbol);
    if (r) return r;
  }
  return null;
}

function findUnit(node, unit) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node[unit])) return node[unit];
  for (const k in node) {
    const r = findUnit(node[k], unit);
    if (r) return r;
  }
  return null;
}
