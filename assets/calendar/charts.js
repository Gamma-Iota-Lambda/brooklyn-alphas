// Charts for the Results tab: SVG line and column charts drawn at the width they're shown at, and
// HTML bar lists. Each has a hover and keyboard readout, and the page offers a table view of every
// chart. Thin marks, hairline grids, and values in text colors; a platform keeps its color in every
// chart. Colors and type come from calendar.css (--viz-*), checked with the dataviz validator.

const SPECS = new Map();
let observer = null;
let showing = false;

const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtNum = (n) => (n === null || n === undefined || Number.isNaN(n) ? '' : nf.format(Math.round(n)));
export const fmtCompact = (n) => (n === null || n === undefined || Number.isNaN(n) ? '' : Math.abs(n) < 10000 ? nf.format(Math.round(n)) : cf.format(n));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayNum = (s) => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const dayISO = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const shortDay = (s) => new Date(dayNum(s) * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = (s) => new Date(dayNum(s) * 86400000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const f1 = (n) => n.toFixed(1);

// Clean, round tick values covering [min, max]. Counts never step below 1.
function scale(min, max, count, { zero = false } = {}) {
  if (zero) min = Math.min(0, min);
  if (!(max > min)) { const pad = Math.max(1, Math.abs(min) * 0.02); max = min + pad; if (!zero) min -= pad; }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = Math.max(1, Math.round((n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag));
  const lo = Math.floor(min / step) * step;
  const hi = Math.max(Math.ceil(max / step) * step, lo + step);
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

// Width of 12px Outfit numerals and short words, to size the left axis.
const textW = (s) => String(s).length * 6.9;

// ---------------------------------------------------------------- registry

// Forget the charts on screen: the page calls this before it renders a view.
export function resetCharts() {
  SPECS.clear();
  if (observer) { observer.disconnect(); observer = null; }
  showing = false;
}

// The placeholder the page renders; drawCharts() fills it in once it has a width.
export function chartHTML(spec) {
  SPECS.set(spec.id, spec);
  return `<div class="viz" data-viz="${esc(spec.id)}" style="height:${spec.height}px"></div>`;
}

// Horizontal bars as HTML, each with its value at the tip. spec: {id, color, rows: [{label,
// labelHTML, value, valueLabel, note, tip: [{value, label}]}]}. One color for every bar; the
// label says what each one is.
export function barsHTML(spec) {
  SPECS.set(spec.id, spec);
  const max = Math.max(1, ...spec.rows.map((r) => r.value || 0));
  return `<div class="viz-bars"><ul class="hbars" data-viz="${esc(spec.id)}">${spec.rows.map((r, i) => `
    <li class="hbar" tabindex="0" data-viz-hit="bar" data-i="${i}" aria-label="${esc(`${r.label}: ${r.valueLabel}${r.note ? `, ${r.note}` : ''}`)}">
      <span class="hb-label">${r.labelHTML || `<span>${esc(r.label)}</span>`}${r.note ? `<span class="hb-note">${esc(r.note)}</span>` : ''}</span>
      <span class="hb-track"><i style="width:calc((100% - 64px) * ${Math.max(0.004, (r.value || 0) / max).toFixed(4)});background:${spec.color}"></i><b>${esc(r.valueLabel)}</b></span>
    </li>`).join('')}</ul><div class="viz-tip" hidden></div></div>`;
}

// Draws every chart placeholder inside root at its current width, and redraws when the width changes.
export function drawCharts(root) {
  if (observer) observer.disconnect();
  const boxes = [...root.querySelectorAll('.viz[data-viz]')];
  for (const box of boxes) draw(box);
  if ('ResizeObserver' in window) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w && w !== Number(entry.target.dataset.w)) draw(entry.target);
      }
    });
    for (const box of boxes) observer.observe(box);
  }
}

function draw(box) {
  const spec = SPECS.get(box.dataset.viz);
  const W = Math.round(box.clientWidth);
  if (!spec || !W) return;
  box.dataset.w = String(W);
  delete box.dataset.at;
  box.innerHTML = (spec.type === 'line' ? lineSVG(spec, W) : columnSVG(spec, W)) + '<div class="viz-tip" hidden></div>';
}

const svgOpen = (W, H, label) => `<svg class="viz-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;

function yAxis(parts, sc, m, W, Y) {
  for (const v of sc.ticks) {
    parts.push(`<line class="${v === 0 ? 'viz-base' : 'viz-grid'}" x1="${m.l}" x2="${W - m.r}" y1="${f1(Y(v))}" y2="${f1(Y(v))}"/>`);
    parts.push(`<text class="viz-tick" x="${m.l - 8}" y="${f1(Y(v))}" dy="0.32em" text-anchor="end">${esc(fmtCompact(v))}</text>`);
  }
}

// ---------------------------------------------------------------- line chart
// spec: {id, type: 'line', height, label, summary, unit, from, to,
//        series: [{label, color, points: [{x: 'YYYY-MM-DD', y}]}]}
// Every series shares one axis.

function lineGeometry(spec, W) {
  const H = spec.height;
  let values = spec.series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
  if (!values.length) values = [0];
  const sc = scale(Math.min(...values), Math.max(...values), 3);
  const m = { t: 10, r: 12, b: 24, l: Math.ceil(Math.max(...sc.ticks.map((v) => textW(fmtCompact(v))))) + 12 };
  const x0 = dayNum(spec.from), x1 = Math.max(dayNum(spec.to), x0 + 1);
  const X = (d) => m.l + ((dayNum(d) - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - m.t - m.b);
  const days = [...new Set(spec.series.flatMap((s) => s.points.filter((p) => Number.isFinite(p.y)).map((p) => p.x)))].sort();
  return { H, sc, m, x0, x1, X, Y, days };
}

function lineSVG(spec, W) {
  const g = lineGeometry(spec, W);
  const { H, sc, m, X, Y } = g;
  const parts = [];
  yAxis(parts, sc, m, W, Y);
  const k = Math.min(W < 360 ? 2 : W < 560 ? 3 : 4, Math.max(1, g.x1 - g.x0));
  const labeled = new Set();
  for (let i = 0; i <= k; i++) {
    const d = dayISO(Math.round(g.x0 + ((g.x1 - g.x0) * i) / k));
    if (labeled.has(d)) continue;
    labeled.add(d);
    const anchor = i === 0 ? 'start' : i === k ? 'end' : 'middle';
    parts.push(`<text class="viz-tick" x="${f1(X(d))}" y="${H - 6}" text-anchor="${anchor}">${esc(shortDay(d))}</text>`);
  }
  for (const s of spec.series) {
    const pts = s.points.filter((p) => Number.isFinite(p.y)).sort((a, b) => a.x.localeCompare(b.x));
    if (!pts.length) continue;
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(X(p.x))},${f1(Y(p.y))}`).join('');
    if (spec.series.length === 1 && pts.length > 1) {
      const base = f1(Y(sc.lo));
      parts.push(`<path class="viz-area" d="${line}L${f1(X(pts.at(-1).x))},${base}L${f1(X(pts[0].x))},${base}Z" style="fill:${s.color}"/>`);
    }
    parts.push(`<path class="viz-line" d="${line}" style="stroke:${s.color}"/>`);
    const last = pts.at(-1);
    parts.push(`<circle class="viz-dot" cx="${f1(X(last.x))}" cy="${f1(Y(last.y))}" r="4" style="fill:${s.color}"/>`);
  }
  parts.push(`<g class="viz-cross" visibility="hidden"><line class="viz-crossline" y1="${m.t}" y2="${H - m.b}"/>${spec.series.map((s) => `<circle class="viz-dot" r="4" style="fill:${s.color}"/>`).join('')}</g>`);
  parts.push(`<rect class="viz-hit" data-viz-hit="line" tabindex="0" x="${m.l}" y="0" width="${Math.max(1, W - m.l - m.r)}" height="${H - m.b}" fill="transparent" aria-label="${esc(`${spec.label}. The arrow keys step through the days.`)}"/>`);
  return `${svgOpen(W, H, spec.summary || spec.label)}${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------- column chart
// spec: {id, type: 'columns', height, label, summary, categories: [{label, short}],
//        columns: [{label, parts: [{label, color, values: []}]}]}
// Each category gets one column per entry in columns, side by side. A column's parts stack, with a
// 2px gap between segments and a 4px rounded top on the highest one. Columns grow from zero and are
// at most 24px wide.

function columnGeometry(spec, W) {
  const H = spec.height;
  const totals = spec.columns.flatMap((c) => spec.categories.map((_, i) => c.parts.reduce((n, p) => n + (p.values[i] || 0), 0)));
  const sc = scale(0, Math.max(1, ...totals), 4, { zero: true });
  const m = { t: 10, r: 6, b: 24, l: Math.ceil(Math.max(...sc.ticks.map((v) => textW(fmtCompact(v))))) + 12 };
  const n = spec.categories.length;
  const band = (W - m.l - m.r) / Math.max(1, n);
  const k = spec.columns.length, gap = 2;
  const bw = Math.max(3, Math.min(24, (band * 0.72 - gap * (k - 1)) / k));
  const Y = (v) => m.t + (1 - v / sc.hi) * (H - m.t - m.b);
  return { H, sc, m, n, band, k, gap, bw, Y };
}

// A segment from y (top) to bottom; rounded top corners when it's the top of its column.
function segmentPath(x, y, w, bottom, rounded) {
  const h = bottom - y;
  if (h < 0.75) return '';
  const r = rounded ? Math.min(4, h, w / 2) : 0;
  if (!r) return `M${f1(x)},${f1(bottom)}V${f1(y)}H${f1(x + w)}V${f1(bottom)}Z`;
  return `M${f1(x)},${f1(bottom)}V${f1(y + r)}Q${f1(x)},${f1(y)} ${f1(x + r)},${f1(y)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y)} ${f1(x + w)},${f1(y + r)}V${f1(bottom)}Z`;
}

function columnSVG(spec, W) {
  const g = columnGeometry(spec, W);
  const { H, sc, m, band, k, gap, bw, Y } = g;
  const parts = [];
  yAxis(parts, sc, m, W, Y);
  const every = band < 34 ? Math.ceil(34 / band) : 1;
  spec.categories.forEach((c, i) => {
    const cx = m.l + band * (i + 0.5);
    const start = cx - (bw * k + gap * (k - 1)) / 2;
    let marks = '';
    spec.columns.forEach((col, j) => {
      const x = start + j * (bw + gap);
      const top = col.parts.reduce((t, p, pi) => ((p.values[i] || 0) > 0 ? pi : t), -1);
      let cum = 0;
      col.parts.forEach((p, pi) => {
        const v = p.values[i] || 0;
        if (v <= 0) return;
        const bottom = Y(cum) - (cum > 0 ? gap : 0);
        cum += v;
        const d = segmentPath(x, Y(cum), bw, bottom, pi === top);
        if (d) marks += `<path d="${d}" style="fill:${p.color}"/>`;
      });
    });
    parts.push(`<g class="viz-band" data-i="${i}">${marks}</g>`);
    if (i % every === 0) parts.push(`<text class="viz-tick" x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(c.short || c.label)}</text>`);
    const said = spec.columns.flatMap((col) => col.parts.map((p) => `${p.label} ${fmtNum(p.values[i] || 0)}`)).join(', ');
    parts.push(`<rect class="viz-hit" data-viz-hit="band" data-i="${i}" tabindex="0" x="${f1(m.l + band * i)}" y="0" width="${f1(band)}" height="${H - m.b + 4}" fill="transparent" aria-label="${esc(`${c.label}: ${said}`)}"/>`);
  });
  return `${svgOpen(W, H, spec.summary || spec.label)}${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------- readout

function tipRows(lines) {
  return lines.map((l) => {
    const row = document.createElement('div');
    if (l.head) {
      row.className = 'tip-head';
      row.textContent = l.head;
      return row;
    }
    row.className = 'tip-row';
    if (l.color) {
      const key = document.createElement('i');
      key.className = 'tip-key';
      key.style.background = l.color;
      row.append(key);
    }
    const value = document.createElement('b');
    value.textContent = l.value;
    row.append(value);
    if (l.label) {
      const label = document.createElement('span');
      label.textContent = l.label;
      row.append(label);
    }
    return row;
  });
}

function showTip(host, lines, x, y) {
  const tip = host.querySelector(':scope > .viz-tip');
  if (!tip) return;
  tip.replaceChildren(...tipRows(lines));
  tip.hidden = false;
  showing = true;
  const hw = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  const left = Math.min(Math.max(0, x + 14), Math.max(0, hw - tw));
  const top = y - th - 10 >= 0 ? y - th - 10 : y + 16;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideTips(except) {
  if (!showing) return;
  if (!except) showing = false;
  for (const tip of document.querySelectorAll('.gc .viz-tip:not([hidden])')) if (tip.parentElement !== except) tip.hidden = true;
  for (const cross of document.querySelectorAll('.gc .viz-cross')) if (!except || !except.contains(cross)) cross.setAttribute('visibility', 'hidden');
  for (const band of document.querySelectorAll('.gc .viz-band.dim')) if (!except || !except.contains(band)) band.classList.remove('dim');
}

// The line readout: a hairline at the day, and every series' value that day.
function lineAt(box, spec, index) {
  const g = lineGeometry(spec, Number(box.dataset.w));
  const i = Math.max(0, Math.min(g.days.length - 1, index));
  const day = g.days[i];
  if (!day) return;
  box.dataset.at = String(i);
  const cross = box.querySelector('.viz-cross');
  const x = g.X(day);
  const line = cross.querySelector('line');
  line.setAttribute('x1', f1(x));
  line.setAttribute('x2', f1(x));
  const dots = cross.querySelectorAll('circle');
  const lines = [{ head: longDay(day) }];
  let topY = g.H;
  spec.series.forEach((s, si) => {
    const p = s.points.find((q) => q.x === day && Number.isFinite(q.y));
    if (!p) { dots[si].setAttribute('visibility', 'hidden'); return; }
    dots[si].setAttribute('cx', f1(x));
    dots[si].setAttribute('cy', f1(g.Y(p.y)));
    dots[si].setAttribute('visibility', 'visible');
    topY = Math.min(topY, g.Y(p.y));
    lines.push({ value: fmtNum(p.y), label: spec.series.length > 1 ? s.label : spec.unit, color: s.color });
  });
  cross.setAttribute('visibility', 'visible');
  showTip(box, lines, x, topY);
}

function nearestDay(box, spec, clientX) {
  const g = lineGeometry(spec, Number(box.dataset.w));
  const x = clientX - box.querySelector('svg').getBoundingClientRect().left;
  let best = 0, dist = Infinity;
  g.days.forEach((d, i) => { const dd = Math.abs(g.X(d) - x); if (dd < dist) { dist = dd; best = i; } });
  return best;
}

function bandAt(box, spec, i) {
  const g = columnGeometry(spec, Number(box.dataset.w));
  for (const band of box.querySelectorAll('.viz-band')) band.classList.toggle('dim', band.dataset.i !== String(i));
  const totals = spec.columns.map((col) => col.parts.reduce((n, p) => n + (p.values[i] || 0), 0));
  const rows = [{ head: spec.categories[i].label }];
  spec.columns.forEach((col) => {
    for (const p of col.parts) rows.push({ value: fmtNum(p.values[i] || 0), label: p.label, color: p.color });
    if (col.parts.length > 1) rows.push({ value: fmtNum(col.parts.reduce((n, p) => n + (p.values[i] || 0), 0)), label: col.label });
  });
  showTip(box, rows, g.m.l + g.band * (i + 0.5), g.Y(Math.max(...totals)));
}

function barAt(list, spec, item) {
  const r = spec.rows[Number(item.dataset.i)];
  if (!r) return;
  const host = list.parentElement;
  const hostRect = host.getBoundingClientRect();
  const rect = item.querySelector('.hb-track i').getBoundingClientRect();
  showTip(host, [{ head: r.label }, ...(r.tip || [{ value: r.valueLabel }])], rect.right - hostRect.left, rect.top - hostRect.top);
}

function handle(target, clientX) {
  const hit = target && target.closest ? target.closest('[data-viz-hit]') : null;
  if (!hit) return false;
  if (hit.dataset.vizHit === 'bar') {
    const list = hit.closest('.hbars');
    const spec = list && SPECS.get(list.dataset.viz);
    if (!spec) return false;
    hideTips(list.parentElement);
    barAt(list, spec, hit);
    return true;
  }
  const box = hit.closest('.viz');
  const spec = box && SPECS.get(box.dataset.viz);
  if (!spec || !box.dataset.w) return false;
  hideTips(box);
  if (hit.dataset.vizHit === 'band') bandAt(box, spec, Number(hit.dataset.i));
  else if (clientX !== undefined) lineAt(box, spec, nearestDay(box, spec, clientX));
  else lineAt(box, spec, box.dataset.at !== undefined ? Number(box.dataset.at) : lineGeometry(spec, Number(box.dataset.w)).days.length - 1);
  return true;
}

let ready = false;
export function initCharts() {
  if (ready) return;
  ready = true;
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (!handle(e.target, e.clientX)) hideTips(null);
  });
  document.addEventListener('pointerdown', (e) => { if (!handle(e.target, e.clientX)) hideTips(null); });
  document.addEventListener('focusin', (e) => { if (!handle(e.target)) hideTips(null); });
  document.addEventListener('focusout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-viz-hit]')) hideTips(null); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideTips(null); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const hit = e.target.closest && e.target.closest('[data-viz-hit="line"]');
    const box = hit && hit.closest('.viz');
    const spec = box && SPECS.get(box.dataset.viz);
    if (!spec) return;
    e.preventDefault();
    const days = lineGeometry(spec, Number(box.dataset.w)).days;
    const at = (box.dataset.at !== undefined ? Number(box.dataset.at) : days.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1);
    lineAt(box, spec, at);
  });
}
