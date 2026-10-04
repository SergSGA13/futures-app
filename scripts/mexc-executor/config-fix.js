// Починка config.json после ручной правки. Типовые поломки - лишняя
// закрывающая скобка после вставленного блока, пропущенная запятая между
// блоками, запятая перед "}" - чинятся перебором: пробуем по одной
// правке рядом с местом ошибки и берём первую, после которой файл
// читается И устроен правильно (все биржи внутри "exchanges", ни одна не
// вложена в другую). Текст правим точечно, форматирование не трогаем.

const looksLikeExchange = v => v && typeof v === 'object' && !Array.isArray(v)
  && ('urls' in v || 'driver' in v || 'signalTimings' in v);

// Устройство конфига: null - всё в порядке, иначе что не так.
function structureProblem(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'корень - не объект';
  if (!('port' in c) && !('secret' in c)) return 'нет port и secret на верхнем уровне';
  if (!c.exchanges || typeof c.exchanges !== 'object') return 'нет раздела exchanges';
  for (const [k, v] of Object.entries(c)) {
    if (k !== 'exchanges' && looksLikeExchange(v)) return `биржа "${k}" лежит вне exchanges`;
  }
  for (const [k, v] of Object.entries(c.exchanges)) {
    if (!looksLikeExchange(v)) return `"${k}" внутри exchanges - не биржа`;
    for (const [k2, v2] of Object.entries(v)) {
      if (looksLikeExchange(v2)) return `биржа "${k2}" вложена в "${k}"`;
    }
  }
  return null;
}

function errPos(text, e) {
  const pos = Number((/position (\d+)/.exec(e.message) || [])[1]);
  if (Number.isFinite(pos)) return pos;
  const ln = Number((/line (\d+)/.exec(e.message) || [])[1]);
  const col = Number((/column (\d+)/.exec(e.message) || [])[1]) || 1;
  if (!ln) return text.length;
  const lines = text.split('\n');
  return lines.slice(0, ln - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
}

// Возможные правки рядом с позицией ошибки, ближние - первыми.
function candidates(text, pos) {
  const out = [];
  const lineStart = i => text.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = i => { const e = text.indexOf('\n', i); return e < 0 ? text.length : e + 1; };
  const lineNo = i => text.slice(0, i).split('\n').length;
  // 1. Удалить строку, где только закрывающая скобка (с запятой или без).
  let i = lineStart(Math.min(pos, text.length));
  for (let k = 0; k < 40 && i >= 0; k++) {
    const s = lineStart(i), e = lineEnd(s);
    const line = text.slice(s, e);
    if (/^\s*[}\]],?\s*$/.test(line)) {
      out.push({ text: text.slice(0, s) + text.slice(e), what: `убрана лишняя «${line.trim()}» (строка ${lineNo(s)})` });
    }
    if (s === 0) break;
    i = s - 1;
  }
  // 2. Вставить пропущенную запятую после последнего значения перед ошибкой.
  let j = pos - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j >= 0 && text[j] !== ',' && text[j] !== '{' && text[j] !== '[') {
    out.push({ text: text.slice(0, j + 1) + ',' + text.slice(j + 1), what: `добавлена запятая (строка ${lineNo(j)})` });
  }
  // 3. Убрать висячую запятую перед ошибкой.
  if (j >= 0 && text[j] === ',') {
    out.push({ text: text.slice(0, j) + text.slice(j + 1), what: `убрана лишняя запятая (строка ${lineNo(j)})` });
  }
  return out;
}

// Годится ли прочитанный конфиг: устроен правильно сразу или после
// переноса бирж, вставленных снаружи exchanges.
function acceptable(obj) {
  if (!structureProblem(obj)) return true;
  const copy = JSON.parse(JSON.stringify(obj));
  moveStrayExchanges(copy);
  return !structureProblem(copy);
}

// Возвращает { text, obj, fixes } или null, если починить не удалось.
function repair(text, maxFixes = 4) {
  const fixes = [];
  let cur = text;
  for (let round = 0; round <= maxFixes; round++) {
    let err;
    try {
      const obj = JSON.parse(cur);
      if (!acceptable(obj)) return null;
      return { text: cur, obj, fixes };
    } catch (e) { err = e; }
    if (round === maxFixes) return null;
    const pos = errPos(cur, err);
    let best = null;
    for (const c of candidates(cur, pos)) {
      try {
        const obj = JSON.parse(c.text);
        if (acceptable(obj)) { best = c; break; }
      } catch (e) {
        // Не прочиталось, но ошибка ушла дальше - правка могла быть верной,
        // а следующая поломка ниже. Запоминаем как запасной ход.
        if (!best && errPos(c.text, e) > pos + 2) best = { ...c, partial: true };
      }
    }
    if (!best) return null;
    fixes.push(best.what);
    cur = best.text;
  }
  return null;
}

// Конфиг прочитался, но биржа лежит снаружи exchanges - переносим внутрь.
function moveStrayExchanges(c) {
  const moved = [];
  if (!c || !c.exchanges || typeof c.exchanges !== 'object') return moved;
  for (const [k, v] of Object.entries(c)) {
    if (k !== 'exchanges' && looksLikeExchange(v) && !(k in c.exchanges)) {
      c.exchanges[k] = v; delete c[k]; moved.push(k);
    }
  }
  return moved;
}

module.exports = { repair, structureProblem, moveStrayExchanges };
