/**
 * Weekly food cost from supplier bills, and the one way it lies.
 *
 * I had this wrong and said a cost percentage could only be monthly, because
 * the P&L's finest grain is a month. Bills carry a DATE, so the purchases side
 * always had daily resolution; the monthly limit belonged to one source, not
 * to the measurement.
 *
 * THE LIE IS COVERAGE. Measured at Neon Pigeon for June 2026, bills explain
 * food purchases at roughly 100% and COGS Beverages at ZERO -- drink is bought
 * on a card or coded to inventory and journalled out later, so it never touches
 * a bill. A weekly beverage cost built from bills therefore reads near nothing
 * and looks like a triumph. That is the most flattering way this product could
 * lie, which is why the tests below are mostly about it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyCogs, coverageFor, USABLE_COVERAGE_PCT, type BillLine } from './weekly-cogs.js';

const names = new Map([
  ['acc-food', 'COGS - Food'],
  ['acc-bev', 'COGS - Beverages'],
  ['acc-rent', 'Rent'],
]);

const bill = (account_id: string | null, line_amount: number): BillLine =>
  ({ account_id, line_amount, bill_date: '2026-09-30' });

describe('a week of purchases against the same week of sales', () => {
  const sales = { food_sales: 10000, beverage_sales: 5000 };

  test('food and beverage are summed from their own accounts', () => {
    const r = weeklyCogs(
      [bill('acc-food', 3200), bill('acc-bev', 1100), bill('acc-rent', 9000)],
      names, sales, { food: 100, beverage: 95 },
    );
    assert.equal(r.food.cogs, 3200);
    assert.equal(r.food.pct, 32);
    assert.equal(r.beverage.pct, 22);
  });

  test('a credit note nets off by being summed, not sign-corrected', () => {
    /**
     * supplier_bills stores ACCPAYCREDIT amounts NEGATIVE so they net against
     * bills. Applying a sign here would double the correction — which is
     * exactly the bug the credit-note ingest was built to fix, reintroduced one
     * layer up.
     */
    const r = weeklyCogs(
      [bill('acc-food', 3500), bill('acc-food', -300)],
      names, sales, { food: 100, beverage: 100 },
    );
    assert.equal(r.food.cogs, 3200);
  });

  test('the same classifier as the monthly path, so the two cannot disagree', () => {
    // 'COGS - Sushi' rolls to food in the P&L route; it must here too, or the
    // weekly and monthly figures describe different things.
    const r = weeklyCogs([bill('acc-sushi', 1000)],
      new Map([['acc-sushi', 'COGS - Sushi']]), sales, { food: 100, beverage: 100 });
    assert.equal(r.food.cogs, 1000);
  });
});

describe('coverage is the control', () => {
  const sales = { food_sales: 10000, beverage_sales: 5000 };

  test('a well-covered account is usable', () => {
    const r = weeklyCogs([bill('acc-food', 3200)], names, sales, { food: 98, beverage: 0 });
    assert.equal(r.food.usable, true);
    assert.equal(r.food.coverage_pct, 98);
  });

  test('beverage at 0% coverage is marked unusable and says why', () => {
    /**
     * This is the real case, measured. Without the guard the panel would report
     * a beverage cost of 2% and somebody would believe it.
     */
    const r = weeklyCogs([bill('acc-bev', 100)], names, sales, { food: 98, beverage: 0 });
    assert.equal(r.beverage.usable, false);
    assert.ok(r.caveats.some(c => /Beverage: bills explain only 0%/.test(c)), r.caveats.join('\n'));
    assert.ok(r.caveats.some(c => /Do not quote this percentage/.test(c)));
  });

  test('the threshold is the stated one, not a feeling', () => {
    const at = weeklyCogs([bill('acc-food', 1)], names, sales, { food: USABLE_COVERAGE_PCT, beverage: 100 });
    const below = weeklyCogs([bill('acc-food', 1)], names, sales, { food: USABLE_COVERAGE_PCT - 0.1, beverage: 100 });
    assert.equal(at.food.usable, true);
    assert.equal(below.food.usable, false);
  });

  test('unknown coverage is not treated as good coverage', () => {
    // No ledger month to measure against is a reason to distrust the figure,
    // not a reason to assume it is fine.
    const r = weeklyCogs([bill('acc-food', 3200)], names, sales, { food: null, beverage: null });
    assert.equal(r.food.usable, false);
    assert.ok(r.caveats.some(c => /no ledger month to measure coverage against/.test(c)));
  });
});

describe('a line whose account cannot be named', () => {
  test('is counted, never dropped', () => {
    /**
     * Dropping it shrinks the numerator and flatters the ratio — a lower food
     * cost, which is the direction nobody questions. A line nobody can name is
     * a line nobody can rule out.
     */
    const r = weeklyCogs(
      [bill('acc-food', 3000), bill('acc-mystery', 800), bill(null, 200)],
      names, { food_sales: 10000, beverage_sales: 5000 }, { food: 100, beverage: 100 },
    );
    assert.equal(r.food.cogs, 3000);
    assert.equal(r.unknown_account_total, 1000);
    assert.ok(r.caveats.some(c => /\$1000\.00 of bill lines could not be matched/.test(c)));
  });
});

test('the purchases-not-consumption caveat is always there, and says why weekly is worse', () => {
  /**
   * Monthly, delivery timing mostly averages out. Weekly it does not: one large
   * delivery lands entirely in the week it was invoiced against sales spread
   * over the next three, and a single week can read 55% or 18% with nothing
   * wrong at all.
   */
  const r = weeklyCogs([bill('acc-food', 1)], names, { food_sales: 10, beverage_sales: 10 }, { food: 100, beverage: 100 });
  assert.ok(r.caveats.some(c => /weekly, that does not average out/i.test(c)), r.caveats.join('\n'));
});

describe('coverageFor', () => {
  test('measures bills against the ledger for the same accounts', () => {
    const c = coverageFor(
      [bill('acc-food', 9800), bill('acc-bev', 0)],
      names, { food: 10000, beverage: 4000 },
    );
    assert.equal(c.food, 98);
    assert.equal(c.beverage, 0);
  });

  test('a ledger with nothing in it gives null, not zero', () => {
    // "We cannot tell" and "the bills explain none of it" are different
    // answers, and only one of them is a reason to distrust the week.
    const c = coverageFor([bill('acc-food', 500)], names, { food: 0, beverage: 0 });
    assert.equal(c.food, null);
    assert.equal(c.beverage, null);
  });

  test('a line on an account that is neither does not inflate coverage', () => {
    const c = coverageFor([bill('acc-rent', 50000)], names, { food: 10000, beverage: 4000 });
    assert.equal(c.food, 0);
  });
});
