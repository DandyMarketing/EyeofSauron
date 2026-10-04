/**
 * The food cost line, and the three ways it draws something untrue.
 *
 *   - a month with no closed P&L plotted as 0%, which draws a collapse in the
 *     most important cost line in the business;
 *   - the points either side of a gap joined up, which claims a measurement
 *     nobody took;
 *   - the current month included, which is partial purchases against partial
 *     sales and would always be the last point, so it would look like the trend.
 *
 * All three produce a plausible picture, which is why they are tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trailingMonths, costTrend, trendNote, type MonthInput } from './cost-trend.js';
import type { PLRow } from './cost-ratios.js';

const line = (canonical: string, amount: number, over: Partial<PLRow> = {}): PLRow => ({
  account_name: canonical, canonical_account: canonical, business_line: 'main',
  section: 'Less Cost of Sales', amount, is_summary: false, ...over,
});

const month = (start: string, foodCogs: number | null, sales = 100000): MonthInput => ({
  start,
  rows: foodCogs === null ? [] : [line('COGS - Food', foodCogs), line('COGS - Beverages', sales * 0.3 * 0.25)],
  sales: { food_sales: sales * 0.7, beverage_sales: sales * 0.3 },
});

describe('which months are plotted', () => {
  test('the six complete months before this one, oldest first', () => {
    assert.deepEqual(trailingMonths('2026-10-04', 6), [
      '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01',
    ]);
  });

  test('the CURRENT month is excluded', () => {
    /**
     * It is partial purchases against partial sales, and it would always be the
     * last point — so a month that happens to have had a big delivery on the 2nd
     * would look like the trend turning.
     */
    assert.ok(!trailingMonths('2026-10-04', 6).includes('2026-10-01'));
  });

  test('it crosses a year boundary', () => {
    assert.deepEqual(trailingMonths('2027-01-15', 3), ['2026-10-01', '2026-11-01', '2026-12-01']);
  });

  test('a bad date throws rather than returning a plausible span', () => {
    assert.throws(() => trailingMonths('not-a-date'));
  });
});

describe('the points', () => {
  test('a month with a P&L gets its percentage', () => {
    const [p] = costTrend([month('2026-09-01', 24500)]);
    assert.equal(p.month, '2026-09');
    assert.equal(p.label, 'Sep');
    assert.equal(p.available, true);
    assert.equal(p.food_pct, 35);        // 24,500 / 70,000
  });

  test('a month with NO P&L is null and flagged, never zero', () => {
    /**
     * This is the one that matters. A 0% food cost drawn on a chart is a
     * collapse in the biggest controllable number in the business, and it would
     * be the most alarming thing on the dashboard — caused entirely by an
     * uningested month.
     */
    const [p] = costTrend([month('2026-09-01', null)]);
    assert.equal(p.available, false);
    assert.equal(p.food_pct, null);
    assert.equal(p.beverage_pct, null);
  });

  test('a month with costs and no sales has no percentage either', () => {
    // Different fact from a missing feed: there are costs, there is no
    // denominator. Both are null and only one is `available: false`.
    const [p] = costTrend([{
      start: '2026-09-01',
      rows: [line('COGS - Food', 5000)],
      sales: { food_sales: 0, beverage_sales: 0 },
    }]);
    assert.equal(p.available, true);
    assert.equal(p.food_pct, null);
    assert.equal(p.food_cogs, 5000);
  });

  test('unclassified cost of sales is carried per month', () => {
    // If an account is mapped in one month and not the next, the line moves for
    // a reason that is not the kitchen, and that is invisible from the shape.
    const [p] = costTrend([{
      start: '2026-09-01',
      rows: [line('COGS - Food', 24500), line('Packaging', 1200)],
      sales: { food_sales: 70000, beverage_sales: 30000 },
    }]);
    assert.equal(p.unclassified_total, 1200);
  });
});

describe('the sentence under the line', () => {
  test('names the move in POINTS, from the first real month', () => {
    /**
     * Points, not percent. A move from 30% to 34% is four POINTS and a 13%
     * rise, and calling it 13% invites somebody to apply it to a different base.
     */
    const note = trendNote(costTrend([
      month('2026-07-01', 21000),    // 30%
      month('2026-08-01', 22400),    // 32%
      month('2026-09-01', 23800),    // 34%
    ]));
    assert.match(note, /Food cost is up 4 points since Jul, at 34%/);
  });

  test('a flat line is described as flat rather than as a tiny move', () => {
    const note = trendNote(costTrend([month('2026-08-01', 21000), month('2026-09-01', 21070)]));
    assert.match(note, /has held near/);
  });

  test('a gap is named, and said to be a gap rather than a zero', () => {
    const note = trendNote(costTrend([
      month('2026-07-01', 21000),
      month('2026-08-01', null),
      month('2026-09-01', 23800),
    ]));
    assert.match(note, /Aug has no closed P&L and is left as a gap rather than a zero/);
  });

  test('the move is measured between months that EXIST', () => {
    // With May missing, "since May" would be a claim about a month nobody
    // measured.
    const note = trendNote(costTrend([
      month('2026-05-01', null),
      month('2026-06-01', 21000),
      month('2026-07-01', 23800),
    ]));
    assert.match(note, /since Jun/);
    assert.ok(!/since May/.test(note), note);
  });

  test('one month is not a trend and says so', () => {
    assert.match(trendNote(costTrend([month('2026-09-01', 21000)])), /no trend to read yet/);
  });

  test('no months at all reports missing, never zero', () => {
    const note = trendNote(costTrend([month('2026-08-01', null), month('2026-09-01', null)]));
    assert.match(note, /missing, not zero/);
  });

  test('a classification that changes between months is flagged', () => {
    // Reported when it is PARTIAL — every month having some packaging is
    // normal, one month having it is a basis difference.
    const note = trendNote(costTrend([
      { start: '2026-08-01', rows: [line('COGS - Food', 21000)], sales: { food_sales: 70000, beverage_sales: 30000 } },
      { start: '2026-09-01', rows: [line('COGS - Food', 21000), line('Packaging', 900)], sales: { food_sales: 70000, beverage_sales: 30000 } },
    ]));
    assert.match(note, /Sep (has|have) cost-of-sales accounts that are neither food nor beverage/);
  });

  test('unclassified in EVERY month is not flagged as a basis change', () => {
    // It is the normal state, not a difference between the points.
    const rows = [line('COGS - Food', 21000), line('Packaging', 900)];
    const note = trendNote(costTrend([
      { start: '2026-08-01', rows, sales: { food_sales: 70000, beverage_sales: 30000 } },
      { start: '2026-09-01', rows, sales: { food_sales: 70000, beverage_sales: 30000 } },
    ]));
    assert.ok(!/not measured on quite the same basis/.test(note), note);
  });
});
