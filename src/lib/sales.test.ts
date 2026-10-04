import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  netSalesOf, serviceChargeOf, totalDiscountsOf, foodAndBevSalesOf, grossSalesOf, salesFiguresOf, classSplitOf,
} from './sales.js';

/**
 * BUILD_LOG 2.4. These pin the business's definitions, which are not the
 * textbook ones:
 *
 *     Gross Sales = food + beverage, service charge EXCLUDED
 *     Net Sales   = (gross sales - discounts) + the 10% service charge
 *     Cost basis  = food + beverage, i.e. gross sales
 *
 * NET SALES IS THEREFORE LARGER THAN GROSS SALES, every day. The service charge
 * is levied after the discounts come off, so it enters net and was never in
 * gross. It looks like an error and it is not.
 *
 * This has now been mis-read in BOTH directions. BUILD_LOG 2.4 assumed the
 * usual convention and made net 10% too low. BUILD_LOG 1.9 assumed gross must
 * exceed net, redefined gross as net plus discounts, and reported it 9% too
 * high. Each looked like an obvious correction of an obvious error.
 *
 * The five real days below are the arbiter, and they fit only one reading:
 * net = (food + bev - discounts) x 1.10. Anyone changing this has to break them
 * first. The independent check is `reconcileMondayVsRevel`, which compares the
 * Monday board's food + beverage against Revel's gross_sales column with a
 * tolerance of ZERO and has been passing in production.
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
      // Gross is food + beverage. Nothing is added to it.
      assert.equal(grossSalesOf(row), fb);
      // And it is the cost basis, under its other name.
      assert.equal(foodAndBevSalesOf(row), fb);
      // The identity that fits all five days and only one reading of "gross".
      assert.ok(
        Math.abs((fb - disc) * 1.1 - net) <= 0.05,
        `${label}: (${fb} - ${disc}) x 1.1 = ${((fb - disc) * 1.1).toFixed(2)}, stored ${net}`,
      );
      // The consequence, stated so nobody "fixes" it again.
      assert.ok(netSalesOf(row) > grossSalesOf(row), `${label}: net must exceed gross`);
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

  test('service charge is null, not zero', () => {
    // Monday-sourced rows carry no net_sales. Zero would claim the venue took
    // no service charge; null says we do not know.
    assert.equal(serviceChargeOf(mondayOnly), null);
    assert.equal(serviceChargeOf({ ...mondayOnly, net_sales: null }), null);
  });

  test('gross sales is still known, because it is just food and beverage', () => {
    // It used to be derived from net_sales and returned null here. It is stored
    // directly, so a Monday-board row has it like any other.
    assert.equal(grossSalesOf(mondayOnly), 5000);
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
 * The one block every tool returns.
 *
 * It exists because `query_sales` had two paths that disagreed: the date-range
 * path used the functions above and the single-date path spread the warehouse
 * row straight out, so asking about a day and asking about a one-day range gave
 * different figures for one question. That part was a real defect and the
 * shared block fixed it.
 *
 * WHAT WAS NOT A DEFECT was the thing that drew attention to it. The answer
 * read "Net sales $3,759.26, Gross sales $3,639.00" and net above gross looked
 * impossible, so gross was redefined as net plus discounts. It was already
 * right: gross is food + beverage, the 10% is levied after discounts come off,
 * and net exceeds gross every day. Reverted — see the five real days above and
 * BUILD_LOG 1.9.
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

  test('gross is food + beverage, and net is ABOVE it', () => {
    const f = salesFiguresOf(row);
    // The file's SALES BY CLASS > Total > Gross Sales column reads 3639.00.
    assert.equal(f.gross_sales, 3639);
    assert.ok(
      f.net_sales > f.gross_sales,
      'net must exceed gross — the 10% is added after discounts come off',
    );
    // $3,980.76 is the file's GROSS PRODUCT SALES total, which is food + bev
    // PLUS the service fee. Revel prints it; the business does not call it
    // gross sales, and reporting it as such overstates gross by 9%.
    assert.notEqual(f.gross_sales, 3980.76);
  });

  test('the cost basis is the same figure as gross', () => {
    // Two names, one number. Every cost percentage and spend per head divides
    // by this; picking up the service charge would read ~9% low and look like
    // an improvement.
    const f = salesFiguresOf(row);
    assert.equal(f.food_bev_sales, 3639);
    assert.equal(f.food_bev_sales, f.gross_sales);
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

  test('a Monday-board row still has a gross figure', () => {
    // Gross is stored directly, so no net sales is needed to know it.
    // service_charge stays null, which says "not known" rather than "none".
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

/**
 * The food and beverage split.
 *
 * `compare_venues` computed it; `query_sales` did not return it at all, so the
 * most ordinary question about a service — how did drinks do against food —
 * could not be answered from the tool that answers how the day went. Khai, 4 Oct
 * 2026: "you should include the F&B split in these sort of queries, $value and
 * %, it gives lots of insight."
 */
describe('classSplitOf', () => {
  // Neon Pigeon, 29 Sep 2026, exactly as the ingest stores it.
  const day = {
    sales_by_class: [
      { class: 'Beverage', grossSales: 1753 },
      { class: 'Food', grossSales: 1886 },
    ],
  };

  test('splits food and beverage in dollars', () => {
    const s = classSplitOf(day);
    assert.equal(s.food_sales, 1886);
    assert.equal(s.beverage_sales, 1753);
  });

  test('the shares are of food + beverage and sum to 100', () => {
    const s = classSplitOf(day);
    assert.equal(s.food_pct, 51.83);
    assert.equal(s.beverage_pct, 48.17);
    assert.equal(Number((s.food_pct! + s.beverage_pct!).toFixed(2)), 100);
  });

  test('the split adds back to the food & beverage figure', () => {
    // 1,886 + 1,753 = 3,639, which is what foodAndBevSalesOf reads off the row.
    // If these two ever stop agreeing, one of them is reading the wrong column.
    const s = classSplitOf(day);
    assert.equal(
      s.food_sales + s.beverage_sales,
      foodAndBevSalesOf({ gross_sales: 3639, item_discounts: 0, order_discounts: 0 }),
    );
  });

  test('a class that is neither food nor beverage is reported, never dropped', () => {
    // Revel allows other classes. A split that silently ignores one is two
    // numbers that do not add up, with nothing saying why.
    const s = classSplitOf({
      sales_by_class: [
        { class: 'Food', grossSales: 100 },
        { class: 'Beverage', grossSales: 100 },
        { class: 'Retail', grossSales: 50 },
      ],
    });
    assert.equal(s.other_sales, 50);
    assert.deepEqual(s.other_classes, ['Retail']);
    // And the shares are of everything, so they still describe the whole.
    assert.equal(s.food_pct, 40);
    assert.equal(s.beverage_pct, 40);
  });

  test("Revel's Total row is never counted as a class", () => {
    // The ingest drops it. A tool that trusts that and is wrong once doubles
    // the whole day.
    const s = classSplitOf({
      sales_by_class: [
        { class: 'Food', grossSales: 1886 },
        { class: 'Beverage', grossSales: 1753 },
        { class: 'Total', grossSales: 3639 },
      ],
    });
    assert.equal(s.food_sales + s.beverage_sales, 3639);
    assert.equal(s.other_sales, undefined);
  });

  test('a day with no class rows reports null shares, not zero', () => {
    // 0% food is a statement about a venue that sold no food. Null says the
    // split is not known, which is a different thing.
    const s = classSplitOf({});
    assert.equal(s.food_pct, null);
    assert.equal(s.beverage_pct, null);
    assert.equal(s.food_sales, 0);
  });

  test('numeric-as-string values from Postgres are added, not concatenated', () => {
    const s = classSplitOf({ sales_by_class: [{ class: 'Food', grossSales: '1886.00' }] });
    assert.equal(s.food_sales, 1886);
  });
});

test('both sales tools return the split from the shared splitter', () => {
  // compare_venues read the JSON by hand with find('Food'), which is how one
  // tool came to have a split and the other none -- two readings of one shape,
  // only one of them maintained.
  const src = readFileSync('src/ai/tool-handlers.ts', 'utf8');
  assert.ok(
    !/find\(c => c\.class === 'Food'\)/.test(src),
    'a handler is reading sales_by_class by hand again — use classSplitOf',
  );
  assert.equal(
    (src.match(/classSplitOf\(/g) ?? []).length, 4,
    'expected classSplitOf in query_sales (both paths), its totals, and compare_venues',
  );
});
