import { test } from 'node:test';
import assert from 'node:assert';
import { renderChartSvg } from './chart-svg.js';
import type { CompositionSpec } from './charts.js';

/**
 * Part-to-whole rendering. These assert the two things that were actually
 * wrong when the charts were first drawn and looked at, rather than the shape
 * of the markup -- a renderer test that checks for `<rect` passes forever and
 * catches nothing.
 */

const comp = (over: Partial<CompositionSpec> = {}): CompositionSpec => ({
  kind: 'composition',
  type: 'pie',
  title: 'Booking channels — Neon Pigeon',
  metric: 'booking_channels',
  unit_label: 'bookings',
  source: 'SevenRooms',
  categories: ['Booking Widget', 'Google', 'Landing Page', 'Walk In', 'Online Menu'],
  buckets: [{
    label: 'range',
    slices: [
      { label: 'Booking Widget', value: 410 },
      { label: 'Google', value: 260 },
      { label: 'Landing Page', value: 190 },
      { label: 'Walk In', value: 155 },
      { label: 'Online Menu', value: 61 },
    ],
    total: 1076,
  }],
  low_sample: [],
  caveats: [],
  ...over,
});

test('five slices get five DIFFERENT colours', () => {
  /**
   * The regression this exists for. The palette held four colours and
   * MAX_SLICES is six, so a five-channel donut drew its fifth slice in the
   * first slice's orange -- two channels rendered as one colour, in a chart
   * whose entire content is which colour is which. It was invisible in every
   * test and obvious the moment somebody looked at the picture.
   */
  const svg = renderChartSvg(comp());
  const fills = [...svg.matchAll(/<path d="M[^"]*" fill="(#[0-9a-f]{6})"/g)].map(m => m[1]);

  assert.equal(fills.length, 5, 'expected one path per slice');
  assert.equal(new Set(fills).size, 5, `slices share a colour: ${fills.join(', ')}`);
});

test('the donut carries its denominator', () => {
  // A part-to-whole chart without its total is the share trap waiting: 12% of
  // what? The hole answers it before anybody asks.
  const svg = renderChartSvg(comp());
  assert.match(svg, /1,076/);
  assert.match(svg, /bookings/);
});

test('a zero-value slice is not drawn at all', () => {
  const svg = renderChartSvg(comp({
    buckets: [{
      label: 'range',
      slices: [
        { label: 'Booking Widget', value: 100 },
        { label: 'Google', value: 0 },
      ],
      total: 100,
    }],
  }));
  const fills = [...svg.matchAll(/<path d="M[^"]*" fill="(#[0-9a-f]{6})"/g)];
  assert.equal(fills.length, 1);
});

test('the stacked chart prints every bucket total above its column', () => {
  // Normalising to 100% throws the denominator away, and the denominator is
  // where the share trap lives. The number above the bar is the whole defence.
  const svg = renderChartSvg(comp({
    type: 'stacked_pct',
    categories: ['First visit', 'Second visit'],
    buckets: [
      { label: '2026-01', slices: [{ label: 'First visit', value: 880 }, { label: 'Second visit', value: 118 }], total: 998 },
      { label: '2026-02', slices: [{ label: 'First visit', value: 400 }, { label: 'Second visit', value: 100 }], total: 500 },
    ],
  }));

  assert.match(svg, /998/);
  assert.match(svg, /500/);
});

test('a month with no data is a gap, never a full column of zeros', () => {
  const svg = renderChartSvg(comp({
    type: 'stacked_pct',
    categories: ['First visit'],
    buckets: [
      { label: '2026-01', slices: [{ label: 'First visit', value: 100 }], total: 100 },
      { label: '2026-02', slices: [{ label: 'First visit', value: 0 }], total: 0 },
    ],
  }));
  assert.match(svg, /no data/);
});

test('a thin bucket has its total drawn in the warning colour', () => {
  const svg = renderChartSvg(comp({
    type: 'stacked_pct',
    categories: ['First visit'],
    buckets: [{ label: '2026-09', slices: [{ label: 'First visit', value: 27 }], total: 27 }],
    low_sample: ['2026-09'],
  }));
  assert.match(svg, /fill="#d4a03a" font-size="10" text-anchor="middle">27</);
});

test('a chart stored before composition existed still renders as a series', () => {
  // Stored recommendations hold ChartSpec objects with no `kind`. If absence
  // were read the other way, every chart already in the database would break.
  const svg = renderChartSvg({
    type: 'line', title: 'Net sales', metric: 'net_sales', unit: 'currency',
    granularity: 'week', source: 'Revel (POS)',
    series: [{ name: 'Neon Pigeon', points: [{ label: '2026-09-07', value: 100 }, { label: '2026-09-14', value: 200 }] }],
    closed_days: 0, low_sample_days: false, partial_first: false, partial_last: false,
  } as any);
  assert.match(svg, /Net sales/);
  assert.doesNotMatch(svg, /no data/i);
});
