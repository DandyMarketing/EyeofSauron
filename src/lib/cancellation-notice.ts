/**
 * How much notice a cancellation gave (issue b3c6181c, Josh, 17 Nov 2026:
 * "how many of those cancellations were within 24 hours?"). Sauron said it
 * could not tell. It could: every booking carries its slot time and the time
 * SevenRooms last changed it, and for a cancelled booking that last change is
 * normally the cancellation itself -- the same reading the cover forecast has
 * used since migration 051.
 *
 * The one known way it reads wrong is said, never hidden: a cancelled booking
 * edited again later (a note added, a re-save) is dated by that later edit,
 * which makes the notice look SHORTER than it was. So "within 24 hours" can
 * only be over-counted, never under-counted, and a change dated after the slot
 * itself cannot be the cancellation at all -- those are counted apart.
 *
 * PURE, so the arithmetic is tested without a database.
 */

export interface CancelledRow {
  party_size: number | string | null;
  /** The booking's slot, Singapore local time, no zone: "2026-11-10T19:30:00". */
  slot_local: string | null;
  /** When SevenRooms last changed the booking, with a zone (UTC). */
  source_updated_at: string | null;
}

export interface NoticeBucket { bookings: number; covers: number }

export interface CancellationNotice {
  within_24h: NoticeBucket;
  from_24h_to_72h: NoticeBucket;
  over_72h: NoticeBucket;
  /** Last changed AFTER the slot: that change is not the cancellation. */
  changed_after_slot: NoticeBucket;
  /** No slot time or no change time recorded. */
  undated: NoticeBucket;
  basis: string;
}

/** The slot as a real instant: Singapore is UTC+8 all year, no daylight saving. */
export function slotInstant(slotLocal: string | null): number | null {
  if (!slotLocal) return null;
  const s = slotLocal.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const t = Date.parse(`${s.slice(0, 19).padEnd(19, ':00')}+08:00`);
  return Number.isNaN(t) ? null : t;
}

/** Hours of notice: slot minus cancellation. Null when either is missing. */
export function noticeHours(row: CancelledRow): number | null {
  const slot = slotInstant(row.slot_local);
  const changed = row.source_updated_at ? Date.parse(row.source_updated_at) : NaN;
  if (slot === null || Number.isNaN(changed)) return null;
  return (slot - changed) / 3_600_000;
}

export function cancellationNotice(cancelled: CancelledRow[]): CancellationNotice {
  const empty = (): NoticeBucket => ({ bookings: 0, covers: 0 });
  const out = { within_24h: empty(), from_24h_to_72h: empty(), over_72h: empty(), changed_after_slot: empty(), undated: empty() };
  for (const r of cancelled) {
    const h = noticeHours(r);
    const bucket = h === null ? out.undated
      : h < 0 ? out.changed_after_slot
        : h < 24 ? out.within_24h
          : h < 72 ? out.from_24h_to_72h
            : out.over_72h;
    bucket.bookings++;
    bucket.covers += Number(r.party_size ?? 0) || 0;
  }
  return {
    ...out,
    basis:
      'Notice = the booking\'s slot time minus when it was cancelled. SevenRooms does not stamp the cancellation itself, ' +
      'so it is dated by the booking\'s LAST change, which for a cancelled booking is normally the cancellation. A booking ' +
      'edited again after it was cancelled is dated by that later edit, so within_24h can be slightly OVER-counted, never ' +
      'under-counted. changed_after_slot were last touched after the booking time, so their notice cannot be told; report ' +
      'them as such, never as late cancellations. Say all of this in one line when quoting the split.',
  };
}
