import { test } from 'node:test';
import assert from 'node:assert';
import {
  monthlyLeadTime,
  leadTimeCaveats,
  medianChange,
  MIN_BOOKINGS_FOR_MEDIAN,
  TAIL_RATIO,
  type LeadTimeRow,
} from './booking-lead-time.js';

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
