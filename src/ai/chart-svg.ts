import type { ChartSpec, CompositionSpec } from './charts.js';
import { toPercent } from '../lib/composition.js';

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

/**
 * Tuned against the app's dark palette (--bg #0a0a0f, --accent #e8933a).
 *
 * SIX, BECAUSE MAX_SLICES IS SIX. It was four until 24 Sep 2026, when the
 * part-to-whole charts arrived and a five-channel donut drew its fifth slice in
 * the same orange as its first -- the index wrapped, and two different channels
 * became one colour in a chart whose entire content is which colour is which.
 * A time-series chart never hit it because nothing plots five venues.
 *
 * THE FIRST FOUR KEEP THEIR POSITIONS, deliberately. Colour follows the entity
 * and the entity here is the slot, so reordering to make room would have
 * repainted every chart already drawn and every one stored inside a
 * recommendation -- for no gain a reader could name.
 *
 * Validated as a categorical palette against this surface: worst adjacent pair
 * ΔE 10.9 under deuteranopia and 16.8 under normal vision, chroma clear of the
 * grey floor, every step at least 3:1 on the background. The one check it does
 * not pass is the dark-mode lightness band -- all six sit around L 0.70-0.76
 * where the band wants 0.48-0.67, which is a glare judgement rather than a
 * legibility one, and predates this change. Tritan separation is low, which is
 * why no chart here rests on colour alone: every slice is named in a legend and
 * the large ones are labelled directly.
 */
const SERIES_COLOURS = ['#e8933a', '#5aa9d6', '#7cc47f', '#c88fd4', '#c2b44e', '#e0655f'];
const AXIS = '#8888a0';
const GRID = '#2a2a3a';
const TEXT = '#e4e4ef';
const MUTED = '#8888a0';
// Amber, for a weekday average resting on too few trading days to trust.
const WARN = '#d4a03a';

const W = 720;
const H = 360;
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

/** Short axis label: 2026-07 -> Jul 26, 2026-07-14 -> 14 Jul, Tuesday -> Tue */
function shortLabel(label: string, granularity: ChartSpec['granularity']): string {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Weekday buckets are already words, not dates -- splitting them on '-' would
  // produce "NaN undefined".
  if (granularity === 'day_of_week') return label.slice(0, 3);
  if (granularity === 'month') {
    const [y, m] = label.split('-');
    return `${M[Number(m) - 1]} ${y.slice(2)}`;
  }
  const [, m, d] = label.split('-');
  return `${Number(d)} ${M[Number(m) - 1]}`;
}

/**
 * Hover text for one plotted point. A weekday point is an average, so it says
 * so and carries its sample size -- "Sunday: $6.1k" invites more confidence
 * than two trading days deserve.
 */
function pointTip(
  seriesName: string,
  p: { label: string; value: number | null; n?: number },
  spec: ChartSpec,
): string {
  const value = fmt(p.value as number, spec.unit);
  if (spec.granularity !== 'day_of_week') {
    // A rate without its denominator is the share trap. Retention points carry
    // the month's booked guests in `n` precisely so the tooltip can say "12% of
    // 602" rather than "12%" -- a rate rises when either half moves.
    return p.n !== undefined
      ? `${seriesName} ${p.label}: ${value} of ${p.n} booked guests`
      : `${seriesName} ${p.label}: ${value}`;
  }
  const n = p.n ?? 0;
  return `${seriesName} ${p.label}: ${value} average over ${n} trading day${n === 1 ? '' : 's'}`;
}

/** Round the axis maximum up to something a human would choose. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function renderChartSvg(spec: ChartSpec | CompositionSpec): string {
  // Charts stored before 24 Sep 2026 have no `kind`, so absence means the
  // original time-series shape. A discriminator that defaulted the other way
  // would break every chart already sitting in a stored recommendation.
  if ('kind' in spec && spec.kind === 'composition') {
    return spec.type === 'pie' ? renderPieSvg(spec) : renderStackedSvg(spec);
  }
  return renderSeriesSvg(spec as ChartSpec);
}

function renderSeriesSvg(spec: ChartSpec): string {
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
  // No max-width: the viewBox lets this scale to whatever container it lands
  // in, so the same markup serves the small inline card and the full-screen
  // view without re-rendering at a second size.
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(spec.title)}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`);
  // Deliberately no root <title>: browsers render it as an unstyled OS tooltip
  // over every part of the chart not covered by a more specific one, which both
  // clashes with the dark theme and shadows the per-point tooltips below. The
  // aria-label above is the accessible name; the text below is the visible one.
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

  // Bars sit in the middle of an equal-width slot; line points sit on the edges
  // of the plot. Labelling both with the line positions leaves every bar offset
  // from its own label, which is invisible over 26 weeks and obvious over 7.
  const groupW = plotW / labels.length;
  const labelX = (i: number) => (spec.type === 'bar' ? PAD.left + groupW * i + groupW / 2 : x(i));

  // X labels, thinned so they never collide
  const every = Math.max(1, Math.ceil(labels.length / 9));
  const showSample = spec.granularity === 'day_of_week' && spec.series.length === 1;
  labels.forEach((label, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    parts.push(`<text x="${labelX(i).toFixed(1)}" y="${H - PAD.bottom + 18}" fill="${MUTED}" font-size="10" text-anchor="middle">${esc(shortLabel(label, spec.granularity))}</text>`);
    // How many trading days the average rests on. Only shown for a single
    // venue: with several plotted, each has its own count and one number under
    // the axis would be wrong for all but one of them.
    const n = showSample ? spec.series[0].points[i]?.n : undefined;
    if (n !== undefined) {
      const thin = n > 0 && n < 4;
      parts.push(`<text x="${labelX(i).toFixed(1)}" y="${H - PAD.bottom + 30}" fill="${thin ? WARN : MUTED}" font-size="9" text-anchor="middle">${n}d</text>`);
    }
  });

  if (spec.type === 'bar') {
    const barW = Math.max(2, (groupW * 0.7) / spec.series.length);
    spec.series.forEach((s, si) => {
      const colour = SERIES_COLOURS[si % SERIES_COLOURS.length];
      s.points.forEach((p, i) => {
        if (p.value === null) return;
        const bx = labelX(i) - (barW * spec.series.length) / 2 + barW * si;
        const by = y(p.value);
        parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${(PAD.top + plotH - by).toFixed(1)}" fill="${colour}" rx="2"><title>${esc(pointTip(s.name, p, spec))}</title></rect>`);
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
        parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="${colour}"><title>${esc(pointTip(s.name, p, spec))}</title></circle>`);
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

/**
 * Part-to-whole renderers.
 *
 * SHARED RULES, both drawn from the same place. Colour follows the CATEGORY and
 * never its rank in a bucket: `alignBuckets()` fixes one order across the whole
 * range, and the index into it is the index into the palette, so a channel does
 * not change colour in March because two others crossed over. And there is a
 * 2px gap of surface between every adjacent fill, which is what stops two
 * similar hues reading as one band -- the secondary encoding that makes the
 * palette legible to a colour-blind reader rather than merely compliant.
 */

/** Where a stacked column's own total is printed, above the bar. */
const TOTAL_ROW = 14;

/** The gap of surface between adjacent fills. Not decoration -- see above. */
const SEG_GAP = 2;

const pct = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)}%`;

/** Legend across the bottom, wrapping when the names are long. */
function legend(categories: string[], yStart: number, xStart: number, maxX: number): string {
  const parts: string[] = [];
  let lx = xStart;
  let ly = yStart;
  categories.forEach((name, i) => {
    const w = 20 + name.length * 6.2;
    if (lx + w > maxX) { lx = xStart; ly += 14; }
    parts.push(`<rect x="${lx}" y="${ly - 9}" width="9" height="9" fill="${SERIES_COLOURS[i % SERIES_COLOURS.length]}" rx="2"/>`);
    parts.push(`<text x="${lx + 14}" y="${ly}" fill="${MUTED}" font-size="10">${esc(name)}</text>`);
    lx += w;
  });
  return parts.join('');
}

/**
 * A donut rather than a full pie, and not for fashion: the hole carries the
 * total. A part-to-whole chart whose denominator is not on it is the share
 * trap waiting to happen -- 12% of what? -- and putting the count in the middle
 * costs nothing and answers it before anybody asks.
 */
function renderPieSvg(spec: CompositionSpec): string {
  const bucket = spec.buckets[0];
  if (!bucket || bucket.total === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="60"><text x="12" y="34" fill="${MUTED}" font-family="sans-serif" font-size="13">No data to chart.</text></svg>`;
  }

  const shares = toPercent(bucket.slices);
  const cx = 190;
  const cy = 190;
  const rOuter = 108;
  const rInner = 62;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 330" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(spec.title)}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`);
  parts.push(`<text x="20" y="22" fill="${TEXT}" font-size="14" font-weight="600">${esc(spec.title)}</text>`);
  parts.push(`<text x="20" y="38" fill="${MUTED}" font-size="10">Source: ${esc(spec.source)}</text>`);

  let angle = -Math.PI / 2;   // start at twelve o'clock, as a clock face reads
  bucket.slices.forEach((slice, i) => {
    if (slice.value <= 0) return;
    const sweep = (slice.value / bucket.total) * Math.PI * 2;
    // A hairline of arc between segments, converted from px to radians at the
    // outer edge so the gap looks even whatever the slice size.
    const inset = Math.min(SEG_GAP / rOuter, sweep / 4);
    const a0 = angle + inset;
    const a1 = angle + sweep - inset;
    const large = sweep > Math.PI ? 1 : 0;

    const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    parts.push(
      `<path d="M${p(rOuter, a0)} A${rOuter},${rOuter} 0 ${large} 1 ${p(rOuter, a1)} ` +
      `L${p(rInner, a1)} A${rInner},${rInner} 0 ${large} 0 ${p(rInner, a0)} Z" ` +
      `fill="${SERIES_COLOURS[i % SERIES_COLOURS.length]}">` +
      `<title>${esc(`${slice.label}: ${Math.round(slice.value)} ${spec.unit_label} (${pct(shares[i].value)})`)}</title></path>`,
    );
    angle += sweep;
  });

  // The denominator, in the hole.
  parts.push(`<text x="${cx}" y="${cy - 2}" fill="${TEXT}" font-size="22" font-weight="600" text-anchor="middle">${Math.round(bucket.total).toLocaleString('en-SG')}</text>`);
  parts.push(`<text x="${cx}" y="${cy + 16}" fill="${MUTED}" font-size="10" text-anchor="middle">${esc(spec.unit_label)}</text>`);

  /**
   * EVERY SLICE IS WRITTEN OUT BESIDE THE RING, with its count as well as its
   * share. Three degrees of arc is not readable and this chart is looked at on
   * a phone between services; the list is what the reader actually uses, and
   * the ring is what makes the shape obvious at a glance. It also means
   * identity never rests on colour alone.
   */
  const lx = 360;
  let ly = 92;
  bucket.slices.forEach((slice, i) => {
    parts.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" fill="${SERIES_COLOURS[i % SERIES_COLOURS.length]}" rx="2"/>`);
    parts.push(`<text x="${lx + 18}" y="${ly}" fill="${TEXT}" font-size="12">${esc(slice.label)}</text>`);
    parts.push(`<text x="${W - 20}" y="${ly}" fill="${TEXT}" font-size="12" text-anchor="end" font-weight="600">${pct(shares[i].value)}</text>`);
    parts.push(`<text x="${W - 20}" y="${ly + 13}" fill="${MUTED}" font-size="10" text-anchor="end">${Math.round(slice.value).toLocaleString('en-SG')} ${esc(spec.unit_label)}</text>`);
    ly += 34;
  });

  parts.push('</svg>');
  return parts.join('');
}

/**
 * A hundred-percent stacked bar: a pie per bucket, laid flat so they can be
 * compared. This is the one a briefing usually wants, because the question is
 * almost never "what is the mix" but "is the mix moving", and two pies side by
 * side cannot answer that -- people read angles badly across circles.
 *
 * THE TOTAL IS PRINTED ABOVE EVERY COLUMN. Normalising to a hundred percent
 * throws the denominator away, and the denominator is where the share trap
 * lives: a band getting fatter while the count underneath it falls is a
 * business shrinking, drawn as a trend in the right direction. The number above
 * the bar is the whole defence.
 */
function renderStackedSvg(spec: CompositionSpec): string {
  const buckets = spec.buckets;
  if (buckets.length === 0 || buckets.every(b => b.total === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="60"><text x="12" y="34" fill="${MUTED}" font-family="sans-serif" font-size="13">No data to chart.</text></svg>`;
  }

  const legendRows = Math.ceil((spec.categories.length * 110) / (W - 40)) || 1;
  const H2 = 300 + legendRows * 14;
  const pad = { top: 56 + TOTAL_ROW, right: 20, bottom: 40 + legendRows * 14, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H2 - pad.top - pad.bottom;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H2}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(spec.title)}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`);
  parts.push(`<text x="${pad.left}" y="22" fill="${TEXT}" font-size="14" font-weight="600">${esc(spec.title)}</text>`);
  parts.push(`<text x="${pad.left}" y="38" fill="${MUTED}" font-size="10">Source: ${esc(spec.source)} · share of each month, with the count above each column</text>`);

  // Gridlines at 0/25/50/75/100, recessive.
  for (const t of [0, 25, 50, 75, 100]) {
    const yy = pad.top + plotH - (t / 100) * plotH;
    parts.push(`<line x1="${pad.left}" y1="${yy.toFixed(1)}" x2="${W - pad.right}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${pad.left - 8}" y="${(yy + 3.5).toFixed(1)}" fill="${MUTED}" font-size="10" text-anchor="end">${t}%</text>`);
  }

  const slotW = plotW / buckets.length;
  const barW = Math.max(6, Math.min(56, slotW * 0.68));
  const everyLabel = Math.max(1, Math.ceil(buckets.length / 9));

  buckets.forEach((bucket, bi) => {
    const cx = pad.left + slotW * bi + slotW / 2;
    const bx = cx - barW / 2;

    if (bucket.total === 0) {
      // A month with no trade is a GAP, never a full column of zeros. Drawing
      // it would put a hundred percent of nothing on the chart.
      parts.push(`<text x="${cx.toFixed(1)}" y="${(pad.top + plotH / 2).toFixed(1)}" fill="${MUTED}" font-size="9" text-anchor="middle">no data</text>`);
    } else {
      const shares = toPercent(bucket.slices);
      let acc = 0;
      bucket.slices.forEach((slice, si) => {
        const share = shares[si].value;
        if (share <= 0) return;
        const hFull = (share / 100) * plotH;
        const yTop = pad.top + plotH - ((acc + share) / 100) * plotH;
        // The gap is taken off the segment, never added between, so the column
        // still ends exactly on the axis and the stack still reads as 100%.
        const h = Math.max(1, hFull - SEG_GAP);
        parts.push(
          `<rect x="${bx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" ` +
          `fill="${SERIES_COLOURS[si % SERIES_COLOURS.length]}" rx="2">` +
          `<title>${esc(`${bucket.label} — ${slice.label}: ${pct(share)} (${Math.round(slice.value)} ${spec.unit_label} of ${Math.round(bucket.total)})`)}</title></rect>`,
        );
        // Direct-label a segment only when it is tall enough to hold the text.
        // A label clipped by its own segment is worse than no label.
        if (hFull >= 22 && barW >= 34) {
          parts.push(`<text x="${cx.toFixed(1)}" y="${(yTop + hFull / 2 + 4).toFixed(1)}" fill="#12121a" font-size="10" font-weight="600" text-anchor="middle">${pct(share)}</text>`);
        }
        acc += share;
      });

      // The denominator, above the column. See the header comment.
      parts.push(`<text x="${cx.toFixed(1)}" y="${(pad.top - 6).toFixed(1)}" fill="${spec.low_sample.includes(bucket.label) ? WARN : MUTED}" font-size="10" text-anchor="middle">${Math.round(bucket.total).toLocaleString('en-SG')}</text>`);
    }

    if (bi % everyLabel === 0 || bi === buckets.length - 1) {
      parts.push(`<text x="${cx.toFixed(1)}" y="${(pad.top + plotH + 16).toFixed(1)}" fill="${MUTED}" font-size="10" text-anchor="middle">${esc(shortLabel(bucket.label, 'month'))}</text>`);
    }
  });

  parts.push(legend(spec.categories, H2 - 14 - (legendRows - 1) * 14, pad.left, W - 20));
  parts.push(`<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="${AXIS}" stroke-width="1"/>`);
  parts.push(`<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}" stroke="${AXIS}" stroke-width="1"/>`);
  parts.push('</svg>');
  return parts.join('');
}
