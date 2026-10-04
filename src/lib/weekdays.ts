/**
 * A week runs MONDAY TO SUNDAY. One definition, because there were two.
 *
 * Khai, 4 Oct 2026: "Treat a week as mon to sun not sun to sat."
 *
 * Almost everything already did. `lastCompleteWeek()`, the chart bucketing,
 * `weekdayOf()` and the dashboard window all index Monday as 0. The exception
 * was `src/ai/post-patterns.ts`, which kept a SUNDAY-FIRST array under a comment
 * claiming it matched "the weekday charts already built" -- and those charts
 * label from a Monday-first array one file away. The comment was not merely
 * wrong, it was the kind of wrong that stops the next person checking.
 *
 * Nothing visibly broke, which is why it survived: that module ranks weekdays by
 * median performance rather than by weekday, so the ordering never showed. It
 * would have surfaced the first time anybody sorted by the index, or compared a
 * post-pattern weekday against a sales weekday -- and it would have surfaced as
 * an off-by-one in a chart nobody could explain.
 *
 * WHY MONDAY. It is what the business works in: the recommendation engine
 * reviews a complete Monday-to-Sunday week because that is the unit an operator
 * already thinks in, and a Sunday-start week would cut every weekend in half.
 * It is also ISO 8601 and what Postgres `date_trunc('week', ...)` returns, so
 * SQL and application code agree without conversion.
 *
 * `getUTCDay()` is 0=Sunday, so every index here goes through `weekdayIndex()`.
 * Using it raw is the mistake this file exists to prevent.
 */

/** Monday = 0 ... Sunday = 6. */
export const DOW_LABELS: readonly string[] = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

/** Short form, for an axis or a chip where the full name will not fit. */
export const DOW_SHORT: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Monday = 0 ... Sunday = 6, from a business date.
 *
 * Parsed as UTC explicitly. `new Date('2026-07-14')` is midnight UTC but reads
 * back in local time, which silently shifts the weekday for any server west of
 * GMT -- a Sunday that reports as a Saturday, on exactly the days a restaurant
 * cares about most.
 */
export function weekdayIndex(businessDate: string): number {
  const d = new Date(`${businessDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`weekdayIndex: "${businessDate}" is not a date`);
  return (d.getUTCDay() + 6) % 7;
}

/** The weekday name for a business date, Monday-first. */
export function weekdayName(businessDate: string): string {
  return DOW_LABELS[weekdayIndex(businessDate)];
}

/** The Monday of the week a date falls in. */
export function mondayOf(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weekdayIndex(businessDate));
  return d.toISOString().slice(0, 10);
}
