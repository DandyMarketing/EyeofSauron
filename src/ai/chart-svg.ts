import type { ChartSpec } from './charts.js';

/**
 * Render a ChartSpec to standalone SVG.
 *
 * Rendered on the server rather than in the browser so there is exactly one
 * renderer: the web app inlines this SVG, and Telegram can later convert the
 * same output to PNG. A client-side chart library would need a second,
 * separate implementation for Telegram, and the two would drift.
 *
 * No external dependencies, no build step -- consistent with public/index.html.
 */

// Tuned against the app's dark palette (--bg #0a0a0f, --accent #e8933a).
const SERIES_COLOURS = ['#e8933a', '#5aa9d6', '#7cc47f', '#c88fd4'];
const AXIS = '#8888a0';
const GRID = '#2a2a3a';
const TEXT = '#e4e4ef';
const MUTED = '#8888a0';

const W = 720;
const H = 320;
const PAD = { top: 44, right: 20, bottom: 52, left: 64 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(v: number, unit: ChartSpec['unit']): string {
  if (unit === 'currency') {
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return `$${v.toFixed(0)}`;
  }
  if (unit === 'percent') return `${v.toFixed(0)}%`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

/** Short axis label: 2026-07 -> Jul 26, 2026-07-14 -> 14 Jul */
function shortLabel(label: string, granularity: ChartSpec['granularity']): string {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (granularity === 'month') {
    const [y, m] = label.split('-');
    return `${M[Number(m) - 1]} ${y.slice(2)}`;
  }
  const [, m, d] = label.split('-');
  return `${Number(d)} ${M[Number(m) - 1]}`;
}

/** Round the axis maximum up to something a human would choose. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function renderChartSvg(spec: ChartSpec): string {
  const labels = spec.series[0]?.points.map(p => p.label) ?? [];
  const values = spec.series.flatMap(s => s.points.map(p => p.value)).filter((v): v is number => v !== null);
  if (labels.length === 0 || values.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="60"><text x="12" y="34" fill="${MUTED}" font-family="sans-serif" font-size="13">No data to chart.</text></svg>`;
  }

  const maxV = niceMax(Math.max(...values));
  // Percentages and counts start at zero; so does currency, since a truncated
  // revenue axis exaggerates small movements.
  const minV = 0;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(spec.title)}" style="max-width:${W}px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`);
  parts.push(`<title>${esc(spec.title)}</title>`);
  parts.push(`<text x="${PAD.left}" y="20" fill="${TEXT}" font-size="14" font-weight="600">${esc(spec.title)}</text>`);
  parts.push(`<text x="${PAD.left}" y="36" fill="${MUTED}" font-size="10">Source: ${esc(spec.source)} · by ${spec.granularity}</text>`);

  // Horizontal gridlines + y labels
  const TICKS = 4;
  for (let t = 0; t <= TICKS; t++) {
    const v = minV + ((maxV - minV) * t) / TICKS;
    const yy = y(v);
    parts.push(`<line x1="${PAD.left}" y1="${yy.toFixed(1)}" x2="${W - PAD.right}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.left - 8}" y="${(yy + 3.5).toFixed(1)}" fill="${MUTED}" font-size="10" text-anchor="end">${fmt(v, spec.unit)}</text>`);
  }

  // X labels, thinned so they never collide
  const every = Math.max(1, Math.ceil(labels.length / 9));
  labels.forEach((label, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    parts.push(`<text x="${x(i).toFixed(1)}" y="${H - PAD.bottom + 18}" fill="${MUTED}" font-size="10" text-anchor="middle">${esc(shortLabel(label, spec.granularity))}</text>`);
  });

  if (spec.type === 'bar') {
    const groupW = plotW / labels.length;
    const barW = Math.max(2, (groupW * 0.7) / spec.series.length);
    spec.series.forEach((s, si) => {
      const colour = SERIES_COLOURS[si % SERIES_COLOURS.length];
      s.points.forEach((p, i) => {
        if (p.value === null) return;
        const cx = PAD.left + groupW * i + groupW / 2;
        const bx = cx - (barW * spec.series.length) / 2 + barW * si;
        const by = y(p.value);
        parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${(PAD.top + plotH - by).toFixed(1)}" fill="${colour}" rx="2"><title>${esc(s.name)} ${esc(p.label)}: ${fmt(p.value, spec.unit)}</title></rect>`);
      });
    });
  } else {
    spec.series.forEach((s, si) => {
      const colour = SERIES_COLOURS[si % SERIES_COLOURS.length];
      // Break the path on nulls so a missing bucket shows as a gap rather than
      // a straight line implying data that does not exist.
      let d = '';
      let pen = false;
      s.points.forEach((p, i) => {
        if (p.value === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
        pen = true;
      });
      if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      s.points.forEach((p, i) => {
        if (p.value === null) return;
        parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="${colour}"><title>${esc(s.name)} ${esc(p.label)}: ${fmt(p.value, spec.unit)}</title></circle>`);
      });
    });
  }

  // Legend, only when more than one series is plotted
  if (spec.series.length > 1) {
    let lx = PAD.left;
    spec.series.forEach((s, si) => {
      const colour = SERIES_COLOURS[si % SERIES_COLOURS.length];
      parts.push(`<rect x="${lx}" y="${H - 16}" width="9" height="9" fill="${colour}" rx="2"/>`);
      parts.push(`<text x="${lx + 14}" y="${H - 8}" fill="${MUTED}" font-size="10">${esc(s.name)}</text>`);
      lx += 20 + s.name.length * 6.2;
    });
  }

  // Axes
  parts.push(`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + plotH}" stroke="${AXIS}" stroke-width="1"/>`);
  parts.push(`<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${W - PAD.right}" y2="${PAD.top + plotH}" stroke="${AXIS}" stroke-width="1"/>`);
  parts.push('</svg>');
  return parts.join('');
}
