/**
 * When a business date's figures become final.
 *
 * Khai's rule: everything is true and final, locked, from the middle of the
 * month AFTER the trading month. July's numbers settle on 15 August; from that
 * day on, July is closed and an edit to it is an event worth someone's
 * attention.
 *
 * Before close, a correction is ordinary work and must flow straight through.
 * The old rule locked a day the moment the Monday board first matched Revel,
 * which froze whatever figures we happened to hold at that instant and made
 * every later correction unreachable -- the board would be fixed, the warehouse
 * would not, and the alert raised said only that they now disagreed. Five Fat
 * Prince days in August 2026 were stale that way, including one reported to
 * Finance as $1,271 of missing trade that had in fact been corrected on the
 * board days earlier. See BUILD_LOG 2.5.
 *
 * "Mid month" is taken as the 15th. If Finance closes on a different day, this
 * constant is the only thing to change.
 */
export const CLOSE_DAY_OF_FOLLOWING_MONTH = 15;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date on which `businessDate`'s month becomes final, as YYYY-MM-DD.
 * December rolls into January of the next year.
 */
export function closeDateFor(businessDate: string): string {
  const m = ISO_DATE.exec(businessDate);
  if (!m) {
    // Callers pass a date that `parseDate` has already validated, so anything
    // else is a programming error. Guessing a close date for a string we
    // cannot read would decide whether real figures are frozen.
    throw new Error(`closeDateFor: expected YYYY-MM-DD, got ${JSON.stringify(businessDate)}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new Error(`closeDateFor: month out of range in ${businessDate}`);
  }
  const closeYear = month === 12 ? year + 1 : year;
  const closeMonth = month === 12 ? 1 : month + 1;
  return `${closeYear}-${String(closeMonth).padStart(2, '0')}-${String(CLOSE_DAY_OF_FOLLOWING_MONTH).padStart(2, '0')}`;
}

/**
 * Whether `businessDate` sits in a period that has closed.
 *
 * Compared as UTC date strings, matching the rest of the ingestion code. The
 * eight-hour offset to Singapore only matters on the close date itself, and a
 * monthly close is not a deadline anyone hits to the hour.
 */
export function isPeriodClosed(businessDate: string, asOf: Date = new Date()): boolean {
  return asOf.toISOString().slice(0, 10) >= closeDateFor(businessDate);
}

/**
 * How long Finance gets before a mismatch counts as a finding.
 *
 * Reconciliation is not done daily, and it is not done at weekends. Friday's
 * sales are not looked at until Monday, so anything comparing Friday against
 * Revel on Saturday is comparing against work nobody has started. Every one of
 * those days would raise an alert saying the numbers disagree, which is true
 * and means nothing.
 *
 * An alert that fires before the answer could possibly exist is worse than no
 * alert: it fills the list with days that will resolve themselves, and the real
 * findings sit among them unread. That is how the Monday cron went four days
 * looking broken while it worked (BUILD_LOG 6.1), and it is the same shape.
 *
 * Two working days covers the weekend with room to spare: Friday settles on
 * Tuesday, Monday settles on Wednesday.
 */
export const SETTLING_WORKING_DAYS = 2;

/**
 * Whether Finance has had time to reconcile this date.
 *
 * Counts Monday to Friday only. Singapore public holidays are NOT modelled --
 * a holiday still counts as a working day here, so a long weekend can settle a
 * day one day early and raise an alert Finance has not had time to answer.
 * Worth adding a holiday table if that proves noisy; not worth guessing at now.
 */
export function isSettled(businessDate: string, asOf: Date = new Date()): boolean {
  if (!ISO_DATE.test(businessDate)) {
    throw new Error(`isSettled: expected YYYY-MM-DD, got ${JSON.stringify(businessDate)}`);
  }
  const target = asOf.toISOString().slice(0, 10);
  const cursor = new Date(`${businessDate}T00:00:00Z`);
  let working = 0;

  // Bounded so a far-past date cannot spin. Anything older than this is
  // settled several times over.
  for (let i = 0; i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.toISOString().slice(0, 10) > target) return false;
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) working++;
    if (working >= SETTLING_WORKING_DAYS) return true;
  }
  return true;
}
