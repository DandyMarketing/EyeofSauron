/**
 * Telling a closed venue apart from a failed ingestion.
 *
 * The parsers reject an empty report rather than writing an empty day, and
 * that is the right default: an empty file and a truncated download look
 * identical, and silently accepting one would log a healthy "success" for a
 * night that never landed. But a venue that is shut produces exactly that
 * empty file, on a schedule, forever -- so the guard fires every week and the
 * watchdog goes permanently red.
 *
 * A watchdog that is always red is one nobody reads, which is the failure mode
 * docs/BUILD_LOG.md calls most likely to go unnoticed at scale. The fix is to
 * give ingestion the one fact it was missing: which days this venue trades.
 */

/** Monday = 0 ... Sunday = 6, matching DOW_LABELS in src/ai/charts.ts. */
export function weekdayOf(businessDate: string): number {
  // Parsed as UTC. `new Date('2026-08-09')` alone reads back in local time,
  // which shifts the weekday for any server west of GMT -- the same bug
  // bucketOf() had to avoid.
  const d = new Date(`${businessDate}T00:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/**
 * Is this venue normally shut on this date?
 *
 * Note what this does NOT do: it never suppresses data. A day listed as closed
 * that turns out to have traded ingests exactly as normal. The flag only
 * changes how an *empty* report is read.
 */
export function isExpectedClosure(
  closedWeekdays: number[] | null | undefined,
  businessDate: string,
): boolean {
  if (!closedWeekdays || closedWeekdays.length === 0) return false;
  return closedWeekdays.includes(weekdayOf(businessDate));
}

/**
 * Did this failure mean "the report was empty", as opposed to anything else?
 *
 * Matched narrowly and deliberately. Broadening it would let a genuine
 * extraction failure be filed as a closure on a day the venue is shut, which
 * is precisely the silent data loss the guard exists to prevent. Any other
 * error on a closed day is still an error.
 */
const EMPTY_REPORT_SIGNATURES = [
  'has no data rows',
  'no sales-by-class rows and no gross/net sales',
];

export function isEmptyReportError(message: string): boolean {
  return EMPTY_REPORT_SIGNATURES.some(sig => message.includes(sig));
}

/**
 * The status an ingestion failure should be logged under.
 *
 * 'closed' is a normal outcome and is excluded from the watchdog's error list;
 * everything else keeps the caller's original status so nothing is downgraded
 * by accident.
 */
export function classifyIngestFailure<T extends string>(
  message: string,
  closedWeekdays: number[] | null | undefined,
  businessDate: string,
  fallbackStatus: T,
): T | 'closed' {
  if (isEmptyReportError(message) && isExpectedClosure(closedWeekdays, businessDate)) {
    return 'closed';
  }
  return fallbackStatus;
}
