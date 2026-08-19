import { closeDateFor } from './accounting-period.js';

/**
 * Which accounting months to pull, and which are already settled for good.
 *
 * Kept apart from the fetching so the awkward part -- deciding when a stored
 * P&L is FINAL rather than merely present -- is testable without Xero.
 *
 * The awkward part is real. A P&L is not fixed when the month ends: finance
 * keeps posting entries for weeks afterwards, so the same month pulled on the
 * 3rd and on the 20th gives different numbers. A backfill that skips any month
 * it already holds would freeze whatever provisional figure it happened to
 * capture first -- which is the Monday lock (BUILD_LOG 2.5) with a ledger
 * instead of a board.
 */

export interface AccountingMonth {
  /** First day, YYYY-MM-DD. */
  start: string;
  /** Last day, YYYY-MM-DD. */
  end: string;
  /** Human label, e.g. "2026-07". */
  label: string;
}

/** Whole calendar months, oldest first, ending with the month `asOf` falls in. */
export function monthsBack(count: number, asOf: Date = new Date()): AccountingMonth[] {
  const months: AccountingMonth[] = [];
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();

  for (let i = count - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(year, month - i, 1));
    // Day zero of the NEXT month is the last day of this one, which handles
    // February and leap years without a table of month lengths.
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    months.push({
      start: first.toISOString().slice(0, 10),
      end: last.toISOString().slice(0, 10),
      label: first.toISOString().slice(0, 7),
    });
  }

  return months;
}

/**
 * Whether a stored P&L can be trusted as final.
 *
 * TWO conditions, and missing either one is how a provisional figure gets
 * quoted as fact:
 *
 *   the period has closed              -- the 15th of the following month, and
 *   we fetched it AFTER it closed      -- or we hold a draft of a closed month.
 *
 * The second is the one that is easy to forget. A month pulled on the 3rd is a
 * draft; the month closing on the 15th does not retroactively make the figure
 * we captured on the 3rd correct. It has to be pulled again.
 */
export function isStoredPeriodFinal(
  periodEnd: string,
  fetchedAt: string | null | undefined,
  asOf: Date = new Date(),
): boolean {
  if (!fetchedAt) return false;

  const closeDate = closeDateFor(periodEnd);
  const closeMs = Date.parse(`${closeDate}T00:00:00Z`);
  const fetchedMs = Date.parse(fetchedAt);

  if (!Number.isFinite(closeMs) || !Number.isFinite(fetchedMs)) return false;

  return asOf.getTime() >= closeMs && fetchedMs >= closeMs;
}
