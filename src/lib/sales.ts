/**
 * What each sales figure means, in one place.
 *
 * The definitions are Khai's, and they are the business's -- not the textbook
 * ones. Getting this wrong is easy and expensive, so it is written down rather
 * than inferred:
 *
 *     Gross Sales = food + beverage, service charge EXCLUDED
 *     Net Sales   = (gross sales - discounts) + the 10% service charge
 *     Cost basis  = food + beverage, i.e. gross sales
 *
 * So NET SALES IS LARGER THAN GROSS SALES, on every trading day. That is not a
 * defect and must never be "corrected": the service charge is added after the
 * discounts come off, so it enters net and was never in gross. It has now been
 * mis-read in both directions -- BUILD_LOG 2.4 assumed the common convention
 * and made net 10% too low; BUILD_LOG 1.9 assumed gross must exceed net and
 * reported gross 9% too high. Both looked like obvious fixes.
 *
 * THE PROOF IS IN PRODUCTION, not in anybody's memory. `reconcileMondayVsRevel`
 * compares the Monday board's food + beverage against Revel's `gross_sales`
 * column with a tolerance of EXACTLY ZERO, and it has been passing. If that
 * column carried service charge, every day at every venue would fail it by
 * about 10%. Monday derives its own figures the same way, in
 * `deriveTotals()`: gross = food + bev, net = gross - discounts + service
 * charge.
 *
 * The warehouse columns do not line up with those names, which is the trap:
 *
 *   `daily_operations.gross_sales`  food + beverage, WITHOUT service charge.
 *                                   This is the COST BASIS, not the business's
 *                                   gross sales. Sourced from the total row of
 *                                   Revel's sales-by-class table, which only
 *                                   has product classes -- service charge is
 *                                   not a product, so it is not in there.
 *
 *   `daily_operations.net_sales`    Revel's "Total Sales", which IS the
 *                                   business's net sales. Already correct;
 *                                   read it, do not re-derive it.
 *
 * The identity, verified to the cent on days across three venues and three
 * years (Neon Pigeon 19 Sep 2024, Fat Prince 18 Sep 2024, Firangi 31 Dec 2022,
 * Firangi 12 Jan 2023, Neon Pigeon 22 Mar 2025):
 *
 *     net_sales = (gross_sales - discounts) x 1.10
 *
 * which is the same statement as `(food + bev + SC) - discounts`, because the
 * 10% service charge is levied on the discounted amount. Both readings give
 * the same number; the second is the one the business uses.
 *
 * Discounts throughout are item plus order -- the pair Revel splits and the
 * Monday board combines into one field. Coupons are reported separately by
 * Revel and are not included; if a day ever carries coupons, `serviceChargeOf`
 * will not come out at 10% and that is the signal to revisit this.
 */

export interface SalesRow {
  /** Food + beverage. NOT the business's "gross sales" -- see above. */
  gross_sales: number | string | null;
  item_discounts: number | string | null;
  order_discounts: number | string | null;
  /** Revel's "Total Sales" == the business's net sales. */
  net_sales?: number | string | null;
}

const n = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Item + order discounts. The single figure the Monday board records. */
export function totalDiscountsOf(row: SalesRow): number {
  return round2(n(row.item_discounts) + n(row.order_discounts));
}

/**
 * Food and beverage sales, before discounts and excluding service charge.
 *
 * The denominator for everything measured per-something: food cost %, beverage
 * cost %, the food/beverage split, discount rate, and spend per head. None of
 * them may divide by a figure carrying service charge -- a cost measured
 * against gross comes out about 10% low and reads as an improvement.
 *
 * Spend per head on this basis will not equal Revel's "Average Sale Per Guest",
 * which uses net sales over Revel's own guest count. Both are correct; they are
 * different questions. Firangi 6 Aug 2026: 4,968.50 here, 5,286.05 there.
 */
export function foodAndBevSalesOf(row: SalesRow): number {
  return round2(n(row.gross_sales));
}

/**
 * Net sales: gross less discounts, service charge included. Read straight from
 * Revel rather than derived, because Revel already computes it and its figure
 * is the one the accounts use.
 */
export function netSalesOf(row: SalesRow): number {
  return round2(n(row.net_sales));
}

/**
 * Service charge, implied by the two stored figures. Null when `net_sales` is
 * absent, which is the case for rows sourced from the Monday board alone --
 * returning 0 there would claim a venue took no service charge, which is a
 * different statement from not knowing.
 */
export function serviceChargeOf(row: SalesRow): number | null {
  if (row.net_sales === null || row.net_sales === undefined) return null;
  return round2(n(row.net_sales) - (foodAndBevSalesOf(row) - totalDiscountsOf(row)));
}

/**
 * Gross sales as the business defines it: food + beverage, service charge
 * EXCLUDED. The same quantity as `foodAndBevSalesOf` -- two names because the
 * business uses both, and because every cost ratio in this codebase divides by
 * the second one and must keep doing so if this ever changes.
 *
 * It returns a number and never null, unlike the version that derived it from
 * net sales: the food and beverage figure is stored directly, so a Monday-board
 * row has it too.
 */
export function grossSalesOf(row: SalesRow): number {
  return foodAndBevSalesOf(row);
}

/**
 * Gross less discounts, BEFORE service charge. Revel prints it as "Net Totals"
 * on the sales-by-class table, and it is the base the 10% is actually levied on
 * -- which is the step that makes net sales exceed gross sales.
 *
 * Not called "net sales": that name is taken, by the figure that includes the
 * service charge, and overloading it is how this got mis-read twice.
 */
export function discountedSalesOf(row: SalesRow): number {
  return round2(foodAndBevSalesOf(row) - totalDiscountsOf(row));
}

/**
 * Every sales figure for one day, in the one shape every tool must return.
 *
 * WHY THIS EXISTS RATHER THAN FOUR CALLS AT EACH SITE. `query_sales` had two
 * paths — one date, and a date range — and only the range used the functions
 * above. The single-date path spread the warehouse row straight out, so the
 * model received the COLUMN named `gross_sales`, which holds food plus beverage
 * with no service charge, while the tool's own description told it that field
 * includes service charge.
 *
 * What that produced, asked in front of Khai about Neon Pigeon on 29 Sep 2026:
 *
 *     Net sales    $3,759.26
 *     Gross sales  $3,639.00     <- net larger than gross, every day, every venue
 *
 * Neither figure is wrong; they are two different bases, and the real gross
 * ($3,980.76 — verified against that day's own GROSS PRODUCT SALES total)
 * never appeared at all. The same question asked as a one-DAY RANGE came back
 * correct, which is the worse half: two paths answering one question and
 * disagreeing.
 *
 * So the block is built once here. A new tool returning day figures spreads
 * this and cannot reintroduce the divergence by forgetting a call.
 */
export interface SalesFigures {
  /** Food + beverage, service charge EXCLUDED. The business's gross. */
  gross_sales: number;
  /** The same figure, under the name every cost and per-head ratio divides by. */
  food_bev_sales: number;
  /** Gross less discounts PLUS the 10% service charge, so it exceeds gross. */
  net_sales: number;
  /** Implied, not stored. Null when there is no Revel figure to imply it from. */
  service_charge: number | null;
  /** Item + order. Coupons are excluded — see the note at the top of this file. */
  total_discounts: number;
  /**
   * Discounts as a share of gross. Null when there were no sales to discount.
   *
   * Computed here rather than left to the model, on the same rule as the food
   * and beverage split: every number comes from a query tool, and a percentage
   * is a number. The dollar figure alone does not travel between venues or
   * across a quiet week — $221 of discounting is a different story on a $3,600
   * day than on a $12,000 one.
   */
  discount_rate_pct: number | null;
}

/**
 * The food and beverage split, in dollars and as a share.
 *
 * WHY IT IS A FIGURE AND NOT A CALCULATION THE MODEL DOES. The classes sit in
 * `sales_by_class` as raw JSON on the row, so a model handed the row could add
 * them up itself — and the standing rule is that every number comes from a
 * query tool, because a figure the model computed is a figure nobody can check.
 * `compare_venues` already did this correctly in a loop of its own; `query_sales`
 * did not do it at all, so the single most ordinary question about a service —
 * how did drinks do against food — could not be answered from the tool that
 * answers how the day went.
 *
 * THE SHARE IS OF FOOD + BEVERAGE, never of gross or net. Service charge is not
 * food and it is not drink; measuring a split against a figure carrying it makes
 * both halves read about 9% low and they stop summing to 100.
 *
 * A CLASS THAT IS NEITHER IS REPORTED, NOT DROPPED. Revel allows classes beyond
 * Food and Beverage — retail, merchandise, a venue that sells cookbooks — and a
 * split that quietly ignores one is two numbers that do not add up with nothing
 * saying why. Same rule as the payment methods one file over: the sum is the
 * check on the list.
 */
/**
 * Where a day's food/drink split came from.
 *
 * `revel` is the POS's own class split. `monday_board` is the food and drink
 * figures the venue types into the Monday board each night, which is the only
 * split that exists before Revel's daily files began (late July 2026). `none`
 * means the day carries sales and neither source split them.
 */
export type SplitBasis = 'revel' | 'monday_board' | 'none';

export interface ClassSplit {
  food_sales: number;
  beverage_sales: number;
  /** Share of food + beverage. Null when there were no sales to take a share of. */
  food_pct: number | null;
  beverage_pct: number | null;
  /** Present only when a class other than Food or Beverage carried sales. */
  other_sales?: number;
  other_classes?: string[];
  split_basis: SplitBasis;
}

interface ClassRow { class?: string; grossSales?: number | string | null }

/**
 * THE MONDAY BOARD IS THE FALLBACK, NOT AN ALTERNATIVE.
 *
 * This read `sales_by_class` and nothing else, so every day that predates
 * Revel's daily files -- January to late July 2026, at every venue -- counted
 * as NO food and NO drink. Silently: the row existed, so nothing said the
 * sales were missing. A month with three Revel days then divided a full month
 * of Xero food cost by three days of food sales, and Neon Pigeon's July came
 * out at 301%. On the full month's sales the same cost is about 32%.
 *
 * Revel wins wherever it has a split. The board is used only on a day Revel did
 * not split, and the day says so in `split_basis`. The two agree to the cent on
 * food plus drink (`reconcileMondayVsRevel`, zero tolerance), and after the
 * Monday sync fix of 6 Oct 2026 (BUILD_LOG 1.12) they agreed on the food/drink
 * split itself on all but two Fat Prince days in August and September.
 */
export function classSplitOf(row: { sales_by_class?: unknown; meal_periods?: unknown }): ClassSplit {
  const rows: ClassRow[] = Array.isArray(row.sales_by_class) ? row.sales_by_class : [];
  const hasRevelSplit = rows.some(r => (r.class ?? '').trim().toLowerCase() !== 'total');

  if (!hasRevelSplit) {
    const board = mondayBoardSplit(row.meal_periods);
    if (board) return board;
  }

  let food = 0, bev = 0, other = 0;
  const otherClasses: string[] = [];

  for (const r of rows) {
    const name = (r.class ?? '').trim();
    // The ingest already drops Revel's "Total" row, but a tool that trusts that
    // and is wrong once double-counts the whole day.
    if (name.toLowerCase() === 'total') continue;
    const amount = n(r.grossSales);

    if (name.toLowerCase() === 'food') food += amount;
    else if (name.toLowerCase() === 'beverage') bev += amount;
    else if (amount !== 0 || name) {
      other += amount;
      if (name && !otherClasses.includes(name)) otherClasses.push(name);
    }
  }

  const base = round2(food + bev + other);
  const split: ClassSplit = {
    food_sales: round2(food),
    beverage_sales: round2(bev),
    food_pct: base > 0 ? round2(food / base * 100) : null,
    beverage_pct: base > 0 ? round2(bev / base * 100) : null,
    split_basis: hasRevelSplit ? 'revel' : 'none',
  };

  if (other !== 0 || otherClasses.length > 0) {
    split.other_sales = round2(other);
    split.other_classes = otherClasses;
  }
  return split;
}

/** Food and drink from the board's meal periods, or null if it has none. */
function mondayBoardSplit(mealPeriods: unknown): ClassSplit | null {
  if (!mealPeriods || typeof mealPeriods !== 'object' || Array.isArray(mealPeriods)) return null;

  let food = 0, bev = 0, any = false;
  for (const p of Object.values(mealPeriods as Record<string, any>)) {
    if (!p || typeof p !== 'object') continue;
    if (p.food_sales != null || p.bev_sales != null) any = true;
    food += n(p.food_sales);
    bev += n(p.bev_sales);
  }
  if (!any) return null;

  const base = round2(food + bev);
  return {
    food_sales: round2(food),
    beverage_sales: round2(bev),
    food_pct: base > 0 ? round2(food / base * 100) : null,
    beverage_pct: base > 0 ? round2(bev / base * 100) : null,
    split_basis: 'monday_board',
  };
}

export interface SplitTotals {
  food_sales: number;
  beverage_sales: number;
  /** How many days each source supplied. */
  days: Record<SplitBasis, number>;
  /** Days that carried sales and no split from either source. */
  unsplit_dates: string[];
}

/**
 * Food and drink summed over a run of days, with a count of where each came from.
 *
 * The count is the point. A total that is part Revel and part board is fine and
 * must say so; a total missing days is short, and a cost measured against it
 * reads high by exactly the missing share -- which is how a 301% got onto a
 * chart. A day counts as unsplit only if it carried SALES, so a closed day's
 * empty row is not mistaken for a hole.
 */
export function sumClassSplits(
  rows: Array<{ business_date?: string; gross_sales?: unknown; sales_by_class?: unknown; meal_periods?: unknown }>,
): SplitTotals {
  const out: SplitTotals = {
    food_sales: 0, beverage_sales: 0,
    days: { revel: 0, monday_board: 0, none: 0 },
    unsplit_dates: [],
  };
  for (const r of rows) {
    const s = classSplitOf(r);
    if (s.split_basis === 'none') {
      if (!n(r.gross_sales as number | string | null | undefined)) continue;
      out.days.none++;
      if (r.business_date) out.unsplit_dates.push(String(r.business_date));
      continue;
    }
    out.days[s.split_basis]++;
    out.food_sales += s.food_sales;
    out.beverage_sales += s.beverage_sales;
  }
  out.food_sales = round2(out.food_sales);
  out.beverage_sales = round2(out.beverage_sales);
  out.unsplit_dates.sort();
  return out;
}

/**
 * What each figure MEANS, travelling with the figure itself.
 *
 * WHY IN THE TOOL RESPONSE AND NOT ONLY THE PROMPT. The definitions were in the
 * system prompt, correctly, and the prompt ALSO carried an older contradictory
 * line saying gross sales was "product sales before discounts/tax". Given both,
 * the model used the wrong one and labelled food & beverage as gross sales. A
 * definition written far from the number is a definition that can disagree with
 * the number; this one is returned by the same function that computes it.
 *
 * These are the business's definitions and NOT the textbook ones — service
 * charge sitting inside gross sales is the opposite of the usual F&B
 * convention, which is exactly why a reader who is not told will be about 10%
 * wrong and will never know it. See the header of this file and BUILD_LOG 2.4.
 *
 * Phrased for an operator to read verbatim, not for a model to paraphrase.
 */
export const FIGURE_DEFINITIONS = {
  gross_sales: 'Food + beverage, before discounts. The service charge is NOT in here. Monday\'s weekly report labels food + beverage + service charge (+ delivery) as "Gross Sales", so it reads about 10% higher; if someone quotes a Monday gross, say so rather than calling either figure wrong. Net sales agrees between the two',
  food_bev_sales: 'The same figure as gross sales. Named separately because every cost percentage and spend per head divides by it',
  net_sales: 'Gross less discounts, plus the 10% service charge — so it is larger than gross. What "sales" means when nobody says which',
  service_charge: 'The 10% charged on the discounted amount. Inside net sales, NOT inside gross — never add it to net',
  total_discounts: 'Item discounts + order discounts. Coupons are reported separately by Revel and are not included',
  discount_rate_pct: 'Discounts as a share of gross sales',
  food_sales: 'Food alone, before discounts and service charge',
  beverage_sales: 'Beverage alone, before discounts and service charge',
  food_pct: 'Food as a share of food & beverage sales. Beverage is the rest, so the two sum to 100',
  avg_spend_per_head: 'Food & beverage ÷ SevenRooms covers. Revenue per PERSON. Deliberately not Revel\'s "Average Sale Per Guest", which uses a different numerator and denominator',
  avg_check: 'Net sales ÷ bills: food and drink after discounts, plus service charge, per BILL -- the same figure the dashboard shows. Not per person: it rises when parties are larger, so it describes table mix as much as selling',
  net_to_account_for: 'Total cash + card collected, including GST. The only figure here that carries tax',
} as const;

export function salesFiguresOf(row: SalesRow): SalesFigures {
  return {
    gross_sales: grossSalesOf(row),
    food_bev_sales: foodAndBevSalesOf(row),
    net_sales: netSalesOf(row),
    service_charge: serviceChargeOf(row),
    total_discounts: totalDiscountsOf(row),
    discount_rate_pct: grossSalesOf(row) > 0
      ? round2(totalDiscountsOf(row) / grossSalesOf(row) * 100)
      : null,
  };
}
