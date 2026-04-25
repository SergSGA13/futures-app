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

  if (pageId === 'statistics') { loadPnlChartInto('pnlChart', 'PNL Charts', 'main'); renderAnalTables(); }
  if (pageId === 'stats-l30d') { loadPnlChartInto('pnlChartL30d', 'ALLsignal', 'l30d'); renderL30dTables(); }
  if (pageId === 'stats-all')  { loadPnlChartInto('pnlChartAll',  'PNL Charts', 'allp'); renderAllTables(); }

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

let analL7dRows = null; // cache for reuse in chart

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
    const winrate7d  = rows[17]?.[10] || '—';
    const signals7d  = rows[16]?.[10] || '—';
    const winrateAll = rows[17]?.[21] || '—';
    const totalAll   = rows[16]?.[21] || '—';

    document.getElementById('statWinrate7d').textContent  = winrate7d;
    document.getElementById('statSignals7d').textContent  = signals7d;
    document.getElementById('statWinrate').textContent    = winrateAll;
    document.getElementById('statTotal').textContent      = totalAll;
  } catch(e) {
    console.log('Stats not available', e);
  }
}

// ===== PNL CHART =====
const pnlChartInstances = {};

async function loadPnlChartInto(canvasId, sheetTabName, key) {
  if (pnlChartInstances[key]) return;
  try {
    const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetTabName)}`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);

    const labels = [], data = [];
    let lastDate = null;
    for (let i = 1; i < rows.length; i++) {
      const dateStr = rows[i][0], pnlStr = rows[i][1];
      if (!dateStr || !pnlStr) continue;
      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const date = new Date(parts[2], parts[1] - 1, parts[0]);
      if (lastDate && date < lastDate) break;
      lastDate = date;
      labels.push(`${parts[0]}.${parts[1]}`);
      data.push(parseInt(pnlStr));
    }

    const pctData = data.map(v => Math.round((v / 5000) * 100));
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
    console.log('PNL chart not available', e);
  }
}

// ===== ANAL L7D TABLES =====
// configs = [{label, row}] where row is the raw CSV row array
function buildAnalTable(configs) {
  const headers = ['', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  for (const {label, row} of configs) {
    if (!row) continue;
    const isTotal = label === 'TOTAL';
    html += `<tr class="${isTotal ? 'anal-total' : ''}">`;
    [label, row[1], row[2], row[3], row[4], row[5], row[6], row[7]].forEach((v, ci) => {
      v = (v !== undefined && v !== '') ? v : (ci === 0 ? '' : '-');
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = num >= 65 ? 'wr-green' : num >= 50 ? 'wr-yellow' : 'wr-red';
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}


function buildHourTable(rows) {
  // Hour zone data at L45:S70 (0-indexed cols 11-18):
  // col[11]=hour(0-23), col[12]=upTotal, col[13]=upWin, col[14]=upWR,
  // col[15]=downTotal, col[16]=downWin, col[17]=downWR, col[18]=total
  const headers = ['Hour', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  let totalRow = null;
  let dataFound = false;
  for (let i = 1; i < rows.length; i++) {
    const hour = rows[i][11]; // col L = index 11
    if (hour === '' || hour === undefined || hour === null) {
      // Possible TOTAL row: col[12] (M) has total data when col[11] is empty
      if (rows[i][12] && rows[i][12] !== '') totalRow = rows[i];
      continue;
    }
    const h = parseInt(hour);
    if (isNaN(h) || h < 0 || h > 23) continue;

    dataFound = true;
    const vals = [
      `${h}:00`,
      rows[i][12] || '-', rows[i][13] || '-',
      rows[i][14] || '-',
      rows[i][15] || '-', rows[i][16] || '-',
      rows[i][17] || '-',
    ];
    html += '<tr>';
    vals.forEach((v, ci) => {
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = num >= 65 ? 'wr-green' : num >= 50 ? 'wr-yellow' : 'wr-red';
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }

  // Append total
  if (totalRow) {
    const vals = ['Total', totalRow[12]||'-', totalRow[13]||'-', totalRow[14]||'-',
                  totalRow[15]||'-', totalRow[16]||'-', totalRow[17]||'-'];
    html += '<tr class="anal-total">';
    vals.forEach((v, ci) => {
      let cls = '';
      if ((ci === 3 || ci === 6) && String(v).includes('%')) {
        const num = parseInt(v);
        cls = num >= 65 ? 'wr-green' : num >= 50 ? 'wr-yellow' : 'wr-red';
      }
      html += `<td class="${cls}">${v}</td>`;
    });
    html += '</tr>';
  }

  html += '</tbody></table>';
  return dataFound ? html : '';
}

async function renderAnalTables() {
  try {
    const rows = await fetchAnalL7d();
    if (!rows || !rows.length) return;

    // By Trading Pair — CSV rows[15]=ETHUSDT.P, rows[16]=BTCUSDT.P, rows[17]=TOTAL
    // (col A is empty in CSV export; labels are hard-coded here)
    const pairsHtml = buildAnalTable([
      { label: 'ETH', row: rows[15] },
      { label: 'BTC', row: rows[16] },
      { label: 'TOTAL',     row: rows[17] },
    ]);
    document.getElementById('analPairsTable').innerHTML = pairsHtml;
    document.getElementById('analPairsCard').style.display = 'block';

    // By Time Zone — CSV rows[24]=0-14, [25]=15-29, [26]=30-44, [27]=45-59, [28]=TOTAL
    // (col A is empty in CSV export; labels are hard-coded here)
    const tzHtml = buildAnalTable([
      { label: '0-14',  row: rows[24] },
      { label: '15-29', row: rows[25] },
      { label: '30-44', row: rows[26] },
      { label: '45-59', row: rows[27] },
      { label: 'TOTAL', row: rows[28] },
    ]);
    document.getElementById('analTFTable').innerHTML = tzHtml;
    document.getElementById('analTFCard').style.display = 'block';

    // By Hour Zone — cols L-S (indices 11-17)
    const hourHtml = buildHourTable(rows);
    if (hourHtml) {
      document.getElementById('analHourTable').innerHTML = hourHtml;
      document.getElementById('analHourCard').style.display = 'block';
    }
  } catch(e) {
    console.log('Anal tables error:', e);
  }
}

// ===== L7D RESULTS CHART =====
let l7dChartInstance = null;

async function loadL7dChart() {
  if (l7dChartInstance) return;
  try {
    const rows = await fetchAnalL7d();

    // Rows 2..N-1 are signal codes. Skip header (row 0) and TOTAL/Active/TimeFrame rows.
    // Col 0=CODE, Col 1=TotalUP, Col 2=WinUP, Col 4=TotalDOWN, Col 5=WinDOWN, Col 7=TotalAll
    const codes = [];
    const winRates = [];
    const colors = [];

    // Indicator names hard-coded (col A is empty in CSV export)
    // Order matches sheet rows 2-14 (CSV indices 1-13)
    const indicatorNames = [
      'v.5000','v.5','v.5','v.36','v.37','v.6000','v.7000',
      'v.38','v.3000','v.4000','v.4','v.6','v.1'
    ];

    for (let i = 1; i <= 13 && i < rows.length; i++) {
      const totalUP = parseInt(rows[i][1]) || 0;
      const winUP   = parseInt(rows[i][2]) || 0;
      const totalDN = parseInt(rows[i][4]) || 0;
      const winDN   = parseInt(rows[i][5]) || 0;
      const total   = totalUP + totalDN;

      if (total === 0) continue;
      const code = indicatorNames[i - 1] || `#${i}`;

      const wr = Math.round((winUP + winDN) / total * 100);
      codes.push(code);
      winRates.push(wr);
      colors.push(wr >= 65 ? '#4EFFA0' : wr >= 50 ? '#FFD166' : '#FF5272');
    }

    const ctx = document.getElementById('l7dChart').getContext('2d');
    l7dChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: codes,
        datasets: [{
          data: winRates,
          backgroundColor: colors,
          borderRadius: 6,
          borderSkipped: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => `WinRate: ${ctx.parsed.y}%` }
        }},
        scales: {
          x: {
            ticks: { color: '#7B84B0', font: { size: 11 } },
            grid: { display: false },
          },
          y: {
            min: 0, max: 100,
            ticks: { color: '#7B84B0', font: { size: 11 }, callback: v => `${v}%` },
            grid: { color: 'rgba(255,255,255,0.04)' },
          }
        }
      }
    });
  } catch(e) {
    console.log('L7D chart not available', e);
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
  if (!timeStr) return '—';
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
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=%D0%9B%D0%B8%D1%81%D1%821`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);
    const today = todayStr(); // DD.MM.YYYY

    // M (index 12) contains date DD.MM.YYYY — filter by today
    const todayRows = rows.filter((r, i) => i > 0 && r[12] === today);

    const list = document.getElementById('signalsList');

    if (todayRows.length === 0) {
      list.innerHTML = `<div class="signals-empty">${t('sig.empty')}</div>`;
      document.getElementById('signalTimer').textContent = '—';
      return;
    }

    // Time is at index 17 (col R = HH:MM) for current sheet format
    const lastRow = todayRows[todayRows.length - 1];
    const lastTime = lastRow[17] || lastRow[11];

    // Start live timer
    if (signalTimerInterval) clearInterval(signalTimerInterval);
    const updateTimer = () => {
      document.getElementById('signalTimer').textContent = formatTimerAgo(lastTime);
    };
    updateTimer();
    signalTimerInterval = setInterval(updateTimer, 1000);

    // Render list (newest first)
    const reversed = [...todayRows].reverse();
    list.innerHTML = reversed.map(r => {
      const pair   = r[1]  || '—';
      const dir    = r[2]  || '—';
      const price  = r[3]  || '';
      const result = r[9]  || '';
      const time   = (r[17] || r[11] || '').substring(0, 5) || '—'; // HH:MM

      const isUp   = dir === 'UP';
      const isWin  = result === 'WIN';
      const isLose = result === 'LOSE';
      const dirClass  = isUp ? 'sig-up' : 'sig-down';
      const resClass  = isWin ? 'sig-win' : isLose ? 'sig-lose' : 'sig-pending';
      const resLabel  = isWin ? 'WIN' : isLose ? 'LOSE' : '—';
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
      const resText   = isWin ? 'WIN' : isLose ? 'LOSE' : '—';

      return `<div class="signal-row">
        <span class="sig-time">${time}</span>
        <span class="sig-pair">${pairShort}</span>
        <span class="sig-dir ${dirClass}">${dirLabel}</span>
        <span class="sig-price">${price}</span>
        <span class="sig-res ${resClass}">${resIcon}${resText}</span>
      </div>`;
    }).join('');

    // Summary line
    const wins   = todayRows.filter(r => r[9] === 'WIN').length;
    const losses = todayRows.filter(r => r[9] === 'LOSE').length;
    const wr     = todayRows.length > 0 ? Math.round(wins / (wins + losses || 1) * 100) : 0;
    const summary = document.createElement('div');
    summary.className = 'signals-summary';
    summary.innerHTML = `${t('sig.sum.total')}: <b>${todayRows.length}</b> &nbsp;·&nbsp; WIN: <b class="wr-green">${wins}</b> &nbsp;·&nbsp; LOSE: <b class="wr-red">${losses}</b> &nbsp;·&nbsp; WR: <b>${wr}%</b>`;
    list.prepend(summary);

  } catch(e) {
    console.log('Signals error:', e);
    document.getElementById('signalsList').innerHTML = `<div class="signals-empty">${t('sig.error')}</div>`;
  }
}

// ===== REFRESH HOME =====
function refreshHome() {
  const btn = document.querySelector('.refresh-btn');
  btn.classList.add('spinning');
  // Reset caches so data reloads
  analL7dRows = null;
  pnlChartInstance?.destroy(); pnlChartInstance = null;
  l7dChartInstance?.destroy(); l7dChartInstance = null;
  Promise.all([loadStatsPreview(), loadTodaySignals()]).finally(() => {
    btn.classList.remove('spinning');
  });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  updateHeader('home');
  applyTranslations();
  loadStatsPreview();
  loadTodaySignals();
});
