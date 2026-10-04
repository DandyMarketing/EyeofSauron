/**
 * The group line. Every figure on it is a chance to average something that
 * should have been summed.
 *
 * A group discount rate taken as the mean of three venue rates weights a quiet
 * Tuesday venue the same as a busy one, and comes out as a number nobody can
 * act on and nobody can tell is wrong. Same for spend per head and food share.
 * The rates here are recomputed from the summed parts, and these tests are the
 * only thing that says so.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rollUp, type VenueWeek } from './dashboard-rollup.js';

function venue(over: Partial<VenueWeek> = {}): VenueWeek {
  return {
    venue_id: 'v', venue: 'V', slug: 'v',
    gross_sales: 1000, food_bev_sales: 1000, food_sales: 600, beverage_sales: 400, food_pct: 60,
    net_sales: 1045, service_charge: 95, total_discounts: 50, discount_rate_pct: 5,
    covers: 100, transactions: 40, avg_spend_per_head: 10, avg_check: 26.13,
    trading_days: 6, closed_days: [],
    prior: { net_sales: 1000, covers: 95, avg_spend_per_head: 9.8 },
    change: {
      net_sales: { delta: 45, pct: 4.5, direction: 'up' },
      covers: { delta: 5, pct: 5.3, direction: 'up' },
      avg_spend_per_head: { delta: 0.2, pct: 2, direction: 'up' },
    },
    daily: [{ date: '2026-09-28', net_sales: 1045, covers: 100 }],
    upcoming: [{ date: '2026-10-03', covers: 20, closed: false }],
    ...over,
  };
}

describe('rates are recomputed from the parts, never averaged', () => {
  test('the discount rate is group discounts over group gross', () => {
    /**
     * A big venue discounting lightly and a small one discounting heavily.
     * The mean of the two RATES is 15%; the real group rate is 5.9%. Averaging
     * would overstate it nearly threefold and read as a business with a
     * discounting problem.
     */
    const big = venue({ gross_sales: 9000, total_discounts: 180, discount_rate_pct: 2 });
    const small = venue({ gross_sales: 1000, total_discounts: 280, discount_rate_pct: 28 });

    const g = rollUp([big, small]);
    assert.equal(g.gross_sales, 10000);
    assert.equal(g.total_discounts, 460);
    assert.equal(g.discount_rate_pct, 4.6);
    // And emphatically not the mean of 2 and 28.
    assert.notEqual(g.discount_rate_pct, 15);
  });

  test('spend per head is group food & beverage over group covers', () => {
    const a = venue({ food_bev_sales: 9000, covers: 300, avg_spend_per_head: 30 });
    const b = venue({ food_bev_sales: 1000, covers: 200, avg_spend_per_head: 5 });

    const g = rollUp([a, b]);
    assert.equal(g.covers, 500);
    assert.equal(g.avg_spend_per_head, 20);   // 10000/500, not (30+5)/2
  });

  test('the food share is group food over group food & beverage', () => {
    const a = venue({ food_bev_sales: 9000, food_sales: 1800, beverage_sales: 7200, food_pct: 20 });
    const b = venue({ food_bev_sales: 1000, food_sales: 800, beverage_sales: 200, food_pct: 80 });

    const g = rollUp([a, b]);
    assert.equal(g.food_pct, 26);             // 2600/10000, not (20+80)/2 = 50
  });
});

describe('a venue with no data must not count as a zero', () => {
  test('covers are null only when EVERY venue is null', () => {
    /**
     * One venue missing its SevenRooms feed should not blank the group -- but
     * it must not be counted as "nobody came" either. Both of those are wrong
     * answers to "how many covers this week"; the first loses the venues that
     * do have data and the second understates the group.
     */
    const withCovers = venue({ covers: 100 });
    const without = venue({ covers: null });

    assert.equal(rollUp([withCovers, without]).covers, 100);
    assert.equal(rollUp([without, without]).covers, null);
  });

  test('a null-covers group reports no spend per head rather than dividing by nothing', () => {
    const g = rollUp([venue({ covers: null }), venue({ covers: null })]);
    assert.equal(g.avg_spend_per_head, null);
  });
});

describe('the forward book across venues', () => {
  test('covers are summed per date', () => {
    const a = venue({ upcoming: [{ date: '2026-10-03', covers: 20, closed: false }, { date: '2026-10-04', covers: 30, closed: false }] });
    const b = venue({ upcoming: [{ date: '2026-10-03', covers: 5, closed: false }, { date: '2026-10-04', covers: 0, closed: true }] });

    const g = rollUp([a, b]);
    assert.deepEqual(g.upcoming.map(u => [u.date, u.covers]), [['2026-10-03', 25], ['2026-10-04', 30]]);
  });

  test('a group day is closed only when every venue is shut', () => {
    // Firangi closes every Sunday. The GROUP is not closed on a Sunday, and
    // marking it so would hide the two venues that traded.
    const open = venue({ upcoming: [{ date: '2026-10-04', covers: 40, closed: false }] });
    const shut = venue({ upcoming: [{ date: '2026-10-04', covers: 0, closed: true }] });

    assert.equal(rollUp([open, shut]).upcoming[0].closed, false);
    assert.equal(rollUp([shut, shut]).upcoming[0].closed, true);
  });
});

describe('the daily line', () => {
  test('sums each date across venues', () => {
    const a = venue({ daily: [{ date: '2026-09-28', net_sales: 100, covers: 10 }] });
    const b = venue({ daily: [{ date: '2026-09-28', net_sales: 50, covers: 5 }] });
    assert.deepEqual(rollUp([a, b]).daily, [{ date: '2026-09-28', net_sales: 150, covers: 15 }]);
  });

  test('a day one venue was closed still carries the other venue', () => {
    // The closed venue contributes null, which must not blank the group's day.
    const open = venue({ daily: [{ date: '2026-09-28', net_sales: 100, covers: 10 }] });
    const shut = venue({ daily: [{ date: '2026-09-28', net_sales: null, covers: null }] });
    const g = rollUp([open, shut]);
    assert.equal(g.daily[0].net_sales, 100);
    assert.equal(g.daily[0].covers, 10);
  });
});

test('the group movement compares group against group', () => {
  // Not an average of the venue movements, which would weight a small venue's
  // swing the same as a large one's.
  const a = venue({ net_sales: 1100, prior: { net_sales: 1000, covers: 100, avg_spend_per_head: 10 } });
  const b = venue({ net_sales: 900, prior: { net_sales: 1000, covers: 100, avg_spend_per_head: 10 } });

  const g = rollUp([a, b]);
  assert.equal(g.net_sales, 2000);
  assert.equal(g.prior.net_sales, 2000);
  assert.equal(g.change.net_sales.direction, 'flat');
});
