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

  if (pageId === 'statistics') loadPnlChart();

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
  const lines = text.split('\n');
  for (const line of lines) {
    const cols = [];
    let inQuote = false;
    let cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cols.push(cell.trim());
    rows.push(cols);
  }
  return rows;
}

async function loadStatsPreview() {
  try {
    const sheetId = '1PCFuUAColEZgV7Be3gXsNhJoFrv34Ni79yR-_3zuJ5o';
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=ANAL%20L7D`;
    const res = await fetch(url);
    const text = await res.text();
    const rows = parseCSV(text);

    // Find last TOTAL row that has data in column V (index 21)
    // This corresponds to sheet row 22 (V22=winrate, K22=last7d)
    // Row above it corresponds to sheet row 21 (V21=total)
    let totalIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] === 'TOTAL' && rows[i][21] && rows[i][21] !== '') {
        totalIdx = i;
        break;
      }
    }

    if (totalIdx === -1) return;

    const winrate = rows[totalIdx][21]     || '—';
    const last7d  = rows[totalIdx][10]     || '—';
    const total   = rows[totalIdx - 1]?.[21] || '—';

    document.getElementById('stat7d').textContent      = last7d;
    document.getElementById('statTotal').textContent   = total;
    document.getElementById('statWinrate').textContent = winrate;
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
            ticks: { color: '#7B84B0', maxTicksLimit: 7, maxRotation: 0, font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.04)' },
          },
          y: {
            ticks: { color: '#7B84B0', font: { size: 11 },
              callback: v => v >= 1000 ? `${v/1000}k` : v
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

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  loadStatsPreview();
});
