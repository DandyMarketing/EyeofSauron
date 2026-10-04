/**
 * Guest retention for the dashboard, which is a MONTHLY figure on a weekly page.
 *
 * WHY NOT THE WEEK. `create_chart` forces both retention measures to monthly
 * whatever is asked of it, because a week holds too few returning guests for
 * the rate to mean anything and a weekly line oscillates on noise. The
 * underlying function will happily compute a week, which is the trap: it
 * returns a number, the number is arithmetically correct, and it is not a
 * measurement. So the dashboard shows the last COMPLETE calendar month and says
 * which month it is -- the same mistake, and the same fix, as the advice panel
 * showing last week's briefing under a heading that said "this week".
 *
 * THE RATE IS MEANINGLESS WITHOUT ITS DENOMINATOR, and that is not a style
 * point. Repeat share FALLS when a venue attracts a lot of new guests, because
 * new guests enlarge the bottom of the fraction. A great month for new business
 * pushes it down; a venue that stops winning anybody new posts a rising
 * retention rate all the way into the ground. So every rate here is returned
 * with the counts that produced it and the page prints both.
 *
 * THE DASHBOARD MEASURES A LIFETIME, THE TREND TOOLS MEASURE A YEAR, and that
 * is deliberate rather than an inconsistency nobody noticed.
 *
 * Khai, 4 Oct 2026: "perhaps it should be all time -- people who had been guest
 * in our life time." He is right about this panel. It answers ONE question
 * about ONE month -- how much of my room is new -- and under a 365-day rule a
 * guest who first came in 2023 and ate here last month was being counted as NEW
 * TO THE GROUP. That is not a conservative reading of the data, it is a false
 * statement about a person we have a record of.
 *
 * The 365-day rule exists for a different job and keeps it. Over a SERIES of
 * months a lifetime lookback widens as the records grow, so the returning share
 * climbs for reasons that are entirely the database filling up -- the Instagram
 * follower-count trap, and the reason `create_chart` withholds months whose
 * lookback is not covered. A line must hold its window still. A single month
 * need not, and pays a real cost for doing so.
 *
 * So the two surfaces measure different things on purpose, and each says which
 * -- because the failure mode here is somebody reading 25% on the dashboard and
 * 18% on a chart and trusting neither again.
 *
 * "LIFETIME" MEANS SINCE OUR RECORDS BEGIN, and the panel prints that date. A
 * guest whose only previous visit predates the ingest is still counted as new,
 * and no amount of widening the window fixes it -- it is the one thing a longer
 * lookback cannot buy.
 */

export interface RetentionCounts {
  booked_guests: number;
  returning_here: number;
  crossed_from_sister: number;
  new_to_group: number;
  walk_in_guests: number;
}

export interface RetentionShares {
  /** Came to THIS venue within the lookback. The venue owns this one. */
  repeat_pct: number | null;
  /** Came to ANY group venue within the lookback. The multi-venue premium. */
  group_pct: number | null;
  /** Had been to no group venue. The only guests being paid for. */
  new_pct: number | null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The last calendar month that has finished.
 *
 * On any day in October this is September, including on 1 October. A month in
 * progress is the week-to-date problem again with a bigger window: three days
 * of October against thirty-one of September is not a comparison.
 */
export function lastCompleteMonth(today: string): { start: string; end: string; label: string } {
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`lastCompleteMonth: "${today}" is not a date`);

  const firstOfThis = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(firstOfThis);
  end.setUTCDate(0);                                    // the last day of the month before
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  return {
    start: iso(start),
    end: iso(end),
    label: start.toLocaleDateString('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/** The month before a given month, for the comparison. */
export function previousMonth(month: { start: string }): { start: string; end: string; label: string } {
  return lastCompleteMonth(month.start);
}

export function retentionShares(c: RetentionCounts): RetentionShares {
  if (!c.booked_guests) return { repeat_pct: null, group_pct: null, new_pct: null };
  const r2 = (n: number) => Math.round(n * 10) / 10;
  return {
    repeat_pct: r2(c.returning_here / c.booked_guests * 100),
    group_pct: r2((c.returning_here + c.crossed_from_sister) / c.booked_guests * 100),
    new_pct: r2(c.new_to_group / c.booked_guests * 100),
  };
}

export function sumCounts(rows: RetentionCounts[]): RetentionCounts {
  return rows.reduce((t, r) => ({
    booked_guests: t.booked_guests + r.booked_guests,
    returning_here: t.returning_here + r.returning_here,
    crossed_from_sister: t.crossed_from_sister + r.crossed_from_sister,
    new_to_group: t.new_to_group + r.new_to_group,
    walk_in_guests: t.walk_in_guests + r.walk_in_guests,
  }), { booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0 });
}

/**
 * Does this month's lookback reach back past the start of the records?
 *
 * Returns true when the rate would be understated by a shortfall that shrinks
 * every month as history accumulates -- which looks exactly like a business
 * getting better at keeping guests.
 */
export function leftCensored(
  monthStart: string,
  dataStartsAt: string | null,
  lookbackDays = 365,
): boolean {
  if (!dataStartsAt) return true;      // no history known: cannot vouch for it
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - lookbackDays);
  return iso(d) < dataStartsAt;
}

/**
 * A lookback long enough that it is bounded by the records rather than by
 * itself. A hundred years; the RPC takes days and does the subtraction in
 * Postgres, which is happy with 1926.
 *
 * NOT `Infinity`, NOT a null meaning "no limit" -- the RPC takes a number of
 * days and a real one keeps it valid SQL.
 *
 * IT DOES COST, and an earlier version of this comment said otherwise. Migration
 * 044 made retention fast by bounding the history scan to a year; a bound before
 * everything we hold is a scan of everything we hold. Measured on
 * production-sized data: 65-115 ms at 365 days, 120-200 ms at lifetime. That is
 * paid once an hour, not per load, because the dashboard caches retention
 * (src/lib/hourly-cache.ts) -- which is what makes the lifetime measure
 * affordable, not the index.
 */
export const LIFETIME_LOOKBACK_DAYS = 36_500;

export interface HistoryHorizon {
  /** The first booking date we hold, or null when there is none. */
  from: string | null;
  /** How many days of history sit before this month. */
  days: number;
  /**
   * TRUE WHEN "LIFETIME" IS A YEAR OR LESS, in which case the phrase promises
   * more than the data can deliver and the figure is understated by the same
   * shrinking shortfall a fixed window would have had. Withheld rather than
   * shown low, which is what the 365-day rule did here before.
   */
  too_thin: boolean;
}

/**
 * How deep "ever" actually goes for a given month.
 *
 * Stated rather than implied, because a lifetime rate reads as complete and is
 * not: it can only see back to the first booking we ingested. For these venues
 * that is April 2022, so the phrase is nearly true -- but it is the venue's
 * records that bound it, never the guest's life, and the panel says which.
 */
export function historyHorizon(monthStart: string, dataStartsAt: string | null): HistoryHorizon {
  if (!dataStartsAt) return { from: null, days: 0, too_thin: true };
  const days = Math.max(
    0,
    Math.round((Date.parse(`${monthStart}T00:00:00Z`) - Date.parse(`${dataStartsAt}T00:00:00Z`)) / 86_400_000),
  );
  return { from: dataStartsAt, days, too_thin: days < 365 };
}

/** 'April 2022', for a sentence. Null in, null out — never "the beginning". */
export function horizonLabel(from: string | null): string | null {
  if (!from) return null;
  const d = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The sentence to put in front of a manager, built rather than left to be
 * composed.
 *
 * The two retention measures are confusable enough without each surface
 * wording them differently, and "retention was 12%" with no explanation is a
 * figure a restaurant manager cannot act on. The tool layer already supplies
 * `in_plain_words` for the model for exactly this reason; this is the same
 * thing for a page.
 */
export function inPlainWords(
  c: RetentionCounts,
  s: RetentionShares,
  label: string,
  horizonFrom?: string | null,
): string {
  if (!c.booked_guests) return `No booked guests in ${label}, so there is no rate to quote.`;

  /**
   * THE WINDOW IS IN THE SENTENCE, because the same word means two things on
   * two surfaces now. "Had eaten here before" with no qualifier is how somebody
   * ends up comparing this figure with a 12-month one from a chart.
   */
  const since = horizonLabel(horizonFrom ?? null);
  const window = since ? `at any point since our records begin in ${since}` : 'at any point in our records';

  return `Of the ${c.booked_guests.toLocaleString('en-SG')} guests who booked in ${label}, ` +
         `${c.returning_here.toLocaleString('en-SG')} had eaten here before ${window} ` +
         `(${s.repeat_pct}%), and ${c.crossed_from_sister.toLocaleString('en-SG')} had been to a sister venue but not this one. ` +
         `${c.new_to_group.toLocaleString('en-SG')} were new to the group — meaning we have no record of them at any venue, ` +
         `which is not quite the same as never having been.`;
}
