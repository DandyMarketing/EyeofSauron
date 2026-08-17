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
 * This is the basis costs are measured against -- food cost % and beverage
 * cost % both divide by this, never by a figure carrying service charge.
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
