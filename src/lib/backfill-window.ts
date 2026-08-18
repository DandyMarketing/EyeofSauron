/**
 * Working out which dates one backfill window should ask Meta for.
 *
 * Small enough to look obvious and wrong enough once to be worth testing.
 *
 * THE BUG THIS EXISTS TO PREVENT. Meta's daily series is requested with
 * `since` and `until`, and returns each value stamped with the END of its
 * period -- so Monday's figure arrives labelled Tuesday. `dayFromEndTime`
 * subtracts a day to correct it, which means a request for [S, U] yields
 * dates S through U MINUS ONE. The window's own last day never lands.
 *
 * On its own that would be harmless: the next window would pick it up. But the
 * backfill stepped to the next window at U + 1, so U was requested by nobody.
 * One day lost per window, every window, permanently -- and invisibly, because
 * every window returned a plausible number of rows.
 *
 * Found on 18 Aug 2026: `reach` had 678 days where every other metric had 729,
 * with the missing dates exactly 30 days apart -- the window size. The other
 * metrics were unaffected because they are fetched one day at a time.
 *
 * The fix is to ask for one day beyond the last day we mean to keep. Not to
 * overlap the windows: overlapping changes what "this window is already done"
 * means, and a skip check that no longer matches the window it guards is how
 * this class of bug gets replaced rather than fixed.
 */

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface BackfillWindow {
  /** First day we want stored. */
  start: string;
  /** Last day we want stored. What the skip check counts up to. */
  end: string;
  /**
   * What to send Meta as `until` -- one day past `end`, because the series
   * stops one short. Never send this to a coverage check; it is a day we do
   * not intend to keep from this window.
   */
  requestUntil: string;
}

/**
 * The window `offset` days back, covering `windowDays` days.
 *
 * `end` is clamped to yesterday. Today is still accruing, and a partial day
 * stored as a whole one is a figure that quietly disagrees with itself the
 * next time anybody looks.
 */
export function backfillWindow(offset: number, windowDays: number, nowMs: number): BackfillWindow {
  const startOffset = offset;
  const endOffset = Math.max(offset - windowDays + 1, 1);

  return {
    start: isoDay(nowMs - startOffset * DAY_MS),
    end: isoDay(nowMs - endOffset * DAY_MS),
    requestUntil: isoDay(nowMs - (endOffset - 1) * DAY_MS),
  };
}

/**
 * How many days a window is meant to store.
 *
 * Usually `windowDays`, but the newest window is short whenever `days` is not
 * a whole number of windows -- and a skip check that expects a full window
 * there would re-fetch that window on every single run, forever.
 */
export function daysCoveredBy(window: BackfillWindow): number {
  const start = Date.parse(`${window.start}T00:00:00Z`);
  const end = Date.parse(`${window.end}T00:00:00Z`);
  return Math.round((end - start) / DAY_MS) + 1;
}
