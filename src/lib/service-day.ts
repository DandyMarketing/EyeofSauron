/**
 * What a day's covers MEAN depends on where the day sits relative to now, and
 * the three answers are not the same measurement.
 *
 * Khai, 4 Oct 2026: "if it's past current date you will look for the
 * uncompleted reservations, on the day you will take the snapshot at that point
 * and before is the completed."
 *
 *   - a day BEFORE today is settled: completed covers, an actual;
 *   - TODAY is a snapshot at an instant -- some guests have eaten and gone,
 *     some are sitting in the room, some have not arrived;
 *   - a day AFTER today is the book: bookings not yet cancelled, which is a
 *     promise rather than a measurement.
 *
 * MIXING THEM IS THE FAILURE THIS EXISTS TO PREVENT. A strip of seven numbers
 * with no basis beside them invites the obvious comparison -- "Thursday is
 * bigger than last Thursday" -- between a figure that has happened and one that
 * might. Today is the worst of the three, because at 11am it is nearly all book
 * and at 11pm it is nearly all actual, and it looks identical either way. So
 * every day carries its basis and the page prints it.
 *
 * THIS IS THE GROUNDWORK FOR A LIVE DASHBOARD AND ONLY HALF OF IT. Covers can
 * be close to live already -- SevenRooms is ingested hourly and carries seating
 * times. SALES cannot: Revel delivers a CSV overnight carrying the previous
 * day, so there is no such thing as today's revenue until tomorrow morning.
 * Today's panel therefore shows covers against no money at all, and says so
 * rather than leaving a blank that reads as a collapse. That gap closes when
 * the POS is swapped, which is the point of building this now.
 */

import { sgtToday } from './dashboard-window.js';

/** Singapore has no daylight saving, so a fixed offset is exact. */
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The fields of a reservation that say where it is in its own evening.
 *
 * TIMEZONE, WHICH THE MIGRATION WARNS ABOUT IN CAPITALS: `arrival_time` is
 * venue-local (SGT) and stored naive; `seated_at` and `left_at` are UTC
 * instants. Comparing a local 'HH:MM' against a UTC clock puts every figure
 * here eight hours out -- which at 8pm SGT would report an empty room.
 */
export interface ReservationMoment {
  party_size: number;
  status_simple: string | null;
  /** Local 'HH:MM' as SevenRooms gives it. */
  arrival_time: string | null;
  /** UTC ISO instant, or null when the floor has not seated the table. */
  seated_at: string | null;
  /** UTC ISO instant, or null while the table is still occupied. */
  left_at: string | null;
}

export type DayBasis = 'completed' | 'snapshot' | 'book';

export interface DaySnapshot {
  /** Local 'HH:MM' in Singapore that this snapshot describes. */
  as_of: string;
  /** Guests who have eaten and left. */
  finished: number;
  /** Guests sitting in the room right now. */
  in_house: number;
  /** Guests booked later today and not yet arrived. */
  to_come: number;
  bookings_to_come: number;
  /** Cancellations and no-shows, which are neither coming nor counted. */
  lost: number;
  /**
   * Booked before now, never seated, not cancelled: either running late or --
   * far more often -- a table the floor seated without touching SevenRooms.
   * Shown rather than absorbed, because the two look identical from here and
   * only one of them is an operational fact.
   */
  unaccounted: number;
  /**
   * FALSE WHEN NOTHING TODAY HAS A SEATING TIME.
   *
   * SevenRooms only knows a guest arrived if somebody marks them seated. A
   * venue whose floor does not use the table statuses returns every single
   * reservation with `seated_at` null -- from which "in house: 0" is a true
   * statement about the database and a lie about the room. When this is false
   * the split falls back to the DIARY: a booking whose slot has passed is
   * treated as arrived, which is a schedule and not an observation.
   */
  seating_tracked: boolean;
}

export interface ServiceDay {
  date: string;
  basis: DayBasis;
  /**
   * The headline for this day on its own basis: completed covers for a past
   * day, everything still expected plus everything already eaten for today,
   * the book for a future one.
   */
  covers: number;
  closed: boolean;
  /** Present only on today. */
  snapshot?: DaySnapshot;
}

const CANCELED = 'Canceled';
const NO_SHOW = 'No Show';
const COMPLETE = 'Complete';

const lost = (r: ReservationMoment) => r.status_simple === CANCELED || r.status_simple === NO_SHOW;

/** Local wall-clock 'HH:MM' in Singapore, from any instant. */
export function sgtClock(now: Date = new Date()): string {
  return new Date(now.getTime() + SGT_OFFSET_MS).toISOString().slice(11, 16);
}

/** Minutes past midnight for an 'HH:MM', or null when it is not a time. */
function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Where today's book stands at a given instant.
 *
 * SEATING TIMES FIRST, THE DIARY ONLY AS A FALLBACK. `seated_at` and `left_at`
 * are observations -- somebody on the floor marked the table -- and the slot
 * time is an intention that may not have been kept. Preferring the observation
 * is right wherever it exists, and detecting that it exists NOWHERE is what
 * keeps the fallback from being silent.
 */
export function daySnapshot(rows: ReservationMoment[], now: Date = new Date()): DaySnapshot {
  const nowMs = now.getTime();
  const nowMin = minutesOf(sgtClock(now)) ?? 0;

  const live = rows.filter(r => !lost(r));
  const seating_tracked = live.some(r => !!r.seated_at);

  let finished = 0, in_house = 0, to_come = 0, bookings_to_come = 0, unaccounted = 0;
  let lostCovers = 0;

  for (const r of rows) {
    const size = Number(r.party_size ?? 0);
    if (lost(r)) { lostCovers += size; continue; }

    const seatedMs = r.seated_at ? Date.parse(r.seated_at) : NaN;
    const leftMs = r.left_at ? Date.parse(r.left_at) : NaN;

    // Already gone. `left_at` is the observation; Complete is SevenRooms'
    // own verdict and is trusted when the floor never recorded a departure.
    if ((!Number.isNaN(leftMs) && leftMs <= nowMs) || (Number.isNaN(leftMs) && r.status_simple === COMPLETE)) {
      finished += size;
      continue;
    }

    // Sitting in the room: seated, not left.
    if (!Number.isNaN(seatedMs) && seatedMs <= nowMs) {
      in_house += size;
      continue;
    }

    const slot = minutesOf(r.arrival_time);

    /**
     * Not seated. Whether that means "still to come" or "we cannot see"
     * depends on the clock, and on whether this venue records seating at all.
     */
    if (slot === null || slot >= nowMin) {
      to_come += size;
      bookings_to_come++;
    } else if (seating_tracked) {
      // The floor DOES mark tables, and did not mark this one, so its absence
      // is information: late, or seated without being recorded.
      unaccounted += size;
    } else {
      /**
       * Nothing today has a seating time, so absence means nothing. Falling
       * back to the diary: the slot has passed, so treat the party as arrived.
       * Counted as in_house rather than finished because a table is far more
       * likely to still be sitting than to have been missed entirely -- and
       * `seating_tracked: false` tells the reader this is the diary talking.
       */
      in_house += size;
    }
  }

  return {
    as_of: sgtClock(now),
    finished, in_house, to_come, bookings_to_come,
    lost: lostCovers,
    unaccounted,
    seating_tracked,
  };
}

export interface DayInput {
  date: string;
  closed: boolean;
  /** Completed covers, for a day that is already settled. */
  completed: number;
  /** Not cancelled and not a no-show, which is the book for a future day. */
  expected: number;
  /** Reservation-level detail, supplied for today only. */
  moments?: ReservationMoment[];
}

/**
 * Label each day with the basis its number is actually on.
 *
 * `today` is passed rather than read from the clock so the whole thing is
 * testable, and so one request cannot straddle midnight in Singapore and
 * produce two different answers in one payload.
 */
export function serviceDays(days: DayInput[], today: string, now: Date = new Date()): ServiceDay[] {
  return days.map(d => {
    if (d.date < today) {
      return { date: d.date, basis: 'completed' as const, covers: d.completed, closed: d.closed };
    }
    if (d.date > today) {
      return { date: d.date, basis: 'book' as const, covers: d.expected, closed: d.closed };
    }
    const snapshot = daySnapshot(d.moments ?? [], now);
    /**
     * TODAY'S HEADLINE IS THE WHOLE DAY, not the part that has happened.
     *
     * Everything still expected plus everything already eaten -- which equals
     * `expected` from the covers reader, since that is exactly "not cancelled
     * and not a no-show". The snapshot beneath it says how much of that is
     * behind us. A headline of only-so-far would fall every morning and rise
     * every evening, and look like trade doing the same.
     */
    return {
      date: d.date,
      basis: 'snapshot' as const,
      covers: snapshot.finished + snapshot.in_house + snapshot.to_come,
      closed: d.closed,
      snapshot,
    };
  });
}

/**
 * The sentence under the strip, computed rather than left to the reader.
 *
 * It names the hour, because a snapshot without a time on it is the one figure
 * on this page that is wrong within minutes of being right.
 */
export function serviceNote(day: ServiceDay | undefined, dataAgeMinutes?: number | null): string {
  if (!day || !day.snapshot) return '';
  const s = day.snapshot;

  if (day.closed) return 'Closed today.';

  let out = `As of ${s.as_of}: ${s.finished} eaten, ${s.in_house} in the room, ${s.to_come} still booked.`;

  if (!s.seating_tracked) {
    out += ' Nobody has been marked seated today, so this split is the DIARY rather than the floor —' +
           ' a party whose slot has passed is counted as in the room because the booking said so,' +
           ' not because anyone saw them. Treat the first two figures as an estimate.';
  } else if (s.unaccounted > 0) {
    out += ` ${s.unaccounted} booked covers are past their slot and were never seated —` +
           ' either running late, or seated without SevenRooms being touched.';
  }

  if (s.lost > 0) out += ` ${s.lost} covers cancelled or no-showed and are not in any of the above.`;

  /**
   * SALES ARE NOT LIVE AND THE PANEL MUST NOT IMPLY THEY ARE. Revel delivers
   * overnight carrying the previous day, so today has covers and no revenue --
   * a shape that reads as a collapse unless it is stated.
   */
  out += ' Covers are live to the last sync; sales for today are not available until Revel delivers overnight.';

  if (typeof dataAgeMinutes === 'number' && Number.isFinite(dataAgeMinutes)) {
    out += ` Reservations last synced ${dataAgeMinutes < 2 ? 'under a minute' : `${Math.round(dataAgeMinutes)} minutes`} ago.`;
  }

  return out;
}

/**
 * How stale the live panel is, in words, measured on the SERVER's clock.
 *
 * Doing this in the browser would make it depend on the phone being set
 * correctly -- a device an hour out would call a fresh ingest stale, or a dead
 * one fresh, and the second is the whole failure this exists to catch.
 *
 * STALE AT 150 MINUTES, which is two hourly runs plus slack. One missed run is
 * a retry; two is a cron that has stopped, and during service that is the
 * difference between a quiet night and a blind one.
 */
export function syncAge(syncedAt: string | null, now: Date = new Date()): {
  label: string | null;
  minutes: number | null;
  stale: boolean;
} {
  if (!syncedAt) return { label: null, minutes: null, stale: false };
  const ms = Date.parse(syncedAt);
  if (Number.isNaN(ms)) return { label: null, minutes: null, stale: false };

  const minutes = Math.max(0, (now.getTime() - ms) / 60000);
  const stale = minutes > 150;
  const label = minutes < 2 ? 'synced just now'
    : minutes < 120 ? `synced ${Math.round(minutes)}m ago`
    : `last synced ${Math.round(minutes / 60)}h ago`;
  return { label, minutes, stale };
}

/** Re-exported so callers do not reach past this module for the business date. */
export { sgtToday };
