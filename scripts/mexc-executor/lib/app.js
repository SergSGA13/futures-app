// ============================================================
// lib/app.js — HTTP-слой и очередь исполнения.
//
// Драйвер передаётся снаружи (createApp({cfg, driver})), поэтому
// весь маршрут «хук → допуск → очередь → ставка» проверяется
// тестом с подставным драйвером, без браузера и без биржи.
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const { BetWindow, checkAdmission } = require("./guards");

const LOG_HEADER = "ts,asset,dir,timing,price,payoutHook,payoutLive,payoutSrc,stake,ageSec,latencyMs,status,detail\n";

function createApp({ cfg, driver, notify }) {
  const betWindow = new BetWindow(cfg.globalCap);
  const seen = new Map();  // dedupKey -> timestamp
  const state = {
    paused: false, placed: 0, rejected: 0, errors: 0,
    startedAt: new Date().toISOString(),
  };

  const say = notify || (async () => {});

  function logRow(row) {
    if (!cfg.logCsv) return;
    const file = path.resolve(cfg.logCsv);
    if (!fs.existsSync(file)) fs.writeFileSync(file, LOG_HEADER);
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    fs.appendFileSync(file, row.map(esc).join(",") + "\n");
  }

  // Ставки исполняются СТРОГО ПО ОЧЕРЕДИ: браузер один, параллельные
  // клики по одной странице ломают форму суммы.
  let chain = Promise.resolve();
  function enqueue(job) {
    chain = chain.then(job).catch((err) => {
      state.errors++;
      console.error("job failed:", err);
    });
    return chain;
  }

  async function executeBet(payload, admission, acceptedAtMs) {
    const { asset, dir, timing } = admission;
    const symbol = cfg.symbols[asset];
    const stake = cfg.stakeUsdt;
    const stampMs = new Date(payload.receivedAt || payload.bartime).getTime();

    // Возраст перечитываем на МОМЕНТ ИСПОЛНЕНИЯ: пока задание ждало
    // очереди, сигнал мог протухнуть. Ставить по устаревшему сигналу
    // на 10-минутном горизонте хуже, чем не ставить вовсе.
    const ageNow = (Date.now() - stampMs) / 1000;
    if (ageNow > cfg.maxSignalAgeSec) {
      state.rejected++;
      logRow([new Date().toISOString(), asset, dir, timing, payload.price, payload.payout, "", "", stake,
        ageNow.toFixed(1), Date.now() - acceptedAtMs, "rejected", `stale-in-queue ${ageNow.toFixed(1)}с`]);
      return;
    }

    let result;
    try {
      result = await driver.placeBet(symbol, dir, timing, stake, { dryRun: !!cfg.dryRun });
    } catch (err) {
      state.errors++;
      logRow([new Date().toISOString(), asset, dir, timing, payload.price, payload.payout, "", "", stake,
        ageNow.toFixed(1), Date.now() - acceptedAtMs, "error", err.message]);
      await say(`⚠️ MEXC executor: ошибка ставки ${asset} ${dir} ${timing}м — ${err.message}`);
      return;
    }

    const livePayout = result.payout != null ? result.payout : "";
    const liveSrc = result.source || "";
    if (!result.ok) {
      state.rejected++;
      logRow([new Date().toISOString(), asset, dir, timing, payload.price, payload.payout, livePayout, liveSrc, stake,
        ageNow.toFixed(1), Date.now() - acceptedAtMs, "rejected", result.reason]);
      // Расхождение с фильтром FM — единственная причина, о которой
      // стоит сказать вслух: значит payout упал за время доставки.
      if (String(result.reason).indexOf("payout") >= 0)
        await say(`⛔ MEXC executor: ставка ${asset} ${dir} ${timing}м отменена — ${result.reason}`);
      return;
    }

    // Слот занимаем ТОЛЬКО по факту размещения (в dry-run тоже, чтобы
    // прогон честно моделировал занятость слотов).
    betWindow.record(Date.now());
    state.placed++;
    logRow([new Date().toISOString(), asset, dir, timing, payload.price, payload.payout, livePayout, liveSrc, stake,
      ageNow.toFixed(1), Date.now() - acceptedAtMs, result.dryRun ? "dry-run" : "placed", result.screenshot || ""]);
    console.log(`${result.dryRun ? "[DRY]" : "[LIVE]"} ${asset} ${dir} ${timing}м ` +
      `payout ${livePayout}% stake ${stake} задержка ${((Date.now() - acceptedAtMs) / 1000).toFixed(1)}с`);
  }

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.post("/bet/:token", (req, res) => {
    if (req.params.token !== cfg.secret) return res.status(401).json({ status: "unauthorized" });

    const payload = req.body || {};
    const nowMs = Date.now();

    // Чистим дедуп-таблицу по тому же горизонту, что и окно ставок
    for (const [k, t] of seen) if (nowMs - t > betWindow.windowMs) seen.delete(k);

    const admission = checkAdmission(payload, {
      nowMs, cfg, window: betWindow, seen, paused: state.paused,
    });

    if (!admission.ok) {
      state.rejected++;
      logRow([new Date().toISOString(), payload.ticker || "", payload.direction || "",
        payload.timing || "", payload.price || "", payload.payout, "", "", "", "", 0, "rejected", admission.reason]);
      return res.status(200).json({ status: "rejected", reason: admission.reason });
    }

    seen.set(admission.key, nowMs);
    const job = enqueue(() => executeBet(payload, admission, nowMs));

    // 202 СРАЗУ: у Apps Script deadline 5 секунд (WEBHOOK_TIMEOUT),
    // а клик по странице занимает дольше. Ждать исполнения нельзя —
    // иначе на каждой ставке хук писал бы таймаут.
    res.status(202).json({ status: "accepted", asset: admission.asset, dir: admission.dir });
    return job;
  });

  app.get("/status", (_req, res) => {
    const nowMs = Date.now();
    res.json({
      ...state,
      dryRun: !!cfg.dryRun,
      minPayoutPct: cfg.minPayoutPct,
      stakeUsdt: cfg.stakeUsdt,
      openSlots: `${betWindow.count(nowMs)}/${betWindow.maxBets}`,
    });
  });

  // Пауза без перезапуска
  app.post("/pause/:token", (req, res) => {
    if (req.params.token !== cfg.secret) return res.status(401).end();
    state.paused = true;
    say("⏸ MEXC executor на паузе");
    res.json({ status: "paused" });
  });
  app.post("/resume/:token", (req, res) => {
    if (req.params.token !== cfg.secret) return res.status(401).end();
    state.paused = false;
    say("▶️ MEXC executor снят с паузы");
    res.json({ status: "running" });
  });

  return { app, state, betWindow, seen, drain: () => chain };
}

module.exports = { createApp };
