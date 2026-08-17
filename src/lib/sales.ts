/**
 * What "net sales" means, in one place.
 *
 * Revel's operations report has a NET SALES section whose "Total Sales" line we
 * store in `daily_operations.net_sales`. That column is NOT net sales as any
 * F&B operator uses the term. It is sales after discounts PLUS the 10% service
 * charge:
 *
 *     Revel "Total Sales" = (gross_sales - discounts) x 1.10
 *
 * Verified exactly, across three venues and three years:
 *
 *     Neon Pigeon  19 Sep 2024   33,667.00            x 1.1 = 37,033.70
 *     Fat Prince   18 Sep 2024  (25,270.00 -    7.50) x 1.1 = 27,788.75
 *     Firangi      31 Dec 2022  (26,528.00 - 1,176.50) x 1.1 = 27,886.65
 *
 * each matching the stored value to the cent.
 *
 * Service charge is not trading revenue. Most of it goes to staff, and Xero
 * accounts for it separately, so quoting it inside "net sales" overstates the
 * headline by about 10% and will not tie to the P&L. The number looks plausible
 * either way, which is exactly why it went unnoticed -- a manager comparing it
 * against their own mental figure would assume they had misremembered.
 *
 * So net sales is DERIVED here and never read from the column of that name.
 * Discounts are the pair Revel splits and the Monday board combines: item plus
 * order. Coupons are reported separately by Revel and are not included; if a
 * day ever carries coupons, `serviceChargeOf` will not come out at 10% and that
 * is the signal to revisit this.
 */

export interface SalesRow {
  gross_sales: number | string | null;
  item_discounts: number | string | null;
  order_discounts: number | string | null;
  /** Revel's "Total Sales" -- net of discounts, INCLUSIVE of service charge. */
  net_sales?: number | string | null;
}

const n = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Item + order discounts. The single figure the Monday board records. */
export function totalDiscountsOf(row: SalesRow): number {
  return round2(n(row.item_discounts) + n(row.order_discounts));
}

/**
 * Sales after discounts, before service charge and tax -- what an operator
 * means by net sales, and the basis that will tie to the Xero P&L.
 */
export function netSalesOf(row: SalesRow): number {
  return round2(n(row.gross_sales) - totalDiscountsOf(row));
}

/**
 * Service charge implied by Revel's own two figures: its "Total Sales" less
 * true net sales. Null when `net_sales` is absent, which is the case for rows
 * sourced from the Monday board alone.
 */
export function serviceChargeOf(row: SalesRow): number | null {
  if (row.net_sales === null || row.net_sales === undefined) return null;
  return round2(n(row.net_sales) - netSalesOf(row));
}
