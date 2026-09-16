import { test } from 'node:test';
import assert from 'node:assert';
import { aggregateLabour, withoutCost, GROUP_LABEL, type LabourRow } from './labour.js';

/**
 * Two of these tests exist because the arithmetic they check is wrong by a
 * factor nobody can see in the output. A venue reporting 140 staff, or a labour
 * percentage of exactly half the real one, looks like a number rather than like
 * a bug.
 */

const row = (over: Partial<LabourRow> = {}): LabourRow => ({
  venue_id: 'v1',
  business_date: '2026-09-08',
  area: 'BOH',
  scheduled_hours: 40,
  actual_hours: 44,
  overtime_hours: 4,
  basic_cost: 500,
  overtime_cost: 48,
  weekend_cost: 0,
  event_cost: 0,
  other_cost: 0,
  total_cost: 548,
  staff_count: 6,
  ...over,
});

const opts = (groupBy: any, sales: Record<string, number> = {}) => ({
  groupBy,
  venueName: (id: string) => (id === 'v1' ? 'Fat Prince' : 'Neon Pigeon'),
  fbSales: (venueId: string, date: string) => sales[`${venueId}|${date}`] ?? 0,
});

test('headcount is the largest single reading, never a sum', () => {
  // A week of BOH days at six people each is six people who came in five times,
  // not thirty people. Summing reports a venue employing five times its actual
  // staff, and reads as a plausible number.
  const week = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']
    .map(d => row({ business_date: d, staff_count: 6 }));
  week.push(row({ business_date: '2026-09-13', staff_count: 9 }));

  const [bucket] = aggregateLabour(week, opts('total'));

  assert.equal(bucket.peak_staff_count, 9);
  assert.notEqual(bucket.peak_staff_count, 39);
});

test('headcount does not double-count somebody working both sections', () => {
  const [bucket] = aggregateLabour(
    [row({ area: 'BOH', staff_count: 6 }), row({ area: 'FOH', staff_count: 7 })],
    opts('total'),
  );
  assert.equal(bucket.peak_staff_count, 7);
});

test('one day of sales is counted once however many sections worked it', () => {
  // THE BUG THIS EXISTS FOR. Labour rows are per section, sales are per day. A
  // day with a BOH row and an FOH row adds its sales twice, which halves the
  // labour percentage -- in a figure that still looks entirely reasonable.
  const rows = [
    row({ area: 'BOH', total_cost: 500 }),
    row({ area: 'FOH', total_cost: 500 }),
  ];

  const [bucket] = aggregateLabour(rows, opts('total', { 'v1|2026-09-08': 5000 }));

  assert.equal(bucket.fb_sales, 5000, 'the day was counted twice');
  assert.equal(bucket.days_counted, 1);
  assert.equal(bucket.total_cost, 1000);
  assert.equal(bucket.labour_pct_of_fb_sales, 20);
});

test('sales accumulate across days, once each', () => {
  const rows = [
    row({ business_date: '2026-09-08', area: 'BOH' }),
    row({ business_date: '2026-09-08', area: 'FOH' }),
    row({ business_date: '2026-09-09', area: 'BOH' }),
  ];

  const [bucket] = aggregateLabour(rows, opts('total', {
    'v1|2026-09-08': 5000,
    'v1|2026-09-09': 4000,
  }));

  assert.equal(bucket.fb_sales, 9000);
  assert.equal(bucket.days_counted, 2);
});

test('no sales means no percentage, not a zero percentage', () => {
  // 0.0% reads as a venue with no labour cost, which is a claim. Migration 039:
  // 46,318.00 of cost was once written against 0.0 hours and reported success.
  const [bucket] = aggregateLabour([row()], opts('total'));
  assert.equal(bucket.fb_sales, 0);
  assert.equal(bucket.labour_pct_of_fb_sales, null);
});

test('the scheduled-to-actual variance is kept, because it is the point', () => {
  const [bucket] = aggregateLabour(
    [row({ scheduled_hours: 40, actual_hours: 47.5 })],
    opts('total'),
  );
  assert.equal(bucket.hours_variance, 7.5);
});

test('the implied overtime rate is a division, and null when nobody worked any', () => {
  // One blended figure across everybody, never per person. It is what tells you
  // whether an overtime hour is cheaper than a basic one -- in which case the
  // universal advice to cut overtime is backwards here.
  const [paid] = aggregateLabour([row({ overtime_hours: 4, overtime_cost: 48 })], opts('total'));
  assert.equal(paid.implied_overtime_rate, 12);

  const [none] = aggregateLabour([row({ overtime_hours: 0, overtime_cost: 0 })], opts('total'));
  assert.equal(none.implied_overtime_rate, null);
});

test('BOH and FOH stay apart, which is the split the whole table exists for', () => {
  const buckets = aggregateLabour(
    [row({ area: 'BOH', actual_hours: 44 }), row({ area: 'FOH', actual_hours: 30 })],
    opts('area'),
  );

  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map(b => b.area), ['BOH', 'FOH']);
  assert.equal(buckets[0].actual_hours, 44);
});

test('group staff are labelled and never folded into a venue', () => {
  // Migration 038: their hours are worked across every venue, the split is a
  // judgement, and a judgement stored as a measurement is the failure this
  // codebase keeps finding.
  const buckets = aggregateLabour(
    [row(), row({ venue_id: null, area: 'GROUP' })],
    opts('total'),
  );

  assert.equal(buckets.length, 2);
  assert.ok(buckets.some(b => b.venue === GROUP_LABEL));
  const group = buckets.find(b => b.venue === GROUP_LABEL)!;
  assert.equal(group.fb_sales, 0, 'group staff have no venue, so no sales to divide by');
  assert.equal(group.labour_pct_of_fb_sales, null);
});

test('rows come back in a stable order whatever order the database returned them', () => {
  const buckets = aggregateLabour(
    [
      row({ business_date: '2026-09-10' }),
      row({ business_date: '2026-09-08' }),
      row({ business_date: '2026-09-09' }),
    ],
    opts('day'),
  );
  assert.deepEqual(buckets.map(b => b.business_date), ['2026-09-08', '2026-09-09', '2026-09-10']);
});

test('numeric strings from Postgres are added, not concatenated', () => {
  // numeric(10,2) arrives as a string through PostgREST. '40' + '40' is '4040'.
  const [bucket] = aggregateLabour(
    [row({ actual_hours: '40' as any }), row({ area: 'FOH', actual_hours: '40' as any })],
    opts('total'),
  );
  assert.equal(bucket.actual_hours, 80);
});

// --- the payroll wall ------------------------------------------------------

test('redaction removes every amount and keeps the percentage', () => {
  // CLAUDE.md: managers see labour percentage, never individual pay. Hours and
  // headcount are what rostering needs and carry no pay.
  const [bucket] = aggregateLabour([row()], opts('total', { 'v1|2026-09-08': 5000 }));
  const safe = withoutCost(bucket) as Record<string, unknown>;

  for (const field of ['basic_cost', 'overtime_cost', 'weekend_cost', 'event_cost', 'other_cost', 'total_cost']) {
    assert.equal(safe[field], undefined, `${field} survived redaction`);
  }

  assert.equal(safe.labour_pct_of_fb_sales, bucket.labour_pct_of_fb_sales);
  assert.equal(safe.actual_hours, bucket.actual_hours);
  assert.equal(safe.peak_staff_count, bucket.peak_staff_count);
  assert.match(String(safe.redacted), /payroll/);
});

test('the implied overtime RATE is redacted too', () => {
  // A rate and the hours beside it multiply back to the cost that was just
  // withheld, which would make the redaction decorative.
  const [bucket] = aggregateLabour([row()], opts('total'));
  const safe = withoutCost(bucket) as Record<string, unknown>;
  assert.equal(safe.implied_overtime_rate, undefined);
  assert.ok(bucket.implied_overtime_rate !== null, 'the test row must have a rate to redact');
});

test('no field in the output could identify a person', () => {
  // The strongest guarantee here is structural: there is no user id in the
  // table, so there is nothing for this to leak. Pinned anyway, because a
  // future field added for convenience is exactly how that stops being true.
  const [bucket] = aggregateLabour([row()], opts('total'));
  const forbidden = /user|employee|staff_name|person|name|email|nric|rate_per|hourly/i;

  for (const key of Object.keys(bucket)) {
    if (key === 'venue' || key === 'peak_staff_count') continue;
    assert.ok(!forbidden.test(key), `"${key}" looks like it could carry a person`);
  }
});
