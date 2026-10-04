/**
 * Food and beverage cost percentages: Xero's cost of sales over Revel's sales.
 *
 * TWO SYSTEMS OF RECORD, DELIBERATELY. Cost comes from the Xero P&L because
 * Revel reports COGS as 0 on every line and always has. Sales come from Revel
 * because the P&L's income lines are an accounting roll-up and the split we
 * need -- food against beverage -- is a product-class fact the POS owns. They
 * meet at the MONTH, which is the finest grain the P&L has.
 *
 * THE DENOMINATOR IS FOOD AND BEVERAGE SALES, NEVER GROSS OR NET. Service
 * charge is not food and it is not drink; a cost measured against a figure
 * carrying it comes out about 9% low and reads as an improvement. This is
 * written down in src/lib/sales.ts and it is the single easiest mistake to make
 * here.
 *
 * WHAT COUNTS AS FOOD COGS IS MATCHED, AND WHAT DID NOT MATCH IS REPORTED.
 * Three ledgers spell the same cost three ways, which is what `account_map`
 * exists for -- but a classifier that silently drops an account it did not
 * recognise produces a food cost percentage that is too low, looks plausible,
 * and is wrong in the direction nobody questions. So every line in the cost of
 * sales section is accounted for: matched to food, matched to beverage, or
 * named in `unclassified` for somebody to map.
 *
 * WHAT THIS IS NOT. A P&L cost of sales line is PURCHASES in the period, not
 * consumption, unless the venue posts a stock movement. Without that
 * adjustment the ratio swings with delivery timing -- a big delivery on the
 * 30th lands entirely in that month against sales it has not produced yet. Over
 * a quarter it washes out; over one month it is noise, and `basis` says so on
 * every response rather than leaving it to be remembered.
 */

export interface PLRow {
  account_name: string;
  canonical_account: string;
  business_line: string;
  section: string;
  amount: number;
  is_summary: boolean;
}

export interface SalesSplit {
  food_sales: number;
  beverage_sales: number;
}

export interface CostRatio {
  cogs: number;
  sales: number;
  /** cogs / sales as a percentage. Null when there were no sales to divide by. */
  pct: number | null;
  /** The canonical accounts that were added together, so a reader can check. */
  accounts: string[];
}

export interface CostRatios {
  food: CostRatio;
  beverage: CostRatio;
  /** Food + beverage together, which is the figure most operators quote. */
  combined: CostRatio;
  /**
   * Cost-of-sales lines that are neither food nor beverage by name.
   *
   * NOT AN ERROR, and not nothing. Packaging, delivery commission and
   * consumables legitimately sit in cost of sales, and so does an account
   * nobody has mapped yet. Either way the reader must see it, because the two
   * look identical from the ratio and only one of them is fine.
   */
  unclassified: Array<{ account: string; amount: number }>;
  unclassified_total: number;
}

/**
 * Is this cost-of-sales account food, drink, or neither?
 *
 * MATCHED ON THE CANONICAL NAME, never the raw one -- the whole point of
 * `account_map` is that Fat Prince spells things differently. An unmapped
 * account resolves to itself, so it still reaches this function and still gets
 * classified if its own name is clear enough.
 *
 * The patterns are deliberately narrow. A loose rule that catches more would
 * also catch the next account nobody has looked at, which is precisely the
 * silent failure this returns `null` to avoid: unclassified is visible, a wrong
 * bucket is not.
 */
export function classifyCogs(canonicalAccount: string): 'food' | 'beverage' | null {
  const n = canonicalAccount.toLowerCase();

  // Only lines that ARE cost of sales. A sales account with the same word in it
  // never reaches here, because the caller filters on section first.
  /**
   * ALCOHOL belongs here, and its absence was a live defect.
   *
   * Neon Pigeon's ledger carries `COGS - Alcohol`, which this did not match --
   * so $8,668 of drink cost sat under "not food or beverage" and the September
   * beverage cost read 9.6% instead of something near 40%. Visible rather than
   * silent, which is the only reason it was caught at a glance, but wrong.
   *
   * The list is still deliberately narrow. A rule loose enough to catch
   * anything drink-shaped also catches the next account nobody has looked at,
   * and a wrong bucket is invisible where `unclassified` is not.
   */
  const isBeverage = /\b(beverage|beverages|drink|drinks|alcohol|liquor|wine|wines|beer|beers|spirits|cocktail|cocktails|bar)\b/.test(n);
  const isFood = /\b(food|kitchen|produce|meat|seafood|sushi|dry goods)\b/.test(n);

  // An account naming both is ambiguous and must not be guessed at. "COGS -
  // Food & Beverage" is a real way to keep a chart of accounts, and splitting
  // it by assumption would invent the very number being asked for.
  if (isBeverage && isFood) return null;
  if (isBeverage) return 'beverage';
  if (isFood) return 'food';
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function ratio(cogs: number, sales: number, accounts: string[]): CostRatio {
  return {
    cogs: round2(cogs),
    sales: round2(sales),
    // Null rather than 0 when there are no sales: a month with no trade has no
    // cost percentage, and 0% says the kitchen spent nothing.
    pct: sales > 0 ? round2(cogs / sales * 100) : null,
    accounts,
  };
}

export function costRatios(rows: PLRow[], sales: SalesSplit): CostRatios {
  /**
   * SUMMARY ROWS ARE EXCLUDED. "Total Cost of Sales" sits in the same section
   * as the lines beneath it, and including it doubles every figure. The
   * profit_and_loss table carries is_summary precisely because somebody will
   * forget, and this is where forgetting costs a food cost of 64%.
   */
  const lines = rows.filter(r => !r.is_summary && /cost of sales/i.test(r.section));

  let foodCogs = 0, bevCogs = 0;
  const foodAccounts: string[] = [], bevAccounts: string[] = [];
  const unclassified: Array<{ account: string; amount: number }> = [];

  for (const r of lines) {
    const kind = classifyCogs(r.canonical_account || r.account_name);
    const name = r.canonical_account || r.account_name;
    if (kind === 'food') {
      foodCogs += Number(r.amount);
      if (!foodAccounts.includes(name)) foodAccounts.push(name);
    } else if (kind === 'beverage') {
      bevCogs += Number(r.amount);
      if (!bevAccounts.includes(name)) bevAccounts.push(name);
    } else {
      const existing = unclassified.find(u => u.account === name);
      if (existing) existing.amount = round2(existing.amount + Number(r.amount));
      else unclassified.push({ account: name, amount: round2(Number(r.amount)) });
    }
  }

  return {
    food: ratio(foodCogs, sales.food_sales, foodAccounts.sort()),
    beverage: ratio(bevCogs, sales.beverage_sales, bevAccounts.sort()),
    combined: ratio(foodCogs + bevCogs, sales.food_sales + sales.beverage_sales,
                    [...foodAccounts, ...bevAccounts].sort()),
    unclassified: unclassified.sort((a, b) => b.amount - a.amount),
    unclassified_total: round2(unclassified.reduce((n, u) => n + u.amount, 0)),
  };
}

/**
 * The caveats that belong beside every one of these figures.
 *
 * SUPPLIED RATHER THAN REMEMBERED. Each one is a way the number misleads while
 * looking right, and the model composes them differently every time if left to
 * its own devices. Returned as a list so the caller can show all of them.
 */
export function costCaveats(r: CostRatios, monthsCovered: number): string[] {
  const out: string[] = [];

  out.push(
    'Cost of sales in a P&L is PURCHASES in the period, not consumption, unless the venue posts a stock movement. ' +
    'A large delivery near a month end lands against sales it has not produced yet, so one month is noisy — ' +
    'read the trend over a quarter before acting on a single month.',
  );

  if (r.unclassified.length > 0) {
    out.push(
      `${r.unclassified.length} cost-of-sales account(s) totalling $${r.unclassified_total.toFixed(2)} are neither ` +
      'food nor beverage by name — packaging, delivery commission and consumables legitimately sit here, but so does ' +
      'an account nobody has mapped yet. They are EXCLUDED from both percentages. Check them in the admin console ' +
      'before quoting these figures as the venue\'s full cost of sales.',
    );
  }

  if (r.food.pct === null || r.beverage.pct === null) {
    out.push('One of the two has no sales in the period, so its percentage is unavailable rather than zero.');
  }

  /**
   * A COST RATIO OVER 100% IS NOT A COST RATIO.
   *
   * Neon Pigeon's July 2026 came back at 301% food cost, which was plotted on a
   * chart and described as a trend. A restaurant does not spend three dollars on
   * food for every dollar it sells; the figure is arithmetically correct and is
   * not a measurement of anything. Three causes, and the reader needs to know
   * which rather than being handed the number:
   *
   *   - a stock BUILD: an opening order or a bulk purchase booked in a month
   *     whose sales have not happened yet;
   *   - MISSING SALES: a month where Revel did not land for part of the period,
   *     so the denominator is a fraction of the real one;
   *   - a misclassified account inflating the numerator.
   *
   * Flagged at 70% rather than 100%, because a food cost above seventy is
   * already outside anything a kitchen produces and the earlier the reader is
   * told, the less likely they are to act on it.
   */
  for (const [label, side] of [['Food', r.food], ['Beverage', r.beverage]] as const) {
    if (side.pct !== null && side.pct > 70) {
      out.push(
        `${label} cost comes out at ${side.pct}%, which is not a cost ratio a kitchen produces. ` +
        'It usually means a stock build booked against sales that have not happened yet, or a month where ' +
        'the POS feed did not land for part of the period so the denominator is short. Check the sales side ' +
        'before reading this as a cost problem.',
      );
    }
  }

  if (monthsCovered > 1) {
    out.push(
      `Covers ${monthsCovered} months. Cost and sales are both totalled across them, so this is the blended ratio ` +
      'for the whole span and not an average of the monthly ones.',
    );
  }

  return out;
}
