const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.append(c);
  }
  return node;
}

function btn(label, variant, onClick, extra = {}) {
  return el('button', { class: `btn ${variant}`, text: label, onClick, ...extra });
}

const state = { user: null, lines: [], executions: [], adjustments: [], disbursements: [], allocations: [], transfers: [], reserveMoves: [], nav: 'dashboard', selectedDisb: null, filters: { year: 'all', month: 'all', disbursement: 'all' } };
const byId = {};
const byDisbursementId = {};
const collapsed = new Set();

const settings = {
  currencySymbol: 'Q ',
  darkMode: false,
  chartExecColor: '#3b82f6',
  chartDispColor: '#16a34a',
};

function loadSettings() {
  const saved = localStorage.getItem('budget-settings');
  if (saved) {
    try {
      Object.assign(settings, JSON.parse(saved));
    } catch (e) {}
  }
  applyDarkMode(settings.darkMode);
}

function saveSettings() {
  localStorage.setItem('budget-settings', JSON.stringify(settings));
}

function applyDarkMode(enabled) {
  settings.darkMode = enabled;
  document.documentElement.classList.toggle('dark', enabled);
  saveSettings();
}

function getCurrencySymbol() {
  return settings.currencySymbol;
}

function setCurrencySymbol(symbol) {
  settings.currencySymbol = symbol;
  saveSettings();
  renderDashboard();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

const money = (n) => getCurrencySymbol() + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

const monthKey = (dateStr) => String(dateStr).slice(0, 7);

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ¿La fecha cae dentro del filtro de año/mes activo?
function dateMatches(dateStr) {
  const f = state.filters;
  const s = String(dateStr || '');
  if (f.year !== 'all' && s.slice(0, 4) !== f.year) return false;
  if (f.month !== 'all' && s.slice(5, 7) !== f.month) return false;
  return true;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1] + ' ' + String(y).slice(2);
}

function moneyCompact(n) {
  const abs = Math.abs(n);
  const sym = getCurrencySymbol();
  if (abs >= 1e9) return sym + (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sym + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sym + (n / 1e3).toFixed(1) + 'K';
  return sym + Math.round(n);
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * mag) return m * mag;
  }
  return 10 * mag;
}

function renderMonthlyChart(panel, totals, execs = state.executions, adjustments = state.adjustments) {
  const months = new Set();
  for (const e of execs) months.add(monthKey(e.date));
  for (const a of adjustments) months.add(monthKey(a.date));
  if (months.size === 0) {
    panel.append(el('div', { class: 'empty-box', text: 'Registra saldo real para ver la ejecución mensual.' }));
    return;
  }

  const sorted = [...months].sort();
  const todayKey = today().slice(0, 7);
  let start = sorted[0];
  let end = todayKey > sorted[sorted.length - 1] ? todayKey : sorted[sorted.length - 1];
  if (start > end) start = end;
  const keys = [];
  for (let k = start; ; ) {
    keys.push(k);
    if (k === end) break;
    const [y, m] = k.split('-').map(Number);
    k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  const execByMonth = {};
  for (const e of execs) {
    const k = monthKey(e.date);
    execByMonth[k] = (execByMonth[k] || 0) + e.amount;
  }
  const budget = Math.max(0, totals.budget);
  const cum = [];
  let run = 0;
  for (const k of keys) {
    run += execByMonth[k] || 0;
    cum.push(run);
  }

  const W = 960, H = 300;
  const P = { l: 70, r: 20, t: 24, b: 40 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const maxCum = Math.max(...cum, 0);
  const amplified = maxCum > 0 && maxCum < budget * 0.25;
  const maxV = niceMax(amplified ? maxCum : Math.max(budget, maxCum, 1));
  const step = iw / (keys.length - 1 || 1);
  const x = (i) => P.l + i * step;
  const yv = (v) => P.t + ih - (Math.max(0, v) / maxV) * ih;
  const yBudget = amplified ? P.t : yv(budget);

  function catmullRom(pts) {
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      const tension = 6;
      const cp1x = p1[0] + (p2[0] - p0[0]) / tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) / tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) / tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) / tension;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }

  const pts = cum.map((v, i) => [x(i), yv(v)]);
  const linePath = catmullRom(pts);
  const areaPath = linePath + ` L ${x(keys.length - 1)} ${yv(0)} L ${x(0)} ${yv(0)} Z`;

  const dispPath = catmullRom(pts);
  const dispArea = dispPath + ` L ${x(keys.length - 1)} ${yBudget} L ${x(0)} ${yBudget} Z`;

  const execColor = settings.chartExecColor || '#3b82f6';
  const dispColor = settings.chartDispColor || '#16a34a';

  const defs = svgEl('defs', {}, [
    svgEl('linearGradient', { id: 'gradExec', x1: 0, y1: 0, x2: 0, y2: 1 }, [
      svgEl('stop', { offset: '0%', 'stop-color': execColor, 'stop-opacity': 0.3 }),
      svgEl('stop', { offset: '85%', 'stop-color': execColor, 'stop-opacity': 0.04 }),
      svgEl('stop', { offset: '100%', 'stop-color': execColor, 'stop-opacity': 0 }),
    ]),
    svgEl('linearGradient', { id: 'gradDisp', x1: 0, y1: 0, x2: 0, y2: 1 }, [
      svgEl('stop', { offset: '0%', 'stop-color': dispColor, 'stop-opacity': 0.18 }),
      svgEl('stop', { offset: '100%', 'stop-color': dispColor, 'stop-opacity': 0.02 }),
    ]),
  ]);

  const grid = [];
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxV * i) / ticks;
    const gy = yv(v);
    grid.push(svgEl('line', { x1: P.l, y1: gy, x2: W - P.r, y2: gy, class: 'ct-grid' }));
    grid.push(svgEl('text', { x: P.l - 8, y: gy + 4, class: 'ct-axis', 'text-anchor': 'end', text: moneyCompact(v) }));
  }

  const labelEvery = Math.ceil(keys.length / 8);
  const xLabels = [];
  for (let i = 0; i < keys.length; i++) {
    if (i % labelEvery !== 0 && i !== keys.length - 1) continue;
    xLabels.push(svgEl('text', { x: x(i), y: H - 16, class: 'ct-axis', 'text-anchor': 'middle', text: monthLabel(keys[i]) }));
    const amt = execByMonth[keys[i]] || 0;
    if (amt > 0) {
      xLabels.push(svgEl('text', { x: x(i), y: H - 2, class: 'ct-amount', 'text-anchor': 'middle', text: moneyCompact(amt) }));
    }
  }

  const budgetLine = svgEl('line', { x1: P.l, y1: yBudget, x2: W - P.r, y2: yBudget, class: 'ct-budget' });
  const budgetLabel = svgEl('text', { x: W - P.r - 4, y: yBudget - 6, class: 'ct-axis', 'text-anchor': 'end', text: 'Presupuesto ' + moneyCompact(budget) + (amplified ? ' (fuera de escala)' : '') });
  const note = amplified ? svgEl('text', { x: P.l, y: yBudget - 6, class: 'ct-note', text: 'Escala ampliada del ejecutado' }) : null;
  const guide = svgEl('line', { x1: 0, y1: P.t, x2: 0, y2: P.t + ih, class: 'ct-guide', style: 'display:none' });
  const dotExec = svgEl('circle', { r: 4, fill: execColor, stroke: '#fff', 'stroke-width': 2, style: 'display:none' });
  const dotDisp = svgEl('circle', { r: 4, fill: dispColor, stroke: '#fff', 'stroke-width': 2, style: 'display:none' });

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` }, [
    defs,
    ...grid,
    budgetLine,
    budgetLabel,
    note,
    svgEl('path', { d: dispArea, fill: 'url(#gradDisp)' }),
    svgEl('path', { d: areaPath, fill: 'url(#gradExec)' }),
    svgEl('path', { d: linePath, fill: 'none', stroke: execColor, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    guide,
    dotExec,
    dotDisp,
    ...xLabels,
  ]);

  const tip = el('div', { class: 'chart-tooltip' });
  const wrap = el('div', { class: 'chart-wrap' }, [svg, tip]);

  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const s = W / rect.width;
    const mx = (ev.clientX - rect.left) * s;
    let idx = Math.round((mx - P.l) / step);
    idx = Math.max(0, Math.min(keys.length - 1, idx));
    const gx = x(idx);
    guide.setAttribute('x1', gx);
    guide.setAttribute('x2', gx);
    guide.style.display = '';
    dotExec.setAttribute('cx', gx);
    dotExec.setAttribute('cy', yv(cum[idx]));
    dotExec.style.display = '';
    dotDisp.setAttribute('cx', gx);
    dotDisp.setAttribute('cy', yv(budget));
    dotDisp.style.display = '';
    const exec = cum[idx];
    const disp = budget - exec;
    const pct = budget > 0 ? (exec / budget) * 100 : 0;
    tip.innerHTML = '';
    tip.append(
      el('div', { class: 'tt-title', text: monthLabel(keys[idx]) }),
      el('div', { class: 'tt-row' }, [el('span', { text: 'Ejecutado del mes' }), el('span', { text: money(execByMonth[keys[idx]] || 0) })]),
      el('div', { class: 'tt-row' }, [el('span', { text: 'Ejecutado acumulado' }), el('span', { text: money(exec) + ' (' + pct.toFixed(1) + '%)' })]),
      el('div', { class: 'tt-row' }, [el('span', { text: 'Disponible' }), el('span', { text: money(disp) })]),
    );
    tip.style.opacity = '1';
    const tw = 220;
    tip.style.left = Math.max(8, Math.min(rect.width - tw - 8, gx / s - tw / 2)) + 'px';
    tip.style.top = '8px';
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.opacity = '0';
    guide.style.display = 'none';
    dotExec.style.display = 'none';
    dotDisp.style.display = 'none';
  });

  panel.append(
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [el('span', { class: 'sw', style: `background:${execColor}` }), el('span', { text: 'Ejecutado acumulado' })]),
      el('span', {}, [el('span', { class: 'sw', style: `background:${dispColor}` }), el('span', { text: 'Disponible' })]),
      el('span', {}, [el('span', { class: 'sw sw-line' }), el('span', { text: 'Presupuesto vigente' })]),
    ]),
    wrap,
  );
}

// Color de la barra de avance:
// 0-10% rojo · 11-50% naranja · 51-80% limón · 81-100% azul (sobre 100% rojo).
function pctColor(p) {
  if (p == null) return 'blue';
  if (p > 100) return 'red';
  if (p <= 10) return 'red';
  if (p <= 50) return 'orange';
  if (p <= 80) return 'lime';
  return 'blue';
}

const PIE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#65a30d', '#ea580c', '#6366f1', '#14b8a6', '#e11d48'];

function renderPieChart(panel, execs = state.executions) {
  const { childrenMap, rolled } = buildTree(execs);
  const roots = childrenMap[null] || [];
  const entries = [];
  for (const l of roots) {
    const r = rolled[l.id];
    if (r && r.exec > 0) {
      entries.push({ id: l.id, amt: r.exec, line: l });
    }
  }
  entries.sort((a, b) => b.amt - a.amt);

  if (entries.length === 0) {
    panel.append(el('div', { class: 'empty-box', text: 'Sin ejecución para mostrar distribución.' }));
    return;
  }

  const total = entries.reduce((s, e) => s + e.amt, 0);
  const W = 220, H = 220, cx = W / 2, cy = H / 2;
  const R = 82, strokeW = 20;
  const monoPalette = [
    '#1e40af', '#2563eb', '#3b82f6', '#60a5fa',
    '#93c5fd', '#1d4ed8', '#2563eb', '#3b82f6',
    '#60a5fa', '#93c5fd', '#bfdbfe', '#1e3a8a',
  ];

  function deg(rad) { return rad * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }
  function polar(cx, cy, R, angleDeg) {
    const a = rad(angleDeg - 90);
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  }
  function arcPath(cx, cy, R, startDeg, endDeg) {
    const s = polar(cx, cy, R, startDeg);
    const e = polar(cx, cy, R, endDeg);
    const large = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${R} ${R} 0 ${large} 1 ${e.x} ${e.y}`;
  }

  const totalGapDeg = entries.length * 5;
  const availableDeg = 360 - totalGapDeg;
  let cur = -90;
  const arcs = [];
  const legendItems = [];

  // Resalta una porción (y su leyenda) y atenúa el resto.
  const setHighlight = (idx) => {
    arcs.forEach((p, j) => {
      p.setAttribute('stroke-width', idx == null ? strokeW : (j === idx ? strokeW + 8 : strokeW));
      p.style.opacity = idx == null || j === idx ? '1' : '0.3';
    });
    legendItems.forEach((it, j) => it.classList.toggle('hi', idx != null && j === idx));
  };

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const color = monoPalette[i % monoPalette.length];
    const pct = ((e.amt / total) * 100).toFixed(1);
    const sliceDeg = (e.amt / total) * availableDeg;
    const label = (e.line.code ? e.line.code + ' · ' : '') + e.line.name;
    const d = arcPath(cx, cy, R, cur, cur + sliceDeg);

    const p = svgEl('path', {
      d, fill: 'none', stroke: color, 'stroke-width': strokeW,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      style: 'transition: stroke-width .15s, opacity .15s; cursor: pointer',
    });
    p.append(svgEl('title', { text: `${label}: ${money(e.amt)} (${pct}%)` }));
    p.addEventListener('mouseenter', () => setHighlight(i));
    p.addEventListener('mouseleave', () => setHighlight(null));
    arcs.push(p);

    const row = el('div', { class: 'pie-legend-item' }, [
      el('span', { class: 'pie-swatch', style: `background:${color}` }),
      el('span', { class: 'pie-legend-text', title: label }, [
        e.line.code ? el('span', { class: 'pie-code', text: e.line.code }) : null,
        el('span', { class: 'pie-legend-name', text: e.line.name }),
      ]),
      el('span', { class: 'pie-legend-amt', text: money(e.amt) }),
      el('span', { class: 'pie-legend-pct', text: pct + '%' }),
    ]);
    row.addEventListener('mouseenter', () => setHighlight(i));
    row.addEventListener('mouseleave', () => setHighlight(null));
    legendItems.push(row);

    cur += sliceDeg + 5;
  }

  const ct1 = svgEl('text', {
    x: cx, y: cy - 2, 'text-anchor': 'middle',
    'font-size': '18', 'font-weight': '700', fill: 'var(--text)',
    'font-family': 'system-ui, sans-serif',
  });
  ct1.textContent = money(total);
  const ct2 = svgEl('text', {
    x: cx, y: cy + 16, 'text-anchor': 'middle',
    'font-size': '10', fill: 'var(--muted)',
    'font-family': 'system-ui, sans-serif',
  });
  ct2.textContent = 'Total ejecutado';

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, style: 'max-width:220px' }, [...arcs, ct1, ct2]);
  const legend = el('div', { class: 'pie-legend' }, legendItems);

  panel.append(el('h2', { text: 'Distribución del gasto' }), el('div', { class: 'pie-wrap' }, [svg, legend]));
}

function toast(msg, isError = false) {
  const t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), 3200);
}

async function init() {
  loadSettings();
  try {
    const { user } = await api('/api/me');
    if (user) {
      state.user = user;
      await loadData();
      renderDashboard();
      return;
    }
  } catch (e) {}
  renderAuth();
}

async function loadData() {
  const data = await api('/api/data');
  state.lines = data.lines;
  state.executions = data.executions;
  state.adjustments = data.adjustments;
  state.disbursements = data.disbursements || [];
  state.allocations = data.allocations || [];
  state.transfers = data.transfers || [];
  state.reserveMoves = data.reserveMoves || [];
  Object.keys(byId).forEach((k) => delete byId[k]);
  Object.keys(byDisbursementId).forEach((k) => delete byDisbursementId[k]);
  state.lines.forEach((l) => { byId[l.id] = l; });
  state.disbursements.forEach((d) => { byDisbursementId[d.id] = d; });
  // Si el desembolso seleccionado ya no existe, limpiar la selección.
  if (state.selectedDisb != null && !byDisbursementId[state.selectedDisb]) state.selectedDisb = null;
  if (state.filters.disbursement !== 'all' && !byDisbursementId[state.filters.disbursement]) state.filters.disbursement = 'all';
}

// Ejecuciones de un desembolso concreto.
function executionsFor(disbursementId) {
  return state.executions.filter((e) => e.disbursement_id === disbursementId);
}

// --- Filtros del dashboard (año / mes / desembolso) ---

function filteredExecutions() {
  const f = state.filters;
  return state.executions.filter((e) => {
    if (f.disbursement !== 'all' && String(e.disbursement_id) !== f.disbursement) return false;
    return dateMatches(e.date);
  });
}

function filteredAdjustments() {
  return state.adjustments.filter((a) => dateMatches(a.date));
}

function filteredAllocations() {
  const f = state.filters;
  if (f.disbursement === 'all') return state.allocations;
  return state.allocations.filter((a) => String(a.disbursement_id) === f.disbursement);
}

function filteredDisbursements() {
  const f = state.filters;
  return state.disbursements.filter((d) => {
    if (f.disbursement !== 'all' && String(d.id) !== f.disbursement) return false;
    return dateMatches(d.date);
  });
}

function disbursementTotals() {
  return state.disbursements.reduce((t, d) => {
    t.received += d.amount || 0;
    return t;
  }, { received: 0 });
}

function disbursementApplied(disbursementId) {
  return state.executions
    .filter((e) => e.disbursement_id === disbursementId)
    .reduce((s, e) => s + e.amount, 0);
}

function unassignedExecutions() {
  return state.executions.filter((e) => e.disbursement_id == null);
}

// --- Asignaciones (reparto del desembolso entre líneas) ---

// Asignaciones de un desembolso.
function allocationsFor(disbursementId) {
  return state.allocations.filter((a) => a.disbursement_id === disbursementId);
}

// Ajustes de reparto (traslados entre líneas) de un desembolso.
function transfersFor(disbursementId) {
  return state.transfers.filter((t) => t.disbursement_id === disbursementId);
}

// Traslados de saldo al siguiente desembolso de un desembolso.
function reserveMovesFor(disbursementId) {
  return state.reserveMoves.filter((m) => m.disbursement_id === disbursementId);
}

// Avance general de un desembolso sobre lo disponible (recibido + reserva).
function disbAvance(d) {
  const base = (d.amount || 0) + reserveBefore(d.id);
  const exec = disbursementApplied(d.id);
  const pct = base > 0 ? (exec / base) * 100 : null;
  const target = d.target_pct != null ? Number(d.target_pct) : 80;
  return { base, exec, pct, target };
}

// Saldo que se puede pasar al siguiente: lo no repartido + lo repartido sin gastar.
function pendingBalance(d) {
  const allocated = disbursementAllocated(d.id);
  const available = (d.amount || 0) + reserveBefore(d.id);
  const unallocated = Math.max(0, available - allocated);
  let unspent = 0;
  const seen = new Set();
  for (const a of allocationsFor(d.id)) {
    if (seen.has(a.line_id)) continue;
    seen.add(a.line_id);
    const free = lineAllocated(a.line_id, d.id) - lineExecuted(a.line_id, d.id);
    if (free > 0) unspent += free;
  }
  return { unallocated, unspent, total: unallocated + unspent };
}

// Total asignado de un desembolso.
function disbursementAllocated(disbursementId) {
  return allocationsFor(disbursementId).reduce((s, a) => s + a.amount, 0);
}

// Total asignado a una línea (en un desembolso, o en todos si se omite).
function lineAllocated(lineId, disbursementId = null) {
  return state.allocations
    .filter((a) => a.line_id === lineId && (disbursementId == null || a.disbursement_id === disbursementId))
    .reduce((s, a) => s + a.amount, 0);
}

// Ejecutado real de una línea dentro de un desembolso.
function lineExecuted(lineId, disbursementId) {
  return state.executions
    .filter((e) => e.line_id === lineId && e.disbursement_id === disbursementId)
    .reduce((s, e) => s + e.amount, 0);
}

function totalReceived() {
  return state.disbursements.reduce((s, d) => s + (d.amount || 0), 0);
}

function totalAllocated() {
  return state.allocations.reduce((s, a) => s + a.amount, 0);
}

// Reserva global: desembolsos recibidos que todavía no se repartieron.
function globalReserve() {
  return totalReceived() - totalAllocated();
}

function disbursementsOrdered() {
  return [...state.disbursements].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)));
}

// Reserva acumulada de los desembolsos anteriores a este (para repartirla aquí).
function reserveBefore(disbursementId) {
  let reserve = 0;
  for (const d of disbursementsOrdered()) {
    if (d.id === disbursementId) return reserve;
    reserve += (d.amount || 0) - disbursementAllocated(d.id);
  }
  return reserve;
}

// Orden natural: compara los números que haya dentro del texto, sin límite de
// profundidad. Así "2" va antes que "10" y "A1.2" antes que "A1.10".
function naturalCompare(a, b) {
  const ta = String(a == null ? '' : a).match(/\d+|\D+/g) || [];
  const tb = String(b == null ? '' : b).match(/\d+|\D+/g) || [];
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const xa = ta[i];
    const xb = tb[i];
    if (xa == null) return -1;
    if (xb == null) return 1;
    const na = /^\d/.test(xa);
    const nb = /^\d/.test(xb);
    if (na && nb) {
      const d = Number(xa) - Number(xb);
      if (d) return d;
    } else {
      const la = xa.toLowerCase();
      const lb = xb.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
    }
  }
  return 0;
}

// Orden de las líneas hermanas: por código (o nombre si no hay código) de forma
// natural y, a igualdad, por orden de creación (id) para que se vea cronológico.
function compareLines(a, b) {
  const d = naturalCompare(a.code || a.name, b.code || b.name);
  if (d) return d;
  return a.id - b.id;
}

function buildTree(execs = state.executions, allocs = state.allocations) {
  const childrenMap = {};
  const stats = {};
  for (const l of state.lines) {
    (childrenMap[l.parent_id] = childrenMap[l.parent_id] || []).push(l);
    stats[l.id] = { ownBudget: l.amount, ownExec: 0, ownAdj: 0, ownExecCount: 0, ownAlloc: 0 };
  }
  for (const list of Object.values(childrenMap)) {
    list.sort(compareLines);
  }
  for (const e of execs) {
    if (stats[e.line_id]) {
      stats[e.line_id].ownExec += e.amount;
      stats[e.line_id].ownExecCount += 1;
    }
  }
  for (const a of state.adjustments) {
    if (stats[a.line_id]) {
      stats[a.line_id].ownBudget += a.amount;
      stats[a.line_id].ownAdj += 1;
    }
  }
  for (const a of allocs) {
    if (stats[a.line_id]) stats[a.line_id].ownAlloc += a.amount;
  }
  const rolled = {};
  const rollup = (id) => {
    let b = stats[id].ownBudget;
    let e = stats[id].ownExec;
    let ac = stats[id].ownAdj;
    let ec = stats[id].ownExecCount;
    let al = stats[id].ownAlloc;
    for (const c of childrenMap[id] || []) {
      const [cb, ce, cac, cec, cal] = rollup(c.id);
      b += cb;
      e += ce;
      ac += cac;
      ec += cec;
      al += cal;
    }
    rolled[id] = { budget: b, exec: e, adjCount: ac, execCount: ec, alloc: al };
    return [b, e, ac, ec, al];
  };
  for (const l of childrenMap[null] || []) rollup(l.id);
  return { childrenMap, stats, rolled };
}

function lineOptions(excludeId) {
  const sorted = [...state.lines].sort(compareLines);
  const opts = [];
  for (const l of sorted) {
    if (l.id === excludeId) continue;
    const prefix = l.code ? `[${l.code}] ` : '';
    opts.push({ value: String(l.id), label: prefix + l.name });
  }
  return opts;
}

// Líneas que ya tienen asignación en un desembolso (para registrar el gasto real).
function allocatedLineOptions(disbursementId) {
  const ids = new Set(allocationsFor(disbursementId).map((a) => a.line_id));
  return lineOptions().filter((o) => ids.has(Number(o.value)));
}

// Ruta jerárquica de una línea: desde la raíz hasta ella (padre › hijo › nieto…).
function linePath(line) {
  const chain = [];
  let cur = line;
  let guard = 0;
  while (cur && guard++ < 50) {
    chain.unshift(cur);
    cur = cur.parent_id ? byId[cur.parent_id] : null;
  }
  return chain;
}

// Nombre del nivel según su profundidad en el árbol.
function lineLevelLabel(depth) {
  const names = ['línea principal', 'hijo', 'nieto', 'bisnieto', 'tataranieto'];
  return names[depth] || `nivel ${depth}`;
}

// Texto de la ruta: "[A] Educación › [A1] Becas › [A1.2] Sub-becas".
function linePathText(line) {
  return linePath(line)
    .map((l) => (l.code ? `[${l.code}] ${l.name}` : l.name))
    .join(' › ');
}

function renderAuth() {
  const app = $('#app');
  app.innerHTML = '';
  let mode = 'login';

  const errBox = el('div', { class: 'auth-error', style: 'display:none' });
  const form = el('form', { class: 'auth-form' });
  const title = el('h1', { text: 'Dashboard de Presupuesto' });

  const tabLogin = el('button', { class: 'tab active', text: 'Iniciar sesión' });
  const tabReg = el('button', { class: 'tab', text: 'Registrarse' });
  tabLogin.addEventListener('click', () => { mode = 'login'; tabLogin.classList.add('active'); tabReg.classList.remove('active'); buildForm(); });
  tabReg.addEventListener('click', () => { mode = 'register'; tabReg.classList.add('active'); tabLogin.classList.remove('active'); buildForm(); });

  function buildForm() {
    form.innerHTML = '';
    form.append(
      el('label', { text: 'Usuario' }),
      el('input', { type: 'text', name: 'username', required: true, minlength: '3', autocomplete: 'username' }),
      el('label', { text: 'Contraseña' }),
      el('input', { type: 'password', name: 'password', required: true, minlength: '4', autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
      errBox,
      btn(mode === 'login' ? 'Entrar' : 'Crear cuenta', 'primary', null, { type: 'submit' }),
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    errBox.style.display = 'none';
    try {
      const { user } = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: { username, password } });
      state.user = user;
      await loadData();
      renderDashboard();
      toast(mode === 'login' ? 'Sesión iniciada' : 'Cuenta creada');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = '';
    }
  });

  buildForm();
  app.append(el('div', { class: 'auth-wrap' }, [
    el('div', { class: 'auth-card' }, [
      title,
      el('div', { class: 'auth-sub', text: 'Presupuestos, líneas jerárquicas, saldo real y ajustes' }),
      el('div', { class: 'auth-tabs' }, [tabLogin, tabReg]),
      form,
    ]),
  ]));
}

function statCard(label, value, sub) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    sub != null ? el('div', { class: 'sub', text: sub }) : null,
  ]);
}

function pctCard(pct) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'label', text: 'Presupuesto ejecutado' }),
    el('div', { class: 'value', text: pct == null ? '—' : pct.toFixed(1) + '%' }),
    el('div', { class: 'progress' }, [
      el('div', { class: 'fill ' + (pct == null ? 'blue' : pctColor(pct)), style: `width:${pct == null ? 0 : Math.min(100, pct)}%` }),
    ]),
  ]);
}

const ORDINALS = ['Primer', 'Segundo', 'Tercer', 'Cuarto', 'Quinto', 'Sexto', 'Séptimo', 'Octavo', 'Noveno', 'Décimo'];

function autoDisbursementName() {
  const n = state.disbursements.length;
  const ord = ORDINALS[n];
  return ord ? `${ord} desembolso` : `Desembolso ${n + 1}`;
}

function treeTotals(tree) {
  const roots = tree.childrenMap[null] || [];
  return roots.reduce((t, l) => {
    t.budget += tree.rolled[l.id].budget;
    t.exec += tree.rolled[l.id].exec;
    return t;
  }, { budget: 0, exec: 0 });
}

const NAV_ITEMS = [
  ['dashboard', '📊', 'Dashboard General'],
  ['disbursements', '💰', 'Desembolsos'],
  ['export', '⬇️', 'Exportar'],
  ['import', '⬆️', 'Importar'],
  ['settings', '⚙️', 'Ajustes'],
];

function renderSidebar() {
  const nav = el('nav', { class: 'nav' }, NAV_ITEMS.map(([id, icon, label]) => el('button', {
    class: 'nav-item' + (state.nav === id ? ' active' : ''),
    onClick: () => { state.nav = id; renderDashboard(); },
  }, [
    el('span', { class: 'nav-icon', text: icon }),
    el('span', { class: 'nav-label', text: label }),
  ])));
  return el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-brand' }, [
      el('div', { class: 'brand-title', text: 'Presupuesto' }),
      el('div', { class: 'brand-sub', text: 'Control 2026' }),
    ]),
    nav,
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'user-chip' }, [
        el('span', { class: 'user-avatar', text: (state.user.username || '?').slice(0, 1).toUpperCase() }),
        el('span', { class: 'user-name', text: state.user.username }),
      ]),
      btn('Cerrar sesión', 'ghost', logout),
    ]),
  ]);
}

function contentHeader(title, sub, actions = []) {
  return el('header', { class: 'content-head' }, [
    el('div', { class: 'content-head-text' }, [
      el('h1', { text: title }),
      sub ? el('p', { text: sub }) : null,
    ]),
    el('div', { class: 'content-head-actions' }, actions.filter(Boolean)),
  ]);
}

function renderDashboard() {
  const app = $('#app');
  app.innerHTML = '';
  if (state.selectedDisb != null && !byDisbursementId[state.selectedDisb]) state.selectedDisb = null;
  if (state.nav === 'disbursements' && state.selectedDisb == null && state.disbursements.length) {
    state.selectedDisb = disbursementsOrdered()[0].id;
  }
  const content = el('main', { class: 'content' });
  if (state.nav === 'dashboard') renderDashboardView(content);
  else if (state.nav === 'disbursements') renderDisbursementsView(content);
  else if (state.nav === 'export') renderExportView(content);
  else if (state.nav === 'import') renderImportView(content);
  else if (state.nav === 'settings') renderSettingsView(content);
  app.append(el('div', { class: 'app-shell' }, [renderSidebar(), content]));
}

function renderFilters() {
  const f = state.filters;
  const years = new Set();
  for (const e of state.executions) years.add(String(e.date).slice(0, 4));
  for (const d of state.disbursements) years.add(String(d.date).slice(0, 4));
  for (const a of state.adjustments) years.add(String(a.date).slice(0, 4));
  const yearOpts = [{ value: 'all', label: 'Todos los años' }, ...[...years].filter(Boolean).sort().reverse().map((y) => ({ value: y, label: y }))];
  const monthOpts = [{ value: 'all', label: 'Todos los meses' }, ...MONTH_NAMES.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m }))];
  const disbOpts = [{ value: 'all', label: 'Todos los desembolsos' }, ...state.disbursements.map((d) => ({ value: String(d.id), label: d.name }))];
  const mk = (label, value, opts, key) => {
    const sel = el('select', { class: 'filter-select' });
    for (const o of opts) sel.append(el('option', { value: o.value, text: o.label }));
    sel.value = value;
    sel.addEventListener('change', () => { state.filters[key] = sel.value; renderDashboard(); });
    return el('label', { class: 'filter' }, [el('span', { class: 'filter-label', text: label }), sel]);
  };
  const active = f.year !== 'all' || f.month !== 'all' || f.disbursement !== 'all';
  return el('div', { class: 'filters' }, [
    el('span', { class: 'filters-title', text: 'Filtros' }),
    mk('Año', f.year, yearOpts, 'year'),
    mk('Mes', f.month, monthOpts, 'month'),
    mk('Desembolso', f.disbursement, disbOpts, 'disbursement'),
    active ? btn('Limpiar', 'ghost', () => { state.filters = { year: 'all', month: 'all', disbursement: 'all' }; renderDashboard(); }) : null,
  ]);
}

function renderDisbursementsView(root) {
  root.append(contentHeader('Desembolsos', 'Reparte cada desembolso entre líneas y registra el gasto real.', [
    btn('+ Nuevo desembolso', 'primary', () => openNewDisbursement()),
  ]));
  if (!state.disbursements.length) {
    root.append(el('div', { class: 'panel' }, [el('div', { class: 'empty-box' }, [
      el('span', { text: 'Todavía no registraste desembolsos.' }),
      btn('+ Crear el primero', 'primary', () => openNewDisbursement()),
    ])]));
    return;
  }
  const list = el('div', { class: 'disb-list' });
  for (const d of disbursementsOrdered()) {
    const allocated = disbursementAllocated(d.id);
    const applied = disbursementApplied(d.id);
    list.append(el('button', {
      class: 'disb-card' + (state.selectedDisb === d.id ? ' active' : ''),
      onClick: () => { state.selectedDisb = d.id; renderDashboard(); },
    }, [
      el('div', { class: 'dc-top' }, [el('span', { class: 'dc-name', text: d.name }), el('span', { class: 'dc-date', text: d.date })]),
      el('div', { class: 'dc-amount', text: money(d.amount) }),
      el('div', { class: 'dc-sub' }, [
        el('span', { text: 'Asignado ' + money(allocated) }),
        el('span', { text: 'Ejecutado ' + money(applied) }),
      ]),
      renderDisbProgress(d, true),
    ]));
  }
  root.append(el('div', { class: 'panel' }, [el('h2', { text: 'Todos los desembolsos' }), list]));

  const d = byDisbursementId[state.selectedDisb];
  if (!d) return;
  root.append(renderDisbursementDetail(d));

  const disbTree = buildTree(executionsFor(d.id), allocationsFor(d.id));
  const allTree = buildTree(state.executions, state.allocations);
  const { childrenMap, stats, rolled } = disbTree;
  const roots = childrenMap[null] || [];
  const panel = el('div', { class: 'panel' }, [
    el('h2', { text: `Ejecución · ${d.name}` }),
    el('div', { class: 'panel-sub', text: '«Asignado» y «Ejecutado» son de este desembolso. «Acumulado» y «Disponible» suman todos los desembolsos.' }),
  ]);
  if (!roots.length) {
    panel.append(el('div', { class: 'empty-box', text: 'No hay líneas de presupuesto.' }));
  } else {
    const headCells = [
      el('div', { text: 'Línea' }),
      el('div', { class: 'tnum', text: 'Presupuesto' }),
      el('div', { class: 'tnum alloc', text: 'Asignado' }),
      el('div', { class: 'tnum exec', text: 'Ejecutado' }),
      el('div', { class: 'tnum', text: 'Acumulado' }),
      el('div', { class: 'tnum', text: 'Disponible' }),
      el('div', { class: 'tpct', text: 'Avance' }),
      el('div', { class: 'tacts', text: 'Acciones' }),
    ];
    const scroll = el('div', { class: 'ttree mode-disb' }, [el('div', { class: 'trow trow-head' }, headCells)]);
    const inner = el('div', { class: 'ttree-inner' });
    renderTree(childrenMap, rolled, stats, roots.map((l) => l.id), 0, inner, undefined, {
      disbursementId: d.id, globalRolled: allTree.rolled, showAlloc: true, showGlobal: true,
    });
    scroll.append(inner);
    panel.append(scroll);
  }
  root.append(panel);
}

function renderExportView(root) {
  root.append(contentHeader('Exportar', 'Descarga tus datos en un archivo Excel (.xlsx).'));
  root.append(el('div', { class: 'panel pad' }, [
    el('p', { class: 'muted-p', text: 'El archivo incluye las hojas: Líneas, Desembolsos, Asignaciones, Saldos reales y Ajustes.' }),
    el('div', { class: 'vpad' }, [btn('⬇️ Descargar Excel', 'primary', exportExcel)]),
  ]));
}

function renderImportView(root) {
  root.append(contentHeader('Importar', 'Sube un archivo Excel con el mismo formato del exportado.'));
  root.append(el('div', { class: 'panel pad' }, [
    el('p', { class: 'muted-p', text: 'Las filas se agregan a lo que ya tienes (no reemplaza nada). Orden de lectura: Líneas → Desembolsos → Asignaciones → Saldos reales → Ajustes.' }),
    el('div', { class: 'vpad' }, [btn('⬆️ Seleccionar archivo', 'primary', importExcel)]),
  ]));
}

function renderSettingsView(root) {
  root.append(contentHeader('Ajustes', 'Moneda, tema y colores de las gráficas.'));

  const symInput = el('input', { type: 'text', value: settings.currencySymbol, placeholder: 'Ej: Q, $, €, S/' });
  const darkInput = el('input', { type: 'checkbox', checked: settings.darkMode === true });
  const execColor = el('input', { type: 'color', value: settings.chartExecColor });
  const dispColor = el('input', { type: 'color', value: settings.chartDispColor });
  const form = el('form', { class: 'settings-form' }, [
    el('label', { class: 'settings-label', text: 'Símbolo de moneda' }),
    symInput,
    el('label', { class: 'settings-check' }, [darkInput, el('span', { text: 'Modo oscuro' })]),
    el('div', { class: 'settings-grid' }, [
      el('div', {}, [el('label', { class: 'settings-label', text: 'Gráfica — Ejecutado' }), execColor]),
      el('div', {}, [el('label', { class: 'settings-label', text: 'Gráfica — Disponible' }), dispColor]),
    ]),
    el('div', { class: 'vpad' }, [btn('Guardar ajustes', 'primary', null, { type: 'submit' })]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.currencySymbol = symInput.value || 'Q ';
    settings.chartExecColor = execColor.value || '#3b82f6';
    settings.chartDispColor = dispColor.value || '#16a34a';
    saveSettings();
    applyDarkMode(darkInput.checked);
    renderDashboard();
    toast('Ajustes guardados');
  });
  root.append(el('div', { class: 'panel pad' }, [form]));

  root.append(el('div', { class: 'panel pad danger-zone' }, [
    el('h2', { text: 'Zona de precaución' }),
    el('p', { class: 'muted-p', text: 'Esto borra TODAS tus líneas, desembolsos, asignaciones, saldos reales y ajustes de forma permanente. No se puede deshacer.' }),
    el('div', { class: 'vpad' }, [btn('🗑️ Eliminar todos mis datos', 'danger', deleteAllData)]),
  ]));
}

function renderDisbursementDetail(d) {
  const allocated = disbursementAllocated(d.id);
  const applied = disbursementApplied(d.id);
  const reserveBeforeAmt = reserveBefore(d.id);
  const available = (d.amount || 0) + reserveBeforeAmt;
  const remaining = available - allocated;
  const pb = pendingBalance(d);
  const item = (label, value, cls) => el('div', { class: 'disb-meta' }, [
    el('span', { class: 'disb-meta-label', text: label }),
    el('span', { class: 'disb-meta-value' + (cls ? ' ' + cls : ''), text: value }),
  ]);

  const allocList = el('div', { class: 'alloc-list' });
  const allocs = allocationsFor(d.id);
  if (allocs.length === 0) {
    allocList.append(el('div', { class: 'empty-box', text: 'Todavía no repartiste este desembolso entre líneas.' }));
  } else {
    allocList.append(el('div', { class: 'alloc-row alloc-head' }, [
      el('div', { text: 'Línea' }),
      el('div', { class: 'tnum', text: 'Asignado' }),
      el('div', { class: 'tnum', text: 'Ejecutado' }),
      el('div', { class: 'tnum', text: 'Saldo' }),
      el('div', { class: 'tacts', text: '' }),
    ]));
    for (const a of allocs) {
      const line = byId[a.line_id];
      const exec = lineExecuted(a.line_id, d.id);
      const saldo = a.amount - exec;
      allocList.append(el('div', { class: 'alloc-row' }, [
        el('div', { class: 'alloc-line' }, [
          line && line.code ? el('span', { class: 'tlevel depth-0', text: line.code }) : null,
          el('span', { class: 'alloc-lname', text: line ? line.name : '?' }),
        ]),
        el('div', { class: 'tnum', text: money(a.amount) }),
        el('div', { class: 'tnum exec', text: money(exec) }),
        el('div', { class: 'tnum' + (saldo < 0 ? ' neg' : ''), text: money(saldo) }),
        el('div', { class: 'tacts' }, [
          btn('Editar', '', () => openEditAllocation(a), { class: 'act-btn' }),
          btn('Eliminar', 'danger', () => deleteAllocation(a), { class: 'act-btn danger' }),
        ]),
      ]));
    }
  }

  return el('div', { class: 'disb-detail' }, [
    el('div', { class: 'disb-meta-row' }, [
      item('Recibido', money(d.amount)),
      item('Reserva anterior', money(reserveBeforeAmt), reserveBeforeAmt < 0 ? 'neg' : ''),
      item('Disponible para repartir', money(available)),
      item('Asignado a líneas', money(allocated), allocated > available ? 'neg' : ''),
      item('Sin repartir', money(remaining), remaining < 0 ? 'neg' : ''),
      item('Ejecutado (gasto real)', money(applied)),
      item('Fecha', d.date),
      d.note ? item('Nota', d.note) : null,
    ]),
    renderDisbProgress(d),
    el('div', { class: 'alloc-block' }, [
      el('div', { class: 'alloc-block-head' }, [
        el('h3', { text: 'Reparto del desembolso entre líneas' }),
        el('div', { class: 'alloc-block-actions' }, [
          allocs.length ? btn('🔀 Ajustar reparto', 'ghost', () => openTransferReparto(d)) : null,
          btn('+ Asignar a líneas', 'primary', () => openDistribution(d.id)),
        ]),
      ]),
      allocList,
    ]),
    renderMonthlySpend(d),
    renderTransferLog(d),
    renderReserveLog(d),
    el('div', { class: 'disb-detail-actions' }, [
      btn('+ Registrar gasto (saldo real)', 'primary', () => openExecution(null, d.id)),
      pb.total > 0 ? btn(`➡️ Pasar saldo al siguiente (${money(pb.total)})`, 'ghost', () => passBalanceToNext(d)) : null,
      btn('Editar desembolso', 'ghost', () => openEditDisbursement(d)),
      btn('Eliminar', 'ghost danger', () => deleteDisbursement(d)),
    ].filter(Boolean)),
  ]);
}

// Etiqueta legible de un mes "YYYY-MM".
function monthLabel(key) {
  const [y, m] = String(key).split('-');
  const idx = Number(m) - 1;
  return `${MONTH_NAMES[idx] || m} ${y}`;
}

// Cuánto se gastó en cada mes dentro de un desembolso.
function renderMonthlySpend(d) {
  const byMonth = {};
  for (const e of executionsFor(d.id)) {
    const k = monthKey(e.date);
    byMonth[k] = (byMonth[k] || 0) + e.amount;
  }
  const keys = Object.keys(byMonth).sort();
  const block = el('div', { class: 'alloc-block' }, [
    el('h3', { text: 'Gasto por mes' }),
  ]);
  if (keys.length === 0) {
    block.append(el('div', { class: 'empty-box', text: 'Todavía no registraste gastos en este desembolso.' }));
    return block;
  }
  const max = Math.max(...keys.map((k) => byMonth[k]));
  const list = el('div', { class: 'month-spend' });
  for (const k of keys) {
    const amt = byMonth[k];
    const w = max > 0 ? Math.max(3, (amt / max) * 100) : 0;
    list.append(el('div', { class: 'ms-row' }, [
      el('span', { class: 'ms-month', text: monthLabel(k) }),
      el('div', { class: 'ms-bar' }, [el('div', { class: 'ms-fill', style: `width:${w}%` })]),
      el('span', { class: 'ms-amt', text: money(amt) }),
    ]));
  }
  const total = keys.reduce((s, k) => s + byMonth[k], 0);
  block.append(list, el('div', { class: 'ms-total' }, [
    el('span', { text: 'Total gastado en el desembolso' }),
    el('span', { text: money(total) }),
  ]));
  return block;
}

// Registro de los ajustes de reparto (para poder explicarlos en cualquier momento).
function renderTransferLog(d) {
  const list = transfersFor(d.id);
  const block = el('div', { class: 'alloc-block' }, [
    el('h3', { text: 'Ajustes de reparto realizados' }),
  ]);
  if (list.length === 0) {
    block.append(el('div', { class: 'empty-box', text: 'Todavía no ajustaste el reparto de este desembolso.' }));
    return block;
  }
  const label = (l) => (l ? (l.code ? `[${l.code}] ` : '') + l.name : '?');
  const wrap = el('div', { class: 'transfer-log' });
  for (const t of list) {
    const from = byId[t.from_line_id];
    const to = byId[t.to_line_id];
    const fromDepth = from ? linePath(from).length - 1 : 0;
    const dt = new Date(Number(t.created_at) || 0);
    const dateText = Number.isFinite(dt.getTime()) && t.created_at
      ? dt.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';
    wrap.append(el('div', { class: 'tf-row' }, [
      el('div', { class: 'tf-head' }, [
        el('span', { class: 'tf-date', text: dateText }),
        el('span', { class: 'tf-move' }, [
          el('span', { class: 'tf-from', text: label(from) }),
          el('span', { class: 'tf-arrow', text: '→' }),
          el('span', { class: 'tf-to', text: label(to) }),
        ]),
        el('span', { class: 'tf-amt', text: money(t.amount) }),
        el('button', { class: 'm-del', text: 'x', title: 'Deshacer este ajuste y devolver el saldo', onClick: () => deleteTransfer(t) }),
      ]),
      el('div', { class: 'tf-tags' }, [
        el('span', {
          class: 'tf-tag',
          title: 'Línea de la que salió el dinero',
          text: `📌 Salió de: ${from ? linePathText(from) : '?'} (${lineLevelLabel(fromDepth)})`,
        }),
      ]),
      t.note ? el('div', { class: 'tf-note' }, [
        el('span', { class: 'tf-note-label', text: 'Nota: ' }),
        el('span', { text: t.note }),
      ]) : null,
    ]));
  }
  block.append(wrap);
  return block;
}

// Deshacer un ajuste de reparto: devuelve el saldo a la línea de origen.
function deleteTransfer(t) {
  const from = byId[t.from_line_id];
  const to = byId[t.to_line_id];
  openDeleteModal({
    title: 'Deshacer ajuste de reparto',
    message: `¿Deshacer este ajuste? Se devolverán ${money(t.amount)} a «${from ? from.name : '?'}» y se quitarán de «${to ? to.name : '?'}». Los gastos ya registrados no se tocan. Esta acción no se puede deshacer.`,
    onConfirm: async (password) => {
      await api(`/api/allocations/transfers/${t.id}`, { method: 'DELETE', body: { password } });
      await loadData();
      renderDashboard();
      toast('Ajuste deshecho — saldo devuelto a la línea de origen');
    },
  });
}

// Saldo de una línea dentro de un desembolso (asignado menos gastado directo).
function availableToMove(disbursementId, lineId) {
  return lineAllocated(lineId, disbursementId) - lineExecuted(lineId, disbursementId);
}

// Ajustar el reparto: mover dinero ya asignado de una línea a otra del mismo desembolso.
function openTransferReparto(d) {
  const seen = new Set();
  const fromOpts = [];
  for (const a of allocationsFor(d.id)) {
    if (seen.has(a.line_id)) continue;
    seen.add(a.line_id);
    const avail = availableToMove(d.id, a.line_id);
    if (avail <= 0) continue;
    const line = byId[a.line_id];
    const pathText = line ? linePathText(line) : '?';
    const level = line ? lineLevelLabel(linePath(line).length - 1) : '';
    fromOpts.push({ value: String(a.line_id), label: `${pathText} (${level}) — disponible ${money(avail)}` });
  }
  if (fromOpts.length === 0) {
    toast('Ninguna línea tiene saldo sin gastar para mover', true);
    return;
  }
  const withPlaceholder = (opts, label) => (opts.length > 1 ? [{ value: '', label }, ...opts] : opts);
  const toOpts = lineOptions();
  openModal({
    title: 'Ajustar reparto del desembolso',
    sub: `Mueve dinero asignado de una línea a otra dentro de «${d.name}». No cambia el total repartido. Solo puedes mover lo que la línea tiene sin gastar, y queda registrado de qué hijo/nieto salió.`,
    fields: [
      { name: 'from_line_id', label: 'Línea de origen (de dónde sale)', type: 'select', required: true, options: withPlaceholder(fromOpts, '— elige la línea de origen —') },
      { name: 'to_line_id', label: 'Línea de destino (a dónde entra)', type: 'select', required: true, options: withPlaceholder(toOpts, '— elige la línea de destino —') },
      { name: 'amount', label: 'Monto a mover', type: 'number', step: '0.01', min: '0', required: true, placeholder: '0.00' },
      { name: 'note', label: 'Nota con más detalle (opcional)', type: 'textarea', placeholder: 'Ej: se pasó a Becas porque la compra se hizo en marzo' },
    ],
    submitText: 'Mover dinero',
    onSubmit: async (v) => {
      const fromId = Number(v.from_line_id);
      const toId = Number(v.to_line_id);
      if (!fromId || !toId) throw new Error('Elige las dos líneas');
      if (fromId === toId) throw new Error('Elige dos líneas distintas');
      const amt = parseMoneyInput(v.amount);
      if (!(amt > 0)) throw new Error('Monto inválido');
      const avail = availableToMove(d.id, fromId);
      if (amt > avail + 1e-9) throw new Error(`Solo puedes mover hasta ${money(avail)} de esa línea`);
      await api('/api/allocations/transfer', {
        method: 'POST',
        body: { disbursement_id: d.id, from_line_id: fromId, to_line_id: toId, amount: amt, note: v.note },
      });
      await loadData();
      renderDashboard();
      toast('Reparto ajustado');
    },
  });
}

// Índice de avance general de un desembolso con su meta (editable).
function renderDisbProgress(d, compact = false) {
  const { exec, pct, target, base } = disbAvance(d);
  const clamped = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const meets = pct != null && pct >= target;
  const status = pct == null ? 'Sin ejecución' : (meets ? 'Cumple la meta' : `Falta ${Math.max(0, target - pct).toFixed(0)}%`);
  const bar = el('div', { class: 'dprog-bar' }, [
    pct != null ? el('div', { class: 'fill ' + pctColor(pct), style: `width:${clamped}%` }) : null,
    el('div', { class: 'dprog-target', style: `left:${Math.min(100, Math.max(0, target))}%`, title: `Meta ${target}%` }),
  ]);
  return el('div', { class: 'dprog' + (compact ? ' compact' : '') }, [
    el('div', { class: 'dprog-head' }, [
      el('span', { class: 'dprog-title', text: 'Avance general' }),
      el('span', { class: 'dprog-val', text: pct == null ? '—' : pct.toFixed(0) + '%' }),
      el('span', { class: 'dprog-meta', text: `meta ${target}%` }),
      el('span', { class: 'dprog-status ' + (meets ? 'ok' : 'no'), text: status }),
    ]),
    bar,
    compact ? null : el('div', { class: 'dprog-sub', text: `Ejecutado ${money(exec)} de ${money(base)} disponibles` }),
  ]);
}

// Registro de los saldos pasados al siguiente desembolso.
function renderReserveLog(d) {
  const moves = reserveMovesFor(d.id);
  if (moves.length === 0) return null;
  const block = el('div', { class: 'alloc-block' }, [
    el('h3', { text: 'Saldo pasado al siguiente desembolso' }),
  ]);
  const wrap = el('div', { class: 'transfer-log' });
  for (const m of moves) {
    const dt = new Date(Number(m.created_at) || 0);
    const dateText = Number.isFinite(dt.getTime()) && m.created_at
      ? dt.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';
    wrap.append(el('div', { class: 'tf-row' }, [
      el('div', { class: 'tf-head' }, [
        el('span', { class: 'tf-date', text: dateText }),
        el('span', { class: 'tf-move' }, [el('span', { class: 'tf-from', text: 'Saldo no gastado liberado y pasado al siguiente desembolso' })]),
        el('span', { class: 'tf-amt', text: money(m.amount) }),
      ]),
      m.note ? el('div', { class: 'tf-note' }, [
        el('span', { class: 'tf-note-label', text: 'Nota: ' }),
        el('span', { text: m.note }),
      ]) : null,
    ]));
  }
  block.append(wrap);
  return block;
}

// Pasar al siguiente desembolso todo lo que no se gastó (reserva + repartido sin gastar).
function passBalanceToNext(d) {
  const pb = pendingBalance(d);
  if (pb.total <= 1e-9) {
    toast('No hay saldo sin gastar para pasar', true);
    return;
  }
  const next = disbursementsOrdered()[disbursementsOrdered().findIndex((x) => x.id === d.id) + 1];
  openModal({
    title: 'Pasar saldo al siguiente desembolso',
    sub: `Se liberará ${money(pb.unspent)} de líneas (lo que repartiste y no gastaste). Sumado a ${money(pb.unallocated)} que no repartiste, quedarán ${money(pb.total)} disponibles para repartir en el siguiente desembolso.`,
    fields: [
      { name: 'note', label: 'Nota (opcional)', type: 'textarea', placeholder: 'Ej: sobró del primer desembolso' },
    ],
    submitText: 'Pasar saldo',
    onSubmit: async (v) => {
      const res = await api(`/api/disbursements/${d.id}/release-balance`, { method: 'POST', body: { note: v.note } });
      await loadData();
      if (next && byDisbursementId[next.id]) {
        state.nav = 'disbursements';
        state.selectedDisb = next.id;
        renderDashboard();
        toast(`Saldo disponible para repartir en «${next.name}»`);
        openDistribution(next.id);
      } else {
        renderDashboard();
        toast(`Saldo liberado (${money(res.released)}). Crea el siguiente desembolso para repartirlo.`);
        openNewDisbursement();
      }
    },
  });
}

function renderDashboardView(root) {
  const execs = filteredExecutions();
  const allocs = filteredAllocations();
  const tree = buildTree(execs, allocs);
  const { childrenMap, stats, rolled } = tree;
  const roots = childrenMap[null] || [];
  const totals = treeTotals(tree);
  const executed = execs.reduce((s, e) => s + e.amount, 0);
  const pct = totals.budget > 0 ? (executed / totals.budget) * 100 : null;
  const adjList = filteredAdjustments();
  const adjCount = adjList.length;
  const dlist = filteredDisbursements();
  const received = dlist.reduce((s, d) => s + (d.amount || 0), 0);
  const dIds = new Set(dlist.map((d) => d.id));
  const allocFiltered = state.allocations.filter((a) => dIds.has(a.disbursement_id)).reduce((s, a) => s + a.amount, 0);
  const reserve = received - allocFiltered;
  const orphanExec = execs.filter((e) => e.disbursement_id == null).reduce((s, e) => s + e.amount, 0);

  root.append(contentHeader('Dashboard General', 'Panorama del presupuesto y su ejecución.', [
    btn('+ Nueva línea', 'primary', () => openNewLine()),
    btn('+ Desembolso', 'ghost', () => openNewDisbursement()),
  ]));
  root.append(renderFilters());

  const cards = el('div', { class: 'cards' }, [
    statCard('Presupuesto vigente', money(totals.budget), `${adjCount} ajuste${adjCount === 1 ? '' : 's'} en el filtro`),
    statCard('Ejecutado', money(executed), `${execs.length} movimiento${execs.length === 1 ? '' : 's'} en el filtro`),
    statCard('Disponible', money(totals.budget - executed), totals.budget - executed < 0 ? 'Presupuesto superado' : 'Saldo por ejecutar'),
    statCard('Recibido (desembolsos)', money(received), `${dlist.length} desembolso${dlist.length === 1 ? '' : 's'}${orphanExec ? ' · ' + money(orphanExec) + ' sin desembolso' : ''}`),
    statCard('Reserva', money(reserve), `${money(allocFiltered)} asignado a líneas`),
    pctCard(pct),
  ]);
  root.append(cards);

  const chartPanel = el('div', { class: 'panel chart-panel' }, [el('h2', { text: 'Ejecución mensual' })]);
  renderMonthlyChart(chartPanel, totals, execs, adjList);
  const piePanel = el('div', { class: 'panel chart-panel' });
  renderPieChart(piePanel, execs);
  root.append(el('div', { class: 'charts-row' }, [chartPanel, piePanel]));

  const treePanel = el('div', { class: 'panel' }, [
    el('h2', { text: 'Líneas de presupuesto' }),
    el('div', { class: 'panel-sub', text: '«Presupuesto» es el plan. «Asignado» y «Ejecutado» responden a los filtros de arriba.' }),
  ]);
  if (roots.length === 0) {
    treePanel.append(el('div', { class: 'empty-box' }, [
      el('span', { text: 'Todavía no hay líneas de presupuesto.' }),
      btn('+ Crear primera línea', 'primary', () => openNewLine()),
    ]));
  } else {
    const headCells = [
      el('div', { text: 'Línea' }),
      el('div', { class: 'tnum', text: 'Presupuesto' }),
      el('div', { class: 'tnum alloc', text: 'Asignado' }),
      el('div', { class: 'tnum exec', text: 'Ejecutado' }),
      el('div', { class: 'tnum', text: 'Disponible' }),
      el('div', { class: 'tpct', text: 'Avance' }),
      el('div', { class: 'tacts', text: 'Acciones' }),
    ];
    const treeScroll = el('div', { class: 'ttree mode-alloc' }, [el('div', { class: 'trow trow-head' }, headCells)]);
    const treeRoot = el('div', { class: 'ttree-inner' });
    renderTree(childrenMap, rolled, stats, roots.map((l) => l.id), 0, treeRoot, undefined, { showAlloc: true });
    treeScroll.append(treeRoot);
    treePanel.append(treeScroll);
  }

  const activityPanel = el('div', { class: 'panel' }, [el('h2', { text: 'Actividad reciente' })]);
  const movs = [
    ...execs.map((e) => ({ ...e, kind: 'exec' })),
    ...adjList.map((a) => ({ ...a, kind: 'adj' })),
  ].sort((a, b) => (a.date === b.date ? b.created_at - a.created_at : b.date.localeCompare(a.date))).slice(0, 25);

  const actList = el('div', { class: 'activity' });
  if (movs.length === 0) {
    actList.append(el('div', { class: 'empty-box', text: 'Sin movimientos para este filtro.' }));
  } else {
    for (const m of movs) {
      const line = byId[m.line_id];
      const movDisb = m.kind === 'exec' && m.disbursement_id != null ? byDisbursementId[m.disbursement_id] : null;
      const label = m.kind === 'exec' ? 'Saldo real' : 'Ajuste';
      const amtClass = m.kind === 'exec' ? 'exec' : (m.amount >= 0 ? 'pos' : 'neg');
      const amtText = m.kind === 'exec' ? money(m.amount) : (m.amount >= 0 ? '+' : '') + money(m.amount);
      actList.append(el('div', { class: 'mov' }, [
        el('div', { class: 'm-date', text: m.date }),
        el('div', { class: 'm-main' }, [
          el('div', { class: 'm-title' }, [
            el('span', { text: `${line ? line.name : '?'} · ${label}` }),
            m.kind === 'exec' ? el('span', {
              class: 'disb-badge' + (movDisb ? '' : ' muted'),
              text: movDisb ? movDisb.name : 'Sin desembolso',
            }) : null,
          ]),
          m.note ? el('div', { class: 'm-note', text: m.note }) : null,
        ]),
        el('span', { class: `m-amt ${amtClass}`, text: amtText }),
        el('button', { class: 'm-del', text: 'x', title: 'Eliminar', onClick: () => deleteMovement(m) }),
      ]));
    }
  }
  activityPanel.append(actList);

  root.append(el('div', { class: 'main' }, [treePanel, activityPanel]));
}

function renderTree(childrenMap, rolled, stats, ids, depth, root, parentNum, opts = {}) {
  const { disbursementId = null, globalRolled = null, showAlloc = false, showGlobal = false } = opts;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const line = byId[id];
    const r = rolled[id];
    const ra = showGlobal && globalRolled ? (globalRolled[id] || r) : null;
    const s = stats[id];
    const kids = childrenMap[id] || [];
    const pct = r.budget > 0 ? (r.exec / r.budget) * 100 : null;
    const hasOwnMov = s.ownExecCount + s.ownAdj > 0;
    const hasDescMov = r.execCount + r.adjCount > s.ownExecCount + s.ownAdj;
    const isLast = i === ids.length - 1;

    const expandBtn = el('button', {
      class: 'tbtn' + (collapsed.has(id) ? ' collapsed' : ''),
      text: kids.length ? (collapsed.has(id) ? '›' : '▼') : '',
      onClick: () => {
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        renderDashboard();
      },
      title: kids.length ? (collapsed.has(id) ? 'Expandir' : 'Colapsar') : '',
    });
    if (!kids.length) expandBtn.classList.add('empty');

    const indent = depth * 18;
    const num = parentNum ? parentNum + '.' + (i + 1) : String(i + 1);
    const levelLabel = line.code || num;
    const depthClass = 'depth-' + Math.min(depth, 5);
    const isComplete = pct != null && pct >= 100;
    const rowClass = 'trow' + (isComplete ? ' row-complete' : '');
    const defRolled = ra || r;
    const ownAlloc = s.ownAlloc > 0;
    const cells = [
      el('div', { class: 'tname', style: `padding-left:${indent + 4}px` }, [
        expandBtn,
        el('span', { class: 'tlevel ' + depthClass, text: levelLabel }),
        el('span', { class: 'tlabel', text: line.name, title: line.name }),
        hasOwnMov ? el('button', { class: 'chg-badge', text: '!', title: 'Esta línea tiene movimientos — ver historial', onClick: () => openLineHistory(id) }) : null,
        hasDescMov && !hasOwnMov ? el('span', { class: 'desc-badge', title: 'Hijos/nietos tienen movimientos', text: '●' }) : null,
      ]),
      el('div', { class: 'tnum', text: money(r.budget) }),
    ];
    if (showAlloc) cells.push(el('div', { class: 'tnum alloc' + (ownAlloc ? ' has-alloc' : ''), text: money(r.alloc) }));
    cells.push(el('div', { class: 'tnum exec', text: money(r.exec) }));
    if (showGlobal) cells.push(el('div', { class: 'tnum', text: money(ra ? ra.exec : r.exec) }));
    cells.push(el('div', { class: 'tnum', text: money(defRolled.budget - defRolled.exec) }));
    cells.push(el('div', { class: 'tpct' }, [
      el('div', { class: 'pctbar' }, [
        pct != null ? el('div', { class: 'fill ' + pctColor(pct), style: `width:${Math.min(100, pct)}%` }) : null,
      ]),
      el('span', { class: 'pctlabel', text: pct == null ? '—' : pct.toFixed(0) + '%' }),
    ]));
    cells.push(el('div', { class: 'tacts' }, [
      (hasOwnMov || hasDescMov) ? btn('Historial', '', () => openLineHistory(id), { class: 'act-btn' }) : null,
      btn('+ hijo', '', () => openNewLine(id), { class: 'act-btn' }),
      disbursementId != null ? btn('Asignar', '', () => openDistribution(disbursementId, id), { class: 'act-btn' }) : null,
      btn('Saldo', '', () => openExecution(id, disbursementId), { class: 'act-btn' }),
      btn('Ajuste', '', () => openAdjustment(id), { class: 'act-btn' }),
      btn('Editar', '', () => openEditLine(id), { class: 'act-btn' }),
      btn('Eliminar', 'danger', () => deleteLine(line), { class: 'act-btn danger' }),
    ]));
    const row = el('div', { class: rowClass, style: `--depth:${depth}; --is-last:${isLast ? 1 : 0}` }, cells);

    const container = el('div', { class: 'tnode', style: `--depth:${depth}; --is-last:${isLast ? 1 : 0}` });
    container.append(row);
    if (kids.length) {
      const wrap = el('div', { class: 'tchildren', style: collapsed.has(id) ? 'display:none' : '' });
      renderTree(childrenMap, rolled, stats, kids.map((k) => k.id), depth + 1, wrap, num, opts);
      container.append(wrap);
    }
    root.append(container);
  }
}

function openModal({ title, sub, fields, submitText = 'Guardar', onSubmit }) {
  closeModal();
  const overlay = el('div', { class: 'overlay' });
  const form = el('form', { class: 'modal-form' });
  const errBox = el('div', { class: 'form-error', style: 'display:none' });
  const inputs = {};

  for (const f of fields) {
    form.append(el('label', { text: f.label + (f.required ? ' *' : '') }));
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.name, required: f.required || false });
      for (const o of f.options || []) {
        input.append(el('option', { value: o.value, text: o.label }));
      }
      if (f.value != null) input.value = f.value;
    } else if (f.type === 'textarea') {
      input = el('textarea', { name: f.name, required: f.required || false, rows: '2' });
      if (f.value != null) input.value = f.value;
    } else if (f.type === 'checkbox') {
      input = el('input', {
        type: 'checkbox',
        name: f.name,
        required: f.required || false,
        checked: f.value === true || f.value === 'on',
      });
    } else {
      input = el('input', {
        type: f.type || 'text',
        name: f.name,
        required: f.required || false,
        step: f.step || undefined,
        placeholder: f.placeholder || '',
        value: f.value != null ? f.value : '',
        min: f.min != null ? f.min : undefined,
      });
    }
    inputs[f.name] = input;
    form.append(input);
  }

  const actions = el('div', { class: 'modal-actions' }, [
    btn('Cancelar', 'ghost', closeModal),
    btn(submitText, 'primary', null, { type: 'submit' }),
  ]);
  form.append(errBox, actions);

  const box = el('div', { class: 'modal' }, [
    el('h2', { class: 'modal-title', text: title }),
    sub ? el('div', { class: 'modal-sub', text: sub }) : null,
    form,
  ]);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  $('#modal-root').append(overlay);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const input = inputs[f.name];
      values[f.name] = f.type === 'checkbox' ? input.checked : input.value;
    }
    try {
      await onSubmit(values);
      closeModal();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = '';
    }
  });

  const first = form.querySelector('input:not([type=hidden]), select');
  if (first) first.focus();
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openInfoModal({ title, sub, content, wide }) {
  closeModal();
  const overlay = el('div', { class: 'overlay' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') }, [
    el('h2', { class: 'modal-title', text: title }),
    sub ? el('div', { class: 'modal-sub', text: sub }) : null,
    ...content,
    el('div', { class: 'modal-actions' }, [btn('Cerrar', 'primary', closeModal)]),
  ]);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  $('#modal-root').append(overlay);
}

function openLineHistory(lineId) {
  const line = byId[lineId];
  if (!line) return;
  const { childrenMap, rolled } = buildTree();
  const r = rolled[lineId] || { budget: 0, exec: 0 };
  const ids = [lineId];
  (function collect(id) {
    for (const c of childrenMap[id] || []) {
      ids.push(c.id);
      collect(c.id);
    }
  })(lineId);

  const movs = [];
  for (const id of ids) {
    const l = byId[id];
    if (!l) continue;
    for (const e of state.executions) {
      if (e.line_id === id) movs.push({ ...e, kind: 'exec', lineName: l.name });
    }
    for (const a of state.adjustments) {
      if (a.line_id === id) movs.push({ ...a, kind: 'adj', lineName: l.name });
    }
  }
  movs.sort((a, b) => (a.date === b.date ? b.created_at - a.created_at : b.date.localeCompare(a.date)));

  const pct = r.budget > 0 ? (r.exec / r.budget) * 100 : null;
  const list = el('div', { class: 'hlist' });
  if (movs.length === 0) {
    list.append(el('div', { class: 'empty-box', text: 'Sin movimientos registrados en esta línea.' }));
  }
  for (const m of movs) {
    const isChild = m.line_id !== lineId;
    const movDisb = m.kind === 'exec' && m.disbursement_id != null ? byDisbursementId[m.disbursement_id] : null;
    const label = m.kind === 'exec' ? 'Saldo real' : 'Ajuste';
    const amtClass = m.kind === 'exec' ? 'exec' : (m.amount >= 0 ? 'pos' : 'neg');
    const amtText = m.kind === 'exec' ? money(m.amount) : (m.amount >= 0 ? '+' : '−') + money(Math.abs(m.amount));
    list.append(el('div', { class: 'hrow' }, [
      el('div', { class: 'hmain' }, [
        el('div', {}, [
          el('span', { class: 'hkind ' + m.kind, text: label }),
          el('span', { class: 'hdate', text: m.date }),
          isChild ? el('span', { class: 'hline', text: '· ' + m.lineName }) : null,
          m.kind === 'exec' ? el('span', { class: 'disb-badge' + (movDisb ? '' : ' muted'), text: movDisb ? movDisb.name : 'Sin desembolso' }) : null,
        ]),
        m.note ? el('div', { class: 'hnote', text: 'Motivo: ' + m.note }) : null,
      ]),
      el('span', { class: 'hamt ' + amtClass, text: amtText }),
      el('button', { class: 'm-del', text: 'x', title: 'Eliminar', onClick: () => { closeModal(); deleteMovement(m); } }),
    ]));
  }

  openInfoModal({
    title: 'Historial · ' + (line.code ? `[${line.code}] ` : '') + line.name,
    sub: `${money(r.budget)} vigente · ${money(r.exec)} ejecutado${pct != null ? ' (' + pct.toFixed(1) + '%)' : ''} · ${money(r.budget - r.exec)} disponible · ${movs.length} movimiento${movs.length === 1 ? '' : 's'}`,
    content: [list],
    wide: true,
  });
}

function openNewLine(parentId = null) {
  const fields = [
    { name: 'code', label: 'Código (ej: A, A1, B2...)', required: false, placeholder: 'Opcional, se sugiere automáticamente' },
    { name: 'name', label: 'Nombre de la línea', required: true, placeholder: 'Ej: Gastos de personal' },
    { name: 'amount', label: 'Monto del presupuesto', type: 'number', step: '0.01', required: true, value: '0' },
    { name: 'parent_id', label: 'Línea padre', type: 'select', options: [{ value: '', label: '— sin padre (línea raíz) —' }, ...lineOptions()], value: parentId != null ? String(parentId) : '' },
  ];
  openModal({
    title: parentId ? 'Nueva línea hija' : 'Nueva línea de presupuesto',
    fields,
    submitText: 'Guardar línea',
    onSubmit: async (v) => {
      await api('/api/lines', {
        method: 'POST',
        body: { name: v.name, amount: v.amount, parent_id: v.parent_id ? Number(v.parent_id) : null, code: v.code },
      });
      await loadData();
      renderDashboard();
      toast('Línea creada');
    },
  });
}

function disbursementOptions() {
  return [
    { value: '', label: '— Sin desembolso —' },
    ...state.disbursements.map((d) => ({ value: String(d.id), label: `${d.name} · ${money(d.amount)} · ${d.date}` })),
  ];
}

function openExecution(lineId = null, disbursementId = null) {
  const presetDisb = disbursementId != null ? disbursementId : (state.filters.disbursement === 'all' ? null : Number(state.filters.disbursement));
  const lineChoices = presetDisb != null ? allocatedLineOptions(presetDisb) : lineOptions();
  openModal({
    title: 'Registrar gasto real',
    sub: presetDisb != null
      ? 'Solo aparecen las líneas con dinero asignado en este desembolso. El gasto se carga contra ese saldo.'
      : 'Monto efectivamente ejecutado (gasto) sobre la línea, dentro del desembolso indicado.',
    fields: [
      { name: 'disbursement_id', label: 'Desembolso', type: 'select', options: disbursementOptions(), value: presetDisb != null ? String(presetDisb) : '' },
      { name: 'line_id', label: 'Línea', type: 'select', options: lineChoices, required: true, value: lineId != null ? String(lineId) : '' },
      { name: 'date', label: 'Fecha', type: 'date', required: true, value: today() },
      { name: 'amount', label: 'Monto ejecutado', type: 'number', step: '0.01', required: true, min: '0' },
      { name: 'note', label: 'Nota (opcional)', type: 'text', placeholder: 'Ej: comprobante 123' },
    ],
    submitText: 'Registrar',
    onSubmit: async (v) => {
      if (v.disbursement_id) {
        const alloc = lineAllocated(Number(v.line_id), Number(v.disbursement_id));
        if (alloc <= 0) throw new Error('Esa línea no tiene dinero asignado en este desembolso. Primero asígnalo con «Asignar a líneas».');
      }
      await api('/api/executions', {
        method: 'POST',
        body: { line_id: v.line_id, date: v.date, amount: v.amount, note: v.note, disbursement_id: v.disbursement_id || null },
      });
      await loadData();
      renderDashboard();
      toast('Gasto real registrado');
    },
  });
}

function parseMoneyInput(value) {
  if (typeof value === 'string') value = value.replace(',', '.');
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Reparte el dinero de un desembolso entre líneas (padres, hijos o nietos).
function openDistribution(disbursementId, presetLineId = null) {
  const disb = byDisbursementId[disbursementId];
  if (!disb) return;
  const reserve = reserveBefore(disbursementId);
  const available = (disb.amount || 0) + reserve;
  const alreadyAllocated = disbursementAllocated(disbursementId);
  const remaining = available - alreadyAllocated;
  const options = lineOptions();

  closeModal();
  const overlay = el('div', { class: 'overlay' });
  const rowsWrap = el('div', { class: 'alloc-rows' });
  const summary = el('div', { class: 'alloc-summary' });
  const errBox = el('div', { class: 'form-error', style: 'display:none' });

  function currentRows() {
    return $$('.alloc-edit-row', rowsWrap)
      .map((row) => ({ line_id: row.querySelector('.alloc-line').value, amount: parseMoneyInput(row.querySelector('.alloc-amount').value) }))
      .filter((r) => r.line_id && r.amount);
  }

  function refresh() {
    const sum = $$('.alloc-edit-row', rowsWrap)
      .reduce((s, row) => s + parseMoneyInput(row.querySelector('.alloc-amount').value), 0);
    const left = remaining - sum;
    summary.innerHTML = '';
    summary.append(
      el('span', {}, [el('span', { class: 'alloc-sum-k', text: 'Disponible: ' }), el('span', { class: 'alloc-sum-v', text: money(available) })]),
      el('span', {}, [el('span', { class: 'alloc-sum-k', text: 'Ya asignado: ' }), el('span', { class: 'alloc-sum-v', text: money(alreadyAllocated) })]),
      el('span', {}, [el('span', { class: 'alloc-sum-k', text: 'Nuevo reparto: ' }), el('span', { class: 'alloc-sum-v', text: money(sum) })]),
      el('span', { class: 'alloc-sum-rest' + (left < 0 ? ' neg' : '') }, [
        el('span', { class: 'alloc-sum-k', text: 'Te queda: ' }), el('span', { class: 'alloc-sum-v', text: money(left) }),
      ]),
    );
  }

  function addRow(lineId = '', amount = '') {
    const select = el('select', { class: 'alloc-line' });
    select.append(el('option', { value: '', text: '— elige una línea —' }));
    for (const o of options) select.append(el('option', { value: o.value, text: o.label }));
    if (lineId) select.value = String(lineId);
    const amountInput = el('input', { class: 'alloc-amount', type: 'number', step: '0.01', min: '0', placeholder: '0.00', value: amount });
    amountInput.addEventListener('input', refresh);
    select.addEventListener('change', refresh);
    const row = el('div', { class: 'alloc-edit-row' }, [
      select,
      amountInput,
      el('button', { class: 'm-del', text: 'x', type: 'button', title: 'Quitar', onClick: () => { row.remove(); refresh(); } }),
    ]);
    rowsWrap.append(row);
    refresh();
  }

  const form = el('form', { class: 'alloc-form' }, [
    el('div', { class: 'alloc-note', text: `Reparte ${money(available)} de «${disb.name}»${reserve > 0 ? ` (incluye ${money(reserve)} de reserva anterior)` : ''} entre las líneas que quieras.` }),
    el('div', { class: 'alloc-edit-row alloc-edit-head' }, [
      el('div', { text: 'Línea' }), el('div', { text: 'Monto a asignar' }), el('div', { text: '' }),
    ]),
    rowsWrap,
    el('button', { class: 'add-alloc-row', text: '+ Agregar otra línea', type: 'button', onClick: () => addRow() }),
    summary,
  ]);
  form.append(errBox, el('div', { class: 'modal-actions' }, [
    btn('Cancelar', 'ghost', closeModal),
    btn('Guardar reparto', 'primary', null, { type: 'submit' }),
  ]));

  const box = el('div', { class: 'modal wide' }, [
    el('h2', { class: 'modal-title', text: 'Repartir desembolso entre líneas' }),
    form,
  ]);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  $('#modal-root').append(overlay);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = currentRows();
    if (rows.length === 0) { closeModal(); return; }
    try {
      for (const r of rows) {
        await api('/api/allocations', {
          method: 'POST',
          body: { disbursement_id: disbursementId, line_id: Number(r.line_id), amount: r.amount },
        });
      }
      await loadData();
      renderDashboard();
      toast('Reparto guardado');
      closeModal();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = '';
    }
  });

  addRow(presetLineId, '');
}

function openEditAllocation(a) {
  const line = byId[a.line_id];
  const disb = byDisbursementId[a.disbursement_id];
  openModal({
    title: 'Editar asignación',
    sub: `${line ? line.name : '?'} · ${disb ? disb.name : ''}`,
    fields: [
      { name: 'amount', label: 'Monto asignado', type: 'number', step: '0.01', required: true, value: String(a.amount) },
    ],
    submitText: 'Guardar',
    onSubmit: async (v) => {
      await api(`/api/allocations/${a.id}`, { method: 'PUT', body: { amount: v.amount } });
      await loadData();
      renderDashboard();
      toast('Asignación actualizada');
    },
  });
}

function deleteAllocation(a) {
  const line = byId[a.line_id];
  openDeleteModal({
    title: 'Eliminar asignación',
    message: `¿Quitar el dinero asignado a "${line ? line.name : '?'}" en este desembolso? Los gastos ya registrados no se borran.`,
    onConfirm: async (password) => {
      await api(`/api/allocations/${a.id}`, { method: 'DELETE', body: { password } });
      await loadData();
      renderDashboard();
      toast('Asignación eliminada');
    },
  });
}

function openNewDisbursement() {
  openModal({
    title: 'Nuevo desembolso',
    sub: 'Registra el monto que te transfirieron. Al guardarlo te pedirá a qué líneas repartir ese dinero.',
    fields: [
      { name: 'name', label: 'Nombre del desembolso', required: true, value: autoDisbursementName(), placeholder: 'Ej: Primer desembolso' },
      { name: 'date', label: 'Fecha', type: 'date', required: true, value: today() },
      { name: 'amount', label: 'Monto recibido', type: 'number', step: '0.01', required: true, min: '0' },
      { name: 'target_pct', label: 'Meta de ejecución (%)', type: 'number', step: '1', min: '0', value: '80', placeholder: '80' },
      { name: 'note', label: 'Nota (opcional)', type: 'text', placeholder: 'Ej: transferencia banco / convenio' },
    ],
    submitText: 'Crear y repartir',
    onSubmit: async (v) => {
      const res = await api('/api/disbursements', { method: 'POST', body: v });
      await loadData();
      state.nav = 'disbursements';
      state.selectedDisb = res.id;
      renderDashboard();
      toast('Desembolso creado — reparte el dinero entre líneas');
      openDistribution(res.id);
    },
  });
}

function openEditDisbursement(disb) {
  openModal({
    title: 'Editar desembolso',
    sub: 'Corrige el nombre, la fecha o el monto recibido.',
    fields: [
      { name: 'name', label: 'Nombre del desembolso', required: true, value: disb.name },
      { name: 'date', label: 'Fecha', type: 'date', required: true, value: disb.date },
      { name: 'amount', label: 'Monto recibido', type: 'number', step: '0.01', required: true, min: '0', value: String(disb.amount) },
      { name: 'target_pct', label: 'Meta de ejecución (%)', type: 'number', step: '1', min: '0', value: String(disb.target_pct != null ? disb.target_pct : 80) },
      { name: 'note', label: 'Nota (opcional)', type: 'text', value: disb.note || '' },
    ],
    submitText: 'Guardar cambios',
    onSubmit: async (v) => {
      await api(`/api/disbursements/${disb.id}`, { method: 'PUT', body: v });
      await loadData();
      renderDashboard();
      toast('Desembolso actualizado');
    },
  });
}

function deleteDisbursement(disb) {
  openDeleteModal({
    title: 'Eliminar desembolso',
    message: `¿Eliminar "${disb.name}", su reparto entre líneas y todos los gastos reales cargados en él? El presupuesto y sus líneas no se tocan. Esta acción no se puede deshacer.`,
    onConfirm: async (password) => {
      await api(`/api/disbursements/${disb.id}`, { method: 'DELETE', body: { password } });
      if (state.selectedDisb === disb.id) state.selectedDisb = null;
      if (state.filters.disbursement === String(disb.id)) state.filters.disbursement = 'all';
      await loadData();
      renderDashboard();
      toast('Desembolso eliminado');
    },
  });
}

function openAdjustment(lineId = null) {
  openModal({
    title: 'Crear ajuste de presupuesto',
    sub: 'Ajusta el presupuesto de una línea. Opcionalmente transfiere monto a otra línea.',
    fields: [
      { name: 'line_id', label: 'Línea origen', type: 'select', options: lineOptions(), required: true, value: lineId != null ? String(lineId) : '' },
      { name: 'date', label: 'Fecha del ajuste', type: 'date', required: true, value: today() },
      { name: 'amount', label: 'Monto a transferir (+/-)', type: 'number', step: '0.01', required: true, placeholder: 'Ej: 836 o -2000' },
      { name: 'dest_line_id', label: 'Transferir a línea destino (opcional)', type: 'select', options: [{ value: '', label: '— No transferir, solo ajustar —' }, ...lineOptions(lineId)] },
      { name: 'note', label: 'Motivo (opcional)', type: 'text', placeholder: 'Ej: redistribución de presupuesto' },
    ],
    submitText: 'Guardar ajuste',
    onSubmit: async (v) => {
      await api('/api/adjustments', {
        method: 'POST',
        body: { line_id: v.line_id, date: v.date, amount: v.amount, note: v.note, dest_line_id: v.dest_line_id || null },
      });
      await loadData();
      renderDashboard();
      toast(v.dest_line_id ? 'Ajuste y transferencia guardados (se anulan juntos)' : 'Ajuste guardado');
    },
  });
}

function openEditLine(lineId) {
  const line = byId[lineId];
  if (!line) return;
  openModal({
    title: 'Editar línea',
    sub: 'Corrige el código, nombre, monto base o la línea padre.',
    fields: [
      { name: 'code', label: 'Código (ej: A, A1, B2...)', required: false, placeholder: 'Opcional', value: line.code || '' },
      { name: 'name', label: 'Nombre de la línea', required: true, value: line.name },
      { name: 'amount', label: 'Monto del presupuesto', type: 'number', step: '0.01', required: true, value: String(line.amount) },
      { name: 'parent_id', label: 'Línea padre', type: 'select', options: [{ value: '', label: '— sin padre (línea raíz) —' }, ...lineOptions(line.id)], value: line.parent_id != null ? String(line.parent_id) : '' },
    ],
    submitText: 'Guardar cambios',
    onSubmit: async (v) => {
      await api(`/api/lines/${line.id}`, { method: 'PUT', body: { name: v.name, amount: v.amount, parent_id: v.parent_id ? Number(v.parent_id) : null, code: v.code } });
      await loadData();
      renderDashboard();
      toast('Línea actualizada');
    },
  });
}

function openDeleteModal({ title, message, onConfirm }) {
  openModal({
    title,
    sub: message,
    fields: [
      { name: 'password', label: 'Contraseña para confirmar', type: 'password', required: true },
    ],
    submitText: 'Eliminar definitivamente',
    onSubmit: async (v) => { await onConfirm(v.password); },
  });
}

function deleteLine(line) {
  openDeleteModal({
    title: 'Eliminar línea',
    message: `¿Eliminar la línea "${line.name}" junto con sus hijas, saldos, ajustes y asignaciones de desembolso? Esta acción no se puede deshacer.`,
    onConfirm: async (password) => {
      await api(`/api/lines/${line.id}`, { method: 'DELETE', body: { password } });
      await loadData();
      renderDashboard();
      toast('Línea eliminada');
    },
  });
}

function deleteMovement(m) {
  const linked = m.kind === 'adj' && m.link_id != null;
  openDeleteModal({
    title: 'Eliminar movimiento',
    message: linked
      ? '¿Eliminar este ajuste de transferencia? Se borrarán los DOS ajustes (origen y destino) y el presupuesto volverá a como estaba antes. Esta acción no se puede deshacer.'
      : '¿Eliminar este movimiento? Esta acción no se puede deshacer.',
    onConfirm: async (password) => {
      await api(`/api/${m.kind === 'exec' ? 'executions' : 'adjustments'}/${m.id}`, { method: 'DELETE', body: { password } });
      await loadData();
      renderDashboard();
      toast('Movimiento eliminado');
    },
  });
}

function exportExcel() {
  const wb = XLSX.utils.book_new();

  const lineData = state.lines.map(l => ({
    'Código': l.code || '',
    'Nombre': l.name,
    'Monto': l.amount,
    'Padre': l.parent_id ? (byId[l.parent_id]?.code || String(l.parent_id)) : '',
  }));
  const wsLines = XLSX.utils.json_to_sheet(lineData.length ? lineData : [{ 'Código': '', 'Nombre': '', 'Monto': 0, 'Padre': '' }]);
  XLSX.utils.book_append_sheet(wb, wsLines, 'Líneas');

  const disbData = state.disbursements.map(d => ({
    'Nombre': d.name,
    'Fecha': d.date,
    'Monto recibido': d.amount,
    'Meta (%)': d.target_pct != null ? Number(d.target_pct) : 80,
    'Nota': d.note || '',
  }));
  const wsDisb = XLSX.utils.json_to_sheet(disbData.length ? disbData : [{ 'Nombre': '', 'Fecha': '', 'Monto recibido': 0, 'Meta (%)': 80, 'Nota': '' }]);
  XLSX.utils.book_append_sheet(wb, wsDisb, 'Desembolsos');

  const execData = state.executions.map(e => {
    const line = byId[e.line_id];
    const disb = e.disbursement_id != null ? byDisbursementId[e.disbursement_id] : null;
    return {
      'Código línea': line?.code || '',
      'Nombre línea': line?.name || '',
      'Desembolso': disb?.name || '',
      'Fecha': e.date,
      'Monto': e.amount,
      'Nota': e.note || '',
    };
  });
  const wsExec = XLSX.utils.json_to_sheet(execData.length ? execData : [{ 'Código línea': '', 'Nombre línea': '', 'Desembolso': '', 'Fecha': '', 'Monto': 0, 'Nota': '' }]);
  XLSX.utils.book_append_sheet(wb, wsExec, 'Saldos reales');

  const adjData = state.adjustments.map(a => {
    const line = byId[a.line_id];
    return {
      'Código línea': line?.code || '',
      'Nombre línea': line?.name || '',
      'Fecha': a.date,
      'Monto': a.amount,
      'Nota': a.note || '',
    };
  });
  const wsAdj = XLSX.utils.json_to_sheet(adjData.length ? adjData : [{ 'Código línea': '', 'Nombre línea': '', 'Fecha': '', 'Monto': 0, 'Nota': '' }]);
  XLSX.utils.book_append_sheet(wb, wsAdj, 'Ajustes');

  const allocData = state.allocations.map(a => {
    const line = byId[a.line_id];
    const disb = byDisbursementId[a.disbursement_id];
    return {
      'Desembolso': disb?.name || '',
      'Código línea': line?.code || '',
      'Nombre línea': line?.name || '',
      'Monto asignado': a.amount,
    };
  });
  const wsAlloc = XLSX.utils.json_to_sheet(allocData.length ? allocData : [{ 'Desembolso': '', 'Código línea': '', 'Nombre línea': '', 'Monto asignado': 0 }]);
  XLSX.utils.book_append_sheet(wb, wsAlloc, 'Asignaciones');

  const transferData = state.transfers.map((t) => {
    const disb = byDisbursementId[t.disbursement_id];
    const from = byId[t.from_line_id];
    const to = byId[t.to_line_id];
    const label = (l) => (l ? (l.code ? l.code + ' - ' : '') + l.name : '');
    const dt = t.created_at ? new Date(Number(t.created_at)).toLocaleDateString('es') : '';
    return {
      'Desembolso': disb?.name || '',
      'Fecha': dt,
      'Desde': label(from),
      'Hacia': label(to),
      'Monto': t.amount,
      'Nota': t.note || '',
    };
  });
  const wsTransfer = XLSX.utils.json_to_sheet(transferData.length ? transferData : [{ 'Desembolso': '', 'Fecha': '', 'Desde': '', 'Hacia': '', 'Monto': 0, 'Nota': '' }]);
  XLSX.utils.book_append_sheet(wb, wsTransfer, 'Traslados');

  const reserveData = (state.reserveMoves || []).map((m) => {
    const disb = byDisbursementId[m.disbursement_id];
    const dt = m.created_at ? new Date(Number(m.created_at)).toLocaleDateString('es') : '';
    return {
      'Desembolso': disb?.name || '',
      'Fecha': dt,
      'Monto liberado': m.amount,
      'Nota': m.note || '',
    };
  });
  const wsReserve = XLSX.utils.json_to_sheet(reserveData.length ? reserveData : [{ 'Desembolso': '', 'Fecha': '', 'Monto liberado': 0, 'Nota': '' }]);
  XLSX.utils.book_append_sheet(wb, wsReserve, 'Saldos trasladados');

  const date = today();
  XLSX.writeFile(wb, `presupuesto_${date}.xlsx`);
  toast('Archivo exportado');
}

function importExcel() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const result = { lines: 0, disbursements: 0, executions: 0, adjustments: 0, allocations: 0, errors: [] };

      const linesSheet = wb.Sheets['Líneas'];
      if (linesSheet) {
        const rows = XLSX.utils.sheet_to_json(linesSheet);
        let pending = rows.filter(row => String(row['Nombre'] || '').trim());
        let maxPasses = 5;
        while (pending.length > 0 && maxPasses-- > 0) {
          const remaining = [];
          for (const row of pending) {
            const code = String(row['Código'] || '').trim().toUpperCase();
            const name = String(row['Nombre'] || '').trim();
            const amount = Number(row['Monto']) || 0;
            const parentCode = String(row['Padre'] || '').trim().toUpperCase();
            const body = { name, amount, code: code || null, parent_id: null };
            if (parentCode) {
              const parent = state.lines.find(l => l.code && l.code.toUpperCase() === parentCode);
              if (parent) body.parent_id = parent.id;
              else { remaining.push(row); continue; }
            }
            const res = await api('/api/lines', { method: 'POST', body });
            state.lines.push({ id: res.id, user_id: state.user.id, code: code || null, name, amount, parent_id: body.parent_id, created_at: Date.now() });
            result.lines++;
          }
          pending = remaining;
        }
        for (const row of pending) {
          result.errors.push(`No se pudo importar "${row['Nombre']}" — padre no encontrado`);
        }
      }

      await loadData();

      const disbSheet = wb.Sheets['Desembolsos'];
      if (disbSheet) {
        const rows = XLSX.utils.sheet_to_json(disbSheet);
        for (const row of rows) {
          const name = String(row['Nombre'] || '').trim();
          const date = String(row['Fecha'] || '').trim();
          const amount = Number(row['Monto recibido']) || 0;
          if (!name) { result.errors.push(`Desembolso inválido: ${JSON.stringify(row)}`); continue; }
          await api('/api/disbursements', { method: 'POST', body: { name, date: date || today(), amount, note: String(row['Nota'] || '').trim() || null } });
          result.disbursements++;
        }
        await loadData();
      }

      function parseExcelDate(v) {
        if (v == null) return '';
        const s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        const n = Number(v);
        if (!isNaN(n) && n > 40000 && n < 200000) {
          const d = new Date((n - 25569) * 86400000);
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        return s;
      }

      const execSheet = wb.Sheets['Saldos reales'];
      if (execSheet) {
        const rows = XLSX.utils.sheet_to_json(execSheet);
        for (const row of rows) {
          const lineCode = String(row['Código línea'] || '').trim().toUpperCase();
          const lineName = String(row['Nombre línea'] || '').trim();
          const date = parseExcelDate(row['Fecha']);
          const amount = Number(row['Monto']);
          const note = String(row['Nota'] || '').trim();
          if ((!lineCode && !lineName) || !date || isNaN(amount)) { result.errors.push(`Saldo inválido: ${JSON.stringify(row)}`); continue; }
          let line = null;
          if (lineName) line = state.lines.find(l => l.name.toLowerCase() === lineName.toLowerCase());
          if (!line && lineCode) line = state.lines.find(l => l.code && l.code.toUpperCase() === lineCode);
          if (!line) { result.errors.push(`Línea "${lineName || lineCode}" no encontrada para saldo`); continue; }
          const disbName = String(row['Desembolso'] || '').trim();
          let disbId = null;
          if (disbName) {
            const d = state.disbursements.find(x => x.name.toLowerCase() === disbName.toLowerCase());
            if (d) disbId = d.id;
            else result.errors.push(`Desembolso "${disbName}" no encontrado para saldo`);
          }
          await api('/api/executions', { method: 'POST', body: { line_id: line.id, date, amount, note: note || null, disbursement_id: disbId } });
          result.executions++;
        }
      }

      const adjSheet = wb.Sheets['Ajustes'];
      if (adjSheet) {
        const rows = XLSX.utils.sheet_to_json(adjSheet);
        for (const row of rows) {
          const lineCode = String(row['Código línea'] || '').trim().toUpperCase();
          const lineName = String(row['Nombre línea'] || '').trim();
          const date = parseExcelDate(row['Fecha']);
          const amount = Number(row['Monto']);
          const note = String(row['Nota'] || '').trim();
          if ((!lineCode && !lineName) || !date || isNaN(amount)) { result.errors.push(`Ajuste inválido: ${JSON.stringify(row)}`); continue; }
          let line = null;
          if (lineName) line = state.lines.find(l => l.name.toLowerCase() === lineName.toLowerCase());
          if (!line && lineCode) line = state.lines.find(l => l.code && l.code.toUpperCase() === lineCode);
          if (!line) { result.errors.push(`Línea "${lineName || lineCode}" no encontrada para ajuste`); continue; }
          await api('/api/adjustments', { method: 'POST', body: { line_id: line.id, date, amount, note: note || null } });
          result.adjustments++;
        }
      }

      const allocSheet = wb.Sheets['Asignaciones'];
      if (allocSheet) {
        const rows = XLSX.utils.sheet_to_json(allocSheet);
        for (const row of rows) {
          const disbName = String(row['Desembolso'] || '').trim();
          const lineCode = String(row['Código línea'] || '').trim().toUpperCase();
          const lineName = String(row['Nombre línea'] || '').trim();
          const amount = Number(row['Monto asignado']);
          if ((!lineCode && !lineName) || isNaN(amount)) { result.errors.push(`Asignación inválida: ${JSON.stringify(row)}`); continue; }
          const disb = disbName ? state.disbursements.find(x => x.name.toLowerCase() === disbName.toLowerCase()) : null;
          if (!disb) { result.errors.push(`Desembolso "${disbName}" no encontrado para asignación`); continue; }
          let line = null;
          if (lineName) line = state.lines.find(l => l.name.toLowerCase() === lineName.toLowerCase());
          if (!line && lineCode) line = state.lines.find(l => l.code && l.code.toUpperCase() === lineCode);
          if (!line) { result.errors.push(`Línea "${lineName || lineCode}" no encontrada para asignación`); continue; }
          await api('/api/allocations', { method: 'POST', body: { disbursement_id: disb.id, line_id: line.id, amount } });
          result.allocations++;
        }
      }

      await loadData();
      renderDashboard();
      const msg = `Importado: ${result.lines} líneas, ${result.disbursements} desembolsos, ${result.allocations} asignaciones, ${result.executions} saldos, ${result.adjustments} ajustes`;
      if (result.errors.length) toast(msg + ` (${result.errors.length} errores)`, true);
      else toast(msg);
    } catch (err) {
      toast('Error al importar: ' + err.message, true);
    }
  };
  input.click();
}

function deleteAllData() {
  openDeleteModal({
    title: 'Eliminar todos los datos',
    message: '¿Eliminar TODAS las líneas, desembolsos, asignaciones, saldos reales y ajustes? Esta acción no se puede deshacer.',
    onConfirm: async (password) => {
      await api('/api/data', { method: 'DELETE', body: { password } });
      await loadData();
      renderDashboard();
      toast('Todos los datos han sido eliminados');
    },
  });
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.user = null;
  state.lines = [];
  state.executions = [];
  state.adjustments = [];
  state.disbursements = [];
  state.allocations = [];
  state.transfers = [];
  state.reserveMoves = [];
  state.nav = 'dashboard';
  state.selectedDisb = null;
  state.filters = { year: 'all', month: 'all', disbursement: 'all' };
  renderAuth();
}

init();