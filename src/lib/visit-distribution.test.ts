import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyDistribution, distributionCaveats, rateChange,
  MIN_VISITS_FOR_RATE, CENSORING_DAYS, type VisitRow,
} from './visit-distribution.js';

const row = (month: string, n: number, visits: number, venue: string | null = null): VisitRow =>
  ({ venue_id: venue, month_start: month, visit_number: n, visits });

/** A month with a realistic mix: mostly first-timers, a thin returning tail. */
const MARCH: VisitRow[] = [
  row('2026-03-01', 1, 800),
  row('2026-03-01', 2, 120),
  row('2026-03-01', 3, 40),
  row('2026-03-01', 4, 40),
];

describe('monthlyDistribution', () => {
  test('buckets fold into one row per month and sum to footfall', () => {
    const [march] = monthlyDistribution(MARCH);

    assert.equal(march.first, 800);
    assert.equal(march.second, 120);
    assert.equal(march.third, 40);
    assert.equal(march.fourth_plus, 40);
    assert.equal(march.total_visits, 1000);
  });

  test('the return rate is everything that was not a first visit', () => {
    const [march] = monthlyDistribution(MARCH);
    assert.equal(march.return_visits, 200);
    assert.equal(march.return_rate_pct, 20);
  });

  test('a bucket with no row is zero, not absent', () => {
    // A missing "third visit" line and a genuine zero are different facts, and
    // a caller iterating the buckets should not have to tell them apart.
    const [m] = monthlyDistribution([row('2026-03-01', 1, 50)]);

    assert.equal(m.second, 0);
    assert.equal(m.third, 0);
    assert.equal(m.fourth_plus, 0);
  });

  test('visit numbers above 4 fold into fourth_plus rather than vanishing', () => {
    // The RPC caps at 4, but nothing stops a caller passing raw ranks, and a
    // dropped bucket would silently shrink the denominator.
    const [m] = monthlyDistribution([row('2026-03-01', 1, 10), row('2026-03-01', 9, 5)]);
    assert.equal(m.fourth_plus, 5);
    assert.equal(m.total_visits, 15);
  });

  test('an empty month is unmeasurable, never 0%', () => {
    // The dangerous default: 0% return reads as a catastrophe rather than as
    // no data, and it would plot as a real point on a trend.
    const [m] = monthlyDistribution([row('2026-03-01', 1, 0)]);
    assert.equal(m.total_visits, 0);
    assert.equal(m.return_rate_pct, null);
  });

  test('months come back oldest first', () => {
    const months = monthlyDistribution([row('2026-05-01', 1, 5), row('2026-01-01', 1, 5)]);
    assert.deepEqual(months.map(m => m.month_start), ['2026-01-01', '2026-05-01']);
  });

  test('a thin month is flagged, and its rate is still returned', () => {
    // Returned rather than hidden: a hole is filled with a guess, and a guess
    // is worse than a number carrying a warning.
    const [m] = monthlyDistribution([row('2026-03-01', 1, 10), row('2026-03-01', 2, 5)]);

    assert.ok(m.low_sample);
    assert.equal(m.return_rate_pct, 33.3);
  });

  test('a busy month is not flagged thin', () => {
    const [m] = monthlyDistribution(MARCH);
    assert.equal(m.low_sample, false);
    assert.ok(MARCH.reduce((n, r) => n + r.visits, 0) >= MIN_VISITS_FOR_RATE);
  });
});

describe('left-censoring', () => {
  test('months inside the first year of data are flagged', () => {
    // A guest whose first visit predates our records counts as a first-timer,
    // so the earliest months overstate acquisition and understate returns.
    const months = monthlyDistribution(
      [row('2022-02-01', 1, 500), row('2024-02-01', 1, 500)],
      '2022-01-01',
    );

    assert.equal(months[0].left_censored, true);
    assert.equal(months[1].left_censored, false);
  });

  test('the boundary is the stated window, not a guess', () => {
    assert.equal(CENSORING_DAYS, 365);
    const months = monthlyDistribution([row('2023-01-01', 1, 10)], '2022-01-01');
    // 2023-01-01 is exactly 365 days after the start, so it is clear.
    assert.equal(months[0].left_censored, false);
  });

  test('with no known data start, nothing is claimed either way', () => {
    // Guessing a start date would mark real months as unreliable, or worse,
    // clear censored ones.
    const [m] = monthlyDistribution([row('2022-02-01', 1, 500)]);
    assert.equal(m.left_censored, false);
  });
});

describe('distributionCaveats', () => {
  test('the three standing caveats are always present', () => {
    const caveats = distributionCaveats(monthlyDistribution(MARCH));
    const text = caveats.join(' ');

    assert.match(text, /VISITS, not guests/);
    assert.match(text, /Booked guests only/);
    assert.match(text, /do not add up/);
  });

  test('censoring is named with the month it runs to, not just asserted', () => {
    const months = monthlyDistribution(
      [row('2022-02-01', 1, 500), row('2022-06-01', 1, 500), row('2025-01-01', 1, 500)],
      '2022-01-01',
    );
    const text = distributionCaveats(months).join(' ');

    assert.match(text, /LEFT-CENSORED/);
    assert.match(text, /2022-06-01/);
    assert.match(text, /partly the data filling in/);
  });

  test('a clean set of months gets no censoring or sample caveat', () => {
    // A caveat that applies sometimes and is stated always stops being read.
    const caveats = distributionCaveats(monthlyDistribution(MARCH, '2020-01-01'));
    assert.equal(caveats.length, 3);
  });
});

describe('rateChange', () => {
  test('it compares the first and last months that can carry a comparison', () => {
    const months = monthlyDistribution([
      row('2026-01-01', 1, 800), row('2026-01-01', 2, 200),
      row('2026-06-01', 1, 700), row('2026-06-01', 2, 300),
    ]);

    const change = rateChange(months)!;
    assert.equal(change.from.month_start, '2026-01-01');
    assert.equal(change.to.month_start, '2026-06-01');
    assert.equal(change.change_pts, 10);
  });

  test('censored and thin months are excluded from the endpoints', () => {
    // Otherwise a censored month at one end and a thin one at the other become
    // "retention improved nine points" out of nothing.
    const months = monthlyDistribution([
      row('2022-02-01', 1, 990), row('2022-02-01', 2, 10),    // censored
      row('2024-01-01', 1, 800), row('2024-01-01', 2, 200),
      row('2024-06-01', 1, 700), row('2024-06-01', 2, 300),
      row('2024-09-01', 1, 8),   row('2024-09-01', 2, 2),     // thin
    ], '2022-01-01');

    const change = rateChange(months)!;
    assert.equal(change.from.month_start, '2024-01-01');
    assert.equal(change.to.month_start, '2024-06-01');
  });

  test('fewer than two usable months means no verdict, not a zero', () => {
    const months = monthlyDistribution([row('2026-01-01', 1, 800), row('2026-01-01', 2, 200)]);
    assert.equal(rateChange(months), null);
  });

  test('no months at all is null rather than a throw', () => {
    assert.equal(rateChange([]), null);
  });
});
