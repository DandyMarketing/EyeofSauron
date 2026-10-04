/**
 * The live service day, and the ways it reports an empty room.
 *
 * Every test here is a shape that looks correct on screen. A snapshot is the
 * only figure on the dashboard that is wrong within an hour of being right, and
 * the two worst failures -- an eight-hour timezone slip and a floor that does
 * not mark tables -- both render as a quiet evening rather than as an error.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  daySnapshot, serviceDays, serviceNote, sgtClock,
  type ReservationMoment, type DayInput,
} from './service-day.js';

/** 2026-10-04 20:00 SGT is 12:00 UTC. */
const at = (utc: string) => new Date(`2026-10-04T${utc}:00Z`);

const res = (over: Partial<ReservationMoment> = {}): ReservationMoment => ({
  party_size: 2, status_simple: 'Incomplete', arrival_time: '19:00',
  seated_at: null, left_at: null, ...over,
});

describe('the clock is Singapore, not the server', () => {
  test('noon UTC is eight in the evening', () => {
    assert.equal(sgtClock(at('12:00')), '20:00');
  });

  test('it rolls the date, which is where the eight hours usually goes wrong', () => {
    // 23:00 UTC is already 07:00 the next morning in Singapore. A snapshot
    // computed on the UTC clock at this moment would be looking at an empty
    // dining room and reporting it as tonight's.
    assert.equal(sgtClock(new Date('2026-10-04T23:00:00Z')), '07:00');
  });
});

describe('where the day stands', () => {
  test('eaten, in the room, and still to come are three different things', () => {
    const now = at('12:00');   // 20:00 SGT
    const s = daySnapshot([
      // Came at 18:00, left at 19:30 — gone.
      res({ party_size: 4, arrival_time: '18:00', seated_at: '2026-10-04T10:00:00Z', left_at: '2026-10-04T11:30:00Z' }),
      // Seated at 19:45, still sitting.
      res({ party_size: 2, arrival_time: '19:45', seated_at: '2026-10-04T11:45:00Z' }),
      // Booked for 21:00, not here yet.
      res({ party_size: 6, arrival_time: '21:00' }),
    ], now);

    assert.equal(s.finished, 4);
    assert.equal(s.in_house, 2);
    assert.equal(s.to_come, 6);
    assert.equal(s.bookings_to_come, 1);
    assert.equal(s.as_of, '20:00');
  });

  test('a cancellation and a no-show are in none of the three', () => {
    /**
     * They must not fall into "still to come", which is the natural place for
     * anything not yet seated. A cancelled eight-top counted as expected makes
     * the kitchen prep for a party that rang off this morning.
     */
    const s = daySnapshot([
      res({ party_size: 8, status_simple: 'Canceled', arrival_time: '21:00' }),
      res({ party_size: 3, status_simple: 'No Show', arrival_time: '19:00' }),
      res({ party_size: 2, arrival_time: '21:00' }),
    ], at('12:00'));

    assert.equal(s.to_come, 2);
    assert.equal(s.lost, 11);
    assert.equal(s.in_house, 0);
    assert.equal(s.finished, 0);
  });

  test('a table seated but never marked as left is in the room, not finished', () => {
    const s = daySnapshot([res({ party_size: 2, seated_at: '2026-10-04T11:00:00Z' })], at('12:00'));
    assert.equal(s.in_house, 2);
    assert.equal(s.finished, 0);
  });

  test('Complete with no departure time is still finished', () => {
    // SevenRooms' own verdict, used where the floor recorded no left_time.
    const s = daySnapshot([
      res({ party_size: 2, status_simple: 'Complete', arrival_time: '18:00', seated_at: '2026-10-04T10:00:00Z' }),
    ], at('12:00'));
    assert.equal(s.finished, 2);
    assert.equal(s.in_house, 0);
  });

  test('a seating time in the FUTURE is not counted as seated', () => {
    // SevenRooms carries a seated_time on some pre-assigned bookings. Taking
    // it at face value would seat the 22:00 table at eight o'clock.
    const s = daySnapshot([
      res({ party_size: 4, arrival_time: '22:00', seated_at: '2026-10-04T14:00:00Z' }),
    ], at('12:00'));
    assert.equal(s.in_house, 0);
    assert.equal(s.to_come, 4);
  });
});

describe('a floor that does not mark tables', () => {
  /**
   * THE FAILURE THIS WHOLE MODULE IS SHAPED AROUND. SevenRooms only knows a
   * guest arrived if somebody marks them seated, and the covers doc already
   * says arrived_guests is not populated by these venues. If seating is not
   * recorded either, every reservation comes back with seated_at null -- from
   * which "in house: 0" is a true statement about the database and a lie about
   * a full room.
   */
  test('with no seating times at all, the diary stands in and says so', () => {
    const s = daySnapshot([
      res({ party_size: 4, arrival_time: '18:00' }),   // slot passed
      res({ party_size: 2, arrival_time: '19:30' }),   // slot passed
      res({ party_size: 6, arrival_time: '21:00' }),   // still to come
    ], at('12:00'));                                    // 20:00 SGT

    assert.equal(s.seating_tracked, false);
    assert.equal(s.in_house, 6, 'the passed slots were not counted as arrived');
    assert.equal(s.to_come, 6);
    assert.equal(s.unaccounted, 0, 'the diary basis must not also report a gap');
  });

  test('when seating IS tracked, an unmarked passed slot is a gap rather than a guest', () => {
    const s = daySnapshot([
      res({ party_size: 2, arrival_time: '18:00', seated_at: '2026-10-04T10:00:00Z' }),
      res({ party_size: 4, arrival_time: '18:30' }),   // slot passed, never seated
    ], at('12:00'));

    assert.equal(s.seating_tracked, true);
    assert.equal(s.unaccounted, 4);
    assert.equal(s.in_house, 2, 'an unmarked booking was counted as a guest in the room');
  });

  test('the note says which basis it is on, in words', () => {
    const diary = serviceNote({
      date: '2026-10-04', basis: 'snapshot', covers: 12, closed: false,
      snapshot: daySnapshot([res({ party_size: 4, arrival_time: '18:00' })], at('12:00')),
    });
    assert.match(diary, /DIARY rather than the floor/);
    assert.match(diary, /not because anyone saw them/);
  });

  test('a cancelled-only day does not claim seating is tracked', () => {
    // seating_tracked is read off the LIVE rows: a day of nothing but
    // cancellations has no seating times and no guests, and must not therefore
    // claim the floor is recording.
    const s = daySnapshot([res({ status_simple: 'Canceled', seated_at: null })], at('12:00'));
    assert.equal(s.seating_tracked, false);
  });
});

describe('which basis each day is on', () => {
  const days: DayInput[] = [
    { date: '2026-10-02', closed: false, completed: 88, expected: 92 },
    { date: '2026-10-03', closed: false, completed: 74, expected: 80 },
    { date: '2026-10-04', closed: false, completed: 20, expected: 96, moments: [
      res({ party_size: 20, arrival_time: '18:00', seated_at: '2026-10-04T10:00:00Z', left_at: '2026-10-04T11:00:00Z' }),
      res({ party_size: 76, arrival_time: '21:00' }),
    ] },
    { date: '2026-10-05', closed: true, completed: 0, expected: 0 },
    { date: '2026-10-06', closed: false, completed: 0, expected: 61 },
  ];

  test('before today is completed, after today is the book, today is a snapshot', () => {
    const out = serviceDays(days, '2026-10-04', at('12:00'));
    assert.deepEqual(out.map(d => d.basis), ['completed', 'completed', 'snapshot', 'book', 'book']);
  });

  test('a past day shows what happened, NOT what was booked', () => {
    /**
     * 88 completed against 92 booked is four covers that cancelled late or did
     * not turn up. Showing the book for a day that is over reports covers the
     * venue never served, in the same strip as days where it will.
     */
    const [yesterday] = serviceDays(days, '2026-10-04', at('12:00'));
    assert.equal(yesterday.covers, 88);
  });

  test('a future day shows the book, because nothing has completed', () => {
    const out = serviceDays(days, '2026-10-04', at('12:00'));
    assert.equal(out[4].covers, 61);
  });

  test("today's headline is the WHOLE day, not the part already eaten", () => {
    /**
     * A headline of only-what-has-happened falls every morning and climbs every
     * evening, which on a strip beside settled days looks exactly like trade
     * doing the same. The snapshot beneath it carries the split.
     */
    const out = serviceDays(days, '2026-10-04', at('12:00'));
    assert.equal(out[2].covers, 96);
    assert.equal(out[2].snapshot?.finished, 20);
    assert.equal(out[2].snapshot?.to_come, 76);
  });

  test('only today carries a snapshot', () => {
    const out = serviceDays(days, '2026-10-04', at('12:00'));
    assert.equal(out.filter(d => d.snapshot).length, 1);
  });

  test('today is computed once and passed in, so one payload cannot straddle midnight', () => {
    // Called with a different "today", the same input relabels wholesale --
    // which is the point: the basis is a function of the date the request
    // decided on, never of when each line of code happened to run.
    const out = serviceDays(days, '2026-10-06', at('12:00'));
    assert.deepEqual(out.map(d => d.basis), ['completed', 'completed', 'completed', 'completed', 'snapshot']);
  });
});

describe('the sentence under the strip', () => {
  const snapshotDay = (now = at('12:00')) => ({
    date: '2026-10-04', basis: 'snapshot' as const, covers: 96, closed: false,
    snapshot: daySnapshot([
      res({ party_size: 20, arrival_time: '18:00', seated_at: '2026-10-04T10:00:00Z', left_at: '2026-10-04T11:00:00Z' }),
      res({ party_size: 10, arrival_time: '19:30', seated_at: '2026-10-04T11:30:00Z' }),
      res({ party_size: 66, arrival_time: '21:00' }),
      res({ party_size: 8, status_simple: 'Canceled', arrival_time: '20:00' }),
    ], now),
  });

  test('it names the time, because a snapshot without one goes stale silently', () => {
    assert.match(serviceNote(snapshotDay()), /As of 20:00/);
  });

  test('it says sales are not live, so a blank revenue figure is not read as a collapse', () => {
    assert.match(serviceNote(snapshotDay()), /sales for today are not available until Revel delivers overnight/);
  });

  test('cancellations are named as outside the three figures', () => {
    assert.match(serviceNote(snapshotDay()), /8 covers cancelled or no-showed and are not in any of the above/);
  });

  test('the sync age is reported when it is known', () => {
    assert.match(serviceNote(snapshotDay(), 47), /synced 47 minutes ago/);
    assert.match(serviceNote(snapshotDay(), 0.5), /synced under a minute ago/);
    // And left out entirely rather than guessed at.
    assert.ok(!/synced/.test(serviceNote(snapshotDay(), null)));
  });

  test('a closed day says so and claims nothing else', () => {
    assert.equal(serviceNote({ ...snapshotDay(), closed: true }), 'Closed today.');
  });

  test('a day that is not today has no note at all', () => {
    assert.equal(serviceNote({ date: '2026-10-03', basis: 'completed', covers: 74, closed: false }), '');
    assert.equal(serviceNote(undefined), '');
  });
});
