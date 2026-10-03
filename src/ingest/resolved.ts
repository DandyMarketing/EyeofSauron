/**
 * Which failed runs a later successful one has already repaired.
 *
 * WHY THIS EXISTS. The admin console showed a SevenRooms auth failure from
 * 29 Sep 2026 as a live problem on 3 Oct, four days after the data it missed
 * had been re-read and loaded. Nothing was wrong any more and the panel could
 * not say so, which is the worst kind of alert: one that is accurate about the
 * past and misleading about the present. Read enough of those and the panel
 * stops being read at all.
 *
 * THE ERROR IS NOT HIDDEN, it is marked. Khai's call, and the right one — a
 * failure that happened is a fact about the vendor, and a week of SevenRooms
 * blips that each self-healed is exactly the pattern somebody should be able to
 * see. What changes is that it stops counting as something to do.
 *
 * TWO KINDS OF FAILURE, REPAIRED DIFFERENTLY, and conflating them would be the
 * easy mistake:
 *
 *   - A DATED failure is about one business date — a Revel file for 29 Sep that
 *     would not parse. Only a later success FOR THAT DATE repairs it. Another
 *     venue's file loading, or the next day's, proves nothing about it.
 *
 *   - A RUN failure has no business date — the SevenRooms auth call never got
 *     far enough to be about a day. Those sources re-read a rolling window on
 *     every run, so the next successful run of the same type covers the same
 *     ground. That is the case here, and it is why nothing was lost.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. For a run failure it says a later run
 * succeeded, not that every missing row is back. The second is only true while
 * the outage is shorter than the source's lookback, and the log does not record
 * what that lookback was. Saying the weaker, true thing is the point: a
 * reassurance nobody checked is how a real gap gets closed on screen and stays
 * open in the warehouse.
 */

export interface LoggedRun {
  venue_id?: string | null;
  report_type?: string | null;
  business_date?: string | null;
  created_at: string;
}

export interface Resolution {
  /** When the later successful run happened. */
  at: string;
  /** Why we believe it covers this failure. Shown to the reader verbatim. */
  because: string;
}

/**
 * The earliest success that repairs this failure, or null if none has.
 *
 * `successes` is every successful run in the same window — the caller fetches
 * it once for the whole list rather than per row.
 */
export function resolutionFor(failure: LoggedRun, successes: LoggedRun[]): Resolution | null {
  const after = (s: LoggedRun) => s.created_at > failure.created_at;
  const sameVenue = (s: LoggedRun) => (s.venue_id ?? null) === (failure.venue_id ?? null);
  const sameType = (s: LoggedRun) => (s.report_type ?? null) === (failure.report_type ?? null);

  const candidates = successes
    .filter(s => after(s) && sameVenue(s) && sameType(s))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (failure.business_date) {
    // Dated: only that date's own success counts.
    const hit = candidates.find(s => s.business_date === failure.business_date);
    return hit
      ? { at: hit.created_at, because: `${failure.business_date} loaded successfully afterwards` }
      : null;
  }

  // Run-level: the next successful run of the same type re-read the window.
  const hit = candidates[0];
  return hit
    ? { at: hit.created_at, because: 'a later run of the same report succeeded' }
    : null;
}

/** How many of these failures nobody needs to act on yet. */
export function countUnresolved(failures: LoggedRun[], successes: LoggedRun[]): number {
  return failures.filter(f => resolutionFor(f, successes) === null).length;
}
