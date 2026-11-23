// Глубокий поиск: откуда страница берёт выплату. Запуск: discover2.
function discover2() {
  scanSite_('https://www.toobit.com/en-US/event-futures/ETH-SWAP-USDT');
  scanSite_('https://omni.apex.exchange/event/BTCUSDT');
}

function scanSite_(url) {
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

  // 1) Данные, вшитые в страницу (_payload.json у Toobit)
  var pm = html.match(/https?:\/\/[^"'\s<>]+_payload\.json[^"'\s<>]*/);
  if (pm) {
    var p = get(pm[0].replace(/&amp;/g, '&'));
    console.log('payload ' + p.length + ' байт. Начало:\n' + p.slice(0, 1500));
    var pc = p.match(/.{0,100}(payout|ratio|odds|rate).{0,100}/gi) || [];
    console.log('payload, совпадения (' + pc.length + '):\n' + pc.slice(0, 10).join('\n---\n'));
  }

  // 2) Все JS-файлы страницы, включая подгружаемые по ходу
  var queue = [], seen = {};
  function add(ref, base) {
    var u = abs(ref, base);
    if (!/\.m?js(\?|$)/.test(u) || seen[u] || /facebook|google|gtag|analytics|sentry|hotjar/i.test(u)) return;
    seen[u] = true; queue.push(u);
  }
  var m, re1 = /(?:src|href)="([^"]+\.m?js[^"]*)"/gi;
  while ((m = re1.exec(html))) add(m[1].replace(/&amp;/g, '&'), url);

  var apis = {}, hosts = {}, fields = [];
  var reApi = /["'`]((?:https?:\/\/[a-z0-9.\-]+)?\/(?:api|bapi|mapi|fapi|papi|quote|openapi|v\d)\/[A-Za-z0-9_\-\/.${}]*)["'`]/g;
  var reHost = /https?:\/\/[a-z0-9.\-]*(?:api|bapi|ws|wss|stream)[a-z0-9.\-]*\.[a-z]{2,}/gi;
  var reField = /.{0,90}(payoutRatio|payout_ratio|payRatio|payoutRate|oddsRatio|profitRate|returnRate|winRate|odds)\b.{0,90}/g;
  var n = 0;
  while (queue.length && n < 150 && Date.now() - t0 < 140000) {
    var u = queue.shift(), txt = get(u); n++;
    if (!txt) continue;
    var reRef = /["'`(]((?:https?:)?\/\/[^"'`\s()]+\.m?js|\/?(?:_nuxt|assets|static|js)\/[^"'`\s()]+\.m?js|\.\/[A-Za-z0-9_\-.]+\.m?js)["'`)]/g;
    while ((m = reRef.exec(txt))) add(m[1], u);
    while ((m = reApi.exec(txt))) if (m[1].length < 160) apis[m[1]] = true;
    while ((m = reHost.exec(txt))) hosts[m[0].toLowerCase()] = true;
    var f = txt.match(reField) || [];
    for (var i = 0; i < f.length && fields.length < 15; i++) fields.push(f[i]);
  }
  console.log('JS просмотрено: ' + n + ', осталось в очереди: ' + queue.length);
  console.log('Адреса серверов:\n' + Object.keys(hosts).sort().join('\n'));
  var all = Object.keys(apis).sort();
  var key = all.filter(function (a) { return /event|predict|payout|odds|ratio|option|binary|contract|symbol|ticker|config/i.test(a); });
  console.log('Пути API по теме (' + key.length + '):\n' + key.slice(0, 150).join('\n'));
  console.log('Все пути API (' + all.length + '), первые 200:\n' + all.slice(0, 200).join('\n'));
  console.log('Поля с выплатой в коде (' + fields.length + '):\n' + fields.join('\n---\n'));
}
