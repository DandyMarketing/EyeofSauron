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
  /**
   * The report key from the filename, e.g. `neon-pigeon_neon-pigeon`. A PARSE
   * failure has only this: it is logged before the key is resolved to a venue
   * id, because that lookup can itself fail on the failure path.
   */
  venue_key?: string | null;
  /** The file itself. Failures logged before 3 Oct 2026 carry nothing else. */
  filename?: string | null;
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
  /**
   * THE VENUE, BY WHICHEVER IDENTITY THE FAILURE HAS.
   *
   * A file that cannot be read is logged with its report KEY and no venue id;
   * every success is logged with both. Comparing ids alone compared a blank
   * with an id, so a parse failure could never be marked resolved however
   * many times the day was loaded successfully afterwards -- Neon Pigeon's 29
   * Sep 2026 sat at "Needs fixing" for a week that way. Ids when the failure
   * has one, the report key when it does not, and never "both blank" as a
   * match, which would let any unidentified success resolve any failure.
   */
  const sameVenue = (s: LoggedRun) => {
    if (failure.venue_id) return s.venue_id === failure.venue_id;
    if (failure.venue_key) return !!s.venue_key && s.venue_key === failure.venue_key;
    return (s.venue_id ?? null) === null && (s.venue_key ?? null) === null;
  };
  const sameType = (s: LoggedRun) => (s.report_type ?? null) === (failure.report_type ?? null);

  /**
   * THE SAME FILE LOADED LATER is the plainest proof there is, and for the
   * oldest failures the only one. Until 3 Oct 2026 a file that could not be
   * read was logged with its filename and nothing else -- no venue, no date --
   * so Neon Pigeon's 30 Sep failure stayed red after the very same file loaded
   * cleanly on 4 Oct. A filename carries the venue key, report type and date
   * within it, so an exact match cannot resolve the wrong thing.
   */
  if (failure.filename) {
    const sameFile = successes
      .filter(s => after(s) && s.filename === failure.filename)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (sameFile) return { at: sameFile.created_at, because: 'the same file loaded successfully afterwards' };
  }

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
