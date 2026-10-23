import { test } from 'node:test';
import assert from 'node:assert';
import { chooseGrouping, bucketDays, DAILY_HARD_MAX, type DayRow } from './ops-buckets.js';

const day = (date: string, over: Partial<DayRow> = {}): DayRow => ({
  date, food_bev_sales: 1000, gross_sales: 1000, net_sales: 1050, service_charge: 100,
  total_discounts: 50, food_sales: 400, beverage_sales: 600, covers: 10,
  walk_in_covers: 2, no_show_covers: 1, transactions: 5, ...over,
});

test('a short range stays day by day; a long one is folded unless asked otherwise', () => {
  assert.deepStrictEqual(chooseGrouping(undefined, 31), { grouping: 'day' });
  assert.deepStrictEqual(chooseGrouping(undefined, 32), { grouping: 'week' });
  assert.deepStrictEqual(chooseGrouping(undefined, 120), { grouping: 'week' });
  assert.deepStrictEqual(chooseGrouping(undefined, 183), { grouping: 'month' });
  assert.deepStrictEqual(chooseGrouping('month', 10), { grouping: 'month' });
  assert.deepStrictEqual(chooseGrouping('weekday', 183), { grouping: 'weekday' });
  assert.deepStrictEqual(chooseGrouping('day', DAILY_HARD_MAX), { grouping: 'day' });
  assert.deepStrictEqual(chooseGrouping('nonsense', 10), { grouping: 'day' });
});

test('day rows past the hard limit are refused with a reason, never sent', () => {
  const g = chooseGrouping('day', 183);
  assert.strictEqual(g.grouping, 'month');
  assert.match(g.note!, /stop at 93 days/);
});

test('weeks start on Monday and months on the 1st', () => {
  // 2026-10-04 is a Sunday, 05 a Monday.
  const weeks = bucketDays([day('2026-10-04'), day('2026-10-05'), day('2026-10-11'), day('2026-10-12')], 'week');
  assert.deepStrictEqual(weeks.map(w => [w.period, w.days]), [['week of 2026-09-28', 1], ['week of 2026-10-05', 2], ['week of 2026-10-12', 1]]);
  const months = bucketDays([day('2026-09-30'), day('2026-10-01'), day('2026-10-31')], 'month');
  assert.deepStrictEqual(months.map(m => [m.period, m.first_day, m.last_day, m.days]), [['2026-09', '2026-09-30', '2026-09-30', 1], ['2026-10', '2026-10-01', '2026-10-31', 2]]);
});

test('a bucket is the sum of its days, and its averages are per day traded', () => {
  const [m] = bucketDays([
    day('2026-10-01'),
    day('2026-10-02', { food_bev_sales: 3000, gross_sales: 3000, food_sales: 1200, beverage_sales: 1800, covers: 30, transactions: 15, net_sales: 3150 }),
    // Closed: zeros, counted as a day but not a trading day.
    day('2026-10-04', { closed: true, food_bev_sales: 0, gross_sales: 0, net_sales: 0, service_charge: 0, total_discounts: 0, food_sales: 0, beverage_sales: 0, covers: null, walk_in_covers: null, no_show_covers: null, transactions: 0 }),
  ], 'month');
  assert.strictEqual(m.days, 3);
  assert.strictEqual(m.trading_days, 2);
  assert.strictEqual(m.closed_days, 1);
  assert.strictEqual(m.food_bev_sales, 4000);
  assert.strictEqual(m.covers, 40);
  assert.strictEqual(m.avg_spend_per_head, 100);
  assert.strictEqual(m.avg_daily_food_bev_sales, 2000);
  assert.strictEqual(m.avg_daily_covers, 20);
  assert.strictEqual(m.avg_check, 210);
  assert.strictEqual(m.food_pct, 40);
  assert.strictEqual(m.discount_rate_pct, 2.5);
  assert.strictEqual(m.days_without_covers, undefined);
});

test('a trading day without covers is named and cannot inflate spend per head', () => {
  const [m] = bucketDays([day('2026-10-01'), day('2026-10-02', { covers: null })], 'month');
  assert.strictEqual(m.days_without_covers, 1);
  assert.strictEqual(m.covers, 10);
  // 1,000 over 10 covers -- the uncovered day's sales are left out of the ratio.
  assert.strictEqual(m.avg_spend_per_head, 100);
  assert.strictEqual(m.food_bev_sales, 2000);
});

test('weekday rows run Monday to Sunday whatever order the days arrive in', () => {
  const rows = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-11', '2026-10-12'].map(d => day(d));
  const w = bucketDays(rows, 'weekday');
  assert.deepStrictEqual(w.map(b => [b.period, b.days]), [['Monday', 2], ['Tuesday', 1], ['Sunday', 2]]);
});

test('a half-year by month is a fraction of its day rows', () => {
  const rows: DayRow[] = [];
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2026, 5, 30); t += 86400000) rows.push(day(new Date(t).toISOString().slice(0, 10)));
  const months = bucketDays(rows, 'month');
  assert.strictEqual(months.length, 6);
  assert.ok(JSON.stringify(months).length * 10 < JSON.stringify(rows).length, 'months should be under a tenth of the day rows');
});
