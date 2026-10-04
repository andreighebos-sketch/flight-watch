import { applyFilters, sortOffers, sortPrice } from '/shared/offer-logic.js';

const $ = (sel) => document.querySelector(sel);
const PAGE = 40;
const FILTER_KEYS = { sort: 'cheapest', dur: 'any', stops: 'any', airline: 'any', date: 'any', max: '' };

const ui = {
  results: null,
  status: null,
  revision: 0,
  filters: readFilters(),
  expanded: new Set(),
  compare: new Set(),
  selectedDate: null,
  shown: PAGE,
  offerHistory: new Map(),
  dateHistory: new Map(),
  notice: null,
  loadingResults: false,
};

/* ---------- formatting ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function money(v, cur = 'EUR') {
  if (!Number.isFinite(v)) return '—';
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(v);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayParts(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { y, m, d, wd, mon: MONTHS[m - 1] };
}
const fmtDate = (iso) => { const p = dayParts(iso); return `${p.wd}, ${p.d} ${p.mon} ${p.y}`; };
const fmtShort = (iso) => { const p = dayParts(iso); return `${p.d} ${p.mon}`; };
/** Airport-local wall-clock time from "YYYY-MM-DDTHH:mm" — never converted to the browser zone. */
const fmtLocal = (s) => (s ? `${fmtShort(s)} ${s.slice(11, 16)}` : '—');
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function dur(min) {
  if (!Number.isFinite(min)) return '—';
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
}
function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} days ago`;
}
function delta(v) {
  if (!Number.isFinite(v)) return '<span class="delta flat">—</span>';
  if (Math.abs(v) < 0.005) return '<span class="delta flat">no change</span>';
  return v < 0 ? `<span class="delta down" title="Cheaper than previous snapshot">↓ ${money(-v)}</span>` : `<span class="delta up" title="More expensive than previous snapshot">↑ ${money(v)}</span>`;
}
/** CSP forbids inline style attributes; apply them through the CSSOM instead. */
function applyCss(root) {
  const apply = (el) => {
    el.style.cssText = el.dataset.css;
    el.removeAttribute('data-css');
  };
  if (root.dataset?.css !== undefined) apply(root);
  root.querySelectorAll('[data-css]').forEach(apply);
}
new MutationObserver((mutations) => {
  for (const m of mutations) for (const n of m.addedNodes) if (n.nodeType === 1) applyCss(n);
}).observe(document.documentElement, { childList: true, subtree: true });
const stopsLabel = (n) => (n === 0 ? 'Direct' : `${n} stop${n > 1 ? 's' : ''}`);
const airportLabel = (a) => `${a.iata}${a.city ? ` — ${a.city}` : a.name ? ` — ${a.name}` : ''}`;

/* ---------- URL-shareable filters ---------- */
function readFilters() {
  const q = new URLSearchParams(location.search);
  const f = { ...FILTER_KEYS };
  for (const k of Object.keys(f)) if (q.has(k)) f[k] = q.get(k);
  return f;
}
function writeFilters() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(ui.filters)) if (v !== FILTER_KEYS[k] && v !== '') q.set(k, v);
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  $('#csv-btn').href = `/api/export.csv?sort=${encodeURIComponent(ui.filters.sort)}`;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, ...opts });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok && res.status !== 202) {
    const err = new Error(body?.error || `Server error (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadResults() {
  if (ui.loadingResults) return;
  ui.loadingResults = true;
  try {
    const data = await api('/api/results');
    ui.results = data;
    ui.status = data.status;
    ui.revision = data.status.revision;
    if (!ui.selectedDate || !data.search.dates.includes(ui.selectedDate)) ui.selectedDate = data.stats.cheapestDate;
    ui.dateHistory.clear();
    ui.offerHistory.clear();
    ui.notice = null;
    renderAll();
    checkAlerts();
  } catch (err) {
    ui.notice = { kind: 'error', text: `Cannot reach the Flight Watch server: ${err.message}` };
    renderNotices();
  } finally {
    ui.loadingResults = false;
  }
}

let pollTimer = null;
let lastResultsLoad = 0;
async function poll() {
  clearTimeout(pollTimer);
  try {
    const st = await api('/api/status');
    const changed = st.revision !== ui.revision;
    ui.status = st;
    renderHeader();
    renderProgress();
    if (changed && (!st.running || Date.now() - lastResultsLoad > 4000)) {
      lastResultsLoad = Date.now();
      await loadResults();
    } else if (!st.running) {
      renderNotices();
    }
    pollTimer = setTimeout(poll, st.running ? 1500 : 30000);
  } catch (err) {
    ui.notice = { kind: 'error', text: `Connection to the server lost (${err.message}). Retrying…` };
    renderNotices();
    pollTimer = setTimeout(poll, 10000);
  }
}

async function refreshNow() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/refresh', { method: 'POST', body: JSON.stringify({ force: true }) });
    ui.notice = r.toFetch === 0 ? { kind: 'info', text: 'All dates were checked within the last few minutes — showing cached results.' } : null;
  } catch (err) {
    ui.notice = { kind: err.status === 429 ? 'warn' : 'error', text: err.message };
  } finally {
    btn.disabled = false;
  }
  renderNotices();
  poll();
}

/* ---------- rendering ---------- */
function renderAll() {
  renderHeader();
  renderModeBanner();
  renderNotices();
  renderProgress();
  renderSummary();
  renderDateChart();
  renderHistory();
  renderFilterOptions();
  renderTable();
  renderCompare();
  renderProvenance();
}

function renderHeader() {
  const st = ui.status;
  if (!st) return;
  $('#last-updated').textContent = st.lastSuccessfulUpdateAt ? `${fmtClock(st.lastSuccessfulUpdateAt)} (${ago(st.lastSuccessfulUpdateAt)})` : 'never';
  const pill = $('#freshness');
  const ttl = st.refresh.cacheTtlMinutes * 60000;
  const oldest = st.oldestDataAt ? Date.now() - Date.parse(st.oldestDataAt) : null;
  let cls = 'stale';
  let text = 'No data';
  if (st.running) { cls = 'aging'; text = 'Updating…'; }
  else if (oldest !== null && st.datesWithData > 0) {
    if (oldest <= ttl * 1.05) { cls = 'fresh'; text = 'Fresh'; }
    else if (oldest <= ttl * 2) { cls = 'aging'; text = 'Aging'; }
    else { cls = 'stale'; text = 'Stale'; }
    text += ` · oldest date checked ${ago(st.oldestDataAt)}`;
  }
  pill.className = `fresh-pill ${cls}`;
  pill.textContent = text;
  $('#next-refresh').textContent = st.refresh.nextAutoRefreshAt ? `Auto refresh every ${st.refresh.intervalMinutes} min · next ≈ ${fmtClock(st.refresh.nextAutoRefreshAt)}` : st.provider.configured ? 'Auto refresh off' : '';
  $('#refresh-btn').disabled = Boolean(st.running) || !st.provider.configured;
  $('#refresh-btn').textContent = st.running ? 'Searching…' : 'Refresh prices';
}

function renderModeBanner() {
  const p = ui.status?.provider;
  if (!p) return;
  let html = '';
  if (p.dataMode === 'demo') {
    html = `<div class="banner demo" role="alert"><span class="tag demo">DEMO DATA</span> <strong>These are synthetic prices for UI testing — not real fares.</strong> Airlines are fictional ("DEMO Air …"). Set <code>FLIGHT_PROVIDER=serpapi</code> or <code>duffel</code> with a key in <code>.env</code> for real prices.</div>`;
  } else if (p.dataMode === 'sandbox') {
    html = `<div class="banner sandbox" role="alert"><span class="tag sandbox">SANDBOX</span> <strong>Duffel test mode:</strong> results come from Duffel's test environment (fictional "Duffel Airways"), not bookable live fares. Use a <code>duffel_live_…</code> token for live content.</div>`;
  }
  $('#mode-banner').innerHTML = html;
}

function errorText(e) {
  if (!e) return '';
  const map = {
    auth: 'The provider rejected the credentials. Check the key in .env.',
    rate_limit: 'The provider rate limit was hit (HTTP 429). Searching paused; cached results are still shown and the next automatic refresh will retry.',
    quota: 'The provider plan quota is exhausted (HTTP 429). Cached results remain visible; upgrade the plan or wait for the quota to reset.',
    budget: 'The daily request budget (DAILY_REQUEST_LIMIT) is used up. Cached results remain visible.',
    timeout: 'The provider did not answer in time.',
    network: 'Network error while contacting the provider.',
    config: 'Configuration problem.',
  };
  return `${map[e.kind] ? `${map[e.kind]} ` : ''}<span class="muted">${esc(e.message)}</span>`;
}

function renderNotices() {
  const st = ui.status;
  const parts = [];
  if (ui.notice) parts.push(`<div class="banner ${ui.notice.kind}">${esc(ui.notice.text)}</div>`);
  if (st && !st.provider.configured && st.provider.setup) {
    const s = st.provider.setup;
    parts.push(`<div class="banner error" role="alert"><strong>API key missing — ${esc(st.provider.label)} is not configured.</strong> No live prices can be fetched until <code>${esc(s.envVar)}</code> is set.
      <ol>${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      <div class="small" data-css="margin-top:6px">Want to look at the UI first? Run with <code>FLIGHT_PROVIDER=demo</code> — it is clearly marked as DEMO DATA.</div></div>`);
  }
  if (st?.lastFatalError && !st.running) {
    const kind = st.lastFatalError.kind;
    const title = kind === 'rate_limit' || kind === 'quota' ? 'Rate limit reached' : kind === 'budget' ? 'Request budget reached' : kind === 'auth' ? 'Authentication failed' : 'Provider error';
    parts.push(`<div class="banner ${kind === 'auth' || kind === 'config' ? 'error' : 'warn'}" role="alert"><strong>${title}.</strong> ${errorText(st.lastFatalError)}</div>`);
  }
  const lr = st?.lastRun;
  if (lr && !st.running && lr.failed > 0) {
    const okCount = lr.ok + lr.cached;
    const failedDates = (ui.results?.dates || []).filter((d) => d.outcome === 'error' || d.outcome === 'skipped');
    const kindsSeen = st.lastFatalError ? [] : [...new Set(failedDates.map((d) => d.error?.message).filter(Boolean))].slice(0, 3);
    parts.push(`<div class="banner warn"><strong>${okCount} of ${lr.total} dates successfully checked</strong> in the last search (${lr.failed} failed). Dates without fresh data keep their last known prices.
      ${kindsSeen.length ? `<div class="small muted">${kindsSeen.map(esc).join(' · ')}</div>` : ''}</div>`);
  }
  if (st && st.provider.configured && !st.running && st.datesWithData === 0 && !lr) {
    parts.push('<div class="banner info"><strong>No price data yet.</strong> The first search starts automatically — or press “Refresh prices”.</div>');
  }
  $('#notices').innerHTML = parts.join('');
}

function renderProgress() {
  const r = ui.status?.running;
  const el = $('#progress');
  el.classList.toggle('hidden', !r);
  if (!r) return;
  const pct = Math.round((r.checked / r.total) * 100);
  $('#progress-fill').style.width = `${pct}%`;
  $('#progress-label').textContent = `Searching fares… ${r.checked} / ${r.total} dates checked${r.cached ? ` (${r.cached} fresh from cache)` : ''}${r.failed ? ` · ${r.failed} failed` : ''}`;
}

function renderSummary() {
  const R = ui.results;
  const el = $('#summary');
  if (!R) return;
  const s = R.stats;
  const c = s.cheapest;
  const cheapestDay = R.dates.find((d) => d.date === s.cheapestDate);
  const hero = c
    ? `<div class="card hero">
        <div class="label">Cheapest found ${c.dataMode === 'demo' ? '<span class="tag demo">DEMO DATA</span>' : ''}</div>
        <div class="value">${money(c.totalPrice)} <span class="sub">total for 2 adults</span></div>
        <div class="sub">${money(c.pricePerPerson)} per person · ${esc(fmtDate(c.departureDate))} · ${stopsLabel(c.stops)} · ${dur(c.totalDurationMin)}</div>
        <div class="sub">Chișinău → Nha Trang · ${esc(c.airlines.slice(0, 2).join(', '))}${c.airlines.length > 2 ? ` +${c.airlines.length - 2}` : ''}${c.priceHistory?.change != null ? ` · vs previous ${delta(c.priceHistory.change)}` : ''}</div>
        <div class="actions"><button class="btn primary small" type="button" data-view="${esc(c.fingerprint)}">View itinerary</button></div>
      </div>`
    : `<div class="card hero empty"><div class="label">Cheapest found</div><div class="value">—</div><div class="sub">${ui.status?.datesWithData ? 'No available fares found for this period.' : 'No price data yet.'}</div></div>`;
  const tile = (label, value, sub) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  el.innerHTML = hero
    + tile('Cheapest date', s.cheapestDate ? esc(fmtShort(s.cheapestDate)) : '—', cheapestDay ? `${money(cheapestDay.minPrice)} · ${delta(cheapestDay.change)}` : '—')
    + tile('Lowest seen', money(s.lowestSeen), s.highestSeen != null ? `highest seen ${money(s.highestSeen)}` : 'no history yet')
    + tile('Median price', money(s.medianPrice), `${s.count} itineraries`)
    + tile('Fastest', s.fastest ? dur(s.fastest.totalDurationMin) : '—', s.fastest ? `${money(s.fastest.totalPrice)} · ${esc(fmtShort(s.fastest.departureDate))} · ${stopsLabel(s.fastest.stops)}` : '—')
    + tile('Best value', s.bestValue ? money(s.bestValue.totalPrice) : '—', s.bestValue ? `${dur(s.bestValue.totalDurationMin)} · ${esc(fmtShort(s.bestValue.departureDate))} · price/duration` : '—');
  el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewItinerary(b.dataset.view)));
}

function renderDateChart() {
  const R = ui.results;
  if (!R) return;
  const priced = R.dates.filter((d) => d.minPrice !== null);
  const min = priced.length ? Math.min(...priced.map((d) => d.minPrice)) : 0;
  const max = priced.length ? Math.max(...priced.map((d) => d.minPrice)) : 1;
  const span = Math.max(max - min, 1);
  const cols = R.dates.map((d) => {
    const p = dayParts(d.date);
    const cls = ['day'];
    if (d.minPrice === null) cls.push('nodata');
    if (d.minPrice !== null && d.minPrice === min) cls.push('best');
    if (d.date === ui.selectedDate) cls.push('selected');
    if (d.outcome === 'error' || d.outcome === 'skipped') cls.push('err');
    if (d.pending) cls.push('pending');
    const h = d.minPrice === null ? 0 : 22 + ((d.minPrice - min) / span) * 78; // % height: cheapest still visible
    const title = d.minPrice === null
      ? `${fmtDate(d.date)} — ${d.pending ? 'searching…' : d.error ? `not checked: ${d.error.message}` : d.fetchedAt ? 'no available fares' : 'not checked yet'}`
      : `${fmtDate(d.date)} — cheapest ${money(d.minPrice)} for 2 adults (${d.offerCount} itineraries), checked ${ago(d.fetchedAt)}${d.change ? `, change ${d.change > 0 ? '+' : ''}${money(d.change)}` : ''}`;
    return `<button class="${cls.join(' ')}" type="button" data-date="${d.date}" title="${esc(title)}" aria-label="${esc(title)}">
      <span class="price">${d.minPrice === null ? (d.pending ? '…' : '—') : money(d.minPrice)}</span>
      <span class="col" data-css="height:${d.minPrice === null ? '' : `${h.toFixed(1)}%`}"></span>
      <span class="dlabel"><b>${p.d}</b>${p.d === 20 || p.d === 1 ? p.mon : p.wd.slice(0, 2)}</span>
    </button>`;
  }).join('');
  $('#date-chart').innerHTML = cols;
  const legendId = 'chart-legend';
  let legend = document.getElementById(legendId);
  if (!legend) {
    legend = document.createElement('div');
    legend.id = legendId;
    legend.className = 'chart-legend';
    $('#date-chart').after(legend);
  }
  legend.innerHTML = `<span><span class="sw" data-css="background:var(--green)"></span>Cheapest day${priced.length ? ` · ${money(min)}` : ''}</span>
    <span><span class="sw" data-css="background:var(--bar)"></span>Other days${priced.length ? ` · up to ${money(max)}` : ''}</span>
    <span><span class="sw" data-css="border:1px dashed var(--border)"></span>No fare / not checked</span>
    <span>${priced.length} of ${R.dates.length} dates have fares</span>`;
  $('#date-chart').querySelectorAll('.day').forEach((b) => b.addEventListener('click', () => {
    ui.selectedDate = b.dataset.date;
    renderDateChart();
    renderHistory();
  }));
}

function sparkline(points, valueKey) {
  const vals = points.map((p) => p[valueKey]).filter(Number.isFinite);
  if (points.length < 2 || vals.length < 2) return '';
  const W = 600, H = 110, pad = 18;
  const t0 = Date.parse(points[0].observedAt);
  const t1 = Date.parse(points.at(-1).observedAt);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (t) => pad + ((t - t0) / Math.max(t1 - t0, 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / Math.max(hi - lo, 1)) * (H - pad * 2);
  const pts = points.filter((p) => Number.isFinite(p[valueKey])).map((p) => [x(Date.parse(p.observedAt)), y(p[valueKey]), p[valueKey]]);
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
  const area = `${line}L${pts.at(-1)[0].toFixed(1)},${H - pad}L${pts[0][0].toFixed(1)},${H - pad}Z`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price trend">
    <path class="area" d="${area}"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
    ${pts.map(([a, b, v]) => `<circle class="pt ${v === lo ? 'low' : ''}" cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="3"/>`).join('')}
    <text x="${pad}" y="12">${esc(money(hi))}</text><text x="${pad}" y="${H - 4}">${esc(money(lo))}</text>
  </svg>`;
}

async function renderHistory() {
  const date = ui.selectedDate;
  const el = $('#history');
  if (!date) {
    $('#history-title').textContent = 'Price history';
    el.innerHTML = '<div class="empty">No price data yet.</div>';
    return;
  }
  $('#history-title').textContent = `Price history · ${fmtDate(date)}`;
  const day = ui.results?.dates.find((d) => d.date === date);
  let hist = ui.dateHistory.get(date);
  if (!hist) {
    el.innerHTML = '<div class="empty">Loading history…</div>';
    try {
      hist = await api(`/api/history/date/${date}`);
      ui.dateHistory.set(date, hist);
    } catch (err) {
      el.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
      return;
    }
    if (ui.selectedDate !== date) return;
  }
  const pts = hist.points;
  const priced = pts.filter((p) => Number.isFinite(p.minTotal));
  const stats = `<div class="hist-stats">
    <div><div class="k">Current</div><div class="v">${money(day?.minPrice)}</div></div>
    <div><div class="k">Lowest seen</div><div class="v">${money(day?.lowestSeen)}</div></div>
    <div><div class="k">Highest seen</div><div class="v">${money(day?.highestSeen)}</div></div>
    <div><div class="k">Change</div><div class="v">${delta(day?.change)}</div></div>
  </div>`;
  const chart = priced.length >= 2 ? sparkline(priced, 'minTotal') : `<div class="empty small">${priced.length === 1 ? 'Only one snapshot so far — the trend builds up with every refresh.' : 'No snapshots for this date yet.'}</div>`;
  const list = [...pts].reverse().slice(0, 30).map((p, i, arr) => {
    const prev = arr[i + 1];
    const ch = prev && Number.isFinite(p.minTotal) && Number.isFinite(prev.minTotal) ? p.minTotal - prev.minTotal : null;
    return `<li><span>${esc(fmtStamp(p.observedAt))}</span><span>${Number.isFinite(p.minTotal) ? money(p.minTotal) : 'no fares'} ${ch ? delta(ch) : ''}</span></li>`;
  }).join('');
  el.innerHTML = `${stats}${chart}<ul class="hist-list">${list}</ul>
    <div data-css="margin-top:8px"><button class="btn ghost small" type="button" id="filter-date-btn">Show only ${esc(fmtShort(date))} in results</button></div>`;
  $('#filter-date-btn').addEventListener('click', () => {
    ui.filters.date = date;
    syncControls();
    onFiltersChanged();
    $('.table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderFilterOptions() {
  const R = ui.results;
  if (!R) return;
  const airlines = [...new Set(R.offers.flatMap((o) => o.airlines))].sort((a, b) => a.localeCompare(b));
  const sel = $('#f-airline');
  sel.innerHTML = `<option value="any">Any</option>${airlines.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}`;
  if (ui.filters.airline !== 'any' && !airlines.includes(ui.filters.airline)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(ui.filters.airline)}">${esc(ui.filters.airline)}</option>`);
  const ds = $('#f-date');
  ds.innerHTML = `<option value="any">Any</option>${R.search.dates.map((d) => {
    const info = R.dates.find((x) => x.date === d);
    return `<option value="${d}">${esc(fmtDate(d))}${info?.minPrice != null ? ` — from ${money(info.minPrice)}` : ''}</option>`;
  }).join('')}`;
  syncControls();
}

function syncControls() {
  $('#f-sort').value = ui.filters.sort;
  $('#f-dur').value = ui.filters.dur;
  $('#f-stops').value = ui.filters.stops;
  $('#f-airline').value = ui.filters.airline;
  $('#f-date').value = ui.filters.date;
  $('#f-price').value = ui.filters.max;
}

function visibleOffers() {
  const R = ui.results;
  if (!R) return [];
  const f = ui.filters;
  return sortOffers(applyFilters(R.offers, { stops: f.stops, maxDurationH: f.dur, airline: f.airline, date: f.date, maxPrice: f.max || null }), f.sort);
}

function durationBar(o, maxDur) {
  if (!Number.isFinite(o.totalDurationMin) || !maxDur) return '';
  let left = 0;
  const scale = (m) => (m / maxDur) * 100;
  const parts = [];
  o.segments.forEach((s, i) => {
    const sd = Number.isFinite(s.durationMin) ? s.durationMin : null;
    if (sd !== null) { parts.push(`<span data-css="left:${scale(left).toFixed(2)}%;width:${scale(sd).toFixed(2)}%"></span>`); left += sd; }
    const l = o.layovers[i];
    if (l && Number.isFinite(l.durationMin)) { parts.push(`<span class="lay" data-css="left:${scale(left).toFixed(2)}%;width:${scale(l.durationMin).toFixed(2)}%"></span>`); left += l.durationMin; }
  });
  return `<div class="durbar" title="Flights (solid) and layovers (striped), to scale">${parts.join('')}</div>`;
}

function renderTable() {
  const R = ui.results;
  const body = $('#results-body');
  if (!R) return;
  const list = visibleOffers();
  const total = R.offers.length;
  $('#results-meta').textContent = total
    ? `${list.length} of ${total} itineraries match · sorted by ${$('#f-sort').selectedOptions[0].textContent.toLowerCase()} · prices are totals for 2 adults in EUR · times are local airport times`
    : '';
  if (!list.length) {
    const msg = !total
      ? (ui.status?.running ? 'Searching fares…' : ui.status?.datesWithData ? 'No available fares found for this period.' : 'No price data yet.')
      : 'No itineraries match these filters.';
    body.innerHTML = `<tr><td colspan="14" class="empty">${esc(msg)}</td></tr>`;
    $('#more-btn').classList.add('hidden');
    return;
  }
  const cheapestFp = R.stats.cheapest?.fingerprint;
  const maxDur = Math.max(...list.map((o) => o.totalDurationMin || 0));
  const rows = list.slice(0, ui.shown).map((o) => {
    const open = ui.expanded.has(o.fingerprint);
    const route = [o.segments[0].origin.iata, ...o.segments.map((s) => s.destination.iata)].join(' → ');
    const logo = o.segments[0].airline.logo && /^https:\/\/www\.gstatic\.com\//.test(o.segments[0].airline.logo) ? `<img class="airline-logo" src="${esc(o.segments[0].airline.logo)}" alt="" loading="lazy" />` : '';
    const row = `<tr class="row ${open ? 'open' : ''} ${o.fingerprint === cheapestFp ? 'top' : ''}" data-fp="${o.fingerprint}" tabindex="0" aria-expanded="${open}">
      <td class="c-cmp"><input type="checkbox" data-cmp="${o.fingerprint}" ${ui.compare.has(o.fingerprint) ? 'checked' : ''} aria-label="Compare" /></td>
      <td class="nowrap">${esc(fmtShort(o.departureDate))}<div class="muted small">${dayParts(o.departureDate).wd}</div></td>
      <td class="nowrap">${esc(fmtLocal(o.departureLocal))}<div class="muted small">${esc(o.origin.iata)}</div></td>
      <td class="nowrap">${esc(fmtLocal(o.arrivalLocal))}<div class="muted small">${esc(o.destination.iata)}</div></td>
      <td class="dur-cell">${dur(o.totalDurationMin)}${durationBar(o, maxDur)}</td>
      <td class="nowrap">${stopsLabel(o.stops)}${o.selfTransfer ? ' <span class="tag warn">Self-transfer</span>' : ''}</td>
      <td class="route-codes">${esc(route)}</td>
      <td class="airlines-cell" title="${esc(o.airlines.join(', '))}">${logo}${esc(o.airlines.slice(0, 2).join(', '))}${o.airlines.length > 2 ? ` <span class="muted">+${o.airlines.length - 2}</span>` : ''}</td>
      <td class="num price-total">${money(o.totalPrice, o.currency)} <span class="muted small">total</span>${o.dataMode === 'demo' ? '<div><span class="tag demo">DEMO</span></div>' : ''}</td>
      <td class="num">${money(o.pricePerPerson, o.currency)}<div class="muted small">per person</div></td>
      <td class="num">${delta(o.priceHistory?.change)}</td>
      <td class="small">${esc(o.sourceLabel)}${o.dataMode === 'sandbox' ? ' <span class="tag sandbox">SANDBOX</span>' : ''}</td>
      <td class="small nowrap" title="${esc(o.fetchedAt)}">${esc(ago(o.fetchedAt))}</td>
      <td><span class="chev" aria-hidden="true">›</span></td>
    </tr>`;
    return open ? row + `<tr class="detail" data-detail="${o.fingerprint}"><td colspan="14">${detailHtml(o)}</td></tr>` : row;
  });
  body.innerHTML = rows.join('');
  $('#more-btn').classList.toggle('hidden', list.length <= ui.shown);
  $('#more-btn').textContent = `Show more (${list.length - ui.shown} remaining)`;
  for (const fp of ui.expanded) loadOfferHistory(fp);
}

function detailHtml(o) {
  const segs = o.segments.map((s, i) => {
    const l = o.layovers[i];
    const lay = l
      ? `<li class="layover ${l.durationMin >= 360 ? 'long' : ''}">Layover in ${esc(airportLabel(l.airport))} · ${dur(l.durationMin)}${l.overnight ? ' · overnight' : ''}${l.changeOfAirport ? ` · <strong>change of airport to ${esc(l.changeOfAirport.iata)}</strong>` : ''}</li>`
      : '';
    return `<li class="seg">
        <div class="t">${esc(s.departureLocal.slice(11, 16))}<small>${esc(fmtShort(s.departureLocal))}</small></div>
        <div class="ap">${esc(airportLabel(s.origin))}${s.origin.name ? ` <span class="muted small">${esc(s.origin.name)}</span>` : ''}</div>
        <div class="meta">${esc(s.airline.name || s.airline.code || 'Airline n/a')}${s.flightNumber ? ` · ${esc(s.flightNumber)}` : ''} · ${dur(s.durationMin)}${s.aircraft ? ` · ${esc(s.aircraft)}` : ''}${s.cabin ? ` · ${esc(s.cabin)}` : ''}${s.operatingAirline ? ` · operated by ${esc(s.operatingAirline.name || s.operatingAirline.code)}` : ''}${s.overnight ? ' · overnight flight' : ''}${s.notes?.length ? `<br>${s.notes.map(esc).join(' · ')}` : ''}</div>
        <div class="t">${esc(s.arrivalLocal.slice(11, 16))}<small>${esc(fmtShort(s.arrivalLocal))}</small></div>
        <div class="ap">${esc(airportLabel(s.destination))}${s.destination.name ? ` <span class="muted small">${esc(s.destination.name)}</span>` : ''}</div>
      </li>${lay}`;
  }).join('');
  const ph = o.priceHistory || {};
  const booking = o.bookingUrl
    ? `<a class="btn primary" href="${esc(o.bookingUrl)}" target="_blank" rel="noopener noreferrer">View / Book ↗</a>
       <div class="muted small" data-css="margin-top:6px">${o.bookingLinkKind === 'search' ? 'Opens the Google Flights results for this date (2 adults, one way). Select this itinerary there to see booking options.' : ''}</div>`
    : '<div class="muted">Booking link unavailable from this provider.</div>';
  return `<div class="detail-grid">
    <div>
      ${o.selfTransfer ? '<div class="warnbox"><strong>Self-transfer.</strong> Separate tickets may require baggage re-check and carry additional connection risk.</div>' : ''}
      <ol class="timeline">${segs}</ol>
      <div class="muted small">All times are local to each airport. Total journey ${dur(o.totalDurationMin)} (from provider${o.departureUtc ? ', time-zone aware' : ''}).</div>
    </div>
    <div>
      <div class="box"><h3>Price</h3><div class="kv">
        <span class="k">Total for 2 adults</span><strong>${money(o.totalPrice, o.currency)}</strong>
        <span class="k">Per person</span><span>${money(o.pricePerPerson, o.currency)} <span class="muted small">(total ÷ 2)</span></span>
        ${o.baseFare != null ? `<span class="k">Base fare</span><span>${money(o.baseFare, o.currency)}</span>` : ''}
        ${o.taxes != null ? `<span class="k">Taxes</span><span>${money(o.taxes, o.currency)}</span>` : ''}
        ${o.original ? `<span class="k">Provider price</span><span>${money(o.original.totalPrice, o.original.currency)} · ECB rate ${esc(o.fx?.date || '')}</span>` : ''}
        ${o.fx?.unavailable ? `<span class="k">Currency</span><span>Shown in ${esc(o.currency)} — EUR conversion unavailable</span>` : ''}
        <span class="k">Change vs previous</span><span>${delta(ph.change)}</span>
        <span class="k">Lowest / highest seen</span><span>${money(ph.lowest)} / ${money(ph.highest)} <span class="muted small">(${ph.samples || 0} snapshots)</span></span>
      </div>
      <div class="muted small" data-css="margin-top:6px">${esc(o.priceNote || '')}</div>
      <div id="oh-${o.fingerprint}" data-css="margin-top:6px"></div></div>
      <div class="box"><h3>Baggage</h3>${o.baggage?.length ? `<ul>${o.baggage.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<span class="muted">Baggage information unavailable</span>'}</div>
      ${o.notes?.length ? `<div class="box"><h3>Notes</h3><ul>${o.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      <div class="box"><h3>Booking</h3>${booking}<div class="muted small" data-css="margin-top:6px">Source: ${esc(o.sourceLabel)} · checked ${esc(fmtStamp(o.fetchedAt))}</div></div>
    </div>
  </div>`;
}

async function loadOfferHistory(fp) {
  const target = document.getElementById(`oh-${fp}`);
  if (!target) return;
  let h = ui.offerHistory.get(fp);
  if (!h) {
    try {
      h = await api(`/api/history/offer/${fp}`);
      ui.offerHistory.set(fp, h);
    } catch {
      target.textContent = '';
      return;
    }
  }
  const el = document.getElementById(`oh-${fp}`);
  if (!el) return;
  el.innerHTML = h.points.length >= 2 ? `<div class="muted small">This itinerary's price over time</div>${sparkline(h.points, 'totalPrice')}` : '<div class="muted small">Price history for this exact itinerary starts with the next refresh.</div>';
}

function renderCompare() {
  const R = ui.results;
  const el = $('#compare');
  if (!R || ui.compare.size === 0) { el.innerHTML = ''; return; }
  const offers = [...ui.compare].map((fp) => R.offers.find((o) => o.fingerprint === fp)).filter(Boolean);
  el.innerHTML = `<div class="compare"><div class="panel-head"><h2>Compare (${offers.length}/3)</h2><button class="btn ghost small" type="button" id="cmp-clear">Clear</button></div>
    <div class="compare-grid">${offers.map((o) => `<div class="card">
      <div class="label">${esc(fmtDate(o.departureDate))}</div>
      <div class="value">${money(o.totalPrice, o.currency)} <span class="sub">total</span></div>
      <div class="sub">${money(o.pricePerPerson, o.currency)} per person</div>
      <div class="sub">${dur(o.totalDurationMin)} · ${stopsLabel(o.stops)}${o.selfTransfer ? ' · self-transfer' : ''}</div>
      <div class="sub route-codes">${esc([o.segments[0].origin.iata, ...o.segments.map((s) => s.destination.iata)].join(' → '))}</div>
      <div class="sub">${esc(o.airlines.join(', '))}</div>
      <div class="sub">Dep ${esc(fmtLocal(o.departureLocal))} · Arr ${esc(fmtLocal(o.arrivalLocal))}</div>
      <div class="sub">Longest layover ${dur(Math.max(0, ...o.layovers.map((l) => l.durationMin || 0)))}</div>
    </div>`).join('')}</div></div>`;
  $('#cmp-clear').addEventListener('click', () => { ui.compare.clear(); renderTable(); renderCompare(); });
}

function renderProvenance() {
  const st = ui.status;
  if (!st) return;
  const p = st.provider;
  $('#provenance').innerHTML = `
    <div>Data source: <strong>${esc(p.label)}</strong> <span class="tag ${esc(p.dataMode)}">${esc(p.dataMode.toUpperCase())}</span>${p.website ? ` · <a href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">API docs</a>` : ''}</div>
    <div>Last provider update: <strong>${esc(fmtStamp(st.lastProviderUpdateAt))}</strong> · last successful fetch ${esc(fmtStamp(st.lastSuccessfulUpdateAt))} · ${st.datesWithData}/${st.totalDates} dates with data${st.budget.dailyLimit ? ` · provider calls today ${st.budget.usedToday}/${st.budget.dailyLimit}` : ''}</div>
    <div>Prices are snapshots taken at the time shown; airfares and availability can change between this search and booking, so always confirm the final price with the seller.</div>`;
}

/* ---------- interactions ---------- */
function viewItinerary(fp) {
  ui.filters = { ...FILTER_KEYS };
  syncControls();
  writeFilters();
  ui.expanded.add(fp);
  const idx = visibleOffers().findIndex((o) => o.fingerprint === fp);
  if (idx >= ui.shown) ui.shown = idx + 1;
  renderTable();
  document.querySelector(`tr[data-fp="${fp}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function onFiltersChanged() {
  ui.shown = PAGE;
  writeFilters();
  renderTable();
}

function bindControls() {
  const map = { '#f-sort': 'sort', '#f-dur': 'dur', '#f-stops': 'stops', '#f-airline': 'airline', '#f-date': 'date' };
  for (const [sel, key] of Object.entries(map)) {
    $(sel).addEventListener('change', (e) => { ui.filters[key] = e.target.value; onFiltersChanged(); });
  }
  $('#f-price').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    ui.filters.max = /^\d+$/.test(v) && Number(v) > 0 ? v : '';
    onFiltersChanged();
  });
  $('#f-reset').addEventListener('click', () => { ui.filters = { ...FILTER_KEYS }; syncControls(); onFiltersChanged(); });
  $('#more-btn').addEventListener('click', () => { ui.shown += PAGE; renderTable(); });
  $('#refresh-btn').addEventListener('click', refreshNow);
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fw-theme', next);
  });
  const body = $('#results-body');
  body.addEventListener('click', (e) => {
    const cmp = e.target.closest('input[data-cmp]');
    if (cmp) {
      const fp = cmp.dataset.cmp;
      if (cmp.checked) {
        if (ui.compare.size >= 3) { cmp.checked = false; ui.notice = { kind: 'info', text: 'You can compare up to 3 itineraries.' }; renderNotices(); return; }
        ui.compare.add(fp);
      } else ui.compare.delete(fp);
      renderCompare();
      return;
    }
    if (e.target.closest('a, button, .detail')) return;
    const row = e.target.closest('tr.row');
    if (!row) return;
    toggleRow(row.dataset.fp);
  });
  body.addEventListener('keydown', (e) => {
    const row = e.target.closest('tr.row');
    if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); toggleRow(row.dataset.fp); }
  });

  const thr = $('#alert-threshold');
  thr.value = localStorage.getItem('fw-alert') || '';
  thr.addEventListener('change', () => {
    const v = thr.value.trim();
    if (/^\d+$/.test(v) && Number(v) > 0) localStorage.setItem('fw-alert', v); else { localStorage.removeItem('fw-alert'); thr.value = ''; }
    localStorage.removeItem('fw-alert-notified');
    checkAlerts();
  });
  $('#notify-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) { $('#alert-status').textContent = 'Desktop notifications are not supported by this browser.'; return; }
    const perm = await Notification.requestPermission();
    renderAlertStatus(perm);
  });
  renderAlertStatus('Notification' in window ? Notification.permission : 'unsupported');
}

function toggleRow(fp) {
  if (ui.expanded.has(fp)) ui.expanded.delete(fp); else ui.expanded.add(fp);
  renderTable();
  document.querySelector(`tr[data-fp="${fp}"]`)?.focus({ preventScroll: true });
}

function renderAlertStatus(perm) {
  $('#alert-status').textContent = perm === 'granted' ? 'Desktop alerts on: you will be notified when the cheapest total drops or falls below your threshold (while this tab is open).'
    : perm === 'denied' ? 'Notifications are blocked in this browser.' : perm === 'unsupported' ? '' : 'Alerts are shown in-page; enable desktop alerts to get notifications.';
}

function checkAlerts() {
  const c = ui.results?.stats?.cheapest;
  if (!c || sortPrice(c) === null) return;
  const tag = c.dataMode === 'demo' ? '[DEMO DATA] ' : c.dataMode === 'sandbox' ? '[SANDBOX] ' : '';
  const key = `fw-last-cheapest-${c.source}-${c.dataMode}`;
  const prev = Number(localStorage.getItem(key));
  localStorage.setItem(key, String(c.totalPrice));
  const threshold = Number(localStorage.getItem('fw-alert'));
  const messages = [];
  if (prev && c.totalPrice < prev - 0.5) messages.push(`${tag}Cheapest fare dropped ${money(prev - c.totalPrice)} → ${money(c.totalPrice)} total for 2 adults (${fmtShort(c.departureDate)})`);
  if (threshold && c.totalPrice <= threshold && localStorage.getItem('fw-alert-notified') !== String(c.totalPrice)) {
    localStorage.setItem('fw-alert-notified', String(c.totalPrice));
    messages.push(`${tag}${money(c.totalPrice)} total for 2 adults on ${fmtShort(c.departureDate)} — below your ${money(threshold)} alert`);
  }
  if (!messages.length) return;
  ui.notice = { kind: 'info', text: messages.join(' · ') };
  renderNotices();
  if ('Notification' in window && Notification.permission === 'granted') {
    for (const m of messages) new Notification('Flight Watch · RMO → CXR', { body: m });
  }
}

/* ---------- boot ---------- */
(function boot() {
  const saved = localStorage.getItem('fw-theme');
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  bindControls();
  syncControls();
  writeFilters();
  loadResults().then(poll);
  setInterval(renderHeader, 30000);
})();
