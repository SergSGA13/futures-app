// ===== TELEGRAM WEB APP INIT =====
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0A0B14');
  tg.setBackgroundColor('#0A0B14');
}

// ===== LANGUAGE =====
let currentLang = localStorage.getItem('fp_lang') || 'ru';

function t(key) {
  return (i18n && i18n[currentLang] && i18n[currentLang][key]) || key;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.getAttribute('data-i18n'));
    el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const v = t(el.getAttribute('data-i18n-html'));
    el.innerHTML = v;
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === currentLang);
  });
  const headerTitle = document.getElementById('headerTitle');
  if (headerTitle) headerTitle.textContent = t(pageTitleKeys[currentPage] || 'title.fp');
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('fp_lang', lang);
  applyTranslations();
}

// ===== NAVIGATION =====
const history = [];
const navMap = {
  'home': 'nav-home',
  'futures-prediction': 'nav-futures-prediction',
  'statistics': 'nav-statistics',
  'stats-l30d': 'nav-statistics',
  'stats-l30d-dev': 'nav-statistics',
  'stats-all': 'nav-statistics',
  'articles': 'nav-articles',
};
const pageTitleKeys = {
  'home': 'title.fp',
  'futures-prediction': 'title.fp',
  'futures-strategy': 'title.fs',
  'indicators': 'title.ind',
  'articles': 'title.art',
  'statistics': 'title.stats',
  'stats-l30d': 'title.stats.l30d',
  'stats-l30d-dev': 'title.stats.l30d.dev',
  'stats-all': 'title.stats.all',
  'article-tilt': 'title.art',
  'article-paradigm': 'title.art',
  'article-what-is': 'title.art',
  'article-focus': 'title.art',
};

let currentPage = 'home';

function navigate(pageId) {
  if (pageId === currentPage) return;
  const currentEl = document.getElementById('page-' + currentPage);
  const nextEl = document.getElementById('page-' + pageId);
  if (!nextEl) return;

  history.push(currentPage);

  currentEl.classList.remove('active');
  nextEl.classList.add('active');
  nextEl.scrollTop = 0;
  currentPage = pageId;

  updateHeader(pageId);
  updateNav(pageId);

  if (pageId === 'statistics') { loadPnlAllFromSignals('pnlChart', 'main'); renderAnalTables(); }
  if (pageId === 'stats-l30d') { loadPnlL30dFromSignals('pnlChartL30d', 'l30d'); renderL30dTables(); }
  if (pageId === 'stats-l30d-dev') { renderDevL30d(); }
  if (pageId === 'stats-all')  { loadPnlAllFromSignals('pnlChartAll', 'allp'); renderAllTables(); renderMonthlyWrChart(); }
  if (pageId === 'futures-strategy') { window.FutStrat && FutStrat.mount('futStrat'); }
  if (pageId === 'futures-prediction') { ensureSignalChart(); }

  if (tg) tg.HapticFeedback?.impactOccurred('light');
}

function goBack() {
  if (history.length === 0) return;
  const prev = history.pop();
  const currentEl = document.getElementById('page-' + currentPage);
  const prevEl = document.getElementById('page-' + prev);
  if (!prevEl) return;

  currentEl.classList.remove('active');
  prevEl.classList.add('active');
  prevEl.scrollTop = 0;
  currentPage = prev;

  updateHeader(prev);
  updateNav(prev);

  if (tg) tg.HapticFeedback?.impactOccurred('light');
}

function updateHeader(pageId) {
  const header = document.querySelector('.app-header');
  const backBtn = document.getElementById('backBtn');
  const headerTitle = document.getElementById('headerTitle');
  const appMain = document.querySelector('.app-main');

  const isHome = pageId === 'home';
  header.style.display = isHome ? 'none' : '';
  appMain.style.top = isHome ? '0' : 'var(--header-height)';
  backBtn.style.display = isHome ? 'none' : 'flex';
  headerTitle.textContent = t(pageTitleKeys[pageId] || 'title.fp');
}

function updateNav(pageId) {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const navId = navMap[pageId];
  if (navId) {
    document.getElementById(navId)?.classList.add('active');
  }
}

// ===== CHECKLIST RESET =====
function resetChecklist() {
  document.querySelectorAll('.check-input').forEach(cb => cb.checked = false);
}

// ===== STATISTICS PREVIEW =====
function parseCSV(text) {
  const rows = [];
  let cols = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else {
        cell += ch; // includes newlines inside quoted field
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        cols.push(cell.trim());
        cell = '';
      } else if (ch === '\n') {
        cols.push(cell.trim());
        cell = '';
        if (cols.length > 1 || cols[0] !== '') rows.push(cols);
        cols = [];
      } else if (ch === '\r') {
        // skip
      } else {
        cell += ch;
      }
    }
  }
  // last cell/row
  cols.push(cell.trim());
  if (cols.length > 1 || cols[0] !== '') rows.push(cols);

  return rows;
}

let analL7dRows = null;
let allSignalRows = null;
let blockedSignalRows = null;
let monthlyWrChartInstance = null;

async function fetchAllSignals() {
  if (allSignalRows) return allSignalRows;
  const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=ALLsignal`;
  const res = await fetch(url);
  const text = await res.text();
  allSignalRows = parseCSV(text);
  return allSignalRows;
}

// Заблокированные сигналы (не попали в отработку из-за лимита 5 окон и других фильтров).
// Структура колонок идентична ALLsignal.
async function fetchBlockedSignals() {
  if (blockedSignalRows) return blockedSignalRows;
  const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=BLOCKEDsignal`;
  const res = await fetch(url);
  const text = await res.text();
  blockedSignalRows = parseCSV(text);
  return blockedSignalRows;
}

async function fetchAnalL7d() {
  if (analL7dRows) return analL7dRows;
  const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=ANAL%20L7D`;
  const res = await fetch(url);
  const text = await res.text();
  analL7dRows = parseCSV(text);
  return analL7dRows;
}

async function loadStatsPreview() {
  try {
    const rows = await fetchAnalL7d();
    if (!rows || rows.length < 18) return;

    // K/V stats are at sheet rows 17-18 = parsed rows[16] and rows[17]
    // rows[17]: col[10]=WinRate L7D, col[21]=WinRate Total
    // rows[16]: col[10]=Signals L7D,  col[21]=Signals Total
    const winrate7d  = rows[18]?.[10] || '-';
    const signals7d  = rows[17]?.[10] || '-';
    const winrateAll = rows[18]?.[21] || '-';
    const totalAll   = rows[17]?.[21] || '-';

    const fmtWR = v => { const n = parseFloat(String(v).replace('%','')); return isNaN(n) ? '-' : n.toFixed(1) + '%'; };
    document.getElementById('statWinrate7d').textContent  = fmtWR(winrate7d);
    document.getElementById('statSignals7d').textContent  = signals7d;
    document.getElementById('statWinrate').textContent    = fmtWR(winrateAll);
    document.getElementById('statTotal').textContent      = totalAll;
  } catch(e) {
    console.log('Stats not available', e);
  }
}

// ===== PNL CHART =====
const pnlChartInstances = {};

async function loadPnlChartInto(canvasId, sheetTabName, key, daysFilter = null) {
  if (pnlChartInstances[key]) return;
  try {
    const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetTabName)}`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);

    // Parse all rows into dated entries, then split into monotone series
    const entries = [];
    for (let i = 1; i < rows.length; i++) {
      const dateStr = rows[i][0], pnlStr = rows[i][1];
      if (!dateStr || !pnlStr) continue;
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const date = new Date(parts[2], parts[1] - 1, parts[0]);
      if (isNaN(date.getTime())) continue;
      const numVal = parseFloat(pnlStr.replace(/[\s]/g, '').replace(',', '.'));
      if (isNaN(numVal)) continue;
      entries.push({ label: `${parts[0]}.${parts[1]}`, value: numVal, date });
    }
    if (!entries.length) return;

    // Split into monotone series
    const series = [];
    let cur = [], prev = null;
    for (const e of entries) {
      if (prev && e.date < prev) { if (cur.length) series.push(cur); cur = []; }
      cur.push(e); prev = e.date;
    }
    if (cur.length) series.push(cur);
    if (!series.length) return;

    let target;
    if (daysFilter) {
      // L30D: use the last series (most recent continuous period)
      const lastSeries = series[series.length - 1];
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysFilter);
      cutoff.setHours(0, 0, 0, 0);
      target = lastSeries.filter(e => e.date >= cutoff);
      // If last series has no data in range, use all of it
      if (!target.length) target = lastSeries;
    } else {
      target = series[0];
    }
    if (!target.length) return;

    // For L30D: normalize to start of window so chart shows change over period (not absolute)
    const baseVal = daysFilter ? target[0].value : 0;
    const labels  = target.map(e => e.label);
    const pctData = target.map(e => parseFloat(((e.value - baseVal) / 5000 * 100).toFixed(2)));
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(157, 80, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

    pnlChartInstances[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ data: pctData, borderColor: '#9D50FF', backgroundColor: gradient, borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y}% от 5 000 USDT` } } },
        scales: {
          x: { ticks: { color: '#7B84B0', maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ...(daysFilter ? {} : { min: 0 }), ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  } catch(e) {
    console.log('PNL chart not available', e);
  }
}

async function loadPnlL30dFromSignals(canvasId, key) {
  if (pnlChartInstances[key]) return;
  try {
    const rows = await fetchAllSignals();
    if (!rows || rows.length < 2) return;

    // Build cutoff as YYYY-MM-DD string (avoids UTC vs local-midnight mismatch)
    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
    const cutoffKey = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth()+1).padStart(2,'0')}-${String(cutoffDate.getDate()).padStart(2,'0')}`;

    const dailyMap = {};
    for (let i = 1; i < rows.length; i++) {
      const dateStr = (rows[i][12] || '').trim();
      const result  = rows[i][9];
      if (!dateStr) continue;
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const d = parts[0].padStart(2,'0');
      const m = parts[1].padStart(2,'0');
      const y = parts[2].substring(0, 4);
      if (y.length < 4 || isNaN(parseInt(y))) continue;
      const dk = `${y}-${m}-${d}`;
      if (dk < cutoffKey) continue;
      if (!dailyMap[dk]) dailyMap[dk] = { label: `${d}.${m}`, wins: 0, losses: 0 };
      if (result === 'WIN') dailyMap[dk].wins++;
      else if (result === 'LOSE') dailyMap[dk].losses++;
    }

    const sortedDays = Object.keys(dailyMap).sort();
    if (!sortedDays.length) return;

    let cumPnl = 0;
    const labels = [];
    const pctData = [];
    for (const dk of sortedDays) {
      const { label, wins, losses } = dailyMap[dk];
      cumPnl += wins * 100 - losses * 125;
      labels.push(label);
      pctData.push(Math.round((cumPnl / 5000) * 100));
    }

    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(157, 80, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

    pnlChartInstances[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ data: pctData, borderColor: '#9D50FF', backgroundColor: gradient, borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y}% от 5 000 USDT` } } },
        scales: {
          x: { ticks: { color: '#7B84B0', maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  } catch(e) {
    console.log('L30D PNL from signals error:', e);
  }
}

// Total PNL за всё время — кумулятивная кривая из ALLsignal (модель +100 / −125)
async function loadPnlAllFromSignals(canvasId, key) {
  if (pnlChartInstances[key]) return;
  try {
    const rows = await fetchAllSignals();
    if (!rows || rows.length < 2) return;

    const dailyMap = {};
    for (let i = 1; i < rows.length; i++) {
      const dateStr = (rows[i][12] || '').trim();
      const result  = rows[i][9];
      if (!dateStr) continue;
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const d = parts[0].padStart(2,'0');
      const m = parts[1].padStart(2,'0');
      const y = parts[2].substring(0, 4);
      if (y.length < 4 || isNaN(parseInt(y))) continue;
      const dk = `${y}-${m}-${d}`;
      if (!dailyMap[dk]) dailyMap[dk] = { label: `${d}.${m}`, wins: 0, losses: 0 };
      if (result === 'WIN') dailyMap[dk].wins++;
      else if (result === 'LOSE') dailyMap[dk].losses++;
    }

    const sortedDays = Object.keys(dailyMap).sort();
    if (!sortedDays.length) return;

    let cumPnl = 0;
    const labels = [];
    const pctData = [];
    for (const dk of sortedDays) {
      const { label, wins, losses } = dailyMap[dk];
      cumPnl += wins * 100 - losses * 125;
      labels.push(label);
      pctData.push(Math.round((cumPnl / 5000) * 100));
    }

    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(157, 80, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

    pnlChartInstances[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ data: pctData, borderColor: '#9D50FF', backgroundColor: gradient, borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y}% от 5 000 USDT` } } },
        scales: {
          x: { ticks: { color: '#7B84B0', maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { min: 0, ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  } catch(e) {
    console.log('ALL PNL from signals error:', e);
  }
}

// ===== ЕДИНОЕ ПРАВИЛО ЦВЕТА ВИНРЕЙТА (для всех данных в приложении) =====
// Точка безубытка при выплате +100 / −125 = 125/225 ≈ 55.6%.
//   < 55.6%        → красный  (убыточно)
//   55.6% – 61.9%  → жёлтый   (безубыток / тонкий плюс)
//   ≥ 62%          → зелёный  (уверенный плюс)
const WR_BREAKEVEN = 55.6;
const WR_GREEN = 62;
function wrClass(pct) {
  const n = parseFloat(String(pct).replace('%', ''));
  if (isNaN(n)) return '';
  return n >= WR_GREEN ? 'wr-green' : n >= WR_BREAKEVEN ? 'wr-yellow' : 'wr-red';
}
function wrHex(pct) {
  const n = parseFloat(pct);
  return n >= WR_GREEN ? '#4EFFA0' : n >= WR_BREAKEVEN ? '#FFD166' : '#FF5272';
}
function wrRgba(pct) {
  const n = parseFloat(pct);
  return n >= WR_GREEN ? 'rgba(78,255,160,0.65)' : n >= WR_BREAKEVEN ? 'rgba(255,209,102,0.65)' : 'rgba(255,82,114,0.65)';
}

// ===== ANAL TABLES (generalized) =====
// dataColStart=1 for L7D (cols B-H), =12 for ALL (cols M-S), =25 for L30D (cols Z-AF)
function buildAnalTableCols(configs, dataColStart) {
  const headers = ['', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  for (const {label, row} of configs) {
    if (!row) continue;
    const isTotal = label === 'TOTAL';
    html += `<tr class="${isTotal ? 'anal-total' : ''}">`;
    const vals = [label];
    for (let c = dataColStart; c <= dataColStart + 6; c++) {
      vals.push((row[c] !== undefined && row[c] !== '') ? row[c] : '-');
    }
    vals.forEach((v, ci) => {
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = wrClass(num);
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return `<div class="stats-table-wrap">${html}</div>`;
}

// hourCol=11 for ALL (col L), =24 for L30D (col Y); dataColStart = hourCol+1
function buildHourTableCols(rows, hourCol, dataColStart) {
  const headers = ['Hour', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  let totalRow = null;
  let dataFound = false;

  for (let i = 0; i < rows.length; i++) {
    const hour = rows[i][hourCol];

    // ✅ пустое или NaN → проверяем на TOTAL
    if (hour === '' || hour === undefined || hour === null || String(hour).trim().toLowerCase() === 'nan') {
      if (rows[i][dataColStart] && rows[i][dataColStart] !== '') totalRow = rows[i];
      continue;
    }

    // явный TOTAL в ячейке
    if (String(hour).trim().toUpperCase() === 'TOTAL') {
      totalRow = rows[i];
      continue;
    }

    const hourStr = String(hour).trim();
    if (!/^\d+(\.\d+)?$/.test(hourStr)) continue;
    const h = parseInt(hourStr, 10);
    if (isNaN(h) || h < 0 || h > 23) continue;

    dataFound = true;
    const d = dataColStart;
    const vals = [`${h}:00`, rows[i][d]||'-', rows[i][d+1]||'-', rows[i][d+2]||'-',
                  rows[i][d+3]||'-', rows[i][d+4]||'-', rows[i][d+5]||'-', rows[i][d+6]||'-'];
    html += '<tr>';
    vals.forEach((v, ci) => {
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = wrClass(num);
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }

  if (totalRow) {
    const d = dataColStart;
    const vals = ['Total', totalRow[d]||'-', totalRow[d+1]||'-', totalRow[d+2]||'-',
                  totalRow[d+3]||'-', totalRow[d+4]||'-', totalRow[d+5]||'-', totalRow[d+6]||'-'];
    html += '<tr class="anal-total">';
    vals.forEach((v, ci) => {
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = wrClass(num);
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }

  html += '</tbody></table>';
  return dataFound ? `<div class="stats-table-wrap">${html}</div>` : '';
}

// ===== CROSS TABLE (Indicator × Timeframe) =====
// Минимальная выборка для доверия к винрейту (решённых сигналов WIN+LOSE)
const MIN_SAMPLE = 5;

// Колонки ALLsignal: C(2)=направление, J(9)=результат, M(12)=дата, V(21)=код индикатора
// Группировка только по коду индикатора (таймфрейм в данных почти везде пуст).
// pairFilter: 'ETH' | 'BTC' | null (без фильтра — все пары)
function aggregateByIndicator(rows, indCol, daysFilter, pairFilter) {
  let cutoff = null;
  if (daysFilter) {
    const n = new Date();
    const c = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysFilter);
    cutoff = `${c.getFullYear()}-${String(c.getMonth()+1).padStart(2,'0')}-${String(c.getDate()).padStart(2,'0')}`;
  }
  const g = {};
  for (let i = 1; i < rows.length; i++) {
    const res = (rows[i][9] || '').trim();
    const dir = (rows[i][2] || '').trim();
    // WIN & LOSE не учитываем в подсчёте — чтобы Total совпадал с 5293
    if (res === 'WIN & LOSE') continue;
    if (pairFilter && sigPairBase(rows[i][1]) !== pairFilter) continue;
    // Фильтр окна только для L30D; в ALL дату не трогаем, чтобы не терять сигналы
    if (cutoff) {
      const p = (rows[i][12] || '').split('.');
      if (p.length < 3) continue; // без корректной даты нельзя отнести к окну 30 дней
      const dk = `${p[2].substring(0,4)}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
      if (dk < cutoff) continue;
    }
    // Пустой код индикатора не выкидываем, а собираем в строку «—»
    const ind = (rows[i][indCol] || '').trim() || '-';
    if (!g[ind]) g[ind] = { ind, upW:0, upL:0, upT:0, dnW:0, dnL:0, dnT:0 };
    const o = g[ind], up = dir === 'UP';
    if (up) o.upT++; else o.dnT++;
    if (res === 'WIN')  { up ? o.upW++ : o.dnW++; }
    if (res === 'LOSE') { up ? o.upL++ : o.dnL++; }
  }
  return Object.values(g);
}

// Винрейт-ячейка с учётом порога малой выборки
function wrCell(w, l, minSample) {
  const decided = w + l;
  if (decided === 0) return { v: '–', cls: '' };
  const pct = Math.round(w / decided * 100);
  if (decided < minSample) return { v: `~${pct}%`, cls: 'wr-low' };
  const cls = wrClass(pct);
  return { v: `${pct}%`, cls };
}

function buildIndicatorTable(combos, minSample) {
  if (!combos.length) return '';
  combos.sort((a, b) => (b.upT + b.dnT) - (a.upT + a.dnT)); // по объёму вниз

  const headers = ['', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table cross-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  const tot = { upW:0, upL:0, upT:0, dnW:0, dnL:0, dnT:0 };
  for (const o of combos) {
    tot.upW += o.upW; tot.upL += o.upL; tot.upT += o.upT;
    tot.dnW += o.dnW; tot.dnL += o.dnL; tot.dnT += o.dnT;
    const up = wrCell(o.upW, o.upL, minSample);
    const dn = wrCell(o.dnW, o.dnL, minSample);
    html += `<tr>
      <td>${o.ind}</td>
      <td>${o.upT}</td><td>${o.upW}</td><td class="${up.cls}">${up.v}</td>
      <td>${o.dnT}</td><td>${o.dnW}</td><td class="${dn.cls}">${dn.v}</td>
      <td>${o.upT + o.dnT}</td></tr>`;
  }

  const upT = wrCell(tot.upW, tot.upL, minSample);
  const dnT = wrCell(tot.dnW, tot.dnL, minSample);
  html += `<tr class="anal-total">
    <td>TOTAL</td>
    <td>${tot.upT}</td><td>${tot.upW}</td><td class="${upT.cls}">${upT.v}</td>
    <td>${tot.dnT}</td><td>${tot.dnW}</td><td class="${dnT.cls}">${dnT.v}</td>
    <td>${tot.upT + tot.dnT}</td></tr>`;
  html += '</tbody></table>';
  return `<div class="stats-table-wrap">${html}</div>`;
}

async function renderCrossTable(targetTableId, targetCardId, daysFilter) {
  try {
    const rows = await fetchAllSignals();
    if (!rows || rows.length < 2) return;
    const html = buildIndicatorTable(aggregateByIndicator(rows, 21, daysFilter), MIN_SAMPLE);
    if (!html) return;
    document.getElementById(targetTableId).innerHTML = html;
    document.getElementById(targetCardId).style.display = 'block';
  } catch (e) {
    console.log('Indicator table error:', e);
  }
}

async function renderAnalTables() {
  try {
    const rows = await fetchAnalL7d();
    if (!rows || !rows.length) return;

    // By Trading Pair L7D — cols B-H (dataColStart=1), rows[15-17]
    const pairsHtml = buildAnalTableCols([
      { label: 'ETH',   row: rows[16] },
      { label: 'BTC',   row: rows[17] },
      { label: 'TOTAL', row: rows[18] },
    ], 1);
    document.getElementById('analPairsTable').innerHTML = pairsHtml;
    document.getElementById('analPairsCard').style.display = 'block';

  } catch(e) {
    console.log('Anal tables error:', e);
  }
}

async function renderL30dTables() {
  try {
    const rows = await fetchAnalL7d();
    if (!rows || !rows.length) return;

    // By Trading Pair L30D — dataColStart=25, JS rows = python+1
    const pairsHtml = buildAnalTableCols([
      { label: 'ETH',   row: rows[16] },
      { label: 'BTC',   row: rows[17] },
      { label: 'TOTAL', row: rows[18] },
    ], 25);
    document.getElementById('l30dPairsTable').innerHTML = pairsHtml;
    document.getElementById('l30dPairsCard').style.display = 'block';

    // WinRate by Day of Week — L30D
    renderDowChart('l30dDowChart', 30);

    // By Time Zone L30D — dataColStart=25
    const tzHtml = buildAnalTableCols([
      { label: '0-14',  row: rows[27] },
      { label: '15-29', row: rows[28] },
      { label: '30-44', row: rows[29] },
      { label: '45-59', row: rows[30] },
      { label: 'TOTAL', row: rows[31] },
    ], 25);
    document.getElementById('l30dTFTable').innerHTML = tzHtml;
    document.getElementById('l30dTFCard').style.display = 'block';

    // By 5min Zone L30D — A60:H72 → rows[60-72] в JS, dataColStart=1
    const fiveMinL30dHtml = buildAnalTableCols([
      { label: '0-4',   row: rows[59] },
      { label: '5-9',   row: rows[60] },
      { label: '10-14', row: rows[61] },
      { label: '15-19', row: rows[62] },
      { label: '20-24', row: rows[63] },
      { label: '25-29', row: rows[64] },
      { label: '30-34', row: rows[65] },
      { label: '35-39', row: rows[66] },
      { label: '40-44', row: rows[67] },
      { label: '45-49', row: rows[68] },
      { label: '50-54', row: rows[69] },
      { label: '55-59', row: rows[70] },
      { label: 'TOTAL', row: rows[71] },
    ], 1);
    document.getElementById('l30d5minTable').innerHTML = fiveMinL30dHtml;
    document.getElementById('l30d5minCard').style.display = 'block';

    // By Hour Zone L30D — hourCol=24, dataColStart=25, срез rows[33..57] в JS = rows.slice(33,58)
    const hourSlice = rows.slice(33, 58);
    const hourHtml = buildHourTableCols(hourSlice, 24, 25);
    if (hourHtml) {
      document.getElementById('l30dHourTable').innerHTML = hourHtml;
      document.getElementById('l30dHourCard').style.display = 'block';
    }
    // Indicator × Timeframe cross-cut — L30D
    await renderCrossTable('l30dCrossTable', 'l30dCrossCard', 30);
  } catch(e) {
    console.log('L30D tables error:', e);
  }
}

async function renderAllTables() {
  try {
    const rows = await fetchAnalL7d();
    if (!rows || !rows.length) return;

    // By Trading Pair ALL — L19:S22, row19=header → data at rows[16-18]
    const pairsHtml = buildAnalTableCols([
      { label: 'ETH',   row: rows[16] },
      { label: 'BTC',   row: rows[17] },
      { label: 'TOTAL', row: rows[18] },
    ], 12);
    document.getElementById('allPairsTable').innerHTML = pairsHtml;
    document.getElementById('allPairsCard').style.display = 'block';

    // WinRate by Day of Week — ALL Periods
    renderDowChart('allDowChart', null);

    // By Time Zone ALL — L36:S41, row36=header → data at rows[36-40]
    const tzHtml = buildAnalTableCols([
      { label: '0-14',  row: rows[27] },
      { label: '15-29', row: rows[28] },
      { label: '30-44', row: rows[29] },
      { label: '45-59', row: rows[30] },
      { label: 'TOTAL', row: rows[31] },
    ], 12);
    document.getElementById('allTFTable').innerHTML = tzHtml;
    document.getElementById('allTFCard').style.display = 'block';

    // By 5min Zone ALL — L60:S72 → rows[59-71], cols 11-17, dataColStart=12
const fiveMinAllHtml = buildAnalTableCols([
  { label: '0-4',   row: rows[59] },
  { label: '5-9',   row: rows[60] },
  { label: '10-14', row: rows[61] },
  { label: '15-19', row: rows[62] },
  { label: '20-24', row: rows[63] },
  { label: '25-29', row: rows[64] },
  { label: '30-34', row: rows[65] },
  { label: '35-39', row: rows[66] },
  { label: '40-44', row: rows[67] },
  { label: '45-49', row: rows[68] },
  { label: '50-54', row: rows[69] },
  { label: '55-59', row: rows[70] },
  { label: 'TOTAL', row: rows[71] },
], 12);
document.getElementById('all5minTable').innerHTML = fiveMinAllHtml;
document.getElementById('all5minCard').style.display = 'block';

       // ✅ By Hour Zone ALL — L34:U58 → rows[33..57], hourCol=11, dataColStart=12
    const hourSlice = rows.slice(33, 58); // 0..24 внутри среза
    const hourHtml = buildHourTableCols(hourSlice, 11, 12);
    if (hourHtml) {
      document.getElementById('allHourTable').innerHTML = hourHtml;
      document.getElementById('allHourCard').style.display = 'block';
    }
    // Indicator × Timeframe cross-cut — ALL Periods
    await renderCrossTable('allCrossTable', 'allCrossCard', null);
  } catch(e) {
    console.log('ALL tables error:', e);
  }
}

// ===== DEV: LAST 30 DAYS (ALLsignal + BLOCKEDsignal) =====
// Раздел «для разработчика»: те же разрезы, что и Last 30 Days, но данные =
// ALLsignal + BLOCKEDsignal (сигналы, не попавшие в отработку из-за лимита
// 5 окон и других фильтров), и все таблицы считаются из сырых строк листов,
// а не из готовых агрегатов ANAL L7D.
// Правила подсчёта: Total = WIN + LOSE + «WIN & LOSE»; WR% = WIN / (WIN + LOSE);
// PNL-модель: WIN +100, LOSE −125, «WIN & LOSE» 0.
let devL30dRendered = false;

const DEV_RESOLVED = new Set(['WIN', 'LOSE', 'WIN & LOSE']);

function devDateKey(dateStr) {
  const p = String(dateStr || '').trim().split('.');
  if (p.length < 3) return null;
  const y = p[2].substring(0, 4);
  if (y.length < 4 || isNaN(parseInt(y))) return null;
  return `${y}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
}

// Заявленная уверенность модели в момент сигнала — встроена в текст сообщения
// (колонка со свободным текстом вида "ETHUSDT Signal 68% v.3/10: UP ..."), а не в
// отдельную фиксированную колонку, поэтому ищем ячейку с "Signal" и вытаскиваем NN%.
function devExtractConfidence(r) {
  for (const cell of r) {
    if (typeof cell === 'string' && cell.includes('Signal')) {
      const m = cell.match(/(\d{1,3})%/);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v >= 1 && v <= 100) return v;
      }
    }
  }
  return null;
}

// Разбор строки листа в сигнал; null — строка без результата или без корректной даты
function devParseSignal(r) {
  if (!r) return null;
  const res = (r[9] || '').trim();
  if (!DEV_RESOLVED.has(res)) return null;
  const dk = devDateKey(r[12]);
  if (!dk) return null;
  const tp = String(r[11] || '').trim().match(/^(\d{1,2}):(\d{1,2})/);
  const hour = tp ? parseInt(tp[1], 10) : NaN;
  const minute = tp ? parseInt(tp[2], 10) : NaN;
  const dir = (r[2] || '').trim().toUpperCase();
  return {
    res, dk,
    dir: dir === 'UP' ? 'UP' : 'DOWN',
    pair: sigPairBase(r[1]),
    ind: (r[21] || '').trim() || '-',
    conf: devExtractConfidence(r),
    hour: (hour >= 0 && hour <= 23) ? hour : null,
    minute: (minute >= 0 && minute <= 59) ? minute : null,
  };
}

// BLOCKEDsignal отличается от ALLsignal раскладкой: результат в K (10), индикатор в N (13),
// остальные колонки совпадают. Приводим строку к раскладке ALLsignal (результат J, индикатор V),
// чтобы вся остальная логика (парсинг, DOW, Indicator) работала одинаково для обоих листов.
function devNormalizeBlockedRow(r) {
  if (!r) return r;
  const c = r.slice();
  c[9] = r[10];   // результат: K → J
  c[21] = r[13];  // индикатор: N → V
  return c;
}

// Сигналы за 30 дней из обоих листов + объединённые сырые строки (для DOW и Indicator)
async function devFetchSignals30d() {
  const [allRows, blockedRows] = await Promise.all([fetchAllSignals(), fetchBlockedSignals()]);
  const n = new Date();
  const c = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 30);
  const cutoff = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;

  const blockedNorm = (blockedRows && blockedRows.length > 1)
    ? blockedRows.slice(1).map(devNormalizeBlockedRow)
    : [];

  const sigs = [];
  let cntAll = 0, cntBlocked = 0;
  const take = (dataRows, isBlocked) => {
    for (const r of dataRows) {
      const s = devParseSignal(r);
      if (!s || s.dk < cutoff) continue;
      s.isBlocked = isBlocked;
      sigs.push(s);
      if (isBlocked) cntBlocked++; else cntAll++;
    }
  };
  take(allRows && allRows.length > 1 ? allRows.slice(1) : [], false);
  take(blockedNorm, true);

  const combinedRaw = (allRows && allRows.length ? allRows : [[]]).concat(blockedNorm);

  return { sigs, cntAll, cntBlocked, combinedRaw };
}

function devAggregate(sigs, keyFn) {
  const g = {};
  for (const s of sigs) {
    const k = keyFn(s);
    if (k == null) continue;
    if (!g[k]) g[k] = { upT: 0, upW: 0, upL: 0, dnT: 0, dnW: 0, dnL: 0 };
    const o = g[k], up = s.dir === 'UP';
    if (up) o.upT++; else o.dnT++;
    if (s.res === 'WIN')  { up ? o.upW++ : o.dnW++; }
    if (s.res === 'LOSE') { up ? o.upL++ : o.dnL++; }
  }
  return g;
}

function devWrTd(w, l) {
  const dec = w + l;
  if (!dec) return '<td>-</td>';
  const pct = Math.round(w / dec * 100);
  return `<td class="${wrClass(pct)}">${pct}%</td>`;
}

function devBuildTable(order, groups) {
  const headers = ['', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  const tot = { upT: 0, upW: 0, upL: 0, dnT: 0, dnW: 0, dnL: 0 };
  let hasData = false;
  for (const label of order) {
    const o = groups[label];
    if (!o) continue;
    hasData = true;
    for (const k in tot) tot[k] += o[k];
    html += `<tr><td>${label}</td><td>${o.upT}</td><td>${o.upW}</td>${devWrTd(o.upW, o.upL)}` +
            `<td>${o.dnT}</td><td>${o.dnW}</td>${devWrTd(o.dnW, o.dnL)}<td>${o.upT + o.dnT}</td></tr>`;
  }
  if (!hasData) return '';
  html += `<tr class="anal-total"><td>TOTAL</td><td>${tot.upT}</td><td>${tot.upW}</td>${devWrTd(tot.upW, tot.upL)}` +
          `<td>${tot.dnT}</td><td>${tot.dnW}</td>${devWrTd(tot.dnW, tot.dnL)}<td>${tot.upT + tot.dnT}</td></tr>`;
  html += '</tbody></table>';
  return `<div class="stats-table-wrap">${html}</div>`;
}

function devShowTable(tableId, cardId, html) {
  if (!html) return;
  const el = document.getElementById(tableId);
  const card = document.getElementById(cardId);
  if (!el || !card) return;
  el.innerHTML = html;
  card.style.display = 'block';
}

function devRenderPnlChart(sigs) {
  if (pnlChartInstances['l30dDev']) return;
  const dailyMap = {};
  for (const s of sigs) {
    if (!dailyMap[s.dk]) dailyMap[s.dk] = { wins: 0, losses: 0 };
    if (s.res === 'WIN') dailyMap[s.dk].wins++;
    else if (s.res === 'LOSE') dailyMap[s.dk].losses++;
  }
  const sortedDays = Object.keys(dailyMap).sort();
  if (!sortedDays.length) return;

  let cumPnl = 0;
  const labels = [], pctData = [];
  for (const dk of sortedDays) {
    const { wins, losses } = dailyMap[dk];
    cumPnl += wins * 100 - losses * 125;
    labels.push(`${dk.slice(8, 10)}.${dk.slice(5, 7)}`);
    pctData.push(Math.round((cumPnl / 5000) * 100));
  }

  const ctx = document.getElementById('pnlChartL30dDev')?.getContext('2d');
  if (!ctx) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(157, 80, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

  pnlChartInstances['l30dDev'] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data: pctData, borderColor: '#9D50FF', backgroundColor: gradient, borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.y}% от 5 000 USDT` } } },
      scales: {
        x: { ticks: { color: '#7B84B0', maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
      }
    }
  });
}

// ===== DEV: PNL vs Цена (ETH / BTC), Last 30 Days =====
// Полный календарный ряд дат (кумулятивный PNL переносится на дни без сигналов),
// чтобы ось X точно совпадала с рядом дневных цен закрытия.
function devDailyDateRange(days) {
  const out = [];
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function devCumulativePnlPct(sigs, dateKeys) {
  const dailyMap = {};
  for (const s of sigs) {
    if (!dailyMap[s.dk]) dailyMap[s.dk] = { wins: 0, losses: 0 };
    if (s.res === 'WIN') dailyMap[s.dk].wins++;
    else if (s.res === 'LOSE') dailyMap[s.dk].losses++;
  }
  let cum = 0;
  return dateKeys.map(dk => {
    const d = dailyMap[dk];
    if (d) cum += d.wins * 100 - d.losses * 125;
    return Math.round((cum / 5000) * 100);
  });
}

// Дневные цены закрытия (Binance fapi -> Bybit фолбэк, как и в графике «Сигналы сегодня»).
// Возвращает { 'YYYY-MM-DD': closePrice }; при ошибке сети — пустой объект (график PNL всё равно рендерится).
async function devFetchDailyCloses(sym, days) {
  try {
    const start = Date.now() - (days + 3) * 864e5;
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1d&limit=${days + 5}&startTime=${start}`;
    const r = await sigFetch(u, 9000);
    if (r.ok) {
      const arr = await r.json();
      if (arr.length) {
        const map = {};
        arr.forEach(k => {
          const dt = new Date(k[0]);
          const dk = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
          map[dk] = +k[4];
        });
        return map;
      }
    }
  } catch (e) { /* фолбэк ниже */ }
  try {
    const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=D&limit=${days + 5}`;
    const r = await sigFetch(u, 9000);
    if (r.ok) {
      const j = await r.json();
      const list = (j.result && j.result.list) || [];
      if (list.length) {
        const map = {};
        list.forEach(k => {
          const dt = new Date(+k[0]);
          const dk = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
          map[dk] = +k[4];
        });
        return map;
      }
    }
  } catch (e) {}
  return {};
}

// PNL (левая ось, %) + цена актива (правая ось) на одном графике — чтобы сопоставить траекторию.
function devRenderPnlPriceChart(canvasId, key, labels, pnlPctData, priceData, priceColor) {
  if (pnlChartInstances[key]) return;
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(157, 80, 255, 0.30)');
  gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

  const hasPrice = priceData.some(v => v != null);
  const datasets = [{
    label: 'PNL',
    data: pnlPctData,
    borderColor: '#9D50FF',
    backgroundColor: gradient,
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.35,
    yAxisID: 'y',
  }];
  if (hasPrice) {
    datasets.push({
      label: 'Price',
      data: priceData,
      borderColor: priceColor,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      fill: false,
      tension: 0.25,
      yAxisID: 'y1',
      spanGaps: true,
    });
  }

  pnlChartInstances[key] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: hasPrice, position: 'top', align: 'end', labels: { color: '#7B84B0', boxWidth: 10, font: { size: 10 }, usePointStyle: true } },
        tooltip: { callbacks: { label: c => c.dataset.label === 'PNL' ? `PNL: ${c.parsed.y}%` : `Price: ${c.parsed.y}` } }
      },
      scales: {
        x: { ticks: { color: '#7B84B0', maxTicksLimit: 10, maxRotation: 0, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { position: 'left', ticks: { color: '#9D50FF', font: { size: 10 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y1: { position: 'right', display: hasPrice, ticks: { color: priceColor, font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

// ===== DEV: AUTO INSIGHTS (Last 30 Days) =====
// Автоматический разбор среза DEV L30D. Ключевой принцип: индикаторы сканируются
// НЕЗАВИСИМО от того, выглядит ли их родительское направление (пара×направление)
// прибыльным — гнилой индикатор с большим объёмом может прятаться внутри агрегата,
// который в среднем выглядит хорошо (другие коды перекрывают его своим WR).
// Плоский взгляд "пара×направление = 68%, всё ок" эту проблему не видит.
//
// Пороги:
//   DEV_INSIGHT_MIN_SAMPLE  — минимум решённых сигналов, чтобы вывод вообще считался
//                             основанием для рекомендации (выше MIN_SAMPLE=5 у таблиц —
//                             там это просто маркер "мало данных", здесь нужна уверенность).
//   DEV_INSIGHT_CRITICAL_WR — ниже этого WR индикатор не просто "слабый", а систематически
//                             убыточный ("гниёт") — рекомендация жёстче, чем "пересмотреть".
const DEV_INSIGHT_MIN_SAMPLE = 15;
const DEV_INSIGHT_CRITICAL_WR = 45;

function devWrOf(w, l) {
  const dec = w + l;
  return dec > 0 ? (w / dec * 100) : null;
}

// Ожидаемый результат ОДНОГО сигнала при данном WR% (в USDT, модель WIN +100 / LOSE -125).
// Используется, чтобы перевести любую находку (тренд, калибровка, волатильность, BLOCKED)
// в одну и ту же валюту — "сколько это стоит в деньгах за месяц" — и ранжировать по этому.
function devEvPerSignal(wrPct) {
  const p = wrPct / 100;
  return p * 100 - (1 - p) * 125;
}

// [{label:'ETH ↑ UP', pair, dir, w, l, decided, wr}, ...] по всем 4 комбинациям пара×направление
function devInsightPairDir(sigs) {
  const g = { ETH: { upW: 0, upL: 0, dnW: 0, dnL: 0 }, BTC: { upW: 0, upL: 0, dnW: 0, dnL: 0 } };
  for (const s of sigs) {
    if (s.pair !== 'ETH' && s.pair !== 'BTC') continue;
    const o = g[s.pair], up = s.dir === 'UP';
    if (s.res === 'WIN')  { up ? o.upW++ : o.dnW++; }
    if (s.res === 'LOSE') { up ? o.upL++ : o.dnL++; }
  }
  const out = [];
  for (const pair of ['ETH', 'BTC']) {
    for (const dir of ['UP', 'DOWN']) {
      const w = dir === 'UP' ? g[pair].upW : g[pair].dnW;
      const l = dir === 'UP' ? g[pair].upL : g[pair].dnL;
      const decided = w + l;
      out.push({ label: `${pair} ${dir === 'UP' ? '↑ UP' : '↓ DOWN'}`, pair, dir, w, l, decided, wr: devWrOf(w, l) });
    }
  }
  return out;
}

// Плоский список [{pair, ind, dir, label, w, l, decided, wr}, ...] по ВСЕМ ячейкам
// индикатор×направление для ETH и BTC отдельно — сканируется целиком, без привязки
// к тому, слабое или сильное у него родительское направление.
function devInsightIndicatorCells(combinedRaw) {
  const out = [];
  for (const pair of ['ETH', 'BTC']) {
    const combos = aggregateByIndicator(combinedRaw, 21, 30, pair);
    for (const o of combos) {
      if (o.ind === '-') continue; // сигналы без кода индикатора отключать не предлагаем
      out.push({ pair, ind: o.ind, dir: 'UP',   label: `${pair} ${o.ind} ↑ UP`,   w: o.upW, l: o.upL, decided: o.upW + o.upL, wr: devWrOf(o.upW, o.upL) });
      out.push({ pair, ind: o.ind, dir: 'DOWN', label: `${pair} ${o.ind} ↓ DOWN`, w: o.dnW, l: o.dnL, decided: o.dnW + o.dnL, wr: devWrOf(o.dnW, o.dnL) });
    }
  }
  return out;
}

// Русское склонение: 1 индикатор, 2-4 индикатора, 5+/11-14 индикаторов
function devPluralRu(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function devInsightBlock(cls, title, bodyLines) {
  const body = bodyLines.map(l => `<div class="dev-insight-body">${l}</div>`).join('');
  return `<div class="dev-insight-item ${cls}"><div class="dev-insight-title">${title}</div>${body}</div>`;
}

// Сколько наберёт WR пары×направления, если исключить один конкретный индикатор —
// конкретная цифра "что будет, если отключить", а не абстрактная рекомендация.
function devWrWithout(pairDirRow, cell) {
  const w = pairDirRow.w - cell.w, l = pairDirRow.l - cell.l;
  return devWrOf(w, l);
}

// ===== 1. НЕДЕЛЬНЫЙ ТРЕНД: ловим деградацию индикатора раньше, чем она утянет месячный агрегат =====
const DEV_TREND_MIN_HALF = 8; // минимум решённых сигналов в каждой половине месяца для сравнения

// 30-дневное окно, разбитое на 4 подряд идущих отрезка (не строго по 7 дней —
// длина окна не всегда делится на 4 без остатка, поэтому распределяем поровну).
function devWeekBuckets(days) {
  const dateKeys = devDailyDateRange(days);
  const n = dateKeys.length;
  const size = Math.ceil(n / 4);
  const buckets = [];
  for (let i = 0; i < 4; i++) {
    const slice = dateKeys.slice(i * size, Math.min((i + 1) * size, n));
    if (slice.length) buckets.push(slice);
  }
  return buckets;
}

function devTrendCells(sigs) {
  const buckets = devWeekBuckets(30);
  const bucketOf = {};
  buckets.forEach((b, i) => b.forEach(dk => { bucketOf[dk] = i; }));

  const groups = {};
  for (const s of sigs) {
    if (s.ind === '-' || (s.pair !== 'ETH' && s.pair !== 'BTC') || (s.res !== 'WIN' && s.res !== 'LOSE')) continue;
    const key = `${s.pair}|${s.ind}|${s.dir}`;
    if (!groups[key]) groups[key] = { pair: s.pair, ind: s.ind, dir: s.dir, buckets: buckets.map(() => ({ w: 0, l: 0 })) };
    const bi = bucketOf[s.dk];
    if (bi == null) continue;
    if (s.res === 'WIN') groups[key].buckets[bi].w++; else groups[key].buckets[bi].l++;
  }

  const out = [];
  for (const key in groups) {
    const g = groups[key];
    const half = Math.ceil(g.buckets.length / 2);
    const sum = arr => arr.reduce((a, b) => ({ w: a.w + b.w, l: a.l + b.l }), { w: 0, l: 0 });
    const first = sum(g.buckets.slice(0, half));
    const second = sum(g.buckets.slice(half));
    const firstDec = first.w + first.l, secondDec = second.w + second.l;
    if (firstDec < DEV_TREND_MIN_HALF || secondDec < DEV_TREND_MIN_HALF) continue;
    const firstWr = devWrOf(first.w, first.l), secondWr = devWrOf(second.w, second.l);
    out.push({ pair: g.pair, ind: g.ind, dir: g.dir, firstWr, secondWr, firstDec, secondDec, delta: secondWr - firstWr });
  }
  return out;
}

function devBuildTrendSection(sigs) {
  const DELTA_THRESHOLD = 15; // сдвиг WR в п.п. между первой и второй половиной месяца, чтобы считать это трендом
  const cells = devTrendCells(sigs);
  const degrading = cells.filter(x => x.delta <= -DELTA_THRESHOLD).sort((a, b) => a.delta - b.delta);
  const improving = cells.filter(x => x.delta >= DELTA_THRESHOLD).sort((a, b) => b.delta - a.delta);

  const blocks = [];
  degrading.slice(0, 5).forEach(x => {
    blocks.push(devInsightBlock('dev-insight-bad', `📉 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'} слабеет`,
      [`Было <b>${x.firstWr.toFixed(0)}%</b> (первая половина месяца, n=${x.firstDec}) → стало <b>${x.secondWr.toFixed(0)}%</b> (вторая половина, n=${x.secondDec}) — просадка на ${Math.abs(x.delta).toFixed(0)} п.п. Деградация свежая, месячный агрегат её ещё маскирует.`]));
  });
  improving.slice(0, 5).forEach(x => {
    blocks.push(devInsightBlock('dev-insight-good', `📈 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'} набирает силу`,
      [`Было <b>${x.firstWr.toFixed(0)}%</b> (n=${x.firstDec}) → стало <b>${x.secondWr.toFixed(0)}%</b> (n=${x.secondDec}) — рост на ${x.delta.toFixed(0)} п.п.`]));
  });
  if (!blocks.length) {
    blocks.push(devInsightBlock('', 'Трендов не найдено', ['За месяц ни один индикатор не сдвинул WR больше чем на 15 п.п. между первой и второй половинами периода — динамика стабильна.']));
  }
  return blocks.join('');
}

// ===== АДМИН-ГЕЙТ: кнопку "Исправлено" видит только владелец мини-аппа =====
// initDataUnsafe — данные со стороны клиента, без криптографической проверки подписи
// (для этого нужен бэкенд с токеном бота, которого у статического приложения нет).
// Для угрозы "случайный пользователь потыкал чек-лист" достаточно и этого — кнопку
// просто не увидит никто, кроме владельца с этим Telegram ID.
const DEV_ADMIN_TG_ID = 431358856;
function isDevAdmin() {
  return !!(tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id === DEV_ADMIN_TG_ID);
}

// ===== ОТМЕТКИ "ИСПРАВЛЕНО" (localStorage этого устройства) =====
const DEV_DISMISS_KEY = 'fp_dev_dismissed';
const DEV_DISMISS_MIN_SAMPLE = 8; // сколько свежих (после отметки) решённых сигналов нужно для вывода о регрессии

function devGetDismissed() {
  try { return JSON.parse(localStorage.getItem(DEV_DISMISS_KEY) || '{}'); } catch (e) { return {}; }
}
function devSetDismissed(map) {
  try { localStorage.setItem(DEV_DISMISS_KEY, JSON.stringify(map)); } catch (e) {}
}
function devTodayDk() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// WR ТОЛЬКО по сигналам после даты отметки — это и есть проверка "а что показывает
// отработка начиная с завтра", без учёта старых (уже исправленных) данных.
function devFreshWrSince(sigs, pair, ind, dir, sinceDk) {
  let w = 0, l = 0;
  for (const s of sigs) {
    if (s.pair !== pair || s.ind !== ind || s.dir !== dir) continue;
    if (s.dk <= sinceDk) continue;
    if (s.res === 'WIN') w++; else if (s.res === 'LOSE') l++;
  }
  return { w, l, decided: w + l, wr: devWrOf(w, l) };
}

let devLastSigs = null, devLastCombinedRaw = null;

function devMarkFixed(pair, ind, dir) {
  if (!isDevAdmin()) return; // защита и на случай прямого вызова из консоли не-админом
  const map = devGetDismissed();
  map[`${pair}|${ind}|${dir}`] = devTodayDk();
  devSetDismissed(map);
  if (tg) tg.HapticFeedback?.notificationOccurred?.('success');
  if (devLastSigs && devLastCombinedRaw) {
    devShowTable('devUrgentBlock', 'devUrgentCard', devBuildUrgentSection(devLastSigs, devLastCombinedRaw));
  }
}

// ===== СПИСОК "ТРЕБУЮТ ПЕРЕСМОТРА ПРЯМО СЕЙЧАС" (под основным графиком PNL DEV) =====
// Индикаторы стареют на новых рыночных уровнях — их нужно периодически пересобирать.
// Список = объединение двух сигналов тревоги (может пересекаться по одному индикатору):
//   🔴 критично — WR уже глубоко ниже безубытка при значимом объёме, действовать сейчас;
//   ⏳ на очереди — абсолютный WR ещё не критичен, но за последние 2 недели заметно просел
//      (та самая ранняя порча индикатора под новые рыночные уровни, до того как это
//      утонет в месячном агрегате).
// Отмеченные "исправлено" (владельцем) молчат, пока свежих сигналов мало; если после
// набора свежих данных WR снова ниже безубытка — пункт возвращается с пометкой "регрессия".
function devBuildUrgentSection(sigs, combinedRaw) {
  devLastSigs = sigs; devLastCombinedRaw = combinedRaw;

  const items = {};
  const getItem = (pair, ind, dir) => {
    const key = `${pair}|${ind}|${dir}`;
    if (!items[key]) items[key] = { pair, ind, dir, critical: false, reasons: [] };
    return items[key];
  };

  const cells = devInsightIndicatorCells(combinedRaw).filter(x => x.decided >= DEV_INSIGHT_MIN_SAMPLE && x.wr != null);
  cells.filter(x => x.wr < DEV_INSIGHT_CRITICAL_WR).forEach(x => {
    const it = getItem(x.pair, x.ind, x.dir);
    it.critical = true;
    it.reasons.push(`WR ${x.wr.toFixed(0)}% на ${x.decided} сигналах — глубоко ниже безубытка.`);
  });

  const TREND_DELTA = 15;
  devTrendCells(sigs).filter(x => x.delta <= -TREND_DELTA).forEach(x => {
    const it = getItem(x.pair, x.ind, x.dir);
    it.reasons.push(`WR упал с ${x.firstWr.toFixed(0)}% до ${x.secondWr.toFixed(0)}% за последние 2 недели — похоже, индикатор устарел под текущие уровни рынка.`);
  });

  const dismissed = devGetDismissed();
  const list = [];
  Object.values(items).forEach(it => {
    const key = `${it.pair}|${it.ind}|${it.dir}`;
    const dismissedAt = dismissed[key];
    if (dismissedAt) {
      const fresh = devFreshWrSince(sigs, it.pair, it.ind, it.dir, dismissedAt);
      if (fresh.decided < DEV_DISMISS_MIN_SAMPLE) return;       // ждём свежих данных после отметки — молчим
      if (fresh.wr == null || fresh.wr >= WR_BREAKEVEN) return; // фикс сработал — молчим
      it.regressed = true;
      it.dismissedAt = dismissedAt;
      it.freshWr = fresh.wr;
      it.freshDecided = fresh.decided;
    }
    list.push(it);
  });

  list.sort((a, b) => (b.critical - a.critical) || (a.pair + a.ind + a.dir).localeCompare(b.pair + b.ind + b.dir));

  if (!list.length) {
    return '<div class="dev-urgent-empty">Явных кандидатов на пересборку нет — все индикаторы либо стабильны, либо выборка ещё мала для вывода.</div>';
  }

  const admin = isDevAdmin();
  return list.map(x => {
    const label = `${x.pair} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'} ${x.ind}`;
    let verdict = x.critical ? 'срочно к пересмотру' : 'на очереди к пересмотру';
    let reasonText = x.reasons.join(' ');
    if (x.regressed) {
      verdict = 'регрессия после правки';
      reasonText = `Отмечено исправленным ${devFmtDk(x.dismissedAt)}, но свежие сигналы снова слабые: WR ${x.freshWr.toFixed(0)}% на ${x.freshDecided} сигналах после фикса.`;
    }
    const icon = x.regressed ? '⚠️' : (x.critical ? '🔴' : '⏳');
    const btn = admin
      ? `<button class="dev-urgent-fix-btn" onclick="devMarkFixed('${x.pair}','${x.ind}','${x.dir}')">✓ Исправлено</button>`
      : '';
    return `<div class="dev-urgent-item ${x.critical || x.regressed ? 'dev-urgent-critical' : ''}">
      <span class="dev-urgent-icon">${icon}</span>
      <div class="dev-urgent-text">
        <div class="dev-urgent-label">${label} — ${verdict}</div>
        <div class="dev-urgent-reason">${reasonText}</div>
        ${btn}
      </div>
    </div>`;
  }).join('');
}

// ===== 2. BLOCKED vs ИСПОЛНЕННЫЕ: кому отдавать приоритет на вход в лимит 5 окон =====
// Лимит "5 одновременных входов в 10-минутное окно" — ограничение биржи, его не обойти.
// Но какой сигнал из нескольких претендентов займёт свободный слот — решается приоритетом,
// и вот это уже управляемо. Если у индикатора WR среди заблокированных сигналов заметно
// выше, чем у того, что реально пропускается в отработку, — это кандидат на повышение приоритета.
const DEV_BLOCKED_MIN_SAMPLE = 10;

function devBlockedVsExecuted(sigs) {
  const agg = { exec: { w: 0, l: 0 }, blocked: { w: 0, l: 0 } };
  const byCell = {};
  for (const s of sigs) {
    if (s.pair !== 'ETH' && s.pair !== 'BTC') continue;
    if (s.res !== 'WIN' && s.res !== 'LOSE') continue;
    const bucket = s.isBlocked ? 'blocked' : 'exec';
    agg[bucket][s.res === 'WIN' ? 'w' : 'l']++;

    if (s.ind === '-') continue;
    const key = `${s.pair}|${s.ind}|${s.dir}`;
    if (!byCell[key]) byCell[key] = { pair: s.pair, ind: s.ind, dir: s.dir, exec: { w: 0, l: 0 }, blocked: { w: 0, l: 0 } };
    byCell[key][bucket][s.res === 'WIN' ? 'w' : 'l']++;
  }
  return { agg, byCell };
}

function devBuildBlockedSection(sigs) {
  const { agg, byCell } = devBlockedVsExecuted(sigs);
  const execWr = devWrOf(agg.exec.w, agg.exec.l);
  const blockedWr = devWrOf(agg.blocked.w, agg.blocked.l);
  const execDec = agg.exec.w + agg.exec.l, blockedDec = agg.blocked.w + agg.blocked.l;

  const blocks = [];
  if (execDec > 0 || blockedDec > 0) {
    blocks.push(devInsightBlock('', '📊 Общая картина',
      [`Исполнено: WR <b>${execWr != null ? execWr.toFixed(1) + '%' : '-'}</b> на <b>${execDec}</b> сигналах. Заблокировано (лимит 5 окон и другие фильтры): WR <b>${blockedWr != null ? blockedWr.toFixed(1) + '%' : '-'}</b> на <b>${blockedDec}</b> сигналах.`]));
  }

  const candidates = [];
  for (const key in byCell) {
    const c = byCell[key];
    const bDec = c.blocked.w + c.blocked.l, eDec = c.exec.w + c.exec.l;
    if (bDec < DEV_BLOCKED_MIN_SAMPLE || eDec < DEV_BLOCKED_MIN_SAMPLE) continue;
    const bWr = devWrOf(c.blocked.w, c.blocked.l), eWr = devWrOf(c.exec.w, c.exec.l);
    candidates.push({ ...c, bWr, eWr, bDec, eDec, delta: bWr - eWr });
  }

  const upgrade = candidates.filter(x => x.delta >= 10).sort((a, b) => b.delta - a.delta);
  const downgrade = candidates.filter(x => x.delta <= -10).sort((a, b) => a.delta - b.delta);

  upgrade.slice(0, 4).forEach(x => {
    blocks.push(devInsightBlock('dev-insight-good', `⬆️ Повысить приоритет: ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}`,
      [`В заблокированных WR <b>${x.bWr.toFixed(0)}%</b> (n=${x.bDec}) — выше, чем у исполненных <b>${x.eWr.toFixed(0)}%</b> (n=${x.eDec}). Этот индикатор чаще проигрывает борьбу за слот более слабым сигналам — стоит дать ему приоритет при занятости 5 окон.`]));
  });
  downgrade.slice(0, 4).forEach(x => {
    blocks.push(devInsightBlock('', `⬇️ Приоритет оправдан: ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}`,
      [`В заблокированных WR <b>${x.bWr.toFixed(0)}%</b> (n=${x.bDec}) — ниже исполненных <b>${x.eWr.toFixed(0)}%</b> (n=${x.eDec}). Здесь фильтр случайно отсекает то, что и так хуже — менять приоритет не нужно.`]));
  });

  if (!upgrade.length && !downgrade.length) {
    blocks.push(devInsightBlock('', 'Явных кандидатов на смену приоритета нет',
      [`Либо выборка заблокированных сигналов слишком мала (нужно ≥ ${DEV_BLOCKED_MIN_SAMPLE} на срез), либо WR блокированных и исполненных сигналов близки друг к другу.`]));
  }
  return blocks.join('');
}

// ===== 3. КАЛИБРОВКА УВЕРЕННОСТИ: соответствует ли заявленный % реальному winrate =====
const DEV_CONF_MIN_SAMPLE = 10;
const DEV_CONF_GAP = 10; // расхождение декларируемой уверенности и реального WR, п.п., чтобы считать разбалансировкой

function devConfidenceBins(sigs) {
  const bins = {};
  for (const s of sigs) {
    if (s.conf == null || (s.res !== 'WIN' && s.res !== 'LOSE')) continue;
    const start = Math.floor(s.conf / 5) * 5;
    const key = `${start}-${start + 4}%`;
    if (!bins[key]) bins[key] = { key, start, w: 0, l: 0, declaredSum: 0, n: 0 };
    bins[key].declaredSum += s.conf;
    bins[key].n++;
    if (s.res === 'WIN') bins[key].w++; else bins[key].l++;
  }
  return Object.values(bins)
    .map(b => ({ ...b, decided: b.w + b.l, avgDeclared: b.declaredSum / b.n, realizedWr: devWrOf(b.w, b.l) }))
    .filter(b => b.decided >= DEV_CONF_MIN_SAMPLE)
    .sort((a, b) => a.start - b.start);
}

function devBuildConfidenceSection(sigs) {
  const bins = devConfidenceBins(sigs);
  if (!bins.length) {
    return devInsightBlock('', 'Недостаточно данных',
      [`В заявленных сигналах не нашлось процента уверенности в тексте сообщения (или сигналов на срез меньше ${DEV_CONF_MIN_SAMPLE}) — сравнить заявленное и реальное не получилось.`]);
  }

  const rows = bins.map(b => {
    const gap = b.realizedWr - b.avgDeclared;
    const cls = Math.abs(gap) >= DEV_CONF_GAP ? (gap < 0 ? 'wr-red' : 'wr-green') : '';
    return `<tr><td>${b.key}</td><td>${b.avgDeclared.toFixed(0)}%</td><td class="${cls}">${b.realizedWr.toFixed(0)}%</td><td class="${cls}">${gap >= 0 ? '+' : ''}${gap.toFixed(0)} п.п.</td><td>${b.decided}</td></tr>`;
  }).join('');
  const table = `<div class="stats-table-wrap"><table class="anal-table"><thead><tr><th>Заявлено</th><th>Ср. заявл.</th><th>Реальный WR</th><th>Разрыв</th><th>n</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const blocks = [devInsightBlock('', '🎯 Заявленная уверенность vs реальный WR по бакетам', [table])];

  const overconfident = bins.filter(b => b.avgDeclared - b.realizedWr >= DEV_CONF_GAP).sort((a, b) => (b.avgDeclared - b.realizedWr) - (a.avgDeclared - a.realizedWr));
  const underconfident = bins.filter(b => b.realizedWr - b.avgDeclared >= DEV_CONF_GAP).sort((a, b) => (b.realizedWr - b.avgDeclared) - (a.realizedWr - a.avgDeclared));

  if (overconfident.length) {
    const worst = overconfident[0];
    blocks.push(devInsightBlock('dev-insight-bad', `⚠️ Модель завышает уверенность в бакете ${worst.key}`,
      [`Заявлено в среднем <b>${worst.avgDeclared.toFixed(0)}%</b>, по факту WR <b>${worst.realizedWr.toFixed(0)}%</b> на ${worst.decided} сигналах — разрыв ${(worst.avgDeclared - worst.realizedWr).toFixed(0)} п.п. Доверять заявленному проценту в этом диапазоне не стоит.`]));
  }
  if (underconfident.length) {
    const best = underconfident[0];
    blocks.push(devInsightBlock('dev-insight-good', `👀 Модель занижает уверенность в бакете ${best.key}`,
      [`Заявлено в среднем <b>${best.avgDeclared.toFixed(0)}%</b>, по факту WR <b>${best.realizedWr.toFixed(0)}%</b> на ${best.decided} сигналах — на деле сигналы этого бакета сильнее, чем написано.`]));
  }
  return blocks.join('');
}

// ===== 5. СЕРИИ ПРОИГРЫШЕЙ: самая длинная просадка подряд по индикатору×направлению =====
const DEV_STREAK_MIN = 4; // от скольки проигрышей подряд считать это заметной серией

// resultType: 'LOSE' для просадок, 'WIN' для победных серий (зеркальная логика)
function devStreaksOfType(sigs, resultType) {
  const groups = {};
  for (const s of sigs) {
    if (s.ind === '-' || (s.pair !== 'ETH' && s.pair !== 'BTC') || (s.res !== 'WIN' && s.res !== 'LOSE')) continue;
    const key = `${s.pair}|${s.ind}|${s.dir}`;
    if (!groups[key]) groups[key] = { pair: s.pair, ind: s.ind, dir: s.dir, seq: [] };
    groups[key].seq.push(s);
  }

  const out = [];
  for (const key in groups) {
    const g = groups[key];
    g.seq.sort((a, b) => (a.dk + String(a.hour ?? 0).padStart(2, '0') + String(a.minute ?? 0).padStart(2, '0'))
      .localeCompare(b.dk + String(b.hour ?? 0).padStart(2, '0') + String(b.minute ?? 0).padStart(2, '0')));

    let cur = 0, curStart = null, maxStreak = 0, maxStart = null, maxEnd = null;
    for (const s of g.seq) {
      if (s.res === resultType) {
        if (cur === 0) curStart = s.dk;
        cur++;
        if (cur > maxStreak) { maxStreak = cur; maxStart = curStart; maxEnd = s.dk; }
      } else cur = 0;
    }
    if (maxStreak >= DEV_STREAK_MIN) {
      out.push({ pair: g.pair, ind: g.ind, dir: g.dir, maxStreak, total: g.seq.length, maxStart, maxEnd });
    }
  }
  return out.sort((a, b) => b.maxStreak - a.maxStreak);
}

function devFmtDk(dk) { return dk ? `${dk.slice(8, 10)}.${dk.slice(5, 7)}` : '?'; }

function devBuildStreakSection(sigs) {
  const losses = devStreaksOfType(sigs, 'LOSE');
  const wins = devStreaksOfType(sigs, 'WIN');
  const blocks = [];

  losses.slice(0, 4).forEach(x => {
    blocks.push(devInsightBlock('dev-insight-bad', `🔥 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}: серия из ${x.maxStreak} проигрышей подряд`,
      [`${devFmtDk(x.maxStart)}-${devFmtDk(x.maxEnd)}, всего сигналов за месяц: ${x.total}. Такая просадка бьёт по риск-менеджменту сильнее, чем видно по среднему WR.`]));
  });
  wins.slice(0, 4).forEach(x => {
    blocks.push(devInsightBlock('dev-insight-good', `🏆 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}: серия из ${x.maxStreak} побед подряд`,
      [`${devFmtDk(x.maxStart)}-${devFmtDk(x.maxEnd)}, всего сигналов за месяц: ${x.total}. Сейчас это "горячий" сигнал - момент присмотреться к увеличению доли.`]));
  });

  if (!blocks.length) {
    blocks.push(devInsightBlock('', 'Серий не найдено', [`Ни у одной пары индикатор×направление нет ${DEV_STREAK_MIN}+ побед или проигрышей подряд за 30 дней.`]));
  }
  return blocks.join('');
}

// ===== ТЕПЛОВАЯ КАРТА: День недели × Час (4-часовые интервалы) =====
const DEV_HEATMAP_MIN = 5; // минимум решённых сигналов в клетке, чтобы красить по WR

function devHeatmapBuild(sigs) {
  const hourBuckets = [[0, 3], [4, 7], [8, 11], [12, 15], [16, 19], [20, 23]];
  const dayLabels = [t('calc.days.mon'), t('calc.days.tue'), t('calc.days.wed'), t('calc.days.thu'), t('calc.days.fri'), t('calc.days.sat'), t('calc.days.sun')];
  const grid = Array.from({ length: 7 }, () => hourBuckets.map(() => ({ w: 0, l: 0 })));

  for (const s of sigs) {
    if ((s.res !== 'WIN' && s.res !== 'LOSE') || s.hour == null) continue;
    const [y, m, d] = s.dk.split('-').map(Number);
    const raw = new Date(y, m - 1, d).getDay(); // 0=Sun
    const dayIdx = raw === 0 ? 6 : raw - 1; // Mon=0..Sun=6
    const bi = hourBuckets.findIndex(([a, b]) => s.hour >= a && s.hour <= b);
    if (bi < 0) continue;
    if (s.res === 'WIN') grid[dayIdx][bi].w++; else grid[dayIdx][bi].l++;
  }
  return { grid, hourBuckets, dayLabels };
}

function devBuildHeatmapSection(sigs) {
  const { grid, hourBuckets, dayLabels } = devHeatmapBuild(sigs);
  const hourLabels = hourBuckets.map(([a, b]) => `${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`);

  let html = '<div class="dev-heatmap-wrap"><table class="dev-heatmap-table"><thead><tr><th></th>';
  hourLabels.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  for (let d = 0; d < 7; d++) {
    html += `<tr><td class="hm-day">${dayLabels[d]}</td>`;
    for (let h = 0; h < hourBuckets.length; h++) {
      const { w, l } = grid[d][h];
      const dec = w + l;
      if (dec < DEV_HEATMAP_MIN) {
        html += '<td class="hm-empty">-</td>';
      } else {
        const wr = Math.round(w / dec * 100);
        html += `<td style="background:${wrRgba(wr)}">${wr}%<span class="hm-n">n=${dec}</span></td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// ===== ПРОСАДКА (DRAWDOWN): насколько глубоко проваливалась кривая PNL от локального пика =====
function devComputeDrawdown(sigs) {
  const dailyMap = {};
  for (const s of sigs) {
    if (s.res !== 'WIN' && s.res !== 'LOSE') continue;
    if (!dailyMap[s.dk]) dailyMap[s.dk] = { wins: 0, losses: 0 };
    if (s.res === 'WIN') dailyMap[s.dk].wins++; else dailyMap[s.dk].losses++;
  }
  const sortedDays = Object.keys(dailyMap).sort();
  if (!sortedDays.length) return null;

  let cum = 0, peak = 0, peakDk = null, maxDd = 0, maxDdStart = null, maxDdEnd = null;
  const labels = [], ddData = [];
  for (const dk of sortedDays) {
    const { wins, losses } = dailyMap[dk];
    cum += wins * 100 - losses * 125;
    if (cum > peak) { peak = cum; peakDk = dk; }
    const dd = cum - peak; // <= 0
    if (dd < maxDd) { maxDd = dd; maxDdStart = peakDk; maxDdEnd = dk; }
    labels.push(`${dk.slice(8, 10)}.${dk.slice(5, 7)}`);
    ddData.push(Math.round((dd / 5000) * 100));
  }
  return { labels, ddData, maxDdUsdt: maxDd, maxDdPct: Math.round((maxDd / 5000) * 100), maxDdStart, maxDdEnd };
}

function devRenderDrawdownChart(sigs) {
  if (pnlChartInstances['l30dDrawdown']) return;
  const dd = devComputeDrawdown(sigs);
  if (!dd) return;

  const noteEl = document.getElementById('devDrawdownNote');
  if (noteEl) {
    noteEl.innerHTML = dd.maxDdPct < 0
      ? `Макс. просадка: <b style="color:#FF5272">${dd.maxDdPct}%</b> от депозита, с ${devFmtDk(dd.maxDdStart)} по ${devFmtDk(dd.maxDdEnd)}.`
      : 'Просадок не было - кривая PNL за месяц ни разу не опускалась ниже локального пика.';
  }

  const ctx = document.getElementById('devDrawdownChart')?.getContext('2d');
  if (!ctx) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, 140);
  gradient.addColorStop(0, 'rgba(255, 82, 114, 0.05)');
  gradient.addColorStop(1, 'rgba(255, 82, 114, 0.4)');

  pnlChartInstances['l30dDrawdown'] = new Chart(ctx, {
    type: 'line',
    data: { labels: dd.labels, datasets: [{ data: dd.ddData, borderColor: '#FF5272', backgroundColor: gradient, borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.25 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `Просадка: ${c.parsed.y}%` } } },
      scales: {
        x: { ticks: { color: '#7B84B0', maxTicksLimit: 8, maxRotation: 0, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { max: 0, ticks: { color: '#7B84B0', font: { size: 10 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
      }
    }
  });
}

// ===== ДОЛЯ ИНДИКАТОРОВ ПО ОБЪЁМУ: контекст для чтения остальных таблиц =====
function devIndicatorShare(sigs) {
  const g = {};
  let total = 0;
  for (const s of sigs) {
    if (s.ind === '-' || (s.res !== 'WIN' && s.res !== 'LOSE')) continue;
    if (!g[s.ind]) g[s.ind] = { ind: s.ind, w: 0, l: 0 };
    if (s.res === 'WIN') g[s.ind].w++; else g[s.ind].l++;
    total++;
  }
  const rows = Object.values(g)
    .map(o => ({ ...o, decided: o.w + o.l, wr: devWrOf(o.w, o.l) }))
    .sort((a, b) => b.decided - a.decided);
  return { rows, total };
}

function devBuildShareSection(sigs) {
  const { rows, total } = devIndicatorShare(sigs);
  if (!rows.length || !total) {
    return devInsightBlock('', 'Нет данных', ['Не удалось определить коды индикаторов в выборке.']);
  }
  let html = '<div class="stats-table-wrap"><table class="anal-table"><thead><tr><th>Индикатор</th><th>Сигналов</th><th>Доля</th><th>WR%</th></tr></thead><tbody>';
  rows.forEach(r => {
    const share = (r.decided / total * 100);
    const wrCls = r.wr != null ? wrClass(Math.round(r.wr)) : '';
    html += `<tr><td>${r.ind}</td><td>${r.decided}</td><td>${share.toFixed(1)}%</td><td class="${wrCls}">${r.wr != null ? r.wr.toFixed(0) + '%' : '-'}</td></tr>`;
  });
  html += '</tbody></table></div>';
  return html;
}

// ===== ВОЛАТИЛЬНОСТЬ ЦЕНЫ vs WR: спокойные дни против волатильных (медианный сплит) =====
function devDailyVolatility(priceMap, dateKeys) {
  const out = {};
  for (let i = 1; i < dateKeys.length; i++) {
    const prev = priceMap[dateKeys[i - 1]], cur = priceMap[dateKeys[i]];
    if (prev == null || cur == null) continue;
    out[dateKeys[i]] = Math.abs(cur - prev) / prev * 100;
  }
  return out;
}

function devVolatilitySplit(sigs, pair, volMap) {
  const vals = Object.values(volMap);
  if (vals.length < 8) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lo = { w: 0, l: 0 }, hi = { w: 0, l: 0 };
  for (const s of sigs) {
    if (s.pair !== pair || (s.res !== 'WIN' && s.res !== 'LOSE')) continue;
    const v = volMap[s.dk];
    if (v == null) continue;
    const b = v >= median ? hi : lo;
    if (s.res === 'WIN') b.w++; else b.l++;
  }
  return { median, loWr: devWrOf(lo.w, lo.l), hiWr: devWrOf(hi.w, hi.l), loDec: lo.w + lo.l, hiDec: hi.w + hi.l };
}

function devBuildVolatilitySection(sigs, ethPriceMap, btcPriceMap, dateKeys) {
  const blocks = [];
  [['ETH', ethPriceMap], ['BTC', btcPriceMap]].forEach(([pair, priceMap]) => {
    const volMap = devDailyVolatility(priceMap, dateKeys);
    const s = devVolatilitySplit(sigs, pair, volMap);
    if (!s || s.loWr == null || s.hiWr == null || s.loDec < 10 || s.hiDec < 10) return;
    const delta = s.hiWr - s.loWr;
    const cls = Math.abs(delta) >= 10 ? (delta < 0 ? 'dev-insight-bad' : 'dev-insight-good') : '';
    const deltaTxt = Math.abs(delta) >= 10
      ? ` Разница ${delta >= 0 ? '+' : ''}${delta.toFixed(0)} п.п. - в этом режиме рынка сигналы работают ${delta < 0 ? 'заметно хуже' : 'заметно лучше'}.`
      : '';
    blocks.push(devInsightBlock(cls, `${pair}: спокойные дни vs волатильные (медиана хода ${s.median.toFixed(1)}%)`,
      [`Спокойные: WR <b>${s.loWr.toFixed(0)}%</b> (n=${s.loDec}). Волатильные: WR <b>${s.hiWr.toFixed(0)}%</b> (n=${s.hiDec}).${deltaTxt}`]));
  });
  if (!blocks.length) {
    blocks.push(devInsightBlock('', 'Недостаточно данных', ['Нужно больше дней с успешно загруженной ценой, чтобы сравнить спокойные и волатильные дни.']));
  }
  return blocks.join('');
}

function devFmtUsdt(v) {
  const r = Math.round(v);
  return `${r >= 0 ? '+' : ''}${r} USDT`;
}

const DEV_INSIGHTS_TOP_N = 10;

// Единый рейтинг находок из ВСЕХ блоков (пары/индикаторы, тренд, BLOCKED, калибровка,
// серии, просадка, волатильность), отсортированный по расчётному влиянию на PNL —
// сколько это стоит в USDT за месяц (или период сравнения), без разбивки по категориям.
// Отрицательное влияние = находка в убыток, положительное = находка в плюс/потенциал.
function devBuildInsights(sigs, combinedRaw, ethPriceMap, btcPriceMap, dateKeys) {
  const findings = [];

  // ── Пары×направления и индикаторы×направления ──────────────────────────
  const pairDir = devInsightPairDir(sigs).filter(x => x.decided >= DEV_INSIGHT_MIN_SAMPLE && x.wr != null);
  const pairDirMap = {};
  pairDir.forEach(x => { pairDirMap[`${x.pair}|${x.dir}`] = x; });

  const cells = devInsightIndicatorCells(combinedRaw).filter(x => x.decided >= DEV_INSIGHT_MIN_SAMPLE && x.wr != null);
  const badCells = cells.filter(x => x.wr < WR_BREAKEVEN);

  badCells.forEach(x => {
    const impact = x.w * 100 - x.l * 125;
    const label = `${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}`;
    const parent = pairDirMap[`${x.pair}|${x.dir}`];
    if (parent && parent.wr >= WR_GREEN) {
      const without = devWrWithout(parent, x);
      const afterTxt = without != null ? `, без него WR направления был бы ${without.toFixed(1)}%` : '';
      findings.push({ impact, cls: 'dev-insight-bad',
        title: `🎭 ${label} маскируется внутри сильного ${parent.pair} ${parent.dir === 'UP' ? '↑ UP' : '↓ DOWN'} (${parent.wr.toFixed(1)}%)`,
        body: [`WR <b>${x.wr.toFixed(0)}%</b> на <b>${x.decided}</b> сигналах${afterTxt}. Влияние на PNL: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
    } else {
      const critical = x.wr < DEV_INSIGHT_CRITICAL_WR;
      findings.push({ impact, cls: 'dev-insight-bad',
        title: `${critical ? '🔴' : '⚠️'} ${label}${critical ? ' систематически убыточен' : ' ниже безубытка'}`,
        body: [`WR <b>${x.wr.toFixed(0)}%</b> на <b>${x.decided}</b> сигналах. Влияние на PNL: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
    }
  });

  pairDir.filter(x => x.wr >= WR_GREEN && !badCells.some(c => c.pair === x.pair && c.dir === x.dir)).forEach(s => {
    const impact = s.w * 100 - s.l * 125;
    findings.push({ impact, cls: 'dev-insight-good',
      title: `✅ ${s.label} - чистая сильная сторона`,
      body: [`WR <b>${s.wr.toFixed(1)}%</b> на <b>${s.decided}</b> сигналах, без слабых индикаторов внутри. Вклад в PNL: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
  });

  pairDir.filter(x => x.wr < WR_BREAKEVEN).forEach(w => {
    const impact = w.w * 100 - w.l * 125;
    findings.push({ impact, cls: 'dev-insight-bad',
      title: `⚠️ ${w.label} - слабое направление целиком`,
      body: [`WR <b>${w.wr.toFixed(1)}%</b> на <b>${w.decided}</b> сигналах - ниже безубытка (${WR_BREAKEVEN}%). Итог направления: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
  });

  // ── Тренд по неделям ─────────────────────────────────────────────────
  const TREND_DELTA = 15;
  devTrendCells(sigs).filter(x => Math.abs(x.delta) >= TREND_DELTA).forEach(x => {
    const impact = x.secondDec * (devEvPerSignal(x.secondWr) - devEvPerSignal(x.firstWr));
    const worsening = x.delta < 0;
    findings.push({ impact, cls: worsening ? 'dev-insight-bad' : 'dev-insight-good',
      title: `${worsening ? '📉' : '📈'} ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'} ${worsening ? 'слабеет' : 'набирает силу'}`,
      body: [`Было <b>${x.firstWr.toFixed(0)}%</b> (n=${x.firstDec}) → стало <b>${x.secondWr.toFixed(0)}%</b> (n=${x.secondDec}). Влияние тренда на PNL: <b>${devFmtUsdt(impact)}</b> за вторую половину месяца.`] });
  });

  // ── BLOCKED vs исполненные: только явные кандидаты на повышение приоритета ──
  const { byCell: blockedByCell } = devBlockedVsExecuted(sigs);
  Object.values(blockedByCell).forEach(c => {
    const bDec = c.blocked.w + c.blocked.l, eDec = c.exec.w + c.exec.l;
    if (bDec < DEV_BLOCKED_MIN_SAMPLE || eDec < DEV_BLOCKED_MIN_SAMPLE) return;
    const bWr = devWrOf(c.blocked.w, c.blocked.l), eWr = devWrOf(c.exec.w, c.exec.l);
    if (bWr - eWr < 10) return;
    const impact = bDec * (devEvPerSignal(bWr) - devEvPerSignal(eWr));
    findings.push({ impact, cls: 'dev-insight-good',
      title: `⬆️ ${c.pair} ${c.ind} ${c.dir === 'UP' ? '↑ UP' : '↓ DOWN'}: повысить приоритет на вход`,
      body: [`В заблокированных WR <b>${bWr.toFixed(0)}%</b> (n=${bDec}) выше, чем у исполненных <b>${eWr.toFixed(0)}%</b> (n=${eDec}). Оценочный потенциал: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
  });

  // ── Калибровка уверенности ───────────────────────────────────────────
  devConfidenceBins(sigs).forEach(b => {
    const gap = b.realizedWr - b.avgDeclared;
    if (Math.abs(gap) < DEV_CONF_GAP) return;
    const impact = b.w * 100 - b.l * 125;
    findings.push({ impact, cls: impact < 0 ? 'dev-insight-bad' : 'dev-insight-good',
      title: `${gap < 0 ? '⚠️' : '👀'} Бакет уверенности ${b.key}: модель ${gap < 0 ? 'завышает' : 'занижает'} уверенность`,
      body: [`Заявлено <b>${b.avgDeclared.toFixed(0)}%</b>, реальный WR <b>${b.realizedWr.toFixed(0)}%</b> на ${b.decided} сигналах. Фактический результат бакета: <b>${devFmtUsdt(impact)}</b> за месяц.`] });
  });

  // ── Серии побед/проигрышей ───────────────────────────────────────────
  devStreaksOfType(sigs, 'LOSE').forEach(x => {
    const impact = -(x.maxStreak * 125);
    findings.push({ impact, cls: 'dev-insight-bad',
      title: `🔥 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}: серия из ${x.maxStreak} проигрышей подряд`,
      body: [`${devFmtDk(x.maxStart)}-${devFmtDk(x.maxEnd)}. Прямой убыток от серии: <b>${devFmtUsdt(impact)}</b>.`] });
  });
  devStreaksOfType(sigs, 'WIN').forEach(x => {
    const impact = x.maxStreak * 100;
    findings.push({ impact, cls: 'dev-insight-good',
      title: `🏆 ${x.pair} ${x.ind} ${x.dir === 'UP' ? '↑ UP' : '↓ DOWN'}: серия из ${x.maxStreak} побед подряд`,
      body: [`${devFmtDk(x.maxStart)}-${devFmtDk(x.maxEnd)}. Прямая прибыль от серии: <b>${devFmtUsdt(impact)}</b>.`] });
  });

  // ── Просадка ──────────────────────────────────────────────────────────
  const dd = devComputeDrawdown(sigs);
  if (dd && dd.maxDdUsdt < 0) {
    findings.push({ impact: dd.maxDdUsdt, cls: 'dev-insight-bad',
      title: '📉 Максимальная просадка за месяц',
      body: [`${devFmtDk(dd.maxDdStart)}-${devFmtDk(dd.maxDdEnd)}. Глубина от локального пика: <b>${devFmtUsdt(dd.maxDdUsdt)}</b>.`] });
  }

  // ── Волатильность цены vs WR ─────────────────────────────────────────
  if (ethPriceMap && btcPriceMap && dateKeys) {
    [['ETH', ethPriceMap], ['BTC', btcPriceMap]].forEach(([pair, priceMap]) => {
      const volMap = devDailyVolatility(priceMap, dateKeys);
      const s = devVolatilitySplit(sigs, pair, volMap);
      if (!s || s.loWr == null || s.hiWr == null || s.loDec < 10 || s.hiDec < 10) return;
      if (Math.abs(s.hiWr - s.loWr) < 10) return;
      const impact = s.hiDec * (devEvPerSignal(s.hiWr) - devEvPerSignal(s.loWr));
      findings.push({ impact, cls: impact < 0 ? 'dev-insight-bad' : 'dev-insight-good',
        title: `〰️ ${pair}: результат заметно ${impact < 0 ? 'хуже' : 'лучше'} на волатильных днях`,
        body: [`Спокойные: WR ${s.loWr.toFixed(0)}% (n=${s.loDec}). Волатильные: WR ${s.hiWr.toFixed(0)}% (n=${s.hiDec}). Влияние: <b>${devFmtUsdt(impact)}</b> за волатильные дни в выборке.`] });
    });
  }

  if (!findings.length) {
    return devInsightBlock('', 'Явных перекосов не найдено',
      [`Все срезы либо в пределах нормы, либо выборка меньше минимума для уверенного вывода.`]);
  }

  findings.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return findings.slice(0, DEV_INSIGHTS_TOP_N).map(f => devInsightBlock(f.cls, f.title, f.body)).join('');
}

async function renderDevL30d() {
  if (devL30dRendered) return;
  try {
    // Цены грузим параллельно с сигналами — если сеть недоступна, графики PNL/таблицы всё равно отрисуются.
    const [{ sigs, cntAll, cntBlocked, combinedRaw }, ethPriceMap, btcPriceMap] = await Promise.all([
      devFetchSignals30d(),
      devFetchDailyCloses('ETHUSDT', 30).catch(() => ({})),
      devFetchDailyCloses('BTCUSDT', 30).catch(() => ({})),
    ]);
    devL30dRendered = true;

    const sum = document.getElementById('devSrcSummary');
    if (sum) {
      sum.innerHTML = `${t('stats.dev.src')}: ALLsignal <b>${cntAll}</b> + BLOCKEDsignal <b class="dev-blocked-num">${cntBlocked}</b> = <b>${cntAll + cntBlocked}</b>`;
    }
    if (!sigs.length) return;

    const dateKeys = devDailyDateRange(30);
    const dateLabels = dateKeys.map(dk => `${dk.slice(8, 10)}.${dk.slice(5, 7)}`);

    // График не должен блокировать таблицы (например, если CDN Chart.js недоступен)
    try { devRenderPnlChart(sigs); } catch (e) { console.log('DEV PNL chart error:', e); }
    try { devShowTable('devUrgentBlock', 'devUrgentCard', devBuildUrgentSection(sigs, combinedRaw)); } catch (e) { console.log('DEV urgent error:', e); }
    try {
      devRenderDrawdownChart(sigs);
      const ddCard = document.getElementById('devDrawdownCard');
      if (ddCard) ddCard.style.display = 'block';
    } catch (e) { console.log('DEV drawdown error:', e); }

    // PNL vs Цена — отдельно ETH и BTC, чтобы сопоставить траекторию цены и PNL
    try {
      const sigsEth = sigs.filter(s => s.pair === 'ETH');
      const sigsBtc = sigs.filter(s => s.pair === 'BTC');
      devRenderPnlPriceChart('pnlChartL30dDevEth', 'l30dDevEth', dateLabels,
        devCumulativePnlPct(sigsEth, dateKeys), dateKeys.map(dk => ethPriceMap[dk] ?? null), '#66A3FF');
      devRenderPnlPriceChart('pnlChartL30dDevBtc', 'l30dDevBtc', dateLabels,
        devCumulativePnlPct(sigsBtc, dateKeys), dateKeys.map(dk => btcPriceMap[dk] ?? null), '#F7931A');
      document.getElementById('devPnlEthCard').style.display = 'block';
      document.getElementById('devPnlBtcCard').style.display = 'block';
    } catch (e) { console.log('DEV PNL/Price chart error:', e); }

    try { devShowTable('devVolatilityBlock', 'devVolatilityCard', devBuildVolatilitySection(sigs, ethPriceMap, btcPriceMap, dateKeys)); } catch (e) { console.log('DEV volatility error:', e); }


    // By Trading Pair
    const pairGroups = devAggregate(sigs, s => (s.pair === 'ETH' || s.pair === 'BTC') ? s.pair : null);
    devShowTable('devPairsTable', 'devPairsCard', devBuildTable(['ETH', 'BTC'], pairGroups));

    // WinRate by Day of Week — по объединённым сырым строкам
    renderDowChart('devDowChart', 30, combinedRaw);
    const dowCard = document.getElementById('devDowCard');
    if (dowCard) dowCard.style.display = 'block';

    // By Time Zone (15-минутные зоны внутри часа)
    const tzOrder = ['0-14', '15-29', '30-44', '45-59'];
    const tzGroups = devAggregate(sigs, s => s.minute == null ? null : tzOrder[Math.floor(s.minute / 15)]);
    devShowTable('devTFTable', 'devTFCard', devBuildTable(tzOrder, tzGroups));

    // By 5min Zone
    const fiveOrder = [];
    for (let f = 0; f < 60; f += 5) fiveOrder.push(`${f}-${f + 4}`);
    const fiveGroups = devAggregate(sigs, s => s.minute == null ? null : fiveOrder[Math.floor(s.minute / 5)]);
    devShowTable('dev5minTable', 'dev5minCard', devBuildTable(fiveOrder, fiveGroups));

    // By Hour Zone
    const hourOrder = [];
    for (let h = 0; h < 24; h++) hourOrder.push(`${h}:00`);
    const hourGroups = devAggregate(sigs, s => s.hour == null ? null : `${s.hour}:00`);
    devShowTable('devHourTable', 'devHourCard', devBuildTable(hourOrder, hourGroups));

    // Тепловая карта День × Час и доля индикаторов по объёму — контекст перед таблицами по индикаторам
    try { devShowTable('devHeatmapBlock', 'devHeatmapCard', devBuildHeatmapSection(sigs)); } catch (e) { console.log('DEV heatmap error:', e); }
    try { devShowTable('devShareBlock', 'devShareCard', devBuildShareSection(sigs)); } catch (e) { console.log('DEV share error:', e); }

    // By Indicator — общая + отдельно ETH и BTC, по объединённым строкам
    devShowTable('devCrossTable', 'devCrossCard', buildIndicatorTable(aggregateByIndicator(combinedRaw, 21, 30, null), MIN_SAMPLE));
    devShowTable('devCrossEthTable', 'devCrossEthCard', buildIndicatorTable(aggregateByIndicator(combinedRaw, 21, 30, 'ETH'), MIN_SAMPLE));
    devShowTable('devCrossBtcTable', 'devCrossBtcCard', buildIndicatorTable(aggregateByIndicator(combinedRaw, 21, 30, 'BTC'), MIN_SAMPLE));

    // Углублённая аналитика — каждый блок независим, ошибка в одном не должна гасить остальные
    try { devShowTable('devTrendBlock', 'devTrendCard', devBuildTrendSection(sigs)); } catch (e) { console.log('DEV trend error:', e); }
    try { devShowTable('devBlockedBlock', 'devBlockedCard', devBuildBlockedSection(sigs)); } catch (e) { console.log('DEV blocked error:', e); }
    try { devShowTable('devConfidenceBlock', 'devConfidenceCard', devBuildConfidenceSection(sigs)); } catch (e) { console.log('DEV confidence error:', e); }
    try { devShowTable('devStreakBlock', 'devStreakCard', devBuildStreakSection(sigs)); } catch (e) { console.log('DEV streak error:', e); }

    // Итог — автоматические выводы по срезу (в конце страницы)
    try {
      const insightsEl = document.getElementById('devInsights');
      const insightsCard = document.getElementById('devInsightsCard');
      if (insightsEl && insightsCard) {
        insightsEl.innerHTML = devBuildInsights(sigs, combinedRaw, ethPriceMap, btcPriceMap, dateKeys);
        insightsCard.style.display = 'block';
      }
    } catch (e) { console.log('DEV insights error:', e); }
  } catch (e) {
    console.log('DEV L30D error:', e);
  }
}

// ===== DOW CHART (WinRate by Day of Week) =====
// daysFilter: число дней назад (30 для L30D), null = все периоды
const dowChartInstances = {};

async function renderDowChart(canvasId, daysFilter, rowsOverride) {
  if (dowChartInstances[canvasId]) return;
  try {
    const rows = rowsOverride || await fetchAllSignals();
    if (!rows || rows.length < 2) return;

    // Day names Mon–Sun (index 0=Mon…6=Sun)
    const dayLabels = [
      t('calc.days.mon'), t('calc.days.tue'), t('calc.days.wed'),
      t('calc.days.thu'), t('calc.days.fri'), t('calc.days.sat'), t('calc.days.sun')
    ];

    // Build cutoff if needed
    let cutoffKey = null;
    if (daysFilter) {
      const now = new Date();
      const cd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFilter);
      cutoffKey = `${cd.getFullYear()}-${String(cd.getMonth()+1).padStart(2,'0')}-${String(cd.getDate()).padStart(2,'0')}`;
    }

    // dow map: 0=Mon … 6=Sun
    const dowMap = [0,1,2,3,4,5,6].map(() => ({ w: 0, l: 0 }));

    for (let i = 1; i < rows.length; i++) {
      const res = rows[i][9];
      if (res !== 'WIN' && res !== 'LOSE') continue;
      const dateStr = (rows[i][12] || '').trim();
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const d = parts[0].padStart(2,'0');
      const m = parts[1].padStart(2,'0');
      const y = parts[2].substring(0,4);
      if (y.length < 4) continue;

      if (cutoffKey) {
        const dk = `${y}-${m}-${d}`;
        if (dk < cutoffKey) continue;
      }

      const dt = new Date(+y, +m - 1, +d);
      if (isNaN(dt.getTime())) continue;
      // getDay(): 0=Sun,1=Mon…6=Sat → convert to Mon-based 0-6
      const raw = dt.getDay(); // 0=Sun
      const idx = raw === 0 ? 6 : raw - 1; // Mon=0…Sun=6
      if (res === 'WIN') dowMap[idx].w++;
      else               dowMap[idx].l++;
    }

    const totals = dowMap.map(d => d.w + d.l);
    const winRates = dowMap.map(d => {
      const tot = d.w + d.l;
      return tot > 0 ? parseFloat((d.w / tot * 100).toFixed(1)) : 0;
    });
    const avgWr = (() => {
      const tw = dowMap.reduce((s,d) => s + d.w, 0);
      const tl = dowMap.reduce((s,d) => s + d.l, 0);
      return (tw + tl) > 0 ? parseFloat((tw / (tw + tl) * 100).toFixed(1)) : 0;
    })();

    const barColors = winRates.map(v => wrRgba(v));
    const borderColors = winRates.map(v => wrHex(v));

    const container = document.getElementById(canvasId)?.parentElement;
    if (!document.getElementById(canvasId)) return;
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (!ctx) return;

    const labelsPlugin = {
      id: 'dowBarLabels_' + canvasId,
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const c = chart.ctx;
        c.save();
        c.textAlign = 'center';
        meta.data.forEach((bar, i) => {
          const wr = winRates[i];
          const col = wrHex(wr);
          c.fillStyle = '#E8EAFF';
          c.font = '600 10px -apple-system, sans-serif';
          c.fillText(`${wr}%`, bar.x, bar.y - 18);
          c.fillStyle = '#7B84B0';
          c.font = '500 9px -apple-system, sans-serif';
          c.fillText(`(${totals[i]})`, bar.x, bar.y - 6);
        });
        c.restore();
      }
    };

    dowChartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dayLabels,
        datasets: [
          {
            data: winRates,
            backgroundColor: barColors,
            borderColor: borderColors,
            borderWidth: 1,
            borderRadius: 4,
            barPercentage: 0.65,
            order: 2
          },
          {
            type: 'line',
            data: dayLabels.map(() => avgWr),
            borderColor: 'rgba(232,234,255,0.35)',
            borderWidth: 1.5,
            borderDash: [5, 4],
            pointRadius: 0,
            fill: false,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 28 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: c => c.datasetIndex === 0
                ? `WR: ${c.parsed.y}%`
                : `Avg: ${c.parsed.y}%`,
              afterLabel: c => c.datasetIndex === 0
                ? `Сигналов: ${totals[c.dataIndex]}`
                : ''
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#7B84B0', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          },
          y: {
            min: Math.floor(Math.max(0, Math.min(...winRates.filter(v => v > 0)) - 10)),
            max: Math.ceil(Math.min(100, Math.max(...winRates) + 5)),
            ticks: { color: '#7B84B0', font: { size: 10 }, precision: 0, stepSize: 5, callback: v => Math.round(v) + '%' },
            grid: { color: 'rgba(255,255,255,0.04)' }
          }
        }
      },
      plugins: [labelsPlugin]
    });
  } catch(e) {
    console.log('DOW chart error:', e);
  }
}

// ===== MONTHLY WINRATE CHART (ALL Periods) =====
async function renderMonthlyWrChart() {
  if (monthlyWrChartInstance) return;
  try {
    const rows = await fetchAllSignals();
    if (!rows || rows.length < 2) return;

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthMap = {};
    let totalWins = 0, totalLosses = 0;

    for (let i = 1; i < rows.length; i++) {
      const result = rows[i][9];
      if (result !== 'WIN' && result !== 'LOSE') continue;
      const dateStr = (rows[i][12] || '').trim();
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const m = parseInt(parts[1], 10);
      const y = parseInt(parts[2].substring(0, 4), 10);
      if (isNaN(m) || isNaN(y) || m < 1 || m > 12) continue;
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      if (!monthMap[mk]) monthMap[mk] = { label: [monthNames[m - 1], `'${String(y).slice(2)}`], wins: 0, losses: 0 };
      if (result === 'WIN') { monthMap[mk].wins++; totalWins++; }
      else { monthMap[mk].losses++; totalLosses++; }
    }

    const sortedKeys = Object.keys(monthMap).sort();
    if (!sortedKeys.length) return;

    const labels = [], wrData = [], counts = [], colors = [];
    for (const mk of sortedKeys) {
      const { label, wins, losses } = monthMap[mk];
      const total = wins + losses;
      const wr = total ? (wins / total * 100) : 0;
      labels.push(label);
      wrData.push(parseFloat(wr.toFixed(1)));
      counts.push(total);
      colors.push(wrHex(wr));
    }

    const avgWr = (totalWins + totalLosses) ? parseFloat((totalWins / (totalWins + totalLosses) * 100).toFixed(1)) : 0;
    const yMin = 50, yMax = 90;

    const ctx = document.getElementById('monthlyWrChart')?.getContext('2d');
    if (!ctx) return;

    const barLabelsPlugin = {
      id: 'monthlyWrBarLabels',
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const c = chart.ctx;
        c.save();
        c.textAlign = 'center';
        meta.data.forEach((bar, i) => {
          c.fillStyle = '#E8EAFF';
          c.font = '600 11px sans-serif';
          c.fillText(`${wrData[i]}%`, bar.x, bar.y - 20);
          c.fillStyle = '#7B84B0';
          c.font = '500 9px sans-serif';
          c.fillText(`(${counts[i]}s)`, bar.x, bar.y - 8);
        });
        c.restore();
      }
    };

    monthlyWrChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { data: wrData, backgroundColor: colors, borderRadius: 4, barPercentage: 0.6, order: 2 },
          { type: 'line', data: labels.map(() => avgWr), borderColor: 'rgba(232,234,255,0.35)', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false, order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 30 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.datasetIndex === 0,
            callbacks: { label: c => `WR ${c.parsed.y}% · ${counts[c.dataIndex]} signals` }
          }
        },
        scales: {
          x: { ticks: { color: '#7B84B0', font: { size: 10 } }, grid: { display: false } },
          y: { min: yMin, max: yMax, ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      },
      plugins: [barLabelsPlugin]
    });
  } catch(e) {
    console.log('Monthly WR chart error:', e);
  }
}


// ===== TODAY'S SIGNALS =====
let signalTimerInterval = null;

function todayStr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatTimerAgo(timeStr) {
  // timeStr = "HH:MM:SS" or "HH:MM"
  if (!timeStr) return '-';
  const parts = timeStr.split(':');
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  const s = parseInt(parts[2]) || 0;

  const now = new Date();
  const signal = new Date();
  signal.setHours(h, m, s, 0);

  let diff = Math.floor((now - signal) / 1000);
  if (diff < 0) diff = 0;

  const hours = Math.floor(diff / 3600);
  const mins  = Math.floor((diff % 3600) / 60);
  const secs  = diff % 60;

  if (hours > 0) return `${hours}${t('sig.ago.h')} ${mins}${t('sig.ago.m')} ${t('sig.ago.word')}`;
  if (mins > 0)  return `${mins}${t('sig.ago.m')} ${secs}${t('sig.ago.s')} ${t('sig.ago.word')}`;
  return `${secs}${t('sig.ago.s')} ${t('sig.ago.word')}`;
}

async function loadTodaySignals() {
  try {
    const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=ALLsignal`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);
    const today = todayStr(); // DD.MM.YYYY

    // M (index 12) contains date DD.MM.YYYY — filter by today
    const todayRows = rows.filter((r, i) => i > 0 && r[12] === today);

    // Показываем сигнал только после появления результата в таблице.
    // Живые (ещё не закрытые) сигналы в приложении не отображаются — они идут в приватную группу PRO.
    const RESOLVED = new Set(['WIN', 'LOSE', 'WIN & LOSE']);
    const resolvedRows = todayRows.filter(r => RESOLVED.has((r[9] || '').trim()));

    const list = document.getElementById('signalsList');

    if (resolvedRows.length === 0) {
      list.innerHTML = `<div class="signals-empty">${t('sig.empty')}</div>`;
      document.getElementById('signalTimer').textContent = '-';
      return;
    }

    // Time is at index 11 (col L = HH:MM) — по последнему ЗАКРЫТОМУ сигналу
    const lastRow = resolvedRows[resolvedRows.length - 1];
    const lastTime = lastRow[11];

    // Start live timer
    if (signalTimerInterval) clearInterval(signalTimerInterval);
    const updateTimer = () => {
      document.getElementById('signalTimer').textContent = formatTimerAgo(lastTime);
    };
    updateTimer();
    signalTimerInterval = setInterval(updateTimer, 1000);

    // Render list (newest first) — только закрытые сигналы
    const reversed = [...resolvedRows].reverse();
    list.innerHTML = reversed.map(r => {
      const pair   = r[1]  || '-';
      const dir    = r[2]  || '-';
      const price  = r[3]  || '';
      const result = r[9]  || '';
      const time   = (r[11] || '').substring(0, 8) || '-'; // HH:MM:SS col L

      const isUp    = dir === 'UP';
      const isWin   = result === 'WIN';
      const isLose  = result === 'LOSE';
      const isHalf  = result === 'WIN & LOSE';
      const dirClass  = isUp ? 'sig-up' : 'sig-down';
      const resClass  = isWin ? 'sig-win' : isLose ? 'sig-lose' : 'sig-pending';
      const dirLabel  = isUp ? '↑ UP' : '↓ DOWN';
      const pairShort = pair.replace('USDT.P', '');

      const WIN_ICON  = `<svg width="22" height="20" viewBox="0 0 22 20" fill="none" style="vertical-align:-4px">
        <path d="M2 10.5L8 16.5L20 3.5" stroke="#4EFFA0" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.15"/>
        <path d="M2.5 10.9L8.1 16.9L20.3 3.9" stroke="#4EFFA0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.65"/>
        <path d="M1.7 10L7.7 16L19.7 3" stroke="#4EFFA0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.9"/>
        <path d="M3 11.3L8.3 16.2L20.6 4.1" stroke="#4EFFA0" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.5"/>
        <path d="M2.2 9.6L7.5 15.5L19.3 2.6" stroke="#4EFFA0" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.4"/>
      </svg>`;
      const LOSE_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" style="vertical-align:-4px">
        <path d="M3 3L17 17M17 3L3 17" stroke="#FF3B6B" stroke-width="5.5" stroke-linecap="round" stroke-opacity="0.15"/>
        <path d="M3.4 2.6L17.4 16.6M16.6 2.6L2.6 16.6" stroke="#FF3B6B" stroke-width="3" stroke-linecap="round" stroke-opacity="0.65"/>
        <path d="M2.6 3.4L16.6 17.4M17.4 3.4L3.4 17.4" stroke="#FF3B6B" stroke-width="2" stroke-linecap="round" stroke-opacity="0.9"/>
        <path d="M3.8 3L17.8 17M17.8 3L3 16.8" stroke="#FF3B6B" stroke-width="1.1" stroke-linecap="round" stroke-opacity="0.5"/>
        <path d="M2.5 3.8L16.2 17.5M17.5 3.8L3.2 17.2" stroke="#FF3B6B" stroke-width="0.8" stroke-linecap="round" stroke-opacity="0.4"/>
      </svg>`;
      const resIcon   = isWin ? WIN_ICON : isLose ? LOSE_ICON : '';
      const resText   = isWin ? 'WIN' : isLose ? 'LOSE' : isHalf ? '50/50' : '-';

      return `<div class="signal-row">
        <span class="sig-time">${time}</span>
        <span class="sig-pair">${pairShort}</span>
        <span class="sig-dir ${dirClass}">${dirLabel}</span>
        <span class="sig-price">${price}</span>
        <span class="sig-res ${resClass}">${resIcon}${resText}</span>
      </div>`;
    }).join('');

    // Summary line (WIN & LOSE excluded from WR calculation) — по закрытым сигналам
    const wins   = resolvedRows.filter(r => r[9] === 'WIN').length;
    const losses = resolvedRows.filter(r => r[9] === 'LOSE').length;
    const wr     = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
    const summary = document.createElement('div');
    summary.className = 'signals-summary';
    summary.innerHTML = `${t('sig.sum.total')}: <b>${resolvedRows.length}</b> &nbsp;·&nbsp; WIN: <b class="wr-green">${wins}</b> &nbsp;·&nbsp; LOSE: <b class="wr-red">${losses}</b> &nbsp;·&nbsp; WR: <b>${wr}%</b>`;
    list.prepend(summary);

  } catch(e) {
    console.log('Signals error:', e);
    document.getElementById('signalsList').innerHTML = `<div class="signals-empty">${t('sig.error')}</div>`;
  }
}

// ===== ГРАФИК «СИГНАЛЫ СЕГОДНЯ» (BTC / ETH) =====
// Свечи 15m + маркеры по результату: WIN UP зелёный / WIN DOWN красный / LOSE серый / 50-50 жёлтый.
// Маркеры строятся ТОЛЬКО по закрытым сигналам — живые (без результата) на график не попадают.
const SIG_CHART = { coin: 'ETH', rendered: false };
const SIG_CANDLE_CACHE = {};        // { BTC: candles[], ETH: candles[] }
const SIG_MARK_COLOR = { winUp: '#4EFFA0', winDown: '#FF5272', lose: '#7B84B0', half: '#FFD166' };
// Сдвиг времени таблицы относительно UTC, в минутах (прибавляется к времени из таблицы).
//   null  = авто-подбор по цене входа (по умолчанию, обычно угадывает сам)
//   число = зафиксировать вручную, если маркеры смещены:
//           -180 если время в таблице по UTC+3 (Москва), -120 для UTC+2, 0 для UTC
const SIG_TZ_OVERRIDE_MIN = null;

function sigPairBase(p) {
  return String(p || '').toUpperCase().replace('USDT.P', '').replace('USDT', '').replace('.P', '').trim();
}
function sigPrecisionFor(price) {
  if (price >= 100) return { precision: 2, minMove: 0.01 };
  if (price >= 1)   return { precision: 4, minMove: 0.0001 };
  return { precision: 6, minMove: 0.000001 };
}

// Маркеры за сегодня по монете. Таймзону таблицы не угадываем —
// подбираем сдвиг времени так, чтобы цена входа попадала в диапазон свечи (авто-калибровка).
// tfSec — длительность свечи в секундах (5m = 300), нужна для привязки к нужной свече.
function buildSignalMarkers(rows, coin, candles, tfSec) {
  tfSec = tfSec || 300;
  const today = todayStr();
  const RESOLVED = new Set(['WIN', 'LOSE', 'WIN & LOSE']);
  const [dd, mo, yy] = today.split('.').map(Number);
  const sigs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[12] !== today) continue;
    if (sigPairBase(r[1]) !== coin) continue;
    const res = (r[9] || '').trim();
    if (!RESOLVED.has(res)) continue;
    const dir = (r[2] || '').trim().toUpperCase();
    const price = parseFloat(String(r[3]).replace(',', '.')) || 0;
    const tp = (r[11] || '0:0:0').split(':');
    const hh = parseInt(tp[0]) || 0, mm = parseInt(tp[1]) || 0, ss = parseInt(tp[2]) || 0;
    const baseUnix = Math.floor(Date.UTC(yy, mo - 1, dd, hh, mm, ss) / 1000);
    sigs.push({ baseUnix, dir, res, price });
  }
  if (!sigs.length || !candles.length) return [];

  const byTime = new Map(candles.map(c => [c.time, c]));
  const bucketOf = (s, off) => Math.floor((s.baseUnix + off * 60) / tfSec) * tfSec;
  const inCandle = (s, off) => {
    const c = byTime.get(bucketOf(s, off));
    return c && s.price >= c.low && s.price <= c.high;
  };

  let off;
  if (SIG_TZ_OVERRIDE_MIN != null) {
    off = SIG_TZ_OVERRIDE_MIN;
  } else {
    // авто-подбор: только целочасовые сдвиги (реальные таймзоны), оценка по попаданию цены в свечу
    let best = { off: 0, hits: -1 };
    for (let h = -12; h <= 14; h++) {
      const o = h * 60;
      let hits = 0;
      for (const s of sigs) if (inCandle(s, o)) hits++;
      if (hits > best.hits || (hits === best.hits && Math.abs(o) < Math.abs(best.off))) best = { off: o, hits };
    }
    off = best.hits > 0 ? best.off : 0;   // нет ни одного совпадения -> ставим как есть (UTC)
  }

  return sigs.map(s => {
    const bucket = bucketOf(s, off);
    const isUp = s.dir === 'UP';
    let color;
    if (s.res === 'WIN') color = isUp ? SIG_MARK_COLOR.winUp : SIG_MARK_COLOR.winDown;
    else if (s.res === 'LOSE') color = SIG_MARK_COLOR.lose;
    else color = SIG_MARK_COLOR.half;
    return {
      time: bucket,
      position: isUp ? 'belowBar' : 'aboveBar',
      color,
      shape: isUp ? 'arrowUp' : 'arrowDown',
      size: 1,
    };
  }).sort((a, b) => a.time - b.time);
}

// Свечи 5m для графика «Сигналы сегодня» (Binance fapi -> Bybit). Отдельно от 15m-движка Лаборатории.
async function sigFetch(u, ms) {
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), ms) : null;
  try { return await fetch(u, ac ? { signal: ac.signal } : {}); }
  finally { if (t) clearTimeout(t); }
}
async function fetchSigCandles5m(sym, days) {
  // Binance USDT-M futures, 5m
  try {
    const end = Date.now(); let start = end - days * 864e5; const out = [];
    for (let it = 0; it < 5 && start < end; it++) {
      const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=5m&limit=1500&startTime=${start}`;
      const r = await sigFetch(u, 9000); if (!r.ok) throw new Error('fapi ' + r.status);
      const chunk = await r.json(); if (!chunk.length) break;
      out.push(...chunk); start = chunk[chunk.length - 1][0] + 1;
      if (chunk.length < 1500) break;
    }
    if (out.length) return out.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
  } catch (e) { /* фолбэк ниже */ }
  // Bybit linear, 5m (последние ~1000 свечей)
  try {
    const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=5&limit=1000`;
    const r = await sigFetch(u, 9000);
    if (r.ok) {
      const j = await r.json(); const list = (j.result && j.result.list) || [];
      if (list.length) return list.slice().reverse().map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    }
  } catch (e) {}
  throw new Error('no 5m klines');
}

// мини-статистика по выбранной монете за сегодня
function sigCoinStat(rows, coin) {
  const today = todayStr();
  const day = rows.filter((r, i) => i > 0 && r && r[12] === today && sigPairBase(r[1]) === coin);
  const wins = day.filter(r => (r[9] || '').trim() === 'WIN').length;
  const losses = day.filter(r => (r[9] || '').trim() === 'LOSE').length;
  const resolved = day.filter(r => ['WIN', 'LOSE', 'WIN & LOSE'].includes((r[9] || '').trim())).length;
  const wr = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
  return { resolved, wins, losses, wr };
}

async function renderSignalChart(force) {
  const el = document.getElementById('sigChart');
  if (!el) return;
  const coin = SIG_CHART.coin;
  const statEl = document.getElementById('sigChartStat');

  if (!window.LiveChart || !window.LightweightCharts) {
    el.innerHTML = '<div class="sig-chart-msg">График недоступен</div>';
    return;
  }
  el.innerHTML = '<div class="sig-chart-msg">Загрузка графика...</div>';

  try {
    let candles = SIG_CANDLE_CACHE[coin];
    if (!candles || force) {
      candles = await fetchSigCandles5m(coin + 'USDT', 2);
      SIG_CANDLE_CACHE[coin] = candles;
    }
    if (!candles || !candles.length) { el.innerHTML = '<div class="sig-chart-msg">Нет данных по свечам</div>'; return; }

    // шаг свечи в секундах (5m = 300) — берём из реального интервала данных
    let tfSec = 300;
    for (let i = 1; i < candles.length; i++) { const d = candles[i].time - candles[i - 1].time; if (d > 0) { tfSec = d; break; } }

    const rows = await fetchAllSignals();
    const markers = buildSignalMarkers(rows, coin, candles, tfSec);
    const prec = sigPrecisionFor(candles[candles.length - 1].close);

    el.innerHTML = '';
    requestAnimationFrame(() => {
      window.LiveChart.renderInto(el, { candles, markers, precision: prec, viewBars: 150 });
    });

    if (statEl) {
      const s = sigCoinStat(rows, coin);
      const wrTxt = s.wr == null ? '-' : s.wr + '%';
      statEl.innerHTML = `${coin} сегодня: <b>${s.resolved}</b> &nbsp;·&nbsp; WIN <b class="wr-green">${s.wins}</b> &nbsp;·&nbsp; LOSE <b class="wr-red">${s.losses}</b> &nbsp;·&nbsp; WR <b>${wrTxt}</b>`;
    }
    SIG_CHART.rendered = true;
  } catch (e) {
    console.log('Signal chart error:', e);
    el.innerHTML = '<div class="sig-chart-msg">Не удалось загрузить график</div>';
  }
}

function ensureSignalChart() {
  if (!SIG_CHART.rendered) renderSignalChart(false);
}

function initSignalChartUI() {
  const seg = document.getElementById('sigAssetSeg');
  if (!seg) return;
  seg.querySelectorAll('button[data-coin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const coin = btn.getAttribute('data-coin');
      if (coin === SIG_CHART.coin) return;
      SIG_CHART.coin = coin;
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      if (tg) tg.HapticFeedback?.selectionChanged?.();
      renderSignalChart(false);
    });
  });
}

// ===== REFRESH HOME =====
function refreshHome() {
  const btn = document.querySelector('.refresh-btn');
  btn.classList.add('spinning');
  // Reset caches so data reloads
  analL7dRows = null;
  allSignalRows = null;
  blockedSignalRows = null;
  devL30dRendered = false;
  dowChartInstances['devDowChart']?.destroy();
  delete dowChartInstances['devDowChart'];
  Object.values(pnlChartInstances).forEach(c => c?.destroy());
  Object.keys(pnlChartInstances).forEach(k => delete pnlChartInstances[k]);
  monthlyWrChartInstance?.destroy();
  monthlyWrChartInstance = null;
  Object.keys(SIG_CANDLE_CACHE).forEach(k => delete SIG_CANDLE_CACHE[k]);
  SIG_CHART.rendered = false;
  Promise.all([loadStatsPreview(), loadTodaySignals()]).finally(() => {
    btn.classList.remove('spinning');
    if (currentPage === 'futures-prediction') renderSignalChart(true);
  });
}

// ===== CALCULATOR =====
function initCalculator() {
  const ethSel = document.getElementById('calcEthBet');
  const btcSel = document.getElementById('calcBtcBet');
  if (!ethSel || !btcSel) return;

  for (let v = 5; v <= 125; v += 5) {
    const o = document.createElement('option');
    o.value = o.textContent = v;
    if (v === 125) o.selected = true;
    ethSel.appendChild(o);
  }
  for (let v = 5; v <= 250; v += 5) {
    const o = document.createElement('option');
    o.value = o.textContent = v;
    if (v === 250) o.selected = true;
    btcSel.appendChild(o);
  }

  const hoursGrid = document.getElementById('calcHoursGrid');
  let hoursHtml = '';
  for (let h = 0; h < 24; h++) {
    const checked = (h >= 8 && h <= 22) ? 'checked' : '';
    hoursHtml += `<label class="calc-hour-item"><span class="calc-hour-lbl">${String(h).padStart(2,'0')}</span><input type="checkbox" class="calc-cb" id="calcH${h}" ${checked}></label>`;
  }
  hoursGrid.innerHTML = hoursHtml;

  const daysGrid = document.getElementById('calcDaysGrid');
  const dayNames = [t('calc.days.mon'),t('calc.days.tue'),t('calc.days.wed'),t('calc.days.thu'),t('calc.days.fri'),t('calc.days.sat'),t('calc.days.sun')];
  let daysHtml = '';
  for (let d = 0; d < 7; d++) {
    const checked = d < 5 ? 'checked' : '';
    daysHtml += `<label class="calc-hour-item"><span class="calc-hour-lbl">${dayNames[d]}</span><input type="checkbox" class="calc-cb" id="calcD${d+1}" ${checked}></label>`;
  }
  daysGrid.innerHTML = daysHtml;

  // Init date pickers — default: empty (all periods)
  const dateFrom = document.getElementById('calcDateFrom');
  const dateTo   = document.getElementById('calcDateTo');
  if (dateFrom && dateTo) {
    // Set max to today
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    dateFrom.max = todayStr;
    dateTo.max   = todayStr;
    dateTo.value = todayStr;
  }

  // Direction toggle buttons — default ALL
  document.querySelectorAll('.calc-dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.calc-dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function calcExtractHour(val) {
  if (val === null || val === undefined || val === '') return NaN;
  const s = String(val).trim();
  if (!s) return NaN;
  // "HH:MM" or "HH:MM:SS" — most common CSV export format
  const hm = s.match(/^(\d{1,2}):/);
  if (hm) {
    const h = parseInt(hm[1]);
    return h === 24 ? 0 : h <= 23 ? h : NaN;
  }
  // Numeric value
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  // Plain integer hour (0–23)
  if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
  // Pure time fraction 0–1 (e.g. 0.625 = 15:00)
  if (n >= 0 && n < 1) return Math.floor(n * 24);
  // Datetime serial (e.g. 45678.625) — extract time part via modulo
  return Math.floor((n % 1) * 24);
}

function calcParseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // DD.MM.YYYY
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  // YYYY-MM-DD (gviz ISO export)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}

async function runCalculator() {
  const btn = document.getElementById('calcRunBtn');
  const results = document.getElementById('calcResults');
  btn.disabled = true;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="calc-spin" style="vertical-align:-1px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/></svg> ${t('calc.loading')}`;
  results.innerHTML = '';

  try {
    const ethBet = parseInt(document.getElementById('calcEthBet').value) || 125;
    const btcBet = parseInt(document.getElementById('calcBtcBet').value) || 250;

    const activeH = {};
    for (let h = 0; h < 24; h++) {
      if (document.getElementById(`calcH${h}`)?.checked) activeH[h] = true;
    }
    const activeD = {};
    for (let d = 1; d <= 7; d++) {
      if (document.getElementById(`calcD${d}`)?.checked) activeD[d] = true;
    }

    // === NEW: Period filter ===
    const dateFromVal = document.getElementById('calcDateFrom')?.value || '';
    const dateToVal   = document.getElementById('calcDateTo')?.value   || '';
    const dateFrom = dateFromVal ? new Date(dateFromVal + 'T00:00:00') : null;
    const dateTo   = dateToVal   ? new Date(dateToVal   + 'T23:59:59') : null;

    // === NEW: Direction filter ===
    const activeDir = document.querySelector('.calc-dir-btn.active')?.dataset?.dir || 'ALL';

    const rows = await fetchAllSignals();
    if (!rows || rows.length < 2) { results.innerHTML = `<div class="calc-error">${t('calc.no.data')}</div>`; return; }

    const ethW = ethBet * 0.8, ethL = -ethBet;
    const btcW = btcBet * 0.8, btcL = -btcBet;
    const st = { EU:{w:0,l:0,p:0}, ED:{w:0,l:0,p:0}, BU:{w:0,l:0,p:0}, BD:{w:0,l:0,p:0} };
    const tradeDays = {};
    // Monthly stats: key = "YYYY-MM", value = {w, l, signals: {date->true}}
    const monthlyStats = {};
    // Hourly stats: key = hour (0-23), value = {w, l}
    const hourlyStats  = {};
    let totalRaw = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const instr = (row[1] || '').toUpperCase();
      const dir   = (row[2] || '').toUpperCase();
      const res   = row[9]  || '';
      if (res !== 'WIN' && res !== 'LOSE') continue;

      const hour = calcExtractHour(row[19] || row[11] || row[17]);
      if (isNaN(hour)) continue;

      const dt = calcParseDate(row[12]);
      if (!dt) continue;

      const isETH = instr.includes('ETH');
      const isBTC = instr.includes('BTC');
      if (!isETH && !isBTC) continue;
      if (dir !== 'UP' && dir !== 'DOWN') continue;

      // === NEW: Date range filter ===
      if (dateFrom && dt < dateFrom) continue;
      if (dateTo   && dt > dateTo)   continue;

      // === NEW: Direction filter ===
      if (activeDir !== 'ALL' && dir !== activeDir) continue;

      totalRaw++;

      if (!activeH[hour]) continue;
      const dow = dt.getDay();
      const dayNum = dow === 0 ? 7 : dow;
      if (!activeD[dayNum]) continue;

      const key = (isETH ? 'E' : 'B') + (dir === 'UP' ? 'U' : 'D');
      const wP = isETH ? ethW : btcW;
      const lP = isETH ? ethL : btcL;
      const win = res === 'WIN';
      st[key].w += win ? 1 : 0;
      st[key].l += win ? 0 : 1;
      st[key].p += win ? wP : lP;
      tradeDays[row[12]] = true;

      // === NEW: Monthly accumulation ===
      const monthKey = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
      if (!monthlyStats[monthKey]) monthlyStats[monthKey] = { w:0, l:0 };
      if (win) monthlyStats[monthKey].w++;
      else     monthlyStats[monthKey].l++;

      // === NEW: Hourly accumulation ===
      if (!hourlyStats[hour]) hourlyStats[hour] = { w:0, l:0 };
      if (win) hourlyStats[hour].w++;
      else     hourlyStats[hour].l++;
    }

    renderCalcResults(st, tradeDays, ethBet, btcBet, Object.keys(activeH).length, totalRaw, monthlyStats, hourlyStats);

  } catch(e) {
    results.innerHTML = `<div class="calc-error">${t('calc.error')}</div>`;
    console.error('Calculator error:', e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${t('calc.run')}`;
  }
}

function renderCalcResults(st, tradeDays, ethBet, btcBet, activeHCount, totalRaw, monthlyStats, hourlyStats) {
  let totW = 0, totL = 0, totP = 0;
  ['EU','ED','BU','BD'].forEach(k => { totW += st[k].w; totL += st[k].l; totP += st[k].p; });
  const totSig = totW + totL;
  const totWR  = totSig > 0 ? totW / totSig * 100 : 0;
  const nDays  = Object.keys(tradeDays).length;
  const ppd    = nDays > 0 ? totP / nDays : 0;
  const ppm    = ppd * 30;
  const ppy    = ppd * 365;
  const evSig  = totSig > 0 ? totP / totSig : 0;
  const sigPerDay = nDays > 0 ? (totSig / nDays) : 0;

  const ethSig  = st.EU.w+st.EU.l+st.ED.w+st.ED.l;
  const ethWins = st.EU.w+st.ED.w;
  const ethPnl  = st.EU.p+st.ED.p;
  const ethWR   = ethSig > 0 ? ethWins/ethSig*100 : 0;

  const btcSig  = st.BU.w+st.BU.l+st.BD.w+st.BD.l;
  const btcWins = st.BU.w+st.BD.w;
  const btcPnl  = st.BU.p+st.BD.p;
  const btcWR   = btcSig > 0 ? btcWins/btcSig*100 : 0;

  const wc  = v => wrHex(v);
  const pc  = v => v >= 0 ? '#4EFFA0' : '#FF5272';
  const fmt = v => (v >= 0 ? '+' : '') + Math.round(v);

  // Build monthly chart HTML (only if >1 month)
  const hasMonthly = monthlyStats && Object.keys(monthlyStats).length > 1;
  // Build hourly chart HTML (only if data exists)
  const hourKeys = hourlyStats ? Object.keys(hourlyStats).filter(h => {
    const d = hourlyStats[h]; return (d.w + d.l) >= 3; // min 3 signals per hour
  }) : [];
  const hasHourly = hourKeys.length > 0;

  document.getElementById('calcResults').innerHTML = `
    <div class="calc-divider"></div>
    <div class="calc-res-grid">
      <div class="calc-res-item"><span>${t('calc.res.signals')}</span><b>${totSig} <span style="color:#7B84B0;font-size:11px;font-weight:400">/ ${totalRaw}</span></b></div>
      <div class="calc-res-item"><span>Win Rate</span><b style="color:${wc(totWR)}">${totWR.toFixed(1)}%</b></div>
      <div class="calc-res-item"><span>${t('calc.res.ev')}</span><b style="color:${pc(evSig)}">${evSig >= 0 ? '+' : ''}${evSig.toFixed(2)} USDT</b></div>
      <div class="calc-res-item"><span>${t('calc.res.sig.day')}</span><b>${sigPerDay.toFixed(1)}</b></div>
      <div class="calc-res-item"><span>${t('calc.res.pnl.month')}</span><b style="color:${pc(ppm)}">${fmt(ppm)} USDT</b></div>
      <div class="calc-res-item"><span>${t('calc.res.pnl.year')}</span><b style="color:${pc(ppy)}">${fmt(ppy)} USDT</b></div>
      <div class="calc-res-item"><span>${t('calc.res.hours')}</span><b>${activeHCount}</b></div>
      <div class="calc-res-item"><span>Break-even WR</span><b style="color:#FFD166">55.6%</b></div>
    </div>
    <div class="calc-pair-row">
      <div class="calc-pair-card">
        <div class="calc-pair-hdr">ETH <span class="calc-pair-bet">${ethBet} USDT</span></div>
        <div class="calc-pair-stat"><span>Сигналов</span><b>${ethSig}</b></div>
        <div class="calc-pair-stat"><span>WR%</span><b style="color:${wc(ethWR)}">${ethWR.toFixed(1)}%</b></div>
        <div class="calc-pair-stat"><span>PnL</span><b style="color:${pc(ethPnl)}">${fmt(ethPnl)}</b></div>
      </div>
      <div class="calc-pair-card">
        <div class="calc-pair-hdr">BTC <span class="calc-pair-bet">${btcBet} USDT</span></div>
        <div class="calc-pair-stat"><span>Сигналов</span><b>${btcSig}</b></div>
        <div class="calc-pair-stat"><span>WR%</span><b style="color:${wc(btcWR)}">${btcWR.toFixed(1)}%</b></div>
        <div class="calc-pair-stat"><span>PnL</span><b style="color:${pc(btcPnl)}">${fmt(btcPnl)}</b></div>
      </div>
    </div>
    ${hasMonthly ? `
    <div class="calc-monthly-chart-block" style="margin-top:12px">
      <div class="pnl-chart-title" style="font-size:12px;padding:10px 12px 6px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9D50FF" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        ${t('calc.chart.monthly.wr')}
      </div>
      <div class="pnl-chart-wrap" style="height:160px"><canvas id="calcMonthlyWrChart"></canvas></div>
    </div>` : ''}
    ${hasHourly ? `
    <div class="calc-monthly-chart-block" style="margin-top:10px">
      <div class="pnl-chart-title" style="font-size:12px;padding:10px 12px 6px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#66A3FF" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ${t('calc.chart.hourly.wr')}
      </div>
      <div class="pnl-chart-wrap" style="height:160px"><canvas id="calcHourlyWrChart"></canvas></div>
    </div>` : ''}
  `;

  // ── Monthly WinRate chart (bars = winrate, data label = signal count) ──
  if (hasMonthly) {
    const sortedMonths = Object.keys(monthlyStats).sort();
    const monthLabels = sortedMonths.map(m => {
      const [y, mo] = m.split('-');
      const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return names[parseInt(mo)-1] + '\'' + y.slice(2);
    });
    const winRates     = sortedMonths.map(m => {
      const tot = monthlyStats[m].w + monthlyStats[m].l;
      return tot > 0 ? parseFloat((monthlyStats[m].w / tot * 100).toFixed(1)) : 0;
    });
    const signalCounts = sortedMonths.map(m => monthlyStats[m].w + monthlyStats[m].l);
    const wrColors       = winRates.map(v => wrRgba(v));
    const wrBorderColors = winRates.map(v => wrHex(v));
    const sigLabel = t('calc.chart.monthly.sig');

    const ctxW = document.getElementById('calcMonthlyWrChart')?.getContext('2d');
    if (ctxW) {
      new Chart(ctxW, {
        type: 'bar',
        data: {
          labels: monthLabels,
          datasets: [{
            label: 'WinRate %',
            data: winRates,
            backgroundColor: wrColors,
            borderColor: wrBorderColors,
            borderWidth: 1,
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: c => `WR: ${c.parsed.y}%`,
                afterLabel: c => `${sigLabel} ${signalCounts[c.dataIndex]}`
              }
            },
            // Inline signal count labels on bars
            datalabels: false,
          },
          scales: {
            x: { ticks: { color: '#7B84B0', maxRotation: 45, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: {
              min: 0, max: 100,
              ticks: { color: '#7B84B0', font: { size: 9 }, callback: v => v + '%' },
              grid: { color: 'rgba(255,255,255,0.04)' }
            }
          }
        },
        plugins: [{
          // Custom: draw signal count above each bar
          id: 'sigCountLabels',
          afterDatasetsDraw(chart) {
            const { ctx, data } = chart;
            chart.getDatasetMeta(0).data.forEach((bar, i) => {
              const count = signalCounts[i];
              const wr = winRates[i];
              const color = wrHex(wr);
              ctx.save();
              ctx.fillStyle = color;
              ctx.font = 'bold 9px -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.fillText(count, bar.x, bar.y - 2);
              ctx.restore();
            });
          }
        }]
      });
    }
  }

  // ── Hourly WinRate chart ──
  if (hasHourly) {
    const sortedHours = hourKeys.map(Number).sort((a,b) => a-b);
    const hourLabels = sortedHours.map(h => String(h).padStart(2,'0') + ':00');
    const hourWR = sortedHours.map(h => {
      const d = hourlyStats[h];
      const tot = d.w + d.l;
      return tot > 0 ? parseFloat((d.w / tot * 100).toFixed(1)) : 0;
    });
    const hourSig = sortedHours.map(h => hourlyStats[h].w + hourlyStats[h].l);
    const hColors       = hourWR.map(v => wrRgba(v));
    const hBorderColors = hourWR.map(v => wrHex(v));
    const sigLabel = t('calc.chart.monthly.sig');

    const ctxH = document.getElementById('calcHourlyWrChart')?.getContext('2d');
    if (ctxH) {
      new Chart(ctxH, {
        type: 'bar',
        data: {
          labels: hourLabels,
          datasets: [{
            label: 'WinRate %',
            data: hourWR,
            backgroundColor: hColors,
            borderColor: hBorderColors,
            borderWidth: 1,
            borderRadius: 3,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: c => `WR: ${c.parsed.y}%`,
                afterLabel: c => `${sigLabel} ${hourSig[c.dataIndex]}`
              }
            }
          },
          scales: {
            x: { ticks: { color: '#7B84B0', maxRotation: 45, font: { size: 8 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: {
              min: 0, max: 100,
              ticks: { color: '#7B84B0', font: { size: 9 }, callback: v => v + '%' },
              grid: { color: 'rgba(255,255,255,0.04)' }
            }
          }
        },
        plugins: [{
          id: 'hourSigLabels',
          afterDatasetsDraw(chart) {
            const { ctx } = chart;
            chart.getDatasetMeta(0).data.forEach((bar, i) => {
              const count = hourSig[i];
              const wr = hourWR[i];
              const color = wrHex(wr);
              ctx.save();
              ctx.fillStyle = color;
              ctx.font = 'bold 8px -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.fillText(count, bar.x, bar.y - 2);
              ctx.restore();
            });
          }
        }]
      });
    }
  }

  document.getElementById('calcResults').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  updateHeader('home');
  applyTranslations();
  loadStatsPreview();
  loadTodaySignals();
  initSignalChartUI();
  initCalculator();
});
