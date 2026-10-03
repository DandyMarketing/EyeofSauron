import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  netSalesOf, serviceChargeOf, totalDiscountsOf, foodAndBevSalesOf, grossSalesOf, salesFiguresOf,
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

/**
 * The one block every tool returns, and the bug that made it necessary.
 *
 * `query_sales` had two paths. The date-range path used the functions above;
 * the single-date path spread the warehouse row straight out, so the model got
 * the COLUMN named `gross_sales` — food plus beverage, no service charge —
 * while the tool description told it that field INCLUDED service charge.
 *
 * Asked about Neon Pigeon on 29 Sep 2026 it answered "Net sales $3,759.26,
 * Gross sales $3,639.00": net larger than gross, on every day and every venue,
 * with the real gross never shown. The same question asked as a one-day RANGE
 * came back right — two paths, one question, different answers.
 */
describe('salesFiguresOf — Neon Pigeon, 29 September 2026', () => {
  /**
   * Exactly what the ingest wrote from that day's operations report. Every
   * derived figure below is checked against a total stated SEPARATELY in the
   * same file, so this is a reconciliation and not a restatement of the code.
   */
  const row = {
    gross_sales: '3639.00',      // SALES BY CLASS > Total > Gross Sales
    item_discounts: '179.50',
    order_discounts: '42.00',
    net_sales: '3759.26',        // NET SALES > Total Sales
  };

  test('gross is food + beverage + service charge, and beats net', () => {
    const f = salesFiguresOf(row);
    // The file's own GROSS PRODUCT SALES > Total line reads 3980.76.
    assert.equal(f.gross_sales, 3980.76);
    assert.ok(f.gross_sales > f.net_sales, 'net came out larger than gross again');
  });

  test('the cost basis stays food and beverage alone', () => {
    // 3,639 is what spend per head and every cost percentage divide by. If this
    // ever picks up the service charge, every cost ratio reads ~9% low — which
    // looks like an improvement, not like a bug.
    assert.equal(salesFiguresOf(row).food_bev_sales, 3639);
  });

  test('service charge is implied correctly', () => {
    // The file states Taxed Service Fee 341.76 independently. Nothing in the
    // warehouse stores it, so agreement here is a real check.
    assert.equal(salesFiguresOf(row).service_charge, 341.76);
  });

  test('the identity in this file holds to the cent', () => {
    // net_sales = (food_bev - discounts) x 1.10
    const f = salesFiguresOf(row);
    const implied = (f.food_bev_sales - f.total_discounts) * 1.1;
    assert.ok(Math.abs(implied - f.net_sales) <= 0.01, `${implied} vs ${f.net_sales}`);
  });

  test('discounts are item plus order', () => {
    // The file's DISCOUNTS > Total line reads 221.50.
    assert.equal(salesFiguresOf(row).total_discounts, 221.5);
  });

  test('a Monday-board row reports food and bev rather than losing the day', () => {
    // No net sales to derive gross from. Gross falls back to food+bev — which
    // understates it by the service charge — and service_charge is null, which
    // says "not known" rather than "none was taken".
    const f = salesFiguresOf({ gross_sales: 5000, item_discounts: 0, order_discounts: 0 });
    assert.equal(f.gross_sales, 5000);
    assert.equal(f.service_charge, null);
  });
});

test('every tool returning day figures builds them from salesFiguresOf', () => {
  /**
   * The structural half of the fix. The bug was not a wrong formula — the
   * formulas in this file were right and well documented — it was one call site
   * that did not use them, and nothing could see that.
   *
   * So: any handler returning a `food_bev_sales` key must get it from
   * `salesFiguresOf`, never assemble the block by hand. Assembling it by hand is
   * exactly how the two paths came to disagree.
   */
  const src = readFileSync('src/ai/tool-handlers.ts', 'utf8');
  const handBuilt = [...src.matchAll(/^\s*food_bev_sales:\s*(.+)$/gm)].map(m => m[1].trim());

  for (const expr of handBuilt) {
    // Two legitimate shapes that are not a day's figures: `0` starts a running
    // total, and compare_venues sums many days before building its block, so it
    // passes that total rather than a row.
    assert.ok(
      /^(0|grossSales),?$/.test(expr),
      `a handler sets food_bev_sales to \`${expr}\` by hand — spread salesFiguresOf(row) instead, ` +
        `or the single-date and date-range paths will answer the same question differently again`,
    );
  }

  assert.ok(
    src.includes('...salesFiguresOf(data)') && src.includes('...salesFiguresOf(d)'),
    'query_sales no longer builds both of its paths from salesFiguresOf',
  );
});
