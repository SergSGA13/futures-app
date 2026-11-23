// Прицельный поиск адреса с выплатой. Запуск: discoverToobit, потом discoverApex.
function discoverToobit() {
  deepScan_('https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT',
    /payRate|eventFutures|event_futures|eventContract|predict/i);
}

function discoverApex() {
  // Публичный справочник рынков ApeX: ищем в нём event-рынки и выплаты.
  var r = UrlFetchApp.fetch('https://omni.apex.exchange/api/v3/symbols', { muteHttpExceptions: true });
  var t = r.getContentText();
  console.log('apex /api/v3/symbols → HTTP ' + r.getResponseCode() + ', ' + t.length + ' байт');
  try {
    var j = JSON.parse(t), d = j.data || j;
    console.log('Ключи: ' + Object.keys(d).join(', '));
    Object.keys(d).forEach(function (k) {
      if (d[k] && typeof d[k] === 'object') console.log('  ' + k + ': ' + Object.keys(d[k]).slice(0, 30).join(', '));
    });
  } catch (e) {}
  var ctx = t.match(/.{0,150}(payout|event|predict).{0,250}/gi) || [];
  console.log('Совпадения в справочнике (' + ctx.length + '):\n' + ctx.slice(0, 8).join('\n---\n'));
  deepScan_('https://omni.apex.exchange/event/BTCUSDT', /payoutRate|eventSymbol|event-symbol|prediction|\.pp\b/i);
}

function deepScan_(url, focus) {
  var t0 = Date.now();
  var ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36',
             'Accept-Language': 'en-US,en;q=0.9' };
  function get(u) {
    try {
      var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, headers: ua, followRedirects: true });
      return r.getResponseCode() === 200 ? r.getContentText() : '';
    } catch (e) { return ''; }
  }
  function abs(ref, base) {
    if (/^https?:\/\//.test(ref)) return ref;
    if (ref.indexOf('//') === 0) return 'https:' + ref;
    var origin = base.match(/^https?:\/\/[^\/]+/)[0];
    if (ref.charAt(0) === '/') return origin + ref;
    return base.replace(/[^\/]*$/, '') + ref.replace(/^\.\//, '');
  }
  var html = get(url);
  console.log('=== ' + url + ' (' + html.length + ' байт)');
  var prio = [], rest = [], seen = {};
  function add(ref, base) {
    var u = abs(ref, base);
    if (!/\.m?js(\?|$)/.test(u) || seen[u] || /facebook|google|gtag|analytics|sentry|hotjar|wallet|privy|walletconnect/i.test(u)) return;
    seen[u] = true;
    (/event|predict|futures|contract|trade|index|entry|app|main/i.test(u) ? prio : rest).push(u);
  }
  var m, re1 = /(?:src|href)="([^"]+\.m?js[^"]*)"/gi;
  while ((m = re1.exec(html))) add(m[1].replace(/&amp;/g, '&'), url);

  var strs = {}, ctx = [], files = [], n = 0;
  // Любые строки в кавычках с event/predict/payout — пути, имена методов, топики.
  var reStr = /["'`]([A-Za-z0-9_\-\/.:${}?=&]{0,80}(?:event|predict|payout|payrate|odds)[A-Za-z0-9_\-\/.:${}?=&]{0,80})["'`]/gi;
  while ((prio.length || rest.length) && n < 400 && Date.now() - t0 < 300000) {
    var u = prio.length ? prio.shift() : rest.shift(), txt = get(u); n++;
    if (!txt) continue;
    var reRef = /["'`(]((?:https?:)?\/\/[^"'`\s()]+\.m?js|\/?(?:_nuxt|assets|static|js)\/[^"'`\s()]+\.m?js|\.\/[A-Za-z0-9_\-.]+\.m?js)["'`)]/g;
    while ((m = reRef.exec(txt))) add(m[1], u);
    var hit = false;
    while ((m = reStr.exec(txt))) {
      var s = m[1];
      if (/\.(svg|png|jpe?g|webp|css)$/i.test(s) || /^[a-z]{2}(-[A-Z]{2})?\//.test(s)) continue;
      strs[s] = true; hit = true;
    }
    if (focus.test(txt)) {
      hit = true;
      var re = new RegExp('.{0,300}(?:' + focus.source + ').{0,300}', 'gi'), c = txt.match(re) || [];
      for (var i = 0; i < c.length && ctx.length < 25; i++) ctx.push(u.split('/').pop() + ': ' + c[i]);
    }
    if (hit) files.push(u);
  }
  console.log('JS просмотрено: ' + n + ', осталось: ' + (prio.length + rest.length));
  console.log('Файлы с совпадениями (' + files.length + '):\n' + files.slice(0, 40).join('\n'));
  var list = Object.keys(strs).sort();
  console.log('Строки с event/predict/payout (' + list.length + '):\n' + list.slice(0, 250).join('\n'));
  console.log('Контекст (' + ctx.length + '):\n' + ctx.join('\n======\n'));
}
