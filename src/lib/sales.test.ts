import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  netSalesOf, serviceChargeOf, totalDiscountsOf, foodAndBevSalesOf, grossSalesOf,
} from './sales.js';

/**
 * BUILD_LOG 2.4. These pin the business's definitions, which are not the
 * textbook ones:
 *
 *     Gross Sales = food + beverage + service charge
 *     Net Sales   = gross sales - discounts
 *     Cost basis  = food + beverage
 *
 * Service charge sits INSIDE gross sales. Assuming the usual F&B convention --
 * that net sales excludes it -- produced a "fix" that broke a figure which was
 * already right. The five real days below are what proved it, and they are here
 * so the next person changing this has to disprove them first.
 */

/** Five days from the warehouse: [label, food+bev, discounts, net_sales]. */
const REAL_DAYS: Array<[string, number, number, number]> = [
  ['Neon Pigeon, 19 Sep 2024', 33667.00, 0.00, 37033.70],
  ['Fat Prince, 18 Sep 2024', 25270.00, 7.50, 27788.75],
  ['Firangi Superstar, 31 Dec 2022', 26528.00, 1176.50, 27886.65],
  ['Firangi Superstar, 12 Jan 2023', 25641.00, 201.00, 27984.00],
  ['Neon Pigeon, 22 Mar 2025', 21208.80, 1405.46, 21783.70],
];

const rowFor = (fb: number, disc: number, net: number) =>
  ({ gross_sales: fb, item_discounts: disc, order_discounts: 0, net_sales: net });

describe('the definitions hold on real days', () => {
  for (const [label, fb, disc, net] of REAL_DAYS) {
    test(label, () => {
      const row = rowFor(fb, disc, net);
      // Net sales comes from Revel and is already the business's figure.
      assert.equal(netSalesOf(row), net);
      // Gross = food + bev + service charge = net + discounts.
      assert.equal(grossSalesOf(row), Math.round((net + disc) * 100) / 100);
      // Gross - discounts must return to net. The definition, closed.
      assert.equal(Math.round((grossSalesOf(row)! - disc) * 100) / 100, net);
      // The cost basis is food + bev alone, never carrying service charge.
      assert.equal(foodAndBevSalesOf(row), fb);
    });
  }

  test('service charge is 10% of food and beverage after discounts', () => {
    // Near enough, not exactly. Service charge is levied and rounded per BILL,
    // then summed, so a day can land a few cents off 10% of the day's total --
    // Neon Pigeon on 22 Mar 2025 is three cents over. Asserting an exact 10%
    // here failed on that day, which is the useful thing this test learned: the
    // relationship is a rule about bills, not an identity about days.
    for (const [label, fb, disc, net] of REAL_DAYS) {
      const sc = serviceChargeOf(rowFor(fb, disc, net))!;
      const tenPct = (fb - disc) / 10;
      assert.ok(Math.abs(sc - tenPct) < 0.10, `${label}: ${sc} vs ${tenPct.toFixed(2)}`);
    }
  });

  test('the cost basis is always below net sales, never above', () => {
    // A cost percentage divided by a figure carrying service charge would come
    // out ~10% low and look like an improvement.
    for (const [label, fb, disc, net] of REAL_DAYS) {
      const row = rowFor(fb, disc, net);
      assert.ok(foodAndBevSalesOf(row) < netSalesOf(row), label);
    }
  });
});

describe('totalDiscountsOf — the figure the Monday board combines', () => {
  test('item plus order, which Finance enters as one number', () => {
    // Firangi Superstar, 11 Aug 2026. Revel splits discounts in two; the board
    // holds the sum. It recorded 960 against an actual 1,066 -- and the 106
    // difference was exactly that day's sales shortfall.
    assert.equal(totalDiscountsOf({ gross_sales: 8155.5, item_discounts: 1016, order_discounts: 50 }), 1066);
  });

  test('missing order discounts do not swallow the item discounts', () => {
    assert.equal(totalDiscountsOf({ gross_sales: 100, item_discounts: 17, order_discounts: null }), 17);
  });

  test('rounds away floating-point residue', () => {
    assert.equal(totalDiscountsOf({ gross_sales: 0, item_discounts: 0.2, order_discounts: 0.1 }), 0.3);
  });
});

describe('rows with no Revel figure', () => {
  const mondayOnly = { gross_sales: 5000, item_discounts: 0, order_discounts: 0 };

  test('service charge and gross sales are null, not zero', () => {
    // Monday-sourced rows carry no net_sales. Zero would claim the venue took
    // no service charge; null says we do not know.
    assert.equal(serviceChargeOf(mondayOnly), null);
    assert.equal(grossSalesOf(mondayOnly), null);
    assert.equal(serviceChargeOf({ ...mondayOnly, net_sales: null }), null);
  });

  test('the cost basis still works, because food and bev are present', () => {
    assert.equal(foodAndBevSalesOf(mondayOnly), 5000);
  });
});

describe('numeric-as-string values from Postgres', () => {
  test('are read as numbers, not concatenated', () => {
    // supabase-js hands back `numeric` columns as strings.
    const row = { gross_sales: '8155.50', item_discounts: '1016', order_discounts: '50', net_sales: '7798.05' };
    assert.equal(foodAndBevSalesOf(row), 8155.5);
    assert.equal(totalDiscountsOf(row), 1066);
    assert.equal(netSalesOf(row), 7798.05);
  });
});
