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

/**
 * The periods the dashboard can show, and why there are four.
 *
 * WEEK TO DATE IS THE DEFAULT AND IT IS USELESS ON A TUESDAY. Khai, 4 Oct 2026:
 * "we usually go through our previous week on Tuesday, this rolling would not
 * give an image of last week on Tuesday." Two days of trade is not a week, and
 * a page that can only ever show the week in progress cannot support the one
 * meeting that actually happens.
 *
 * So the period is SELECTABLE, and early in the week the selection defaults to
 * the completed week -- see `defaultPeriod()`. A changing default is normally a
 * way to confuse somebody, and the thing that makes it safe here is that the
 * selector is on screen and the window label spells the dates out. The reader
 * is never guessing which period they are looking at.
 *
 * EVERY PERIOD COMPARES LIKE FOR LIKE. That is the whole reason this is one
 * function rather than four: a week to date against a whole previous week shows
 * a fall every day except Sunday, and a month to date against a whole previous
 * month does the same thing on a bigger scale and for longer.
 */
export type PeriodKind = 'wtd' | 'last_week' | 'mtd' | 'last_month';

export const PERIOD_LABELS: Record<PeriodKind, string> = {
  wtd: 'Week to date',
  last_week: 'Last week',
  mtd: 'Month to date',
  last_month: 'Last month',
};

export function isPeriodKind(v: unknown): v is PeriodKind {
  return v === 'wtd' || v === 'last_week' || v === 'mtd' || v === 'last_month';
}

/**
 * Which period to open on, given the day of the week.
 *
 * Monday and Tuesday open on the COMPLETED week, because that is when the
 * business reviews it and because week-to-date on a Tuesday is two days. From
 * Wednesday the week in progress has enough in it to be worth watching, so it
 * takes over. The rest of the week is the rhythm the operator already has.
 */
export function defaultPeriod(today: string = sgtToday()): PeriodKind {
  const dow = daysSinceMonday(today);     // Monday = 0
  return dow <= 1 ? 'last_week' : 'wtd';
}

function monthStart(date: string): string {
  return date.slice(0, 8) + '01';
}

function addMonths(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp: 31 March minus a month is 28 or 29 February, not 2 or 3 March.
  const lastOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfTarget));
  return iso(d);
}

/** How many Saturdays and Sundays a date range contains. */
export function weekendDays(start: string, end: string): number {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = daysSinceMonday(d);
    if (dow === 5 || dow === 6) n++;
  }
  return n;
}

export interface PeriodWindow extends DashboardWindow {
  kind: PeriodKind;
  label: string;
  /**
   * The last business date that actually has sales in the warehouse.
   *
   * REVEL ARRIVES OVERNIGHT, about 04:26 SGT, carrying the PREVIOUS day. So
   * during any given day the warehouse's most recent complete day is yesterday,
   * and a window running to "today" holds one day less data than the window it
   * is compared against. Mon-to-Sat against Mon-to-Sat is five days of trade
   * against six, and it shows a fall every single day of every single week.
   *
   * That is the defect this whole file was written to prevent, arriving through
   * the back door: the dates were right and the DATA behind one of them was
   * not. So the window is built from the last date with data, never from the
   * calendar, and `data_through` is reported so the page can say which day it
   * actually runs to.
   */
  data_through: string | null;
  /**
   * Things true of this comparison that the figures cannot show.
   *
   * A month to date against the same dates last month can hold a different
   * number of weekends, and in this business a weekend day is worth
   * substantially more than a Tuesday -- so a "fall" can be one fewer Saturday.
   * Stated rather than left for somebody to notice.
   */
  warnings: string[];
}

export function periodWindow(
  kind: PeriodKind,
  today: string = sgtToday(),
  dataThrough?: string | null,
): PeriodWindow {
  /**
   * The effective "now" is the last day we have data for, not the calendar day.
   * Everything below is built from it, so both sides of every comparison hold
   * the same number of TRADED days rather than the same number of dates.
   */
  const effective = dataThrough && dataThrough < today ? dataThrough : today;
  const base = { today, kind, label: PERIOD_LABELS[kind], data_through: dataThrough ?? null };

  const lag = (w: PeriodWindow): PeriodWindow => {
    if (!dataThrough || dataThrough >= today) return w;
    return {
      ...w,
      warnings: [
        `Runs to ${dataThrough}, not today: Revel delivers overnight so the current day is never in the warehouse yet. ` +
        'Both sides of the comparison are cut to the same length, so the movement is still like for like.',
        ...w.warnings,
      ],
    };
  };

  if (kind === 'wtd' || kind === 'last_week') {
    const w = dashboardWindow(effective);
    if (kind === 'wtd') return lag({ ...w, ...base, warnings: [] });

    // The completed week, and the one before it. Both are full Monday-to-Sunday
    // weeks, so there is no partial-period caveat at all.
    /**
     * A COMPLETED week is historical, so it is computed from the CALENDAR and
     * not from the data lag -- using `effective` would shift the week under
     * review backwards every Monday morning before the overnight run lands,
     * and a review meeting would be looking at the wrong week.
     */
    const cal = dashboardWindow(today);
    const end = addDays(cal.current.start, -1);        // the Sunday just gone
    const start = addDays(end, -6);
    const warnings: string[] = [];
    if (dataThrough && dataThrough < end) {
      warnings.push(
        `The warehouse only runs to ${dataThrough}, so this week is incomplete by ` +
        `${Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${dataThrough}T00:00:00Z`)) / 86400_000)} day(s). ` +
        'Treat the totals as partial rather than as a quiet week.',
      );
    }
    return {
      ...base,
      current: { start, end },
      prior: { start: addDays(start, -7), end: addDays(end, -7) },
      days: 7,
      thin: false,
      warnings,
    };
  }

  if (kind === 'mtd') {
    const start = monthStart(effective);
    const priorStart = addMonths(start, -1);
    const priorEnd = addMonths(effective, -1);
    const days = Math.round((Date.parse(`${effective}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1;

    const warnings: string[] = [];

    /**
     * THE SPANS CAN DIFFER, AND ONLY AT A MONTH END.
     *
     * 31 March minus a month is 28 February, because February has no 31st. So
     * month to date on the 31st compares 31 days of trade against 28 -- about
     * 10% more trading, which lands as growth and is the calendar. It cannot be
     * fixed by truncating the current month, because the reader asked for month
     * to date and hiding three days of it is the worse answer. So it is stated.
     */
    const priorDays = Math.round(
      (Date.parse(`${priorEnd}T00:00:00Z`) - Date.parse(`${priorStart}T00:00:00Z`)) / 86400_000) + 1;
    const curDays = days;
    if (curDays !== priorDays) {
      warnings.push(
        `${curDays} days against ${priorDays}: the previous month is shorter, so it has no matching date. ` +
        'The extra day(s) of trade land as growth and are the calendar, not the business.',
      );
    }

    const nowWeekend = weekendDays(start, effective);
    const thenWeekend = weekendDays(priorStart, priorEnd);
    if (nowWeekend !== thenWeekend) {
      warnings.push(
        `This span has ${nowWeekend} weekend day(s) against ${thenWeekend} in the comparison. ` +
        'A weekend day is worth considerably more than a Tuesday here, so part of any movement is the calendar rather than the trade.',
      );
    }

    return lag({
      ...base,
      current: { start, end: effective },
      prior: { start: priorStart, end: priorEnd },
      days,
      thin: days <= 2,
      warnings,
    });
  }

  // last_month: the month that has finished, against the one before it.
  const thisMonth = monthStart(today);
  const end = addDays(thisMonth, -1);
  const start = monthStart(end);
  const priorEnd = addDays(start, -1);
  const priorStart = monthStart(priorEnd);

  const warnings: string[] = [];
  const nowWeekend = weekendDays(start, end);
  const thenWeekend = weekendDays(priorStart, priorEnd);
  const curLen = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1;
  const priorLen = Math.round((Date.parse(`${priorEnd}T00:00:00Z`) - Date.parse(`${priorStart}T00:00:00Z`)) / 86400_000) + 1;

  if (curLen !== priorLen) {
    // A whole month against a whole month is the right comparison and they are
    // genuinely different lengths. February against January is 28 against 31 --
    // a 10% difference in trading days before anybody sells anything.
    warnings.push(
      `${curLen} days against ${priorLen}: calendar months are different lengths, which is about ` +
      `${Math.abs(Math.round((curLen / priorLen - 1) * 100))}% of trading days before any trading happens.`,
    );
  }
  if (nowWeekend !== thenWeekend) {
    warnings.push(
      `${start.slice(0, 7)} has ${nowWeekend} weekend days against ${thenWeekend} in the month before. ` +
      'A weekend day is worth considerably more than a Tuesday here, so part of any movement is the calendar.',
    );
  }

  return {
    ...base,
    current: { start, end },
    prior: { start: priorStart, end: priorEnd },
    days: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1,
    thin: false,
    warnings,
  };
}
