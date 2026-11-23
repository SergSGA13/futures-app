// Точечный поиск: файлы страницы event-futures Toobit и откуда в них берётся
// _longPayRate / _shortPayRate. Запуск: discoverToobit2. Для ApeX: discoverApex2.
function discoverToobit2() {
  var page = 'https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT';
  var html = get4_(page);
  var entries = [], m, re = /(?:src|href)="([^"]+\.js[^"]*)"/gi;
  while ((m = re.exec(html))) entries.push(abs4_(m[1].replace(/&amp;/g, '&'), page));

  // Ищем файл-маршрутизатор: в нём есть маршрут event-futures-symbol___en-US.
  var router = null, rtxt = '';
  var queue = entries.slice(), seen = {}, n = 0;
  while (queue.length && n < 60 && !router) {
    var u = queue.shift(); if (seen[u]) continue; seen[u] = true; n++;
    var t = get4_(u);
    if (t.indexOf('event-futures-symbol___en-US') >= 0) { router = u; rtxt = t; break; }
    var r2 = /["'`(](\.\/[A-Za-z0-9_\-.]+\.js)["'`)]/g;
    while ((m = r2.exec(t))) queue.push(abs4_(m[1], u));
  }
  if (!router) { console.log('Маршрутизатор не найден, просмотрено ' + n); return; }
  console.log('Маршрутизатор: ' + router);

  // Файлы, которые грузит маршрут event-futures-symbol___en-US.
  var i0 = rtxt.indexOf('event-futures-symbol___en-US');
  var seg = rtxt.slice(i0, i0 + 1500);
  var imp = seg.match(/import\("(\.\/[^"]+\.js)"\)/);
  var deps = seg.match(/__vite__mapDeps\(\[([0-9,]+)\]/);
  var files = [];
  if (imp) files.push(abs4_(imp[1], router));
  var list = rtxt.match(/m\.f\s*\|\|\s*\(m\.f\s*=\s*\[([^\]]+)\]/) || rtxt.match(/\[("\.\/[^\]]{1000,})\]/);
  if (deps && list) {
    var names = list[1].split(',').map(function (s) { return s.replace(/["'\s]/g, ''); });
    deps[1].split(',').forEach(function (k) {
      var f = names[Number(k)];
      if (f && /\.js$/.test(f)) files.push(abs4_(f, router));
    });
  }
  console.log('Файлов страницы: ' + files.length + ' (главный: ' + (imp ? imp[1] : '—') + ')');

  var ctx = {}, apis = {}, ws = {}, cnt = 0;
  var focus = /.{0,350}(_longPayRate|_shortPayRate|longPayRate|shortPayRate|payRate|event-futures-config|eventFuturesStore).{0,350}/g;
  var reApi = /["'`]((?:https?:\/\/[a-z0-9.\-]+)?\/?[a-z0-9_\-]*\/?(?:api|quote|mapi|bapi|v1|v2|v3)\/[A-Za-z0-9_\-\/.${}]{2,120})["'`]/g;
  var reWs = /wss?:\/\/[A-Za-z0-9.\-\/${}_]+/g;
  files.forEach(function (u) {
    var t = get4_(u); if (!t) return;
    var c = t.match(focus) || [];
    c.forEach(function (x) { if (cnt < 18 && !ctx[x]) { ctx[x] = u.split('/').pop(); cnt++; } });
    while ((m = reApi.exec(t))) apis[m[1]] = true;
    while ((m = reWs.exec(t))) ws[m[0]] = true;
  });
  console.log('Пути API в файлах страницы:\n' + Object.keys(apis).sort().slice(0, 120).join('\n'));
  console.log('WebSocket-адреса:\n' + Object.keys(ws).slice(0, 20).join('\n'));
  console.log('Где берётся выплата (' + cnt + '):\n' +
    Object.keys(ctx).map(function (x) { return ctx[x] + ': ' + x; }).join('\n======\n'));
}

// Адрес запроса symbolList (список рынков с longPayRate/shortPayRate). Запуск: discoverToobit3.
function discoverToobit3() {
  var page = 'https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT';
  var html = get4_(page);
  var queue = [], m, re = /(?:src|href)="([^"]+\.js[^"]*)"/gi;
  while ((m = re.exec(html))) queue.push(abs4_(m[1].replace(/&amp;/g, '&'), page));
  var seen = {}, n = 0, out = [], t0 = Date.now();
  var focus = /.{0,250}(symbolList\s*:|baseURL|baseUrl|apiPrefix|API_HOST|apiHost).{0,250}/g;
  while (queue.length && n < 500 && out.length < 14 && Date.now() - t0 < 300000) {
    var u = queue.shift(); if (seen[u]) continue; seen[u] = true; n++;
    var t = get4_(u); if (!t) continue;
    var r2 = /["'`(](\.\/[A-Za-z0-9_\-.]+\.js)["'`)]/g;
    while ((m = r2.exec(t))) { var v = abs4_(m[1], u); if (!seen[v]) queue.push(v); }
    var c = t.match(focus) || [];
    c.forEach(function (x) { if (out.length < 14) out.push(u.split('/').pop() + ': ' + x); });
  }
  console.log('Просмотрено файлов: ' + n);
  console.log('Найдено (' + out.length + '):\n' + out.join('\n======\n'));
}

function discoverApex2() {
  var base = 'https://omni.apex.exchange/api/v3';
  var t = get4_(base + '/symbols');
  console.log('symbols: ' + t.length + ' байт');
  var ev = JSON.parse(t).data.eventConfig || {};
  console.log('eventConfig.global: ' + JSON.stringify(ev.global).slice(0, 1500));
  var list = ev.contract || [];
  console.log('Event-рынков: ' + list.length);
  list.forEach(function (c) {
    console.log(' - ' + [c.symbol, c.crossSymbolName, c.symbolDisplayName, c.contractId, c.enableTrade].join(' | '));
  });
  if (list[0]) console.log('Первый рынок целиком:\n' + JSON.stringify(list[0]).slice(0, 3500));
  var sym = list[0] ? list[0].symbol : 'BTCUSDT';
  var cross = list[0] ? (list[0].crossSymbolName || sym) : 'BTCUSDT';
  [
    '/event/price', '/event/price?symbol=' + sym, '/event/price?symbol=' + cross,
    '/ticker?symbol=' + sym, '/ticker?symbol=' + cross,
    '/event/kline?symbol=' + sym + '&interval=1&limit=1'
  ].forEach(function (path) {
    var r = UrlFetchApp.fetch(base + path, { muteHttpExceptions: true });
    console.log(path + ' → HTTP ' + r.getResponseCode() + '\n' + r.getContentText().slice(0, 800));
  });
}

function get4_(u) {
  try {
    var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36' } });
    return r.getResponseCode() === 200 ? r.getContentText() : '';
  } catch (e) { return ''; }
}

function abs4_(ref, base) {
  if (/^https?:\/\//.test(ref)) return ref;
  if (ref.indexOf('//') === 0) return 'https:' + ref;
  var origin = base.match(/^https?:\/\/[^\/]+/)[0];
  if (ref.charAt(0) === '/') return origin + ref;
  return base.replace(/[^\/]*$/, '') + ref.replace(/^\.\//, '');
}
