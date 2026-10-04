/**
 * Food and beverage cost percentages, and the four ways they go quietly wrong.
 *
 *   - a summary row counted alongside the lines beneath it doubles everything;
 *   - a cost-of-sales account nobody recognised is dropped, which LOWERS the
 *     percentage and so never gets questioned;
 *   - the wrong denominator — anything carrying service charge — lowers it by
 *     about 9% and reads as the kitchen improving;
 *   - a month with no sales reports 0% rather than "no figure".
 *
 * Every one of them produces a plausible number, which is why they are tests
 * rather than comments.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCogs, costRatios, costCaveats, type PLRow } from './cost-ratios.js';

const line = (canonical: string, amount: number, over: Partial<PLRow> = {}): PLRow => ({
  account_name: canonical,
  canonical_account: canonical,
  business_line: 'main',
  section: 'Less Cost of Sales',
  amount,
  is_summary: false,
  ...over,
});

describe('classifying a cost-of-sales account', () => {
  test('the canonical food and beverage names', () => {
    assert.equal(classifyCogs('COGS - Food'), 'food');
    assert.equal(classifyCogs('COGS Beverages'), 'beverage');
    assert.equal(classifyCogs('Cost of Sales - Beverage'), 'beverage');
  });

  test('a sub-business that rolls into food is food', () => {
    // Neon Pigeon's sushi operation rolls into COGS - Food for the entity.
    assert.equal(classifyCogs('COGS - Sushi'), 'food');
  });

  test('an account naming BOTH is refused rather than split', () => {
    /**
     * "COGS - Food & Beverage" is a real way to keep a chart of accounts.
     * Splitting it by assumption would invent the exact number being asked for,
     * so it falls to unclassified and a person decides.
     */
    assert.equal(classifyCogs('COGS - Food & Beverage'), null);
  });

  test('a cost of sales line that is neither is left alone', () => {
    assert.equal(classifyCogs('Packaging'), null);
    assert.equal(classifyCogs('Delivery Commission'), null);
    assert.equal(classifyCogs('Consumables'), null);
  });

  test('it does not match a word inside another word', () => {
    // A narrow rule is the point: a loose one catches the next account nobody
    // has looked at, and a wrong bucket is invisible where unclassified is not.
    assert.equal(classifyCogs('Foodservice Software Licence'), null);
    assert.equal(classifyCogs('Barista Training'), null);
  });
});

describe('the ratios', () => {
  const sales = { food_sales: 40000, beverage_sales: 20000 };

  test('food and beverage are measured against their own sales', () => {
    const r = costRatios([line('COGS - Food', 12000), line('COGS - Beverages', 5000)], sales);
    assert.equal(r.food.pct, 30);         // 12000/40000
    assert.equal(r.beverage.pct, 25);     // 5000/20000
    assert.equal(r.combined.pct, 28.33);  // 17000/60000
  });

  test('a summary row is excluded, or every figure doubles', () => {
    /**
     * "Total Cost of Sales" sits in the same section as the lines beneath it.
     * Counting it alongside them gives a food cost of 60% against a real 30%,
     * and 60% is a believable number for somebody having a bad month.
     */
    const rows = [
      line('COGS - Food', 12000),
      line('COGS - Beverages', 5000),
      line('Total Cost of Sales', 17000, { is_summary: true }),
    ];
    assert.equal(costRatios(rows, sales).food.pct, 30);
  });

  test('a line outside the cost of sales section is ignored', () => {
    // An income account called "Sales - Food" must never reach the numerator.
    const rows = [line('COGS - Food', 12000), line('Sales - Food', 40000, { section: 'Income' })];
    assert.equal(costRatios(rows, sales).food.cogs, 12000);
  });

  test('two accounts rolling to the same canonical name are added, not replaced', () => {
    const rows = [
      line('COGS - Food', 8000),
      line('COGS - Sushi', 4000),
    ];
    const r = costRatios(rows, sales);
    assert.equal(r.food.cogs, 12000);
    assert.deepEqual(r.food.accounts, ['COGS - Food', 'COGS - Sushi']);
  });

  test('the accounts that were added up are named, so a reader can check', () => {
    const r = costRatios([line('COGS - Food', 12000), line('COGS - Beverages', 5000)], sales);
    assert.deepEqual(r.food.accounts, ['COGS - Food']);
    assert.deepEqual(r.beverage.accounts, ['COGS - Beverages']);
  });
});

describe('an account nobody recognised is reported, never dropped', () => {
  const sales = { food_sales: 40000, beverage_sales: 20000 };

  test('it is excluded from both percentages and named', () => {
    /**
     * This is the failure that matters. Dropping it silently LOWERS the cost
     * percentage, and a lower food cost is the direction nobody questions.
     */
    const rows = [line('COGS - Food', 12000), line('Packaging', 3000), line('Delivery Commission', 1500)];
    const r = costRatios(rows, sales);

    assert.equal(r.food.pct, 30);          // unchanged by the two unknowns
    assert.equal(r.unclassified_total, 4500);
    assert.deepEqual(r.unclassified.map(u => u.account), ['Packaging', 'Delivery Commission']);
  });

  test('the caveat says so in money, not just in count', () => {
    const rows = [line('COGS - Food', 12000), line('Packaging', 3000)];
    const caveats = costCaveats(costRatios(rows, sales), 1);
    assert.ok(caveats.some(c => /\$3000\.00/.test(c) && /EXCLUDED/.test(c)), caveats.join('\n'));
  });

  test('nothing unclassified means no such caveat', () => {
    const caveats = costCaveats(costRatios([line('COGS - Food', 12000)], sales), 1);
    assert.ok(!caveats.some(c => /EXCLUDED/.test(c)));
  });
});

describe('no sales means no percentage', () => {
  test('null rather than zero', () => {
    // 0% beverage cost says the bar bought nothing. A month with no beverage
    // sales has no ratio at all.
    const r = costRatios([line('COGS - Beverages', 500)], { food_sales: 1000, beverage_sales: 0 });
    assert.equal(r.beverage.pct, null);
    assert.equal(r.beverage.cogs, 500);
  });

  test('and the caveat names it', () => {
    const r = costRatios([line('COGS - Beverages', 500)], { food_sales: 1000, beverage_sales: 0 });
    assert.ok(costCaveats(r, 1).some(c => /unavailable rather than zero/.test(c)));
  });
});

test('the purchases-not-consumption caveat is always present', () => {
  /**
   * A cost of sales line is purchases unless the venue posts a stock movement,
   * so a big delivery near a month end lands against sales it has not produced
   * yet. It is the first thing an F&B operator will ask about a figure that
   * moved, and it applies to every response.
   */
  const r = costRatios([line('COGS - Food', 1)], { food_sales: 10, beverage_sales: 10 });
  assert.ok(costCaveats(r, 1).some(c => /PURCHASES in the period, not consumption/.test(c)));
});

test('a multi-month span says it is blended, not averaged', () => {
  const r = costRatios([line('COGS - Food', 1)], { food_sales: 10, beverage_sales: 10 });
  assert.ok(costCaveats(r, 3).some(c => /blended ratio/.test(c)));
  assert.ok(!costCaveats(r, 1).some(c => /blended ratio/.test(c)));
});
