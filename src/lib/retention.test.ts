import { test } from 'node:test';
import assert from 'node:assert';
import {
  retentionRates,
  retentionCaveats,
  rollingWindow,
  totalCounts,
  MIN_SAMPLE_FOR_TREND,
  cohortRates,
  comparableCohorts,
  MIN_COHORT_SIZE,
} from './retention.js';

/** Neon Pigeon, week of 17-23 Aug 2026. Real figures. */
const NEON_PIGEON = {
  booked_guests: 76,
  returning_here: 9,
  crossed_from_sister: 5,
  new_to_group: 62,
  walk_in_guests: 34,
};

test('outlet and group retention are DIFFERENT numbers', () => {
  // The whole reason there are two metrics: a guest returning to the group at
  // another venue is not a new guest, and is not a win for this venue either.
  const r = retentionRates(NEON_PIGEON);

  assert.equal(r.outlet_pct, 11.8);
  assert.equal(r.group_pct, 18.4);
  assert.equal(r.cross_venue_pct, 6.6);
});

test('the three categories are mutually exclusive and sum to the whole', () => {
  const { returning_here, crossed_from_sister, new_to_group, booked_guests } = NEON_PIGEON;
  assert.equal(returning_here + crossed_from_sister + new_to_group, booked_guests);

  const r = retentionRates(NEON_PIGEON);
  assert.equal(Math.round((r.outlet_pct! + r.cross_venue_pct! + r.new_pct!) * 10) / 10, 100);
});

test('coverage says how much of the venue the metric can see', () => {
  // 76 booked against 34 walk-ins: this describes 69% of Neon Pigeon's guests.
  assert.equal(retentionRates(NEON_PIGEON).coverage_pct, 69.1);
});

test('a period with no guests returns null, never zero', () => {
  // 0% retention and "nobody came" are different facts, and a zero would be
  // averaged into a trend as though it were a measurement.
  const empty = retentionRates({
    booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0,
  });
  assert.equal(empty.outlet_pct, null);
  assert.equal(empty.group_pct, null);
  assert.equal(empty.coverage_pct, null);
});

// --- the caveats, which travel with the numbers ---------------------------

test('walk-in exclusion is always stated', () => {
  const notes = retentionCaveats(NEON_PIGEON);
  assert.ok(notes.some(n => /BOOKED GUESTS ONLY/.test(n)));
  assert.ok(notes.some(n => /not diners/.test(n)));
});

test('low coverage is called out', () => {
  // Neon Pigeon is 31% walk-in, so this metric misses nearly a third of it.
  assert.ok(retentionCaveats(NEON_PIGEON).some(n => /69\.1% of this period's guests are booked/.test(n)));
});

test('good coverage does not raise the coverage warning', () => {
  const notes = retentionCaveats({ ...NEON_PIGEON, walk_in_guests: 5, booked_guests: 200, new_to_group: 150, crossed_from_sister: 40 });
  assert.ok(!notes.some(n => /invisible to this metric/.test(n)));
});

test('the small cross-venue count is flagged — it is the one people over-read', () => {
  // Twelve guests group-wide. A normal fluctuation is several, which is tens
  // of percent of the metric.
  const notes = retentionCaveats({ ...NEON_PIGEON, booked_guests: 200, crossed_from_sister: 12, new_to_group: 179 });
  assert.ok(notes.some(n => /too small to compare week to week/.test(n)));
});

test('a tiny period is flagged wholesale rather than per-column', () => {
  const notes = retentionCaveats({
    booked_guests: 11, returning_here: 1, crossed_from_sister: 0, new_to_group: 10, walk_in_guests: 2,
  });
  assert.ok(notes.some(n => /too few to read a change/.test(n)));
  assert.ok(MIN_SAMPLE_FOR_TREND > 11);
});

// --- windows ---------------------------------------------------------------

test('a rolling window is whole weeks, ending on the given Sunday', () => {
  assert.deepEqual(rollingWindow('2026-08-23', 4), { start: '2026-07-27', end: '2026-08-23' });
  const { start, end } = rollingWindow('2026-08-23', 4);
  assert.equal((Date.parse(end) - Date.parse(start)) / 86400000, 27);  // 28 days inclusive
});

test('one week is the degenerate case and still works', () => {
  assert.deepEqual(rollingWindow('2026-08-23', 1), { start: '2026-08-17', end: '2026-08-23' });
});

test('a nonsense date is rejected', () => {
  assert.throws(() => rollingWindow('not-a-date'));
});

// --- group totals ----------------------------------------------------------

test('venues sum to the group figures measured', () => {
  const group = totalCounts([
    { booked_guests: 166, returning_here: 19, crossed_from_sister: 5, new_to_group: 142, walk_in_guests: 26 },
    { booked_guests: 114, returning_here: 14, crossed_from_sister: 2, new_to_group: 98, walk_in_guests: 26 },
    NEON_PIGEON,
  ]);

  assert.equal(group.booked_guests, 356);
  assert.equal(group.returning_here, 42);
  assert.equal(group.crossed_from_sister, 12);
  assert.equal(group.new_to_group, 302);

  const r = retentionRates(group);
  assert.equal(r.outlet_pct, 11.8);
  assert.equal(r.group_pct, 15.2);
  assert.equal(r.cross_venue_pct, 3.4);
});

test('an empty group is null, not zero', () => {
  assert.equal(retentionRates(totalCounts([])).outlet_pct, null);
});

// --- cohorts ---------------------------------------------------------------

const cohort = (over: Partial<{ cohort_start: string; cohort_size: number; returned: number; is_mature: boolean }> = {}) => ({
  cohort_start: over.cohort_start ?? '2025-01-01',
  cohort_size: over.cohort_size ?? 1000,
  returned: over.returned ?? 150,
  is_mature: over.is_mature ?? true,
});

test('a cohort rate is returned within the window over cohort size', () => {
  const [r] = cohortRates([cohort({ cohort_size: 1000, returned: 150 })]);
  assert.equal(r.return_pct, 15);
});

test('an IMMATURE cohort is marked, not silently dropped', () => {
  // The most dangerous row in the table: its guests have not had the full
  // window, so a near-zero rate plotted at the right-hand edge reads exactly
  // like retention collapsing.
  const [r] = cohortRates([cohort({ is_mature: false, returned: 4 })]);

  assert.equal(r.return_pct, 0.4);
  assert.match(r.warning!, /INCOMPLETE/);
  assert.match(r.warning!, /Do NOT compare/);
});

test('a mature cohort of normal size carries no warning', () => {
  assert.equal(cohortRates([cohort()])[0].warning, undefined);
});

test('a tiny cohort is flagged even when mature', () => {
  const [r] = cohortRates([cohort({ cohort_size: 8, returned: 2 })]);
  assert.match(r.warning!, /too few/);
  assert.ok(MIN_COHORT_SIZE > 8);
});

test('cohorts come back in date order whatever order they arrive in', () => {
  const rows = cohortRates([
    cohort({ cohort_start: '2025-07-01' }),
    cohort({ cohort_start: '2024-01-01' }),
    cohort({ cohort_start: '2025-01-01' }),
  ]);
  assert.deepEqual(rows.map(r => r.cohort_start), ['2024-01-01', '2025-01-01', '2025-07-01']);
});

test('comparableCohorts excludes exactly what must not be compared', () => {
  const all = [
    cohort({ cohort_start: '2024-01-01' }),
    cohort({ cohort_start: '2024-04-01', cohort_size: 5, returned: 1 }),   // too small
    cohort({ cohort_start: '2026-04-01', is_mature: false, returned: 3 }), // too new
  ];

  assert.equal(comparableCohorts(all).length, 1);
  // The full list still returns all three — an excluded row must be visible.
  assert.equal(cohortRates(all).length, 3);
});

test('an empty cohort is null rather than 0%', () => {
  const [r] = cohortRates([cohort({ cohort_size: 0, returned: 0 })]);
  assert.equal(r.return_pct, null);
});
