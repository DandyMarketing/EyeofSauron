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
import { weeklyCogs, coverageFor, costSettlement, USABLE_COVERAGE_PCT, type BillLine, transferTotals, type TransferLine, type AccountNames, type AccountInfo } from './weekly-cogs.js';

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
    // Sushi is split out in the P&L route; it must be here too, or the weekly
    // and monthly figures describe different things.
    const r = weeklyCogs([bill('acc-sushi', 1000)],
      new Map([['acc-sushi', 'COGS - Sushi']]), sales, { food: 100, beverage: 100 });
    assert.equal(r.food.cogs, 0);
    assert.equal(r.sushi.cogs, 1000);
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

test('the low-coverage warning explains the account it is printed under', () => {
  /**
   * It read "Drink is often bought on a card" for whichever side was short, and
   * appeared under FOOD once food coverage dropped (Neon Pigeon, September
   * 2026: 66.9%) — an explanation of the wrong account.
   */
  const r = weeklyCogs([bill('acc-food', 3200), bill('acc-bev', 1100)], names,
    { food_sales: 10000, beverage_sales: 5000 }, { food: 66.9, beverage: 95 });
  const food = r.caveats.find(c => c.startsWith('Food:'))!;
  assert.ok(food, 'low food coverage carries no warning');
  assert.ok(!/drink/i.test(food), `the food warning talks about drink: ${food}`);
  assert.match(food, /paid by card or bank transfer/);
});

describe('short sales in the window', () => {
  test('a day with sales and no split withholds the weekly percentages', () => {
    const out = weeklyCogs([], new Map(), { food_sales: 9000, beverage_sales: 3000, days: { monday_board: 0, none: 1 } },
      { food: 95, beverage: 90 });
    assert.equal(out.food.pct, null);
    assert.equal(out.beverage.pct, null);
    assert.ok(out.caveats.some(c => /withheld/.test(c)));
  });

  test('board days are named, not hidden', () => {
    const out = weeklyCogs([], new Map(), { food_sales: 9000, beverage_sales: 3000, days: { monday_board: 2, none: 0 } },
      { food: 95, beverage: 90 });
    assert.ok(out.caveats.some(c => /Monday board/.test(c)));
  });
});

/**
 * Neon Pigeon, 28 Sep - 4 Oct 2026, from the bills Sauron actually held. The
 * panel showed food at $6,609 (38.2%) against Monday's 23%: $1,748.60 of it was
 * not cost of sales at all, and $596.14 was sushi.
 */
describe('the week the panel read 38.2%', () => {
  const names = new Map<string, any>([
    ['food',   { name: 'COGS - Food', raw: 'COGS - Food', section: 'Less Cost of Sales', business_line: 'main' }],
    ['sushi',  { name: 'COGS - Food', raw: 'COGS - Sushi', section: 'Less Cost of Sales', business_line: 'sushi' }],
    ['alc',    { name: 'COGS - Alcohol', raw: 'COGS - Alcohol', section: 'Less Cost of Sales', business_line: 'main' }],
    ['bev',    { name: 'COGS - Beverages', raw: 'COGS - Beverages', section: 'Less Cost of Sales', business_line: 'main' }],
    ['trans',  { name: 'Transportation - Sushi', raw: 'Transportation - Sushi', section: 'Less Operating Expenses', business_line: 'main' }],
    ['kitchen',{ name: 'Kitchen expenses', raw: 'Kitchen expenses', section: 'Less Operating Expenses', business_line: 'main' }],
  ]);
  const line = (account_id: string, line_amount: number, status = 'AUTHORISED') =>
    ({ account_id, line_amount, bill_date: '2026-09-29', status });
  const lines = [
    line('food', 4264.54),
    line('food', 161.10, 'DELETED'),   // Toho S126-00099813, re-entered at $147.80
    line('sushi', 596.14),
    line('trans', 1490),
    line('kitchen', 97.50),
    line('alc', 1933.20),
    line('bev', 884.03),
  ];
  const r = weeklyCogs(lines, names, { food_sales: 17286, beverage_sales: 16312 }, { food: 95, beverage: 95 });

  test('food is cost-of-sales food only', () => {
    assert.equal(r.food.cogs, 4264.54);
    assert.equal(r.food.pct, 24.67);
  });

  test('sushi is its own line, and its transport is not a cost of sales', () => {
    assert.equal(r.sushi.cogs, 596.14);
  });

  test('drink is unchanged, because it was right', () => {
    assert.equal(r.beverage.cogs, 2817.23);
  });

  test('a deleted bill is never spend, in the figure or in its coverage', () => {
    const withDeleted = weeklyCogs([line('food', 500, 'VOIDED')], names, { food_sales: 1000, beverage_sales: 0 }, { food: 95, beverage: 95 });
    assert.equal(withDeleted.food.cogs, 0);
    assert.deepEqual(coverageFor([line('food', 500, 'DELETED')], names, { food: 1000, beverage: 0 }), { food: 0, beverage: null });
  });
});

/**
 * Khai, 6 Oct 2026: "the invoice should reach within the week". The week of
 * 28 Sep - 4 Oct is the real case: viewed on 6 Oct it was missing invoices
 * that were on Monday's board and not yet in Xero.
 */
describe('when a period\'s cost is final', () => {
  test('a week still running is in progress', () => {
    assert.equal(costSettlement('2026-10-11', '2026-10-06').status, 'in_progress');
  });

  test('last week, two days after it ended, is provisional', () => {
    assert.deepEqual(costSettlement('2026-10-04', '2026-10-06'), { status: 'provisional', final_on: '2026-10-12' });
  });

  test('provisional for the whole following week, final the Monday after', () => {
    assert.equal(costSettlement('2026-10-04', '2026-10-11').status, 'provisional');
    assert.equal(costSettlement('2026-10-04', '2026-10-12').status, 'final');
  });

  test('a month works the same way', () => {
    assert.deepEqual(costSettlement('2026-09-30', '2026-10-06'), { status: 'provisional', final_on: '2026-10-08' });
    assert.equal(costSettlement('2026-09-30', '2026-10-08').status, 'final');
  });
});

/**
 * Stock moved between sister venues. Khai, 6 Oct 2026: "if Neon Pigeon buys for
 * FP then it should minus from NP and + to FP", and "transfers are usually food
 * and beverage products". The cases are real lines from query 51.
 */
describe('transfers between sister venues', () => {
  const fpAccounts: AccountNames = new Map<string, AccountInfo>([
    ['fp-alc', { name: 'COGS - Alcohol', section: 'Less Cost of Sales' }],
    ['fp-food', { name: 'COGS - Food', section: 'Less Cost of Sales' }],
    ['fp-pr', { name: 'Public Relations / Marketing costs', section: 'Less Operating Expenses' }],
    ['fp-tips', { name: 'Staff costs - Tips', section: 'Less Operating Expenses' }],
  ]);
  const npAccounts: AccountNames = new Map<string, AccountInfo>([
    ['np-sushi', { name: 'COGS - Food', raw: 'COGS - Sushi', section: 'Less Cost of Sales', business_line: 'sushi' }],
    ['np-bev', { name: 'COGS - Beverages', section: 'Less Cost of Sales' }],
  ]);
  const names = new Map([['fp', fpAccounts], ['np', npAccounts]]);
  const t = (receiver: string, sender: string, account: string, amount: number, status = 'AUTHORISED'): TransferLine =>
    ({ receiver_venue_id: receiver, sender_venue_id: sender, account_id: account, line_amount: amount, bill_date: '2026-09-30', status });

  test('Neon Pigeon sends Fat Prince tequila: + to Fat Prince, - from Neon Pigeon', () => {
    const r = transferTotals([t('fp', 'np', 'fp-alc', 716)], names);
    assert.deepEqual(r.get('fp'), { in: { food: 0, beverage: 716, sushi: 0 }, out: { food: 0, beverage: 0 } });
    assert.deepEqual(r.get('np'), { in: { food: 0, beverage: 0, sushi: 0 }, out: { food: 0, beverage: 716 } });
  });

  test('PR fees and tips from a sister company are costs, not stock, and move nothing', () => {
    const r = transferTotals([t('fp', 'fi', 'fp-pr', 25014.98), t('fp', 'fp', 'fp-tips', 269.66)], names);
    assert.equal(r.size, 0);
  });

  test('a company billing its own venue is not a transfer, even for stock', () => {
    assert.equal(transferTotals([t('fp', 'fp', 'fp-food', 100)], names).size, 0);
  });

  test('sushi received is sushi at the receiver and comes off the sender\'s food', () => {
    const r = transferTotals([t('np', 'fp', 'np-sushi', 25.6)], names);
    assert.equal(r.get('np')!.in.sushi, 25.6);
    assert.equal(r.get('fp')!.out.food, 25.6);
  });

  test('a voided bill moves nothing; an account the receiver never reported moves nothing', () => {
    assert.equal(transferTotals([t('fp', 'np', 'fp-alc', 610.29, 'VOIDED'), t('fp', 'np', 'no-such', 50)], names).size, 0);
  });

  test('the sender\'s weekly cost loses what it sent, and says so', () => {
    const own: BillLine[] = [{ account_id: 'np-bev', line_amount: 2000, bill_date: '2026-09-29', status: 'PAID' }];
    const sent = { in: { food: 0, beverage: 0, sushi: 0 }, out: { food: 0, beverage: 716 } };
    const w = weeklyCogs(own, npAccounts, { food_sales: 10000, beverage_sales: 8000 }, { food: 95, beverage: 95 }, sent);
    assert.equal(w.beverage.cogs, 1284);
    assert.equal(w.beverage.pct, 16.05);
    assert.deepEqual(w.transfers, sent);
    assert.ok(w.caveats.some(c => /\$716\.00 of stock sent to sister venues/.test(c)));
  });

  test('the receiver\'s cost is unchanged -- it is already in its bills -- and the caveat names it', () => {
    const own: BillLine[] = [{ account_id: 'fp-alc', line_amount: 716, bill_date: '2026-09-30', status: 'PAID' }];
    const got = { in: { food: 0, beverage: 716, sushi: 0 }, out: { food: 0, beverage: 0 } };
    const w = weeklyCogs(own, fpAccounts, { food_sales: 1, beverage_sales: 1 }, { food: 95, beverage: 95 }, got);
    assert.equal(w.beverage.cogs, 716);
    assert.ok(w.caveats.some(c => /Includes \$716\.00 of stock received/.test(c)));
  });

  test('no transfers, no field and no caveat', () => {
    const w = weeklyCogs([], fpAccounts, { food_sales: 1, beverage_sales: 1 }, { food: 95, beverage: 95 },
      { in: { food: 0, beverage: 0, sushi: 0 }, out: { food: 0, beverage: 0 } });
    assert.equal(w.transfers, undefined);
    assert.ok(!w.caveats.some(c => /sister venues/.test(c)));
  });
});
