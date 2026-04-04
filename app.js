// ===== TELEGRAM WEB APP INIT =====
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0A0B14');
  tg.setBackgroundColor('#0A0B14');
}

// ===== NAVIGATION =====
const history = [];
const navMap = {
  'home': 'nav-home',
  'futures-prediction': 'nav-futures-prediction',
  'statistics': 'nav-statistics',
  'articles': 'nav-articles',
};
const pageTitles = {
  'home': 'Futures Prediction',
  'futures-prediction': 'Futures Prediction',
  'futures-strategy': 'Futures Strategy',
  'indicators': 'Индикаторы',
  'articles': 'Статьи',
  'statistics': 'Статистика',
  'article-tilt': 'Статьи',
  'article-paradigm': 'Статьи',
  'article-what-is': 'Статьи',
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

  if (pageId === 'statistics') { loadPnlChart(); loadL7dChart(); renderAnalTables(); }

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
  const backBtn = document.getElementById('backBtn');
  const headerTitle = document.getElementById('headerTitle');
  const spacer = document.querySelector('.header-spacer');

  const isHome = pageId === 'home';
  backBtn.style.display = isHome ? 'none' : 'flex';
  spacer.style.visibility = isHome ? 'hidden' : 'hidden';
  headerTitle.textContent = pageTitles[pageId] || 'Futures Prediction';
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

    // Find last TOTAL row with data in column V (index 21) = sheet row 22
    let totalIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] === 'TOTAL' && rows[i][21] && rows[i][21] !== '') {
        totalIdx = i;
        break;
      }
    }
    if (totalIdx === -1) return;

    // K22 = WinRate Last 7 Day, K21 = Signals Last 7 Day (fallback: col H of TOTAL row)
    const winrate7d  = rows[totalIdx][10]       || '—';
    const signals7d  = rows[totalIdx - 1]?.[10] || rows[totalIdx][7] || '—';
    const winrateAll = rows[totalIdx][21]        || '—';
    const totalAll   = rows[totalIdx - 1]?.[21]  || '—';

    document.getElementById('statWinrate7d').textContent  = winrate7d;
    document.getElementById('statSignals7d').textContent  = signals7d;
    document.getElementById('statWinrate').textContent    = winrateAll;
    document.getElementById('statTotal').textContent      = totalAll;
  } catch(e) {
    console.log('Stats not available', e);
  }
}

// ===== PNL CHART =====
let pnlChartInstance = null;

async function loadPnlChart() {
  if (pnlChartInstance) return; // already loaded
  try {
    const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=PNL%20Charts`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);

    const labels = [];
    const data = [];
    let lastDate = null;

    for (let i = 1; i < rows.length; i++) {
      const dateStr = rows[i][0];
      const pnlStr  = rows[i][1];
      if (!dateStr || !pnlStr) continue;

      const parts = dateStr.split('.');
      if (parts.length < 3) continue;
      const date = new Date(parts[2], parts[1] - 1, parts[0]);

      // First series only — stop when dates restart
      if (lastDate && date < lastDate) break;
      lastDate = date;

      labels.push(`${parts[0]}.${parts[1]}`);
      data.push(parseInt(pnlStr));
    }

    const ctx = document.getElementById('pnlChart').getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(157, 80, 255, 0.35)');
    gradient.addColorStop(1, 'rgba(157, 80, 255, 0.0)');

    pnlChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: '#9D50FF',
          backgroundColor: gradient,
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.35,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y.toLocaleString()} USDT`
          }
        }},
        scales: {
          x: {
            ticks: { color: '#7B84B0', maxTicksLimit: 12, maxRotation: 0, font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            min: 0,
            ticks: { color: '#7B84B0', font: { size: 11 }, stepSize: 5000,
              callback: v => `${(v/1000).toFixed(0)}k`
            },
            grid: { color: 'rgba(255,255,255,0.04)' },
          }
        }
      }
    });
  } catch(e) {
    console.log('PNL chart not available', e);
  }
}

// ===== ANAL L7D TABLES =====
function buildAnalTable(rows, startIdx, endIdx) {
  // Columns A-H: code, upTotal, upWin, upWR, downTotal, downWin, downWR, total
  const headers = ['', '↑ Total', '↑ Win', '↑ WR%', '↓ Total', '↓ Win', '↓ WR%', 'Total'];
  let html = '<table class="anal-table"><thead><tr>';
  headers.forEach(h => { html += `<th>${h}</th>`; });
  html += '</tr></thead><tbody>';

  for (let i = startIdx; i <= endIdx; i++) {
    const r = rows[i];
    if (!r) continue;
    const code = r[0];
    if (!code) continue;
    // Skip section header rows (no numeric data)
    const isHeader = !r[1] && !r[7];
    if (isHeader) continue;
    const isTotal = code === 'TOTAL';
    html += `<tr class="${isTotal ? 'anal-total' : ''}">`;
    for (let c = 0; c < 8; c++) {
      const val = r[c] || (c === 0 ? '' : '-');
      // Color WR% cells
      let cls = '';
      if ((c === 3 || c === 6) && val.includes('%')) {
        const num = parseInt(val);
        cls = num >= 65 ? 'wr-green' : num >= 50 ? 'wr-yellow' : 'wr-red';
      }
      html += `<td class="${cls}">${val}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

let analTablesLoaded = false;

async function renderAnalTables() {
  if (analTablesLoaded) return;
  try {
    const rows = await fetchAnalL7d();
    if (!rows || !rows.length) return;

    // Find "Active" section dynamically → By Trading Pair
    let activeIdx = -1;
    let tzIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === 'Active' && activeIdx === -1) activeIdx = i + 1;
      if (rows[i][0] === 'TimeZone' && tzIdx === -1) tzIdx = i + 1;
    }

    if (activeIdx !== -1) {
      // ETHUSDT.P, BTCUSDT.P, TOTAL → 3 rows after "Active" header
      const pairsHtml = buildAnalTable(rows, activeIdx, activeIdx + 2);
      document.getElementById('analPairsTable').innerHTML = pairsHtml;
      document.getElementById('analPairsCard').style.display = 'block';
    }

    if (tzIdx !== -1) {
      // 0-14, 15-29, 30-44, 45-59, TOTAL → up to 5 rows after "TimeZone" header
      const tzHtml = buildAnalTable(rows, tzIdx, tzIdx + 4);
      document.getElementById('analTFTable').innerHTML = tzHtml;
      document.getElementById('analTFCard').style.display = 'block';
    }

    analTablesLoaded = true;
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

    for (let i = 1; i < rows.length; i++) {
      const code    = rows[i][0];
      const totalUP = parseInt(rows[i][1]) || 0;
      const winUP   = parseInt(rows[i][2]) || 0;
      const totalDN = parseInt(rows[i][4]) || 0;
      const winDN   = parseInt(rows[i][5]) || 0;
      const total   = totalUP + totalDN;

      // Skip non-code rows and codes with no trades
      if (!code || code === 'TOTAL' || code === 'Active' || code === 'TimeFrame' || code === 'TimeZone') break;
      if (total === 0) continue;

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

  if (hours > 0) return `${hours}ч ${mins}м назад`;
  if (mins > 0)  return `${mins}м ${secs}с назад`;
  return `${secs}с назад`;
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
      list.innerHTML = '<div class="signals-empty">Сигналов сегодня нет</div>';
      document.getElementById('signalTimer').textContent = '—';
      return;
    }

    // Last signal time for timer (index 3 = column L)
    const lastRow = todayRows[todayRows.length - 1];
    const lastTime = lastRow[11];

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
      const result = r[9]  || '';
      const time   = r[11] ? r[11].substring(0, 5) : '—'; // HH:MM

      const isUp   = dir === 'UP';
      const isWin  = result === 'WIN';
      const isLose = result === 'LOSE';
      const dirClass  = isUp ? 'sig-up' : 'sig-down';
      const resClass  = isWin ? 'sig-win' : isLose ? 'sig-lose' : 'sig-pending';
      const resLabel  = isWin ? 'WIN' : isLose ? 'LOSE' : '—';
      const dirLabel  = isUp ? '↑ UP' : '↓ DOWN';
      const pairShort = pair.replace('USDT.P', '');

      return `<div class="signal-row">
        <span class="sig-time">${time}</span>
        <span class="sig-pair">${pairShort}</span>
        <span class="sig-dir ${dirClass}">${dirLabel}</span>
        <span class="sig-res ${resClass}">${resLabel}</span>
      </div>`;
    }).join('');

    // Summary line
    const wins   = todayRows.filter(r => r[9] === 'WIN').length;
    const losses = todayRows.filter(r => r[9] === 'LOSE').length;
    const wr     = todayRows.length > 0 ? Math.round(wins / (wins + losses || 1) * 100) : 0;
    const summary = document.createElement('div');
    summary.className = 'signals-summary';
    summary.innerHTML = `Всего: <b>${todayRows.length}</b> &nbsp;·&nbsp; WIN: <b class="wr-green">${wins}</b> &nbsp;·&nbsp; LOSE: <b class="wr-red">${losses}</b> &nbsp;·&nbsp; WR: <b>${wr}%</b>`;
    list.prepend(summary);

  } catch(e) {
    console.log('Signals error:', e);
    document.getElementById('signalsList').innerHTML = '<div class="signals-empty">Ошибка загрузки</div>';
  }
}

// ===== REFRESH HOME =====
function refreshHome() {
  const btn = document.querySelector('.refresh-btn');
  btn.classList.add('spinning');
  // Reset caches so data reloads
  analL7dRows = null;
  analTablesLoaded = false;
  pnlChartInstance?.destroy(); pnlChartInstance = null;
  l7dChartInstance?.destroy(); l7dChartInstance = null;
  Promise.all([loadStatsPreview(), loadTodaySignals()]).finally(() => {
    btn.classList.remove('spinning');
  });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  loadStatsPreview();
  loadTodaySignals();
});
