/**
 * Revel's business day runs past midnight, so 12 AM-5 AM rows are the END of
 * the shift. Neon Pigeon, 10 Oct 2026: 12 AM $214, 1 AM $14, filed under the
 * Saturday they belong to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMealPeriods, serviceOrder, isDaytime } from './meal-periods.js';

const hour = (h: number, sales: number, transactions = 1) =>
  ({ hour: h, timeLabel: '', transactions, items: 1, avgCheck: null, sales, pctSales: 0 });

test('after-midnight hours sort after 11 PM, not before lunch', () => {
  const sorted = [0, 1, 12, 18, 21, 23].sort((a, b) => serviceOrder(a) - serviceOrder(b));
  assert.deepEqual(sorted, [12, 18, 21, 23, 0, 1]);
});

test('after midnight is dinner, the day side is lunch', () => {
  assert.equal(isDaytime(0), false);
  assert.equal(isDaytime(1), false);
  assert.equal(isDaytime(5), false);
  assert.equal(isDaytime(6), true);
  assert.equal(isDaytime(12), true);
  assert.equal(isDaytime(16), true);
  assert.equal(isDaytime(17), false);
});

test('the late bills count towards dinner in the meal-period split', () => {
  const periods = deriveMealPeriods(
    { hours: [hour(12, 1000), hour(21, 2055), hour(23, 412), hour(0, 214), hour(1, 14, 0)], totals: {} as any },
    { venueSlug: 'neon-pigeon', businessDate: '2026-10-10' },
  );
  assert.equal(periods.find(p => p.period === 'lunch')?.sales, 1000);
  assert.equal(periods.find(p => p.period === 'dinner')?.sales, 2055 + 412 + 214 + 14);
});
