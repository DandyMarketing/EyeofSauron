/**
 * What each sales figure means, in one place.
 *
 * The definitions are Khai's, and they are the business's -- not the textbook
 * ones. Getting this wrong is easy and expensive, so it is written down rather
 * than inferred:
 *
 *     Gross Sales = food + beverage + service charge
 *     Net Sales   = gross sales - discounts
 *     Cost basis  = food + beverage only, service charge excluded
 *
 * Note that service charge sits INSIDE gross sales here. The common F&B
 * convention is the opposite, and assuming it produced a wrong "fix" that had
 * to be reverted -- see BUILD_LOG 2.4.
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
 * Gross sales as the business defines it: food + beverage + service charge.
 * Equivalently net sales plus the discounts that were taken off it. Null when
 * there is no Revel figure to imply the service charge from.
 */
export function grossSalesOf(row: SalesRow): number | null {
  if (row.net_sales === null || row.net_sales === undefined) return null;
  return round2(n(row.net_sales) + totalDiscountsOf(row));
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
  /** Food + beverage + service charge. The business's gross. */
  gross_sales: number;
  /** Food + beverage alone. The basis for every cost and per-head figure. */
  food_bev_sales: number;
  /** Gross less discounts. Revel's own "Total Sales". */
  net_sales: number;
  /** Implied, not stored. Null when there is no Revel figure to imply it from. */
  service_charge: number | null;
  /** Item + order. Coupons are excluded — see the note at the top of this file. */
  total_discounts: number;
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
  gross_sales: 'Food + beverage + the 10% service charge, before discounts',
  food_bev_sales: 'Food + beverage alone, no service charge. The basis for cost percentages and spend per head',
  net_sales: 'Gross sales less discounts. What "sales" means when nobody says which',
  service_charge: 'The 10% charged on the discounted amount. Already inside gross and net sales — never add it on top',
  total_discounts: 'Item discounts + order discounts. Coupons are reported separately by Revel and are not included',
  avg_spend_per_head: 'Food & beverage ÷ SevenRooms covers. Revenue per PERSON. Deliberately not Revel\'s "Average Sale Per Guest", which uses a different numerator and denominator',
  avg_check: 'Revenue per BILL, not per person. It rises when parties are larger, so it describes table mix as much as selling',
  net_to_account_for: 'Total cash + card collected, including GST. The only figure here that carries tax',
} as const;

export function salesFiguresOf(row: SalesRow): SalesFigures {
  return {
    // Falls back to food+bev when there is no net sales to derive gross from,
    // which is a Monday-board row. Reporting food+bev as gross understates it
    // by the service charge; reporting null would lose the day entirely.
    gross_sales: grossSalesOf(row) ?? foodAndBevSalesOf(row),
    food_bev_sales: foodAndBevSalesOf(row),
    net_sales: netSalesOf(row),
    service_charge: serviceChargeOf(row),
    total_discounts: totalDiscountsOf(row),
  };
}
