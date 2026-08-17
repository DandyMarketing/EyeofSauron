import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { netSalesOf, serviceChargeOf, totalDiscountsOf } from './sales.js';

/**
 * BUILD_LOG 2.4. `daily_operations.net_sales` holds Revel's "Total Sales",
 * which is net of discounts but INCLUSIVE of the 10% service charge. It was
 * being charted and returned to the model under the label "Net sales",
 * overstating the headline revenue figure by about 10%.
 *
 * The defect survived because the number is plausible. Nothing about a figure
 * 10% too high looks wrong on a chart; a manager comparing it to their own
 * recollection would assume they had misremembered.
 *
 * These tests pin the definition to real days from the warehouse, so a future
 * refactor that reaches for the column again fails here rather than in front
 * of a venue leader.
 */

describe('netSalesOf — gross less item and order discounts', () => {
  test('subtracts both discount kinds', () => {
    assert.equal(netSalesOf({ gross_sales: 1000, item_discounts: 60, order_discounts: 40 }), 900);
  });

  test('treats missing discounts as zero, not as a reason to return null', () => {
    assert.equal(netSalesOf({ gross_sales: 500, item_discounts: null, order_discounts: null }), 500);
  });

  test('accepts the numeric-as-string values Postgres returns', () => {
    // supabase-js hands back `numeric` columns as strings. Number() on a whole
    // row of them silently produced NaN in an earlier bug.
    assert.equal(netSalesOf({ gross_sales: '8155.50', item_discounts: '1016', order_discounts: '50' }), 7089.5);
  });

  test('rounds away floating-point residue', () => {
    assert.equal(netSalesOf({ gross_sales: 100.1, item_discounts: 0.2, order_discounts: 0.1 }), 99.8);
  });
});

describe('serviceChargeOf — the 10% that was hiding inside net sales', () => {
  /**
   * Three real days, three venues, three years. Each was verified against the
   * stored `net_sales` to the cent before being written down here. If any of
   * these stops holding, Revel changed its report and the parser needs looking
   * at -- do not simply update the expected value.
   */
  test('Neon Pigeon, 19 Sep 2024 — a day with no discounts', () => {
    const row = { gross_sales: 33667, item_discounts: 0, order_discounts: 0, net_sales: 37033.7 };
    assert.equal(netSalesOf(row), 33667);
    assert.equal(serviceChargeOf(row), 3366.7);
  });

  test('Fat Prince, 18 Sep 2024 — a token discount', () => {
    const row = { gross_sales: 25270, item_discounts: 7.5, order_discounts: 0, net_sales: 27788.75 };
    assert.equal(netSalesOf(row), 25262.5);
    assert.equal(serviceChargeOf(row), 2526.25);
  });

  test('Firangi Superstar, 31 Dec 2022 — a heavily discounted night', () => {
    const row = { gross_sales: 26528, item_discounts: 1176.5, order_discounts: 0, net_sales: 27886.65 };
    assert.equal(netSalesOf(row), 25351.5);
    assert.equal(serviceChargeOf(row), 2535.15);
  });

  test('the service charge is 10% of net sales on every one of them', () => {
    // The relationship, stated once. This is what makes the column what it is.
    const days = [
      { gross_sales: 33667, item_discounts: 0, order_discounts: 0, net_sales: 37033.7 },
      { gross_sales: 25270, item_discounts: 7.5, order_discounts: 0, net_sales: 27788.75 },
      { gross_sales: 26528, item_discounts: 1176.5, order_discounts: 0, net_sales: 27886.65 },
    ];
    for (const d of days) {
      assert.equal(serviceChargeOf(d), Math.round(netSalesOf(d) * 10) / 100);
    }
  });

  test('null when the row has no Revel figure at all', () => {
    // Monday-sourced rows carry no `net_sales`. Returning 0 here would report a
    // venue as having taken no service charge, which is a different claim.
    assert.equal(serviceChargeOf({ gross_sales: 5000, item_discounts: 0, order_discounts: 0 }), null);
    assert.equal(serviceChargeOf({ gross_sales: 5000, item_discounts: 0, order_discounts: 0, net_sales: null }), null);
  });
});

describe('totalDiscountsOf — the figure the Monday board combines', () => {
  test('item plus order, which is what Finance enters as one number', () => {
    // Firangi Superstar, 11 Aug 2026. Revel splits discounts in two; the Monday
    // board has a single Discounts field holding the sum. The board recorded
    // 960 against an actual 1,066 -- and the 106 difference was exactly the
    // day's sales shortfall.
    assert.equal(totalDiscountsOf({ gross_sales: 8155.5, item_discounts: 1016, order_discounts: 50 }), 1066);
  });

  test('missing order discounts do not swallow the item discounts', () => {
    assert.equal(totalDiscountsOf({ gross_sales: 100, item_discounts: 17, order_discounts: null }), 17);
  });
});
