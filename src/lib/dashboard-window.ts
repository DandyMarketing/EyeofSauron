/**
 * The weeks a week-to-date dashboard compares, and the one trap in doing it.
 *
 * THE TRAP. `lastCompleteWeek()` exists in recommendation.ts because reviewing
 * "the last seven days" on a Wednesday compares four trading days against seven
 * and reports a collapse in covers every single time. A week-to-date dashboard
 * walks into the same thing from the other side: Monday-to-Saturday of this week
 * against the WHOLE of last week is six days against seven, and it will show a
 * fall every day of every week except Sunday.
 *
 * So the comparison is LIKE FOR LIKE BY WEEKDAY. This week Monday→today against
 * last week Monday→the same weekday. On a Saturday that is Mon–Sat against
 * Mon–Sat; on a Monday it is one day against one day. The number is then
 * honest, and the label has to say so, which is why `days` comes back with it --
 * "6 days vs 6 days" is the only thing that makes a reader trust the arrow.
 *
 * WHY WEEK-TO-DATE AT ALL, when the recommendation engine insists on a COMPLETE
 * week. Different jobs. The engine is deciding whether something is worth saying
 * unprompted, where a part-week is noise. The dashboard is a person asking "how
 * are we doing" mid-week, and telling them about last week only is answering a
 * question they did not ask. Both are right; neither should borrow the other's
 * window.
 *
 * ALL DATES ARE SINGAPORE BUSINESS DATES. The warehouse stores a business date,
 * not a timestamp, so the only thing that matters is which calendar day it is in
 * Singapore. A UTC server at 23:00 is already tomorrow in Singapore, so "today"
 * is computed from the SGT calendar day or the dashboard shows an empty week
 * every evening.
 */

/** Singapore has no daylight saving, so a fixed offset is exact, not an approximation. */
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Today's business date in Singapore, from any instant. */
export function sgtToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Days since the most recent Monday, where Monday is 0 from itself. */
export function daysSinceMonday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`daysSinceMonday: "${date}" is not a date`);
  return (d.getUTCDay() + 6) % 7;
}

export interface DashboardWindow {
  /** Monday of the current week through today. */
  current: { start: string; end: string };
  /** The SAME weekdays of the week before. Never last week entire. */
  prior: { start: string; end: string };
  /** How many calendar days each side covers. Equal, by construction. */
  days: number;
  /** Today, so the page can say what "to date" means. */
  today: string;
  /**
   * True on a Monday, when the comparison is one day against one day.
   *
   * A single day against a single day is a coin toss, and the page must say so
   * rather than drawing an arrow. The same argument as the recommendation
   * engine's "always read the baseline before the comparison".
   */
  thin: boolean;
}

export function dashboardWindow(today: string = sgtToday()): DashboardWindow {
  const since = daysSinceMonday(today);
  const monday = addDays(today, -since);

  return {
    current: { start: monday, end: today },
    // Exactly seven days earlier, both ends, so the weekday pairs line up.
    prior: { start: addDays(monday, -7), end: addDays(today, -7) },
    days: since + 1,
    today,
    thin: since === 0,
  };
}

/**
 * A movement between two periods, or null when there is nothing to compare to.
 *
 * NULL RATHER THAN ZERO when the prior period is absent or empty. Zero means
 * "no change", which is a measurement; a venue with no data last week has not
 * stayed flat. The same distinction the whole codebase keeps making -- a
 * judged-absent and a never-judged are different, and collapsing them makes the
 * figure meaningless.
 *
 * A rise FROM zero is also null rather than infinity: a venue that was closed
 * all last week has not grown by an infinite percentage, and printing one makes
 * the whole row untrustworthy.
 */
export function movement(current: number | null, prior: number | null): {
  delta: number | null;
  pct: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
} {
  if (current === null || prior === null || prior === 0) {
    return { delta: null, pct: null, direction: 'unknown' };
  }
  const delta = Math.round((current - prior) * 100) / 100;
  const pct = Math.round((delta / prior) * 1000) / 10;
  return {
    delta,
    pct,
    direction: pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat',
  };
}
