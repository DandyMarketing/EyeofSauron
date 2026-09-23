import { test } from 'node:test';
import assert from 'node:assert';
import {
  alignBuckets,
  bucketTotal,
  toPercent,
  shareTrap,
  lowSampleBuckets,
  pieFitNote,
  MAX_SLICES,
  type Bucket,
} from './composition.js';

/**
 * Two things here can produce a confident wrong chart. A category that changes
 * position between buckets draws movement that is an artefact of sorting, in
 * the one chart type whose job is showing movement. And a share that rose
 * because its denominator fell draws a shrinking business as a trend in the
 * right direction. Both look fine.
 */

const b = (label: string, slices: Record<string, number>): Bucket => ({
  label,
  slices: Object.entries(slices).map(([l, v]) => ({ label: l, value: v })),
});

test('category order is fixed across buckets, not sorted per bucket', () => {
  // Widget leads in January and Google leads in February. If each bucket sorted
  // itself, the two would swap colour and position mid-chart and the reader
  // would see a change that is the sort order, not the data.
  const { categories, buckets } = alignBuckets([
    b('2026-01', { 'Booking Widget': 100, Google: 20 }),
    b('2026-02', { 'Booking Widget': 10, Google: 90 }),
  ]);

  assert.deepEqual(categories, ['Booking Widget', 'Google']);
  for (const bucket of buckets) {
    assert.deepEqual(bucket.slices.map(s => s.label), ['Booking Widget', 'Google']);
  }
});

test('a category absent from a bucket is zero-filled, never dropped', () => {
  // A channel that fell to zero IS the finding — Neon Pigeon lost two online
  // paths for four months. A missing row and a dead channel must not look alike.
  const { buckets } = alignBuckets([
    b('2026-01', { 'Booking Widget': 100, Google: 40 }),
    b('2026-02', { 'Booking Widget': 90 }),
  ]);

  const feb = buckets[1].slices.find(s => s.label === 'Google');
  assert.equal(feb?.value, 0);
  assert.equal(buckets[1].slices.length, 2);
});

test('ties break on name, so two runs of the same query draw the same chart', () => {
  const first = alignBuckets([b('2026-01', { Zulu: 10, Alpha: 10 })]).categories;
  const second = alignBuckets([b('2026-01', { Alpha: 10, Zulu: 10 })]).categories;
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['Alpha', 'Zulu']);
});

test('past the slice cap the smallest fold into Other and the total is preserved', () => {
  const many: Record<string, number> = {};
  for (let i = 0; i < 10; i++) many[`Channel ${i}`] = 100 - i * 5;

  const { categories, buckets } = alignBuckets([b('2026-01', many)]);

  assert.equal(categories.length, MAX_SLICES);
  assert.equal(categories[categories.length - 1], 'Other');
  // Folding must not lose anything, or the percentages stop summing to 100 and
  // the chart is quietly lying about the whole.
  assert.equal(bucketTotal(buckets[0]), Object.values(many).reduce((a, c) => a + c, 0));
});

test('under the cap nothing is folded and there is no Other slice', () => {
  const { categories } = alignBuckets([b('2026-01', { A: 3, B: 2, C: 1 })]);
  assert.deepEqual(categories, ['A', 'B', 'C']);
});

test('percentages sum to about a hundred, and an empty bucket gives zeros not NaN', () => {
  const p = toPercent(b('x', { A: 1, B: 2, C: 1 }).slices);
  assert.equal(p.reduce((a, c) => a + c.value, 0), 100);

  const empty = toPercent(b('x', { A: 0, B: 0 }).slices);
  assert.deepEqual(empty.map(s => s.value), [0, 0]);
});

test('THE SHARE TRAP: a rising share on a falling total is called out', () => {
  // 100 guests, 12 returning (12%) → 50 guests, 10 returning (20%).
  // The band gets fatter and the business got smaller.
  const note = shareTrap([
    b('2026-01', { 'New to group': 88, 'Returning here': 12 }),
    b('2026-06', { 'New to group': 40, 'Returning here': 10 }),
  ]);

  assert.ok(note, 'the trap was not detected');
  assert.match(note!, /TOTAL FELL/);
  assert.match(note!, /Returning here/);
  assert.match(note!, /not an improvement/);
});

test('a rising share on a RISING total is not the trap and stays quiet', () => {
  // A caveat that fires every time is one nobody reads.
  const note = shareTrap([
    b('2026-01', { 'New to group': 88, 'Returning here': 12 }),
    b('2026-06', { 'New to group': 150, 'Returning here': 50 }),
  ]);
  assert.equal(note, null);
});

test('a falling total with no rising share is not the trap either', () => {
  const note = shareTrap([
    b('2026-01', { A: 50, B: 50 }),
    b('2026-06', { A: 25, B: 25 }),
  ]);
  assert.equal(note, null);
});

test('empty buckets are skipped when finding the ends of the range', () => {
  // A month with no trade at the front would otherwise be the baseline, and
  // every share would read as having risen from nothing.
  const note = shareTrap([
    b('2026-01', { A: 0, B: 0 }),
    b('2026-02', { A: 88, B: 12 }),
    b('2026-06', { A: 40, B: 10 }),
  ]);
  assert.ok(note);
  assert.match(note!, /88 to 50|100 to 50/);
});

test('a single bucket cannot show a trap, so a pie never claims one', () => {
  assert.equal(shareTrap([b('2026-01', { A: 88, B: 12 })]), null);
});

test('thin buckets are named, and genuinely empty ones are not', () => {
  const low = lowSampleBuckets([
    b('2026-01', { A: 10, B: 5 }),    // 15 — thin
    b('2026-02', { A: 200, B: 40 }),  // fine
    b('2026-03', { A: 0, B: 0 }),     // empty is a gap, not a thin sample
  ]);
  assert.deepEqual(low, ['2026-01']);
});

test('a pie dominated by one slice says what it cannot show', () => {
  // Guest source runs about 85/12/3. Three points of arc is eleven degrees.
  const note = pieFitNote(b('x', { 'New to group': 85, 'Returning here': 12, Crossed: 3 }).slices);
  assert.ok(note);
  assert.match(note!, /85%/);
  assert.match(note!, /stacked/);
});

test('a balanced pie gets no complaint', () => {
  // Booking channels are the case a pie is genuinely right for.
  const note = pieFitNote(b('x', { Widget: 40, Google: 25, Phone: 20, 'Landing Page': 15 }).slices);
  assert.equal(note, null);
});

test('several slivers are flagged even when no slice dominates', () => {
  const note = pieFitNote(b('x', { A: 45, B: 45, C: 4, D: 3, E: 3 }).slices);
  assert.ok(note);
  assert.match(note!, /under 5%/);
});
