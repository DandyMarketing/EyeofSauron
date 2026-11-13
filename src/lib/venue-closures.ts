/**
 * One-off closures (migration 067, Khai, 10 Nov 2026): days a venue was or will
 * be shut beyond its regular closed weekday -- a public holiday, a private
 * event, a renovation -- with the reason a person gave.
 *
 * Fat Prince had no sales and no bookings on Deepavali 2025, a Monday, which is
 * not one of its closed weekdays. Nothing could tell that from a missing Revel
 * file, so a Diwali comparison could only say "not comparable". With the date
 * listed, every surface says "closed for Deepavali" instead.
 *
 * PURE, so the rule is tested without a database. The read is in
 * venue-closures-read.ts.
 */
import { weekdayIndex } from './weekdays.js';

export interface OneOffClosure {
  venue_id: string;
  closed_on: string;
  reason: string;
}

/** venue id -> date -> reason. */
export type ClosureIndex = Map<string, Map<string, string>>;

export function indexClosures(rows: OneOffClosure[]): ClosureIndex {
  const out: ClosureIndex = new Map();
  for (const r of rows) {
    const byDate = out.get(r.venue_id) ?? new Map<string, string>();
    byDate.set(r.closed_on, r.reason);
    out.set(r.venue_id, byDate);
  }
  return out;
}

/**
 * Was the venue shut on this date: its regular closed weekday, or a listed
 * one-off closure. The ONE rule every surface uses, so the dashboard, the daily
 * report and the ingest watchdog cannot disagree about a day.
 */
export function isShutOn(
  date: string,
  closedWeekdays: number[] | null | undefined,
  closedDates?: ReadonlySet<string> | ReadonlyMap<string, string> | null,
): boolean {
  if (closedDates?.has(date)) return true;
  return !!closedWeekdays && closedWeekdays.includes(weekdayIndex(date));
}

/** A venue's listed closures inside [from, to], oldest first, for a tool's reply. */
export function closuresIn(
  byDate: ReadonlyMap<string, string> | undefined,
  from: string,
  to: string,
): Array<{ date: string; reason: string }> {
  if (!byDate) return [];
  return [...byDate.entries()]
    .filter(([d]) => d >= from && d <= to)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, reason]) => ({ date, reason }));
}

/**
 * Said beside the figures whenever a range holds a listed closure: the day has
 * no sales because the venue was shut, and the reader must hear it as that.
 *
 * A comparison is by CALENDAR (Khai, 13 Nov 2026): the whole week against the
 * whole week, a closed day counting as the nothing it traded, with the closure
 * named beside the result. The first version said to compare only the days both
 * periods traded, which is the "not comparable" answer by another route -- it
 * drops the day that explains the movement.
 */
export const CLOSURE_NOTE =
  'The venue was CLOSED on these dates for the reason given (recorded by the team in Settings). ' +
  'They have no sales or covers because nobody traded, not because data is missing. ' +
  'COMPARE THE WHOLE PERIODS ANYWAY: a comparison is by calendar -- the whole week against the whole ' +
  'week, the whole month against the whole month -- with each closed day counting as the nothing it ' +
  'traded. Never drop a day to make the periods match, and never call the comparison "not comparable". ' +
  'Beside the result, name the closure specifically: which venue, which date and weekday, the reason, ' +
  'and that the period had that many fewer trading days, so the reader sees how much of the movement ' +
  'the closure explains.';
