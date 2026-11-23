/**
 * СБОРЩИК ВЫПЛАТ (payout) — отдельный проект Google Apps Script.
 *
 * Раз в 5 минут снимает текущие выплаты и пишет их в таблицу:
 *   PAYOUTS_LOG — длинный журнал, одна строка = один замер одной комбинации
 *                 Биржа – Сеть – Актив – Направление – Экспирация – Выплата %;
 *   PAYOUTS_NOW — последний снимок по каждой комбинации + состояние источников.
 *
 * Существующие листы (MEXC_PAYOUT, MEXC30_PAYOUT, TOOBIT_PAYOUT, ALLsignal и
 * все остальные) этот код только ЧИТАЕТ или не трогает вовсе.
 *
 * Все имена начинаются с payouts_ / PAYOUTS_, чтобы не пересечься с другими
 * скриптами, но ставить код лучше ОТДЕЛЬНЫМ проектом (см. README.md).
 *
 * Ни id таблицы, ни ключей в коде нет — всё в свойствах скрипта
 * (Настройки проекта → Свойства скрипта):
 *
 *   PAYOUTS_SHEET_ID     — id таблицы Signals Log (из адресной строки).
 *                          Не нужен, если проект создан из самой таблицы.
 *   PAYOUTS_WRITE_MODE   — 'change' (по умолчанию): строка пишется, когда
 *                          выплата изменилась, и не реже раза в час;
 *                          'all': строка на каждый замер каждые 5 минут.
 *   PAYOUTS_HEARTBEAT_MIN — для режима 'change': как часто писать строку,
 *                          даже если ничего не изменилось (по умолчанию 60).
 *   PAYOUTS_KEEP_DAYS    — сколько дней держать в PAYOUTS_LOG (по умолчанию 14).
 *   PAYOUTS_ARCHIVE_ID   — (необязательно) id ОТДЕЛЬНОЙ таблицы-архива. Если
 *                          задан, старые строки переносятся туда, иначе удаляются.
 *   PAYOUTS_SOURCES      — какие источники включены, через запятую
 *                          (по умолчанию 'speed,monitor').
 *   PAYOUTS_SPEED_ASSETS — активы Speed Markets для проверки
 *                          (по умолчанию BTC,ETH,SOL,XRP,DOGE,BNB,ADA,AVAX,LINK,POL).
 *                          Пишутся только те, что контракт сам отмечает
 *                          как поддерживаемые.
 *   PAYOUTS_SPEED_EXPIRIES — экспирации Speed Markets в минутах
 *                          (по умолчанию 1,2,5,10,15,30,60). Лишние, не
 *                          разрешённые контрактом, отбрасываются.
 *   PAYOUTS_RPC_OPTIMISM / _ARBITRUM / _BASE — свой RPC-адрес сети, если
 *                          публичный узел начнёт отказывать (может содержать
 *                          ключ провайдера, поэтому и живёт здесь, а не в коде).
 *   PAYOUTS_AMM_OPTIMISM / _ARBITRUM / _BASE — адрес контракта SpeedMarketsAMM,
 *                          если Thales его сменит.
 */

var PAYOUTS_LOG_SHEET = 'PAYOUTS_LOG';
var PAYOUTS_NOW_SHEET = 'PAYOUTS_NOW';
var PAYOUTS_TZ_LOCAL = 'Europe/Warsaw';
var PAYOUTS_INTERVAL_MIN = 5;

var PAYOUTS_HEADER = [
  'Время UTC', 'Время Варшава', 'Биржа', 'Сеть', 'Актив', 'Направление',
  'Экспирация', 'Выплата %', 'Источник', 'Примечание'
];

// Публичные адреса контрактов SpeedMarketsAMM (прокси) из пакета
// @thales-dao/contracts, scripts/deployments.json. Это открытые ончейн-адреса.
var PAYOUTS_SPEED_NETWORKS = [
  { key: 'OPTIMISM', name: 'Optimism', rpc: 'https://mainnet.optimism.io',
    amm: '0xE16B8a01490835EC1e76bAbbB3Cadd8921b32001' },
  { key: 'ARBITRUM', name: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc',
    amm: '0x02D0123a89Ae6ef27419d5EBb158d1ED4Cf24FA3' },
  { key: 'BASE', name: 'Base', rpc: 'https://mainnet.base.org',
    amm: '0x85b827d133FEDC36B844b20f4a198dA583B25BAA' }
];

// Листы монитора исполнителя: читаем последнюю запись каждого актива.
// Формат: Time | Asset ("ETH 10м") | Payout ("82/72" = up/down) | Source.
var PAYOUTS_MONITOR_SHEETS = [
  { sheet: 'MEXC_PAYOUT', exchange: 'MEXC' },
  { sheet: 'MEXC30_PAYOUT', exchange: 'MEXC' },
  { sheet: 'TOOBIT_PAYOUT', exchange: 'Toobit' }
];
// Запись монитора старше этого считаем устаревшей и не переписываем.
var PAYOUTS_MONITOR_MAX_AGE_MIN = 30;


/* ===================== ТОЧКИ ВХОДА ===================== */

/** Один проход сборщика. Его вызывает триггер раз в 5 минут. */
function payouts_run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.warn('payouts_run: предыдущий проход ещё идёт, пропуск'); return; }
  try {
    var now = new Date();
    var enabled = payouts_list_(payouts_prop_('PAYOUTS_SOURCES') || 'speed,monitor');
    var sources = {
      speed: payouts_sourceSpeed_,
      monitor: payouts_sourceMonitor_
    };
    var rows = [];
    var status = [];
    enabled.forEach(function (name) {
      var fn = sources[name];
      if (!fn) { status.push([name, 'неизвестный источник', '']); return; }
      // Ошибка одного источника не роняет остальные.
      try {
        var res = fn(now);
        res.rows.forEach(function (r) { rows.push(r); });
        status.push([name, res.errors.length ? 'частично: ' + res.errors.join('; ') : 'OK', res.rows.length]);
      } catch (e) {
        console.error('Источник ' + name + ': ' + (e && e.stack || e));
        status.push([name, 'ОШИБКА: ' + payouts_short_(e), 0]);
      }
    });

    rows = rows.filter(payouts_valid_);
    var ss = payouts_ss_();
    var toWrite = payouts_dedup_(rows, now);
    payouts_append_(ss, toWrite);
    payouts_writeNow_(ss, rows, status, now);
    console.log('payouts_run: замеров ' + rows.length + ', записано строк ' + toWrite.length);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ставит триггеры: payouts_run раз в 5 минут и payouts_trim раз в сутки.
 * Трогает только свои триггеры, чужие не удаляет.
 */
function payouts_install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'payouts_run' || h === 'payouts_trim') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('payouts_run').timeBased().everyMinutes(PAYOUTS_INTERVAL_MIN).create();
  ScriptApp.newTrigger('payouts_trim').timeBased().everyDays(1).atHour(3).create();
  payouts_sheet_(payouts_ss_(), PAYOUTS_LOG_SHEET, PAYOUTS_HEADER);
  console.log('Триггеры поставлены. Первый проход запускаю сейчас.');
  payouts_run();
}

/** Снимает свои триггеры (сборщик останавливается, данные остаются). */
function payouts_uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'payouts_run' || h === 'payouts_trim') ScriptApp.deleteTrigger(t);
  });
  console.log('Триггеры сборщика сняты.');
}

/**
 * Ограничение роста PAYOUTS_LOG: строки старше PAYOUTS_KEEP_DAYS дней
 * переносятся в архивную таблицу (если задан PAYOUTS_ARCHIVE_ID) или удаляются.
 */
function payouts_trim() {
  var keepDays = Number(payouts_prop_('PAYOUTS_KEEP_DAYS') || 14);
  if (!(keepDays > 0)) return;
  var ss = payouts_ss_();
  var sh = ss.getSheetByName(PAYOUTS_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = payouts_fmt_(new Date(Date.now() - keepDays * 86400000), 'UTC');
  var times = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues();
  // Журнал дописывается по времени, поэтому старые строки идут подряд сверху.
  var n = 0;
  while (n < times.length && String(times[n][0]) < cutoff) n++;
  if (!n) { console.log('payouts_trim: чистить нечего'); return; }

  var archiveId = payouts_prop_('PAYOUTS_ARCHIVE_ID');
  if (archiveId) {
    var old = sh.getRange(2, 1, n, PAYOUTS_HEADER.length).getValues();
    var arch = SpreadsheetApp.openById(archiveId);
    var ash = payouts_sheet_(arch, PAYOUTS_LOG_SHEET + '_' + String(old[0][0]).slice(0, 7), PAYOUTS_HEADER);
    ash.getRange(ash.getLastRow() + 1, 1, n, PAYOUTS_HEADER.length).setValues(old);
  }
  sh.deleteRows(2, n);
  console.log('payouts_trim: ' + (archiveId ? 'перенесено в архив ' : 'удалено ') + n + ' строк');
}

/**
 * Проверка доступности адреса ИМЕННО С СЕРВЕРОВ GOOGLE.
 * Пример: payouts_probe('https://contract.mexc.com/api/v1/contract/ping')
 * Пишет в журнал код ответа и начало ответа. Ничего не сохраняет.
 */
function payouts_probe(url) {
  url = url || 'https://contract.mexc.com/api/v1/contract/ping';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  console.log(url + ' → HTTP ' + res.getResponseCode() + '\n' + res.getContentText().slice(0, 1500));
}

/** Пробный проход без записи в таблицу: печатает, что было бы записано. */
function payouts_dryRun() {
  var now = new Date();
  var r = payouts_sourceSpeed_(now);
  console.log('Speed: ' + r.rows.length + ' замеров; ошибки: ' + (r.errors.join('; ') || 'нет'));
  r.rows.slice(0, 60).forEach(function (x) { console.log(payouts_rowToArray_(x).join(' | ')); });
  var m = payouts_sourceMonitor_(now);
  console.log('Monitor: ' + m.rows.length + ' замеров; ошибки: ' + (m.errors.join('; ') || 'нет'));
  m.rows.forEach(function (x) { console.log(payouts_rowToArray_(x).join(' | ')); });
}


/* ===================== ИСТОЧНИК: SPEED MARKETS (Thales) ===================== */
/*
 * Выплата считается так же, как в контракте SpeedMarketsAMM:
 *   игрок платит  buyin * (1 + safeBoxImpact + fee),  при выигрыше получает 2 * buyin;
 *   fee = lpFee по времени до экспирации
 *       + skew(направление)
 *       − (skew(направление) == 0 ? skew(обратное) / 2 : 0);
 *   skew = currentRisk / maxRisk * maxSkewImpact.
 * Выплата % = (2 / (1 + safeBoxImpact + fee) − 1) * 100 — чистая прибыль на ставку.
 */

function payouts_sourceSpeed_(now) {
  var assets = payouts_list_(payouts_prop_('PAYOUTS_SPEED_ASSETS') ||
    'BTC,ETH,SOL,XRP,DOGE,BNB,ADA,AVAX,LINK,POL').map(function (s) { return s.toUpperCase(); });
  var expiries = payouts_list_(payouts_prop_('PAYOUTS_SPEED_EXPIRIES') || '1,2,5,10,15,30,60')
    .map(Number).filter(function (x) { return x > 0; });
  var rows = [], errors = [];

  PAYOUTS_SPEED_NETWORKS.forEach(function (net) {
    try {
      var rpc = payouts_prop_('PAYOUTS_RPC_' + net.key) || net.rpc;
      var amm = payouts_prop_('PAYOUTS_AMM_' + net.key) || net.amm;
      payouts_speedNetwork_(net.name, rpc, amm, assets, expiries, now).forEach(function (r) { rows.push(r); });
    } catch (e) {
      errors.push(net.name + ': ' + payouts_short_(e));
    }
  });
  if (!rows.length && errors.length) throw new Error(errors.join('; '));
  return { rows: rows, errors: errors };
}

var PAYOUTS_SEL = {
  lpFee: '0x704ce43e',
  safeBoxImpact: '0xd69fb668',
  maxSkewImpact: '0xe9155866',
  minimalTimeToMaturity: '0x3e7ad1de',
  maximalTimeToMaturity: '0x5403f80f',
  getLengths: '0x023fb259',               // getLengths(address) -> uint[5], [4] = lpFees.length
  timeThresholdsForFees: '0x5631bf8a',    // (uint256)
  lpFees: '0x4eb7c43b',                   // (uint256)
  supportedAsset: '0xe396ed26',           // (bytes32)
  currentRisk: '0x05bfdfd4',              // currentRiskPerAssetAndDirection(bytes32,uint8)
  maxRisk: '0xe11f951d'                   // maxRiskPerAssetAndDirection(bytes32,uint8)
};

function payouts_speedNetwork_(netName, rpc, amm, assets, expiries, now) {
  var ONE = 1e18;
  // Шаг 1: общие параметры + какие активы поддерживаются.
  var calls1 = [
    PAYOUTS_SEL.lpFee, PAYOUTS_SEL.safeBoxImpact, PAYOUTS_SEL.maxSkewImpact,
    PAYOUTS_SEL.minimalTimeToMaturity, PAYOUTS_SEL.maximalTimeToMaturity,
    PAYOUTS_SEL.getLengths + payouts_word_('0')
  ];
  assets.forEach(function (a) { calls1.push(PAYOUTS_SEL.supportedAsset + payouts_b32_(a)); });
  var r1 = payouts_ethCallBatch_(rpc, amm, calls1);

  var lpFeeDefault = payouts_num_(r1[0]) / ONE;
  var safeBox = payouts_num_(r1[1]) / ONE;
  var maxSkew = payouts_num_(r1[2]) / ONE;
  var minMat = payouts_num_(r1[3]);   // секунды
  var maxMat = payouts_num_(r1[4]);   // секунды
  var nFees = payouts_num_(payouts_wordAt_(r1[5], 4));
  if (nFees > 50) throw new Error('странная длина lpFees: ' + nFees);
  var supported = assets.filter(function (a, i) { return payouts_num_(r1[6 + i]) === 1; });
  if (!supported.length) return [];

  // Шаг 2: таблица комиссий по времени + риски по направлениям.
  var calls2 = [];
  for (var i = 0; i < nFees; i++) {
    calls2.push(PAYOUTS_SEL.timeThresholdsForFees + payouts_word_(String(i)));
    calls2.push(PAYOUTS_SEL.lpFees + payouts_word_(String(i)));
  }
  supported.forEach(function (a) {
    [0, 1].forEach(function (dir) {
      calls2.push(PAYOUTS_SEL.currentRisk + payouts_b32_(a) + payouts_word_(String(dir)));
      calls2.push(PAYOUTS_SEL.maxRisk + payouts_b32_(a) + payouts_word_(String(dir)));
    });
  });
  var r2 = payouts_ethCallBatch_(rpc, amm, calls2);
  var thresholds = [], fees = [];
  for (i = 0; i < nFees; i++) {
    thresholds.push(payouts_num_(r2[2 * i]));          // минуты
    fees.push(payouts_num_(r2[2 * i + 1]) / ONE);
  }
  function feeByTime(minutes) {   // как SpeedMarketsAMMUtils.getFeeByTimeThreshold
    for (var k = thresholds.length - 1; k >= 0; k--) if (minutes >= thresholds[k]) return fees[k];
    return lpFeeDefault;
  }

  var okExp = expiries.filter(function (m) {
    return m * 60 >= minMat && (!maxMat || m * 60 <= maxMat);
  });
  var rows = [];
  var base = 2 * nFees;
  supported.forEach(function (asset, ai) {
    var skew = [];
    for (var dir = 0; dir < 2; dir++) {
      var cur = payouts_num_(r2[base + ai * 4 + dir * 2]);
      var max = payouts_num_(r2[base + ai * 4 + dir * 2 + 1]);
      skew.push(max > 0 ? (cur / max) * maxSkew : null);   // null — направление закрыто
    }
    for (var d = 0; d < 2; d++) {
      if (skew[d] === null) continue;
      var discount = skew[d] === 0 && skew[1 - d] !== null ? skew[1 - d] / 2 : 0;
      okExp.forEach(function (m) {
        var fee = feeByTime(m) + skew[d] - discount;
        var pct = (2 / (1 + safeBox + fee) - 1) * 100;
        rows.push({
          ts: now, exchange: 'Speed Market', network: netName, asset: asset,
          direction: d === 0 ? 'UP' : 'DOWN', expiry: payouts_expLabel_(m),
          payout: Math.round(pct * 100) / 100, source: 'onchain',
          note: 'lp ' + payouts_p_(feeByTime(m)) + ' skew ' + payouts_p_(skew[d] - discount) +
                ' safebox ' + payouts_p_(safeBox)
        });
      });
    }
  });
  return rows;
}

function payouts_ethCallBatch_(rpc, to, datas) {
  var body = datas.map(function (data, i) {
    return { jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: to, data: data }, 'latest'] };
  });
  var res = UrlFetchApp.fetch(rpc, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('RPC HTTP ' + code);
  var arr = JSON.parse(res.getContentText());
  if (!Array.isArray(arr)) throw new Error('RPC: ' + payouts_short_(res.getContentText()));
  var out = [];
  arr.forEach(function (x) {
    if (x.error) throw new Error('eth_call #' + x.id + ': ' + (x.error.message || JSON.stringify(x.error)));
    out[x.id] = x.result;
  });
  for (var i = 0; i < datas.length; i++) {
    if (!out[i] || out[i] === '0x') throw new Error('пустой ответ eth_call #' + i);
  }
  return out;
}

function payouts_word_(dec) {
  var h = Number(dec).toString(16);
  return ('0000000000000000000000000000000000000000000000000000000000000000' + h).slice(-64);
}
function payouts_b32_(ascii) {
  var h = '';
  for (var i = 0; i < ascii.length; i++) h += ('0' + ascii.charCodeAt(i).toString(16)).slice(-2);
  return (h + '0000000000000000000000000000000000000000000000000000000000000000').slice(0, 64);
}
function payouts_wordAt_(hex, idx) {
  return '0x' + String(hex).replace(/^0x/, '').substr(idx * 64, 64);
}
function payouts_num_(hex) {
  var h = String(hex).replace(/^0x/, '').replace(/^0+/, '');
  return h ? parseInt(h, 16) : 0;
}
function payouts_p_(x) { return (Math.round(x * 10000) / 100) + '%'; }


/* ===================== ИСТОЧНИК: ЛИСТЫ МОНИТОРА (MEXC / Toobit) ===================== */
/*
 * Только ЧТЕНИЕ существующих листов MEXC_PAYOUT / MEXC30_PAYOUT / TOOBIT_PAYOUT.
 * Берём последнюю запись по каждому активу и переносим в длинный формат.
 * Новая строка в журнале появляется, только когда монитор записал новый замер.
 */

function payouts_sourceMonitor_(now) {
  var ss = payouts_ss_();
  var rows = [], errors = [];
  PAYOUTS_MONITOR_SHEETS.forEach(function (cfg) {
    var sh = ss.getSheetByName(cfg.sheet);
    if (!sh) { errors.push(cfg.sheet + ': листа нет'); return; }
    var last = sh.getLastRow();
    if (last < 2) return;
    var from = Math.max(2, last - 199);
    var vals = sh.getRange(from, 1, last - from + 1, 3).getValues();
    // Последняя запись по каждой метке актива ("ETH 10м").
    var latest = {};
    vals.forEach(function (v) {
      var label = String(v[1] || '').trim();
      if (!label) return;
      var t = v[0] instanceof Date ? v[0] : new Date(v[0]);
      var tt = isNaN(t.getTime()) ? null : t;
      var prev = latest[label];
      if (!prev || !tt || !prev.t || tt >= prev.t) latest[label] = { t: tt, raw: v };
    });
    Object.keys(latest).forEach(function (label) {
      var it = latest[label];
      var m = label.match(/^([A-Za-z0-9]+)\s*(\d+)\s*(м|m|мин|min|ч|h)?/i);
      var p = String(it.raw[2] || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/);
      if (!m || !p) { errors.push(cfg.sheet + ': не разобрал «' + label + ' / ' + it.raw[2] + '»'); return; }
      if (!it.t) { errors.push(cfg.sheet + ': нет времени у «' + label + '»'); return; }
      if (now - it.t > PAYOUTS_MONITOR_MAX_AGE_MIN * 60000) {
        errors.push(cfg.sheet + ' ' + label + ': запись старше ' + PAYOUTS_MONITOR_MAX_AGE_MIN + ' мин');
        return;
      }
      var minutes = Number(m[2]) * (/^(ч|h)$/i.test(m[3] || '') ? 60 : 1);
      var asset = m[1].toUpperCase();
      [['UP', p[1]], ['DOWN', p[2]]].forEach(function (x) {
        rows.push({
          ts: it.t, exchange: cfg.exchange, network: '', asset: asset, direction: x[0],
          expiry: payouts_expLabel_(minutes), payout: Number(String(x[1]).replace(',', '.')),
          source: 'monitor:' + cfg.sheet, note: '', srcKey: String(it.t.getTime())
        });
      });
    });
  });
  return { rows: rows, errors: errors };
}


/* ===================== ЗАПИСЬ ===================== */

function payouts_valid_(r) {
  // Пустые и ошибочные замеры не пишем — и уж точно не как 0.
  return r && r.asset && r.direction && r.expiry &&
    typeof r.payout === 'number' && isFinite(r.payout) && r.payout > 0 && r.payout < 1000;
}

function payouts_key_(r) {
  return [r.exchange, r.network, r.asset, r.direction, r.expiry].join('|');
}

/**
 * Без дублей: одна комбинация пишется не чаще раза за 5-минутный слот
 * (или раз на каждый новый замер монитора). В режиме 'change' — только когда
 * выплата изменилась, плюс контрольная строка раз в PAYOUTS_HEARTBEAT_MIN.
 */
function payouts_dedup_(rows, now) {
  var props = PropertiesService.getScriptProperties();
  var state = {};
  try { state = JSON.parse(props.getProperty('PAYOUTS_STATE') || '{}'); } catch (e) { state = {}; }
  var mode = (payouts_prop_('PAYOUTS_WRITE_MODE') || 'change').toLowerCase();
  var heartbeatMs = Number(payouts_prop_('PAYOUTS_HEARTBEAT_MIN') || 60) * 60000;
  var slotMs = PAYOUTS_INTERVAL_MIN * 60000;
  var out = [];
  rows.forEach(function (r) {
    var k = payouts_key_(r);
    var s = state[k];
    var slot = r.srcKey || String(Math.floor(r.ts.getTime() / slotMs));
    if (s && s.slot === slot) return;                       // этот замер уже записан
    if (mode === 'change' && s && s.p === r.payout && (now.getTime() - s.w) < heartbeatMs) {
      s.slot = slot;                                        // не изменилось — пропускаем
      return;
    }
    state[k] = { slot: slot, p: r.payout, w: now.getTime() };
    out.push(r);
  });
  // Чистим состояние от комбинаций, которых не было больше суток.
  var dayAgo = now.getTime() - 86400000;
  Object.keys(state).forEach(function (k) { if (state[k].w < dayAgo) delete state[k]; });
  props.setProperty('PAYOUTS_STATE', JSON.stringify(state));
  return out;
}

function payouts_append_(ss, rows) {
  if (!rows.length) return;
  var sh = payouts_sheet_(ss, PAYOUTS_LOG_SHEET, PAYOUTS_HEADER);
  rows.sort(function (a, b) { return a.ts - b.ts; });
  var data = rows.map(payouts_rowToArray_);
  var start = sh.getLastRow() + 1;
  // Время пишем текстом 'yyyy-MM-dd HH:mm:ss', чтобы локаль таблицы его не переиначила.
  sh.getRange(start, 1, data.length, 2).setNumberFormat('@');
  sh.getRange(start, 1, data.length, PAYOUTS_HEADER.length).setValues(data);
}

function payouts_writeNow_(ss, rows, status, now) {
  var sh = payouts_sheet_(ss, PAYOUTS_NOW_SHEET, PAYOUTS_HEADER);
  // Старый снимок держим, пока источник молчит; свежие замеры перекрывают его.
  var keep = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, PAYOUTS_HEADER.length).getValues().forEach(function (v) {
      if (!v[2] || !v[4]) return;
      keep[[v[2], v[3], v[4], v[5], v[6]].join('|')] = v;
    });
  }
  rows.forEach(function (r) { keep[payouts_key_(r)] = payouts_rowToArray_(r); });
  var data = Object.keys(keep).map(function (k) { return keep[k]; });
  data.sort(function (a, b) {
    return (String(a[2]) + a[3] + a[4] + a[6] + a[5]).localeCompare(String(b[2]) + b[3] + b[4] + b[6] + b[5]);
  });
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 14).clearContent();
  if (data.length) {
    sh.getRange(2, 1, data.length, 2).setNumberFormat('@');
    sh.getRange(2, 1, data.length, PAYOUTS_HEADER.length).setValues(data);
  }
  // Справа — состояние источников на момент последнего прохода.
  var st = [['Источник', 'Состояние', 'Замеров']].concat(status)
    .concat([['Проход', payouts_fmt_(now, 'UTC') + ' UTC', '']]);
  sh.getRange(1, 12, st.length, 3).setValues(st);
}

function payouts_rowToArray_(r) {
  return [
    payouts_fmt_(r.ts, 'UTC'), payouts_fmt_(r.ts, PAYOUTS_TZ_LOCAL), r.exchange, r.network || '',
    r.asset, r.direction, r.expiry, r.payout, r.source, r.note || ''
  ];
}


/* ===================== ВСПОМОГАТЕЛЬНОЕ ===================== */

function payouts_ss_() {
  var id = payouts_prop_('PAYOUTS_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Не задано свойство скрипта PAYOUTS_SHEET_ID');
  return ss;
}

function payouts_sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function payouts_prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function payouts_list_(s) {
  return String(s).split(',').map(function (x) { return x.trim(); }).filter(String);
}

function payouts_fmt_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss'); }

function payouts_expLabel_(minutes) {
  return minutes % 60 === 0 && minutes >= 60 ? (minutes / 60) + 'ч' : minutes + 'м';
}

function payouts_short_(e) {
  return String(e && e.message || e).slice(0, 200);
}
