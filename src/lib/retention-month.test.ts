/**
 * Retention on a weekly dashboard, which is a monthly figure and must say so.
 *
 * Two traps, both of which produce a plausible number:
 *   - a week's retention rate is arithmetically fine and is not a measurement;
 *   - a month whose 365-day lookback predates the records understates the rate,
 *     and the understatement shrinks every month as history accumulates, which
 *     draws a rising line that is the database filling up.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastCompleteMonth, previousMonth, retentionShares, sumCounts, leftCensored, inPlainWords,
  historyHorizon, horizonLabel, LIFETIME_LOOKBACK_DAYS,
} from './retention-month.js';

describe('the month is the last one that FINISHED', () => {
  test('mid-month looks back to the previous month', () => {
    assert.deepEqual(lastCompleteMonth('2026-10-04'), { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' });
  });

  test('the first of a month is not three days of data against thirty-one', () => {
    // A month in progress is the week-to-date problem with a bigger window.
    assert.equal(lastCompleteMonth('2026-10-01').start, '2026-09-01');
  });

  test('the last day of a month still reports the month before', () => {
    // 31 October is not complete until it is over.
    assert.deepEqual(lastCompleteMonth('2026-10-31'), { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' });
  });

  test('January looks back into the previous year', () => {
    assert.deepEqual(lastCompleteMonth('2027-01-15'), { start: '2026-12-01', end: '2026-12-31', label: 'December 2026' });
  });

  test('a 31-day month after a 30-day one gets the right end', () => {
    assert.equal(lastCompleteMonth('2026-09-10').end, '2026-08-31');
  });

  test('February is handled by the calendar, not by a day count', () => {
    assert.equal(lastCompleteMonth('2028-03-05').end, '2028-02-29');   // leap year
    assert.equal(lastCompleteMonth('2027-03-05').end, '2027-02-28');
  });

  test('the comparison month is the one before', () => {
    assert.deepEqual(previousMonth({ start: '2026-09-01' }), { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' });
  });

  test('a bad date throws rather than returning a month-shaped guess', () => {
    assert.throws(() => lastCompleteMonth('not-a-date'));
  });
});

describe('the shares', () => {
  const counts = {
    booked_guests: 200, returning_here: 50, crossed_from_sister: 30,
    new_to_group: 120, walk_in_guests: 40,
  };

  test('repeat share is this venue only; group share includes a sister venue', () => {
    const s = retentionShares(counts);
    assert.equal(s.repeat_pct, 25);        // 50/200
    assert.equal(s.group_pct, 40);         // (50+30)/200
    assert.equal(s.new_pct, 60);           // 120/200
  });

  test('a month with no booked guests reports null, not 0%', () => {
    // 0% retention is a statement about a month that traded. A month with no
    // bookings has no rate at all, and printing 0% says the opposite.
    const s = retentionShares({ ...counts, booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0 });
    assert.equal(s.repeat_pct, null);
    assert.equal(s.group_pct, null);
  });

  test('the group total sums the counts, so the rate is recomputed not averaged', () => {
    // Averaging two venues' rates weights a quiet venue the same as a busy one.
    const small = { booked_guests: 10, returning_here: 8, crossed_from_sister: 0, new_to_group: 2, walk_in_guests: 0 };
    const big = { booked_guests: 990, returning_here: 99, crossed_from_sister: 0, new_to_group: 891, walk_in_guests: 0 };

    const t = sumCounts([small, big]);
    assert.equal(t.booked_guests, 1000);
    assert.equal(retentionShares(t).repeat_pct, 10.7);   // 107/1000, not (80+10)/2 = 45
  });
});

describe('left-censoring is computed, never assumed', () => {
  test('a month whose lookback predates the records is withheld', () => {
    // Guests who did come back are invisible before the records start, so the
    // rate is understated — and it rises every month as history fills, which
    // reads as a business getting better at keeping people.
    assert.equal(leftCensored('2022-06-01', '2022-01-01'), true);
  });

  test('a month with a full year of history behind it is fine', () => {
    assert.equal(leftCensored('2026-09-01', '2022-01-01'), false);
  });

  test('the boundary month is included only when the lookback clears it', () => {
    // 2023-01-01 minus 365 days is 2022-01-01 — exactly the first record.
    assert.equal(leftCensored('2023-01-01', '2022-01-01'), false);
    assert.equal(leftCensored('2022-12-31', '2022-01-01'), true);
  });

  test('an unknown history start is treated as censored, not as clear', () => {
    // The safe direction: an absence of evidence is not a clean bill.
    assert.equal(leftCensored('2026-09-01', null), true);
  });
});

test('the plain-English line carries the counts, not just the rate', () => {
  /**
   * Repeat share FALLS when a venue attracts a lot of new guests, because they
   * enlarge the bottom of the fraction. "Retention was 25%" alone is a figure a
   * manager cannot act on and will read backwards — the counts are what make it
   * readable.
   */
  const counts = { booked_guests: 200, returning_here: 50, crossed_from_sister: 30, new_to_group: 120, walk_in_guests: 0 };
  const line = inPlainWords(counts, retentionShares(counts), 'September 2026');

  assert.match(line, /200 guests who booked in September 2026/);
  assert.match(line, /50 had eaten here before/);
  assert.match(line, /120 were new to the group/);
  assert.match(line, /25%/);
});

test('a month with nothing in it says so rather than producing a sentence of zeroes', () => {
  const empty = { booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0 };
  assert.match(inPlainWords(empty, retentionShares(empty), 'September 2026'), /No booked guests/);
});

describe('how deep "ever" actually goes', () => {
  /**
   * Khai, 4 Oct 2026: "perhaps it should be all time — people who had been
   * guest in our life time."
   *
   * The dashboard now measures a lifetime, and a lifetime rate reads as
   * complete when it is not: it can see back only as far as the first booking
   * we ingested. A guest whose one previous visit predates the ingest is still
   * counted as new, and widening the window is the one thing that cannot fix
   * it. So the horizon is computed and printed.
   */
  test('the depth is measured from the first booking we hold', () => {
    const h = historyHorizon('2026-09-01', '2022-04-01');
    assert.equal(h.from, '2022-04-01');
    assert.equal(h.days, 1614);
    assert.equal(h.too_thin, false);
  });

  test('under a year of history is too thin to call a lifetime', () => {
    /**
     * The phrase promises more than the records hold, and the figure carries
     * the same shrinking shortfall the 365-day rule was withheld for — it would
     * climb every month as history filled and read as guests coming back more.
     */
    assert.equal(historyHorizon('2022-09-01', '2022-04-01').too_thin, true);
    assert.equal(historyHorizon('2023-04-01', '2022-04-01').too_thin, false);
  });

  test('no history at all is thin, never deep', () => {
    // An absence of evidence is not a clean bill — the same direction
    // leftCensored takes.
    const h = historyHorizon('2026-09-01', null);
    assert.equal(h.too_thin, true);
    assert.equal(h.days, 0);
    assert.equal(h.from, null);
  });

  test('a venue whose records start AFTER the month has no history, not negative history', () => {
    assert.equal(historyHorizon('2022-01-01', '2022-04-01').days, 0);
  });

  test('the horizon is named as a month, and null stays null', () => {
    assert.equal(horizonLabel('2022-04-01'), 'April 2022');
    assert.equal(horizonLabel(null), null);
    // Never "the beginning" or today's date standing in for a date we lack.
    assert.equal(horizonLabel('not-a-date'), null);
  });

  test('the lookback is bounded, not infinite', () => {
    /**
     * Migration 044 exists because an unbounded history scan timed out in
     * production. The window stays real and simply sits before anything we
     * hold, so the index is still usable.
     */
    assert.ok(Number.isFinite(LIFETIME_LOOKBACK_DAYS));
    assert.ok(LIFETIME_LOOKBACK_DAYS > 365 * 20);
  });
});

describe('the sentence names its own window', () => {
  const counts = { booked_guests: 200, returning_here: 50, crossed_from_sister: 30, new_to_group: 120, walk_in_guests: 0 };

  test('it says since when, because a chart says twelve months and this does not', () => {
    const line = inPlainWords(counts, retentionShares(counts), 'September 2026', '2022-04-01');
    assert.match(line, /at any point since our records begin in April 2022/);
  });

  test('with no horizon it does not invent one', () => {
    const line = inPlainWords(counts, retentionShares(counts), 'September 2026', null);
    assert.match(line, /at any point in our records/);
    assert.ok(!/since our records begin in/.test(line));
  });

  test('"new" is qualified, because it means unrecorded and not unvisited', () => {
    // The one thing a longer lookback cannot buy: a guest whose only previous
    // visit predates the ingest is indistinguishable from a first-timer.
    const line = inPlainWords(counts, retentionShares(counts), 'September 2026', '2022-04-01');
    assert.match(line, /not quite the same as never having been/);
  });
});
