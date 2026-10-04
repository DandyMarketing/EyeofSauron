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
 * LEFT-CENSORING IS COMPUTED, NOT ASSUMED. The measure asks whether a guest
 * came within the previous 365 days. For a month whose lookback reaches back
 * past the start of the booking history, guests who did come are invisible and
 * the rate is understated -- so the month is WITHHELD rather than shown low.
 * Plotting them draws a rise that is the database filling up.
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
 * The sentence to put in front of a manager, built rather than left to be
 * composed.
 *
 * The two retention measures are confusable enough without each surface
 * wording them differently, and "retention was 12%" with no explanation is a
 * figure a restaurant manager cannot act on. The tool layer already supplies
 * `in_plain_words` for the model for exactly this reason; this is the same
 * thing for a page.
 */
export function inPlainWords(c: RetentionCounts, s: RetentionShares, label: string): string {
  if (!c.booked_guests) return `No booked guests in ${label}, so there is no rate to quote.`;
  return `Of the ${c.booked_guests.toLocaleString('en-SG')} guests who booked in ${label}, ` +
         `${c.returning_here.toLocaleString('en-SG')} had eaten here before in the previous year ` +
         `(${s.repeat_pct}%), and ${c.crossed_from_sister.toLocaleString('en-SG')} had been to a sister venue but not this one. ` +
         `${c.new_to_group.toLocaleString('en-SG')} were new to the group.`;
}
