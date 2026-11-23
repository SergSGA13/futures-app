/**
 * СБОРЩИК ВЫПЛАТ (payout) — отдельный проект Google Apps Script.
 *
 * Раз в 5 минут снимает текущие выплаты и пишет их в таблицу:
 *   PAYOUTS_LOG — длинный журнал, одна строка = один замер одной комбинации
 *                 Биржа – Сеть – Актив – Направление – Экспирация – Выплата %;
 *   PAYOUTS_NOW — последний снимок по каждой комбинации + состояние источников;
 *   PAYOUTS_DAILY — среднее, минимум и максимум за день (по Варшаве)
 *                 по КАЖДОМУ 5-минутному замеру, в каком бы режиме ни писался журнал.
 *
 * MEXC не собирается и не запрашивается вовсе.
 * Существующие листы (TOOBIT_PAYOUT — только чтение; MEXC_PAYOUT, ALLsignal и
 * все остальные) этот код не меняет.
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
 *                          (по умолчанию 'speed,toobit'). 'monitor' — копия
 *                          листа TOOBIT_PAYOUT, если он вдруг нужен.
 *   PAYOUTS_TOOBIT_ASSETS — активы Toobit (по умолчанию BTC,ETH,SOL,XRP).
 *   PAYOUTS_MONITOR_TZ   — часовой пояс времени в листе монитора вида
 *                          «23.11 22:15» (по умолчанию Europe/Warsaw).
 *   PAYOUTS_SPEED_ASSETS — активы Speed Markets для проверки
 *                          (по умолчанию ETH,BTC).
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

var PAYOUTS_DEFAULT_SOURCES = 'speed,toobit';
var PAYOUTS_LOG_SHEET = 'PAYOUTS_LOG';
var PAYOUTS_NOW_SHEET = 'PAYOUTS_NOW';
var PAYOUTS_DAILY_SHEET = 'PAYOUTS_DAILY';
var PAYOUTS_DAILY_HEADER = [
  'Дата (Варшава)', 'Биржа', 'Сеть', 'Актив', 'Направление', 'Экспирация',
  'Средняя %', 'Мин %', 'Макс %', 'Замеров'
];
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
// Формат: Time ("23.11 22:15") | Asset ("ETH 10м") | Payout ("82/72" = up/down) | Source.
// MEXC сознательно не включён.
var PAYOUTS_MONITOR_SHEETS = [
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
    var enabled = payouts_list_(payouts_prop_('PAYOUTS_SOURCES') || PAYOUTS_DEFAULT_SOURCES);
    var sources = {
      speed: payouts_sourceSpeed_,
      toobit: payouts_sourceToobit_,
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
    var d = payouts_dedup_(rows, now);
    payouts_append_(ss, d.write);
    payouts_writeNow_(ss, rows, status, now);
    payouts_daily_(ss, d.fresh, now);
    console.log('payouts_run: замеров ' + rows.length + ', новых ' + d.fresh.length +
      ', записано в журнал ' + d.write.length);
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
  // Google не даёт удалить все строки листа, кроме закреплённой: оставим пустую.
  if (sh.getMaxRows() <= n + 1) sh.insertRowsAfter(sh.getMaxRows(), 1);
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

/**
 * Поиск, откуда страница биржи берёт выплату (для Toobit, ApeX и т.п.).
 * Запрос идёт С СЕРВЕРОВ GOOGLE, не с вашего IP. Ничего не сохраняет.
 * Пример: payouts_discover('https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT')
 * Печатает: код ответа, есть ли «payout» прямо в HTML, и пути API из
 * скриптов страницы, похожие на event / predict / payout / odds.
 * Результат журнала пришлите — по нему подключается источник.
 */
function payouts_discover(url) {
  url = url || 'https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT';
  var ua = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' };
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: ua });
  var html = res.getContentText();
  console.log(url + ' → HTTP ' + res.getResponseCode() + ', ' + html.length + ' байт');
  var hits = html.match(/.{0,120}payout.{0,160}/gi) || [];
  console.log('«payout» в HTML: ' + hits.length + '\n' + hits.slice(0, 5).join('\n---\n'));
  var origin = url.match(/^https?:\/\/[^\/]+/)[0];
  var scripts = [], m, re = /<script[^>]+src="([^"]+)"/gi;
  while ((m = re.exec(html))) scripts.push(m[1].indexOf('http') === 0 ? m[1] : m[1].charAt(0) === '/' ? (m[1].charAt(1) === '/' ? 'https:' + m[1] : origin + m[1]) : origin + '/' + m[1]);
  console.log('Скриптов на странице: ' + scripts.length);
  var found = {};
  var pathRe = /["'`]((?:https?:\/\/[a-z0-9.\-]+)?\/[a-z0-9_\-\/.{}$]*(?:event|predict|payout|odds|option|binary|updown|up-down)[a-z0-9_\-\/.{}$?=&]*)["'`]/gi;
  [html].concat(scripts.slice(0, 40).map(function (u) {
    try { return UrlFetchApp.fetch(u, { muteHttpExceptions: true, headers: ua }).getContentText(); } catch (e) { return ''; }
  })).forEach(function (txt) {
    var x;
    while ((x = pathRe.exec(txt))) if (x[1].length < 200) found[x[1]] = true;
  });
  var list = Object.keys(found).sort();
  console.log('Похожие пути API (' + list.length + '):\n' + list.slice(0, 150).join('\n'));
}

/** Пробный проход без записи в таблицу: печатает, что было бы записано. */
function payouts_dryRun() {
  var now = new Date();
  var fns = { speed: payouts_sourceSpeed_, toobit: payouts_sourceToobit_, monitor: payouts_sourceMonitor_ };
  payouts_list_(payouts_prop_('PAYOUTS_SOURCES') || PAYOUTS_DEFAULT_SOURCES).forEach(function (name) {
    try {
      var r = fns[name](now);
      console.log(name + ': ' + r.rows.length + ' замеров; ошибки: ' + (r.errors.join('; ') || 'нет'));
      r.rows.slice(0, 80).forEach(function (x) { console.log(payouts_rowToArray_(x).join(' | ')); });
    } catch (e) {
      console.log(name + ': ОШИБКА ' + payouts_short_(e));
    }
  });
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
  var assets = payouts_list_(payouts_prop_('PAYOUTS_SPEED_ASSETS') || 'ETH,BTC').map(function (s) { return s.toUpperCase(); });
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


/* ===================== ИСТОЧНИК: TOOBIT (event futures) ===================== */
/*
 * Тот же запрос, которым страница toobit.com/…/event-futures получает список
 * рынков: GET @bapi/v1/event/contract/symbol/list, без входа в аккаунт.
 * У каждого актива cycleList — экспирации, и у каждой longPayRate (UP) и
 * shortPayRate (DOWN) в процентах: «бонус = (1 + выплата) × сумма», т.е. это
 * чистая прибыль на ставку — как и наша колонка «Выплата %».
 * Запрос идёт с серверов Google, не с вашего IP.
 */

var PAYOUTS_TOOBIT_PATH = '/v1/event/contract/symbol/list';
// Проверено с серверов Google: отвечает JSON {"code":200,"data":[…]}.
var PAYOUTS_TOOBIT_BASES = [
  'https://bapi.toobit.com/bapi'
];

function payouts_sourceToobit_(now) {
  var want = payouts_list_(payouts_prop_('PAYOUTS_TOOBIT_ASSETS') || 'BTC,ETH,SOL,XRP')
    .map(function (x) { return x.toUpperCase(); });
  var list = payouts_toobitFetch_();
  var rows = [], errors = [], seen = {};
  list.forEach(function (sym) {
    var name = String(sym.symbolName || sym.symbolId || '');
    var asset = (name.match(/^[A-Za-z0-9]+?(?=[-_]?(?:SWAP|USDT|USD|$))/) || [name])[0].toUpperCase();
    if (want.indexOf(asset) < 0) return;
    seen[asset] = true;
    if (sym.status !== undefined && Number(sym.status) !== 1) { errors.push(asset + ': рынок выключен'); return; }
    if (Number(sym.allowOpen) === 2) { errors.push(asset + ': торговля приостановлена'); return; }
    (sym.cycleList || []).forEach(function (c) {
      var minutes = payouts_cycleMinutes_(c.code);
      if (!minutes) { errors.push(asset + ': не понял экспирацию «' + c.code + '»'); return; }
      [['UP', c.longPayRate], ['DOWN', c.shortPayRate]].forEach(function (x) {
        var v = Number(x[1]);
        if (x[1] === null || x[1] === undefined || x[1] === '' || !isFinite(v)) return;
        rows.push({
          ts: now, exchange: 'Toobit', network: '', asset: asset, direction: x[0],
          expiry: payouts_expLabel_(minutes), payout: Math.round(v * 100) / 100,
          source: 'toobit-api',
          note: 'cycle ' + c.code + (Number(c.payRateType) === 3 ? ' (акция)' : '')
        });
      });
    });
  });
  want.forEach(function (a) { if (!seen[a]) errors.push(a + ': нет в списке Toobit'); });
  if (!rows.length) throw new Error('нет данных: ' + (errors.join('; ') || 'пустой ответ'));
  return { rows: rows, errors: errors };
}

/** Запрашивает список; рабочий адрес запоминает в свойствах скрипта. */
function payouts_toobitFetch_() {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty('PAYOUTS_TOOBIT_BASE');
  var bases = saved ? [saved].concat(PAYOUTS_TOOBIT_BASES.filter(function (b) { return b !== saved; }))
                    : PAYOUTS_TOOBIT_BASES;
  var tried = [];
  for (var i = 0; i < bases.length; i++) {
    var url = bases[i] + PAYOUTS_TOOBIT_PATH;
    try {
      var res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true, followRedirects: true,
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json',
                   'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36' }
      });
      var code = res.getResponseCode(), txt = res.getContentText();
      if (code !== 200) { tried.push(url + ' → HTTP ' + code); continue; }
      var j = JSON.parse(txt);
      var data = Array.isArray(j) ? j : (j.data || j.result || []);
      if (data && !Array.isArray(data) && Array.isArray(data.list)) data = data.list;
      if (!Array.isArray(data) || !data.length || !data[0].cycleList) {
        tried.push(url + ' → не тот ответ: ' + txt.slice(0, 120));
        continue;
      }
      if (saved !== bases[i]) props.setProperty('PAYOUTS_TOOBIT_BASE', bases[i]);
      return data;
    } catch (e) {
      tried.push(url + ' → ' + payouts_short_(e));
    }
  }
  throw new Error('Toobit не ответил: ' + tried.join(' | '));
}

/** Экспирация Toobit → минуты: '10m', '1h', '5min', '600' (секунды), '10' (минуты). */
function payouts_cycleMinutes_(code) {
  var s = String(code || '').trim().toLowerCase();
  var m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|мин|м|h|hr|ч|d|д)?$/);
  if (!m) return 0;
  var n = Number(m[1]), u = m[2] || '';
  if (/^(s|sec)$/.test(u)) return n / 60;
  if (/^(h|hr|ч)$/.test(u)) return n * 60;
  if (/^(d|д)$/.test(u)) return n * 1440;
  if (u) return n;
  return n >= 120 && n % 60 === 0 ? n / 60 : n;   // голое число: 300/600 → секунды
}


/** Пробный запрос к Toobit: печатает сырой ответ по первому активу. */
function payouts_testToobit() {
  var list = payouts_toobitFetch_();
  console.log('Адрес: ' + PropertiesService.getScriptProperties().getProperty('PAYOUTS_TOOBIT_BASE') +
    PAYOUTS_TOOBIT_PATH + '\nАктивов: ' + list.length + ': ' +
    list.map(function (x) { return x.symbolName || x.symbolId; }).join(', '));
  console.log('Первый актив целиком:\n' + JSON.stringify(list[0]).slice(0, 2500));
  var r = payouts_sourceToobit_(new Date());
  console.log('Разобрано: ' + r.rows.length + '; замечания: ' + (r.errors.join('; ') || 'нет'));
  r.rows.forEach(function (x) { console.log(payouts_rowToArray_(x).join(' | ')); });
}


/* ===================== ИСТОЧНИК: ЛИСТ МОНИТОРА (Toobit) ===================== */
/*
 * Только ЧТЕНИЕ существующего листа TOOBIT_PAYOUT. Сам Toobit не запрашивается.
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
      var tt = payouts_parseMonitorTime_(v[0], now);
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


/**
 * Время монитора: дата из таблицы или текст «23.11 22:15» (день.месяц часы:минуты,
 * по PAYOUTS_MONITOR_TZ). Год берётся текущий; если дата выходит в будущее
 * больше чем на сутки (запись 31.12 прочитана 1 января) — прошлый.
 */
function payouts_parseMonitorTime_(v, now) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var m = String(v || '').trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    var t = new Date(v);
    return isNaN(t.getTime()) ? null : t;
  }
  var tz = payouts_prop_('PAYOUTS_MONITOR_TZ') || PAYOUTS_TZ_LOCAL;
  var year = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(Utilities.formatDate(now, tz, 'yyyy'));
  function build(y) {
    var iso = y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' +
      ('0' + m[4]).slice(-2) + ':' + m[5] + ':' + (m[6] || '00');
    // Переводим «местное» время пояса tz в настоящий момент времени.
    var guess = new Date(iso + 'Z');
    var off = payouts_tzOffsetMin_(guess, tz);
    return new Date(guess.getTime() - off * 60000);
  }
  var t2 = build(year);
  if (!m[3] && t2 - now > 86400000) t2 = build(year - 1);
  return isNaN(t2.getTime()) ? null : t2;
}

/** Смещение пояса tz от UTC в минутах в момент d (учитывает летнее время). */
function payouts_tzOffsetMin_(d, tz) {
  var z = Utilities.formatDate(d, tz, 'Z');   // например +0100
  var sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (Number(z.substr(1, 2)) * 60 + Number(z.substr(3, 2)));
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
  var out = [], fresh = [];
  rows.forEach(function (r) {
    var k = payouts_key_(r);
    var s = state[k];
    var slot = r.srcKey || String(Math.floor(r.ts.getTime() / slotMs));
    if (s && s.slot === slot) return;                       // этот замер уже учтён
    fresh.push(r);                                          // новый замер — идёт в дневное среднее
    if (mode === 'change' && s && s.p === r.payout && (now.getTime() - s.w) < heartbeatMs) {
      s.slot = slot;                                        // не изменилось — в журнал не пишем
      return;
    }
    state[k] = { slot: slot, p: r.payout, w: now.getTime() };
    out.push(r);
  });
  // Чистим состояние от комбинаций, которых не было больше суток.
  var dayAgo = now.getTime() - 86400000;
  Object.keys(state).forEach(function (k) { if (state[k].w < dayAgo) delete state[k]; });
  props.setProperty('PAYOUTS_STATE', JSON.stringify(state));
  return { write: out, fresh: fresh };
}

/**
 * Дневное среднее по Варшаве: копит сумму, число, мин и макс каждого нового
 * замера и переписывает строки СЕГОДНЯШНЕГО дня внизу PAYOUTS_DAILY.
 * Прошедшие дни остаются в листе как есть.
 */
function payouts_daily_(ss, fresh, now) {
  var props = PropertiesService.getScriptProperties();
  var acc;
  try { acc = JSON.parse(props.getProperty('PAYOUTS_DAILY_ACC') || 'null'); } catch (e) { acc = null; }
  var sh = payouts_sheet_(ss, PAYOUTS_DAILY_SHEET, PAYOUTS_DAILY_HEADER);
  var today = Utilities.formatDate(now, PAYOUTS_TZ_LOCAL, 'yyyy-MM-dd');
  if (!acc || acc.date !== today) acc = { date: today, c: {} };   // новый день: вчерашние строки уже в листе
  fresh.forEach(function (r) {
    // Замер монитора, сделанный вчера, во вчерашний день уже не попадёт — пропускаем.
    if (Utilities.formatDate(r.ts, PAYOUTS_TZ_LOCAL, 'yyyy-MM-dd') !== today) return;
    var k = payouts_key_(r);
    var a = acc.c[k] || (acc.c[k] = { s: 0, n: 0, mn: r.payout, mx: r.payout });
    a.s += r.payout; a.n++;
    if (r.payout < a.mn) a.mn = r.payout;
    if (r.payout > a.mx) a.mx = r.payout;
  });
  props.setProperty('PAYOUTS_DAILY_ACC', JSON.stringify(acc));

  var keys = Object.keys(acc.c).sort();
  if (!keys.length) return;
  // Сегодняшние строки идут подряд в конце листа — стираем их и пишем заново.
  var last = sh.getLastRow();
  var first = last + 1;
  if (last >= 2) {
    var dates = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    while (first - 2 > 0 && String(dates[first - 3][0]) === today) first--;
    if (first <= last) sh.getRange(first, 1, last - first + 1, PAYOUTS_DAILY_HEADER.length).clearContent();
  }
  var data = keys.map(function (k) {
    var p = k.split('|'), a = acc.c[k];
    return [today, p[0], p[1], p[2], p[3], p[4],
      Math.round(a.s / a.n * 100) / 100, a.mn, a.mx, a.n];
  });
  sh.getRange(first, 1, data.length, 1).setNumberFormat('@');
  sh.getRange(first, 1, data.length, PAYOUTS_DAILY_HEADER.length).setValues(data);
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
