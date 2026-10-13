import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import {
  monthlyLeadTime,
  leadTimeCaveats,
  medianChange,
  MIN_BOOKINGS_FOR_MEDIAN,
  TAIL_RATIO,
  bookingsByCreatedDay,
  type LeadTimeRow,
  type NightReservation,
} from './booking-lead-time.js';
import { readFileSync } from 'node:fs';
import { SHIFT_MAP, parseMealPeriod } from './covers.js';

/**
 * These pin the things that decide whether a lead-time figure is honest: that
 * the median leads and the mean is qualified, that walk-ins are visibly absent
 * rather than quietly absent, and that a thin month cannot be read as a trend.
 */

const row = (over: Partial<LeadTimeRow> = {}): LeadTimeRow => ({
  venue_id: 'v1',
  month_start: '2026-06-01',
  bookings: 100,
  median_days: 4,
  mean_days: 6,
  p90_days: 21,
  same_day: 10,
  days_1_3: 30,
  days_4_7: 30,
  days_8_30: 25,
  days_31_plus: 5,
  walk_ins: 0,
  retrospective: 0,
  ...over,
});

test('bands are turned into shares of the bookings, not of everything', () => {
  const [m] = monthlyLeadTime([row()]);
  assert.equal(m.pct_same_day, 10);
  assert.equal(m.pct_1_3, 30);
  assert.equal(m.pct_31_plus, 5);
});

test('months come back in date order whatever order the database returned them', () => {
  const months = monthlyLeadTime([
    row({ month_start: '2026-07-01' }),
    row({ month_start: '2026-05-01' }),
    row({ month_start: '2026-06-01' }),
  ]);
  assert.deepEqual(months.map(m => m.month_start), ['2026-05-01', '2026-06-01', '2026-07-01']);
});

test('a thin month is flagged and its median still returned', () => {
  // Hiding the figure would leave a hole somebody fills with a guess. Flagging
  // it says what the figure is worth.
  const [m] = monthlyLeadTime([row({ bookings: MIN_BOOKINGS_FOR_MEDIAN - 1 })]);
  assert.equal(m.low_sample, true);
  assert.equal(m.median_days, 4);

  const [ok] = monthlyLeadTime([row({ bookings: MIN_BOOKINGS_FOR_MEDIAN })]);
  assert.equal(ok.low_sample, false);
});

test('walk-ins are reported in the caveats rather than silently dropped', () => {
  // The exclusion is correct and invisible from the numbers, which is exactly
  // the combination that needs saying out loud.
  const caveats = leadTimeCaveats(monthlyLeadTime([row({ walk_ins: 240 })]));
  const text = caveats.join(' ');

  assert.match(text, /240 walk-in/);
  assert.match(text, /zero by definition/);
});

test('a month carried by a long tail is named', () => {
  // A Christmas party booked in September moves the mean and not the median.
  // Quoting the mean there reports a change in behaviour that did not happen.
  const caveats = leadTimeCaveats(monthlyLeadTime([
    row({ median_days: 3, mean_days: 3 * TAIL_RATIO + 1 }),
  ]));
  assert.match(caveats.join(' '), /carried by a few long-lead bookings/);
});

test('an ordinary right skew is not flagged as a tail', () => {
  // Lead time is skewed in every healthy month. A caveat on every row is a
  // caveat nobody reads.
  const caveats = leadTimeCaveats(monthlyLeadTime([row({ median_days: 4, mean_days: 6 })]));
  assert.doesNotMatch(caveats.join(' '), /carried by a few/);
});

test('the future-date exclusion is always stated', () => {
  // The reader cannot see the filter, and without it the most recent month
  // always looks like the best one.
  const caveats = leadTimeCaveats(monthlyLeadTime([row()]));
  assert.match(caveats.join(' '), /future are excluded/);
});

test('retrospective records are called what they are', () => {
  const caveats = leadTimeCaveats(monthlyLeadTime([row({ retrospective: 12 })]));
  assert.match(caveats.join(' '), /created AFTER the date they were for/);
});

test('the change skips thin months at both ends', () => {
  // A series that begins or ends on a quiet month reports a swing that is a
  // sample size, and it is equally wrong at either end.
  const months = monthlyLeadTime([
    row({ month_start: '2026-01-01', bookings: 5, median_days: 30 }),
    row({ month_start: '2026-02-01', bookings: 200, median_days: 6 }),
    row({ month_start: '2026-03-01', bookings: 200, median_days: 3 }),
    row({ month_start: '2026-04-01', bookings: 4, median_days: 40 }),
  ]);

  const change = medianChange(months)!;
  assert.equal(change.from, '2026-02-01');
  assert.equal(change.to, '2026-03-01');
  assert.equal(change.change_days, -3);
});

test('one usable month is not a change', () => {
  const months = monthlyLeadTime([
    row({ month_start: '2026-01-01', bookings: 5 }),
    row({ month_start: '2026-02-01', bookings: 200 }),
  ]);
  assert.equal(medianChange(months), null);
});

test('a month with no bookings gives null shares, never zero', () => {
  // Zero would read as "nobody booked same-day", which is a finding. Null reads
  // as "there is nothing to divide", which is the truth.
  const [m] = monthlyLeadTime([row({ bookings: 0, same_day: 0, days_1_3: 0, days_4_7: 0, days_8_30: 0, days_31_plus: 0, median_days: null, mean_days: null })]);
  assert.equal(m.pct_same_day, null);
  assert.equal(m.median_days, null);
});

import { leadTimeWindow } from './booking-lead-time.js';

test('one night is a one-day window, so an occasion can be measured on its own', () => {
  assert.deepEqual(leadTimeWindow({ business_date: '2025-12-31' }, '2026-10-12'),
    { start: '2025-12-31', end: '2025-12-31', single_night: true });
  // Months still work as before.
  assert.deepEqual(leadTimeWindow({ start_date: '2026-06-01', end_date: '2026-09-30' }, '2026-10-12'),
    { start: '2026-06-01', end: '2026-09-30', single_night: false });
});

test('a night still ahead is refused, and pointed at last year', () => {
  const r = leadTimeWindow({ business_date: '2026-12-31' }, '2026-10-12');
  assert.ok('error' in r && /LAST year/.test(r.error));
  assert.ok('error' in leadTimeWindow({}, '2026-10-12'));
  assert.ok('error' in leadTimeWindow({ business_date: '31/12/2025' }, '2026-10-12'));
});

// --- One meal, and when its bookings were made (13 Oct 2026) ---

/**
 * Firangi Superstar, F1 Champagne Brunch, 10 Oct 2026, as SevenRooms lists it
 * (Khai's screenshot): created date and party size only -- no guest details.
 * 15 bookings for 49 covers, plus 3 walk-ins for 6: the 55 the team counted.
 * Created at noon Singapore time (04:00 UTC) unless the test says otherwise.
 */
const BRUNCH_10_OCT: Array<[string | null, number]> = [
  [null, 2], ['2026-09-16', 2], ['2026-09-10', 8], ['2026-10-06', 2], ['2026-10-01', 4],
  ['2026-09-29', 3], ['2026-09-29', 4], ['2026-09-29', 3], ['2026-08-20', 4], ['2026-10-06', 2],
  ['2026-10-06', 3], ['2026-10-07', 4], ['2026-10-10', 2], ['2026-10-07', 4], [null, 2],
  [null, 2], ['2026-10-05', 2], ['2026-10-03', 2],
];
const night = (rows: Array<[string | null, number]>): NightReservation[] => rows.map(([created, size]) => ({
  business_date: '2026-10-10',
  source_created_at: created ? `${created}T04:00:00Z` : '2026-10-10T04:00:00Z',
  party_size: size,
  status_simple: 'Complete',
  is_walk_in: created === null,
}));

test('the 10 Oct brunch reproduces SevenRooms: 15 bookings, 3 walk-ins, 55 covers', () => {
  const r = bookingsByCreatedDay(night(BRUNCH_10_OCT));
  assert.strictEqual(r.bookings, 15);
  assert.strictEqual(r.covers, 49);
  assert.deepStrictEqual(r.walk_ins, { bookings: 3, covers: 6 });
  assert.strictEqual(r.covers + r.walk_ins.covers, 55);
  assert.deepStrictEqual(
    r.created_by_day.map(d => [d.created, d.days_before, d.bookings, d.covers]),
    [
      ['2026-08-20', 51, 1, 4], ['2026-09-10', 30, 1, 8], ['2026-09-16', 24, 1, 2],
      ['2026-09-29', 11, 3, 10], ['2026-10-01', 9, 1, 4], ['2026-10-03', 7, 1, 2],
      ['2026-10-05', 5, 1, 2], ['2026-10-06', 4, 3, 7], ['2026-10-07', 3, 2, 8],
      ['2026-10-10', 0, 1, 2],
    ],
  );
  // The days the chat credited: no brunch booking was made on either.
  assert.ok(!r.created_by_day.some(d => d.created === '2026-10-08' || d.created === '2026-10-09'));
});

test('the created day is Singapore\'s, and a cancelled booking is a booking made but not covers held', () => {
  const r = bookingsByCreatedDay([
    // 01:30 on 10 Oct in Singapore is still 9 Oct in UTC.
    { business_date: '2026-10-10', source_created_at: '2026-10-09T17:30:00Z', party_size: 2, status_simple: 'Complete', is_walk_in: false },
    { business_date: '2026-10-10', source_created_at: '2026-10-08T04:00:00Z', party_size: 6, status_simple: 'Canceled', is_walk_in: false },
    { business_date: '2026-10-10', source_created_at: '2026-10-11T04:00:00Z', party_size: 2, status_simple: 'Complete', is_walk_in: false },
    { business_date: '2026-10-10', source_created_at: null, party_size: 2, status_simple: 'Complete', is_walk_in: false },
  ]);
  assert.deepStrictEqual(r.created_by_day, [
    { created: '2026-10-08', days_before: 2, bookings: 1, covers: 0, cancelled: 1 },
    { created: '2026-10-10', days_before: 0, bookings: 1, covers: 2, cancelled: 0 },
  ]);
  assert.strictEqual(r.retrospective, 1);
  assert.strictEqual(r.no_created_date, 1);
});

test('cancellations are counted beside the lead time, so it reconciles with SevenRooms\' list', () => {
  const [m] = monthlyLeadTime([row({ bookings: 40, cancelled: 5 })]);
  assert.strictEqual(m.cancelled, 5);
  assert.strictEqual(m.active_bookings, 35);
  assert.ok(leadTimeCaveats([m]).some(c => c.includes('5 of the bookings counted were later cancelled')));
  // Before migration 059 the column is absent: not measured, never zero.
  const [old] = monthlyLeadTime([row({ bookings: 40 })]);
  assert.strictEqual(old.cancelled, null);
  assert.strictEqual(old.active_bookings, null);
});

test('a meal means the same in SQL as in TypeScript', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/059_booking_lead_time_by_meal.sql', import.meta.url), 'utf8');
  for (const [shift, meal] of Object.entries(SHIFT_MAP)) {
    assert.match(sql, new RegExp(`when '${shift}'\\s+then '${meal}'`), `${shift} -> ${meal} missing from meal_period()`);
  }
  assert.match(sql, /< 15 then 'lunch'/);
});

test('a meal asked for is checked', () => {
  assert.strictEqual(parseMealPeriod('Brunch'), 'brunch');
  assert.strictEqual(parseMealPeriod(undefined), null);
  assert.strictEqual(parseMealPeriod('all'), null);
  assert.ok(typeof parseMealPeriod('supper') === 'object');
});
