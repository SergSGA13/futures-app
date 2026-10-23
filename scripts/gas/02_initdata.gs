/**
 * ПРОВЕРКА ПОДПИСИ Telegram.WebApp.initData.
 *
 * Мини-приложение - обычная веб-страница, и её код открыт. Если принимать
 * user_id из тела запроса на веру, любой желающий пришлёт чужой id и получит
 * его персональный список каналов вместе с инвайт-ссылками. Поэтому клиент
 * присылает initData целиком, а мы пересчитываем HMAC и сравниваем с hash.
 *
 * Алгоритм Telegram:
 *   secret_key       = HMAC_SHA256(ключ = bot_token, данные = "WebAppData")
 *   data_check_string = пары "ключ=значение" (значения РАСКОДИРОВАНЫ),
 *                       кроме hash и signature, отсортированные по ключу
 *                       и склеенные через \n
 *   hash             = HMAC_SHA256(ключ = secret_key, данные = data_check_string), hex
 */

function validateInitData_(initData) {
  var raw = String(initData || '');
  if (!raw) return { ok: false, error: 'no initData' };

  var pairs = raw.split('&');
  var hash = '';
  var parts = [];
  var map = {};
  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    var k = pairs[i].slice(0, eq);
    var vRaw = pairs[i].slice(eq + 1);
    var v;
    try { v = decodeURIComponent(vRaw); } catch (e) { return { ok: false, error: 'bad encoding' }; }
    if (k === 'hash') { hash = v; continue; }
    map[k] = v;
    // signature - подпись сторонней проверки (Ed25519), в расчёт hash не входит.
    if (k === 'signature') continue;
    parts.push(k + '=' + v);
  }
  if (!hash || !parts.length) return { ok: false, error: 'no hash' };

  parts.sort();
  // Токен ИМЕННО того бота, через которого открыто мини-приложение.
  var secret = Utilities.computeHmacSha256Signature('WebAppData', miniAppBotToken_());
  var sig = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(parts.join('\n')).getBytes(), secret);

  if (!eqConst_(bytesToHex_(sig), String(hash).toLowerCase())) {
    // Самая частая причина не в подделке, а в том, что мини-приложение
    // принадлежит другому боту, чем тот, чей токен лежит в свойствах.
    return { ok: false, error: 'bad signature (проверьте, тем ли ботом открыто мини-приложение: см. MINIAPP_BOT_TOKEN)' };
  }

  var age = Math.floor(Date.now() / 1000) - Number(map.auth_date || 0);
  if (!map.auth_date || age < -60 || age > INITDATA_MAX_AGE_SEC) {
    return { ok: false, error: 'stale auth_date' };
  }

  var user;
  try { user = JSON.parse(map.user || 'null'); } catch (e) { user = null; }
  if (!user || !user.id) return { ok: false, error: 'no user' };

  return { ok: true, user: user, authDate: Number(map.auth_date), startParam: map.start_param || '' };
}

function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    // В Apps Script байты знаковые (-128..127) - приводим к 0..255.
    var b = (bytes[i] + 256) % 256;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// Сравнение без ранних выходов: по времени ответа нельзя угадывать hash по байтам.
function eqConst_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Разовая самопроверка. Открыть мини-приложение, в консоли взять
 * Telegram.WebApp.initData, вставить сюда и запустить - в логе должен
 * появиться ваш user.id.
 */
function testInitData() {
  var sample = '';  // <- вставить строку initData
  if (!sample) { Logger.log('Вставьте initData в переменную sample'); return; }
  Logger.log(JSON.stringify(validateInitData_(sample), null, 2));
}
