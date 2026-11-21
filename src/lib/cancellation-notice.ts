/**
 * How much notice a cancellation gave (issue b3c6181c, Josh, 17 Nov 2026:
 * "how many of those cancellations were within 24 hours?"). Sauron said it
 * could not tell. It could: every booking carries its slot time and the time
 * SevenRooms last changed it, and for a cancelled booking that last change is
 * normally the cancellation itself -- the same reading the cover forecast has
 * used since migration 051.
 *
 * To the MINUTE, grouped by DAY (Khai, 21 Nov 2026: "track the cancellation
 * down to the min ... but still categorise it", "2 days 3 days etc"): every
 * notice is computed in minutes from the two timestamps; the groups are within
 * 24 hours, then each day out to a week, then over a week; and the
 * cancellations inside 24 hours are listed with their exact notice.
 *
 * The one known way it reads wrong is said, never hidden: a cancelled booking
 * edited again later (a note added, a re-save) is dated by that later edit,
 * which makes the notice look SHORTER than it was. So the short groups can
 * only be over-counted, never under-counted, and a change dated after the slot
 * itself cannot be the cancellation at all -- those are counted apart.
 *
 * PURE, so the arithmetic is tested without a database.
 */

export interface CancelledRow {
  party_size: number | string | null;
  business_date?: string | null;
  /** The booking's slot, Singapore local time, no zone: "2026-11-10T19:30:00". */
  slot_local: string | null;
  /** When SevenRooms last changed the booking, with a zone (UTC). */
  source_updated_at: string | null;
}

export interface NoticeGroup { notice: string; bookings: number; covers: number }

export interface LateCancellation {
  date: string | null;
  slot: string | null;
  covers: number;
  notice: string;
  notice_minutes: number;
}

export interface CancellationNotice {
  /** Within 24 hours, 1-2 days ... 6-7 days, over 7 days. Groups with nothing are left out. */
  by_notice: NoticeGroup[];
  /** Last changed AFTER the slot: that change is not the cancellation. */
  changed_after_slot: { bookings: number; covers: number };
  /** No slot time or no change time recorded. */
  undated: { bookings: number; covers: number };
  /** The middle cancellation's notice, of those that could be dated. */
  median_notice: string | null;
  median_notice_minutes: number | null;
  /** Each cancellation inside 24 hours, shortest notice first, to the minute. */
  within_24h_detail: LateCancellation[];
  within_24h_detail_note?: string;
  basis: string;
}

const DAY = 1440;
const DETAIL_MAX = 40;

/** The slot as a real instant: Singapore is UTC+8 all year, no daylight saving. */
export function slotInstant(slotLocal: string | null): number | null {
  if (!slotLocal) return null;
  const s = slotLocal.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const t = Date.parse(`${s.slice(0, 19).padEnd(19, ':00')}+08:00`);
  return Number.isNaN(t) ? null : t;
}

/** Minutes of notice: slot minus cancellation, rounded down. Null when either is missing. */
export function noticeMinutes(row: CancelledRow): number | null {
  const slot = slotInstant(row.slot_local);
  const changed = row.source_updated_at ? Date.parse(row.source_updated_at) : NaN;
  if (slot === null || Number.isNaN(changed)) return null;
  return Math.floor((slot - changed) / 60_000);
}

/** "3d 4h 12m", "5h 03m", "45m". */
export function formatNotice(minutes: number): string {
  const d = Math.floor(minutes / DAY);
  const h = Math.floor((minutes % DAY) / 60);
  const m = minutes % 60;
  if (d) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** The group a notice falls in: within 24 hours, "1-2 days" ... "6-7 days", over 7 days. */
export function noticeGroup(minutes: number): string {
  if (minutes < DAY) return 'within 24 hours';
  const days = Math.floor(minutes / DAY);
  return days >= 7 ? 'over 7 days' : `${days}-${days + 1} days`;
}

const GROUP_ORDER = ['within 24 hours', '1-2 days', '2-3 days', '3-4 days', '4-5 days', '5-6 days', '6-7 days', 'over 7 days'];

export function cancellationNotice(cancelled: CancelledRow[]): CancellationNotice {
  const groups = new Map<string, NoticeGroup>();
  const after = { bookings: 0, covers: 0 };
  const undated = { bookings: 0, covers: 0 };
  const dated: number[] = [];
  const late: LateCancellation[] = [];

  for (const r of cancelled) {
    const covers = Number(r.party_size ?? 0) || 0;
    const mins = noticeMinutes(r);
    if (mins === null) { undated.bookings++; undated.covers += covers; continue; }
    if (mins < 0) { after.bookings++; after.covers += covers; continue; }
    dated.push(mins);
    const name = noticeGroup(mins);
    const g = groups.get(name) ?? { notice: name, bookings: 0, covers: 0 };
    g.bookings++; g.covers += covers;
    groups.set(name, g);
    if (mins < DAY) {
      late.push({
        date: r.business_date ?? r.slot_local?.slice(0, 10) ?? null,
        slot: r.slot_local ? r.slot_local.replace(' ', 'T').slice(11, 16) : null,
        covers,
        notice: formatNotice(mins),
        notice_minutes: mins,
      });
    }
  }

  dated.sort((a, b) => a - b);
  const median = dated.length
    ? (dated.length % 2 ? dated[(dated.length - 1) / 2] : Math.floor((dated[dated.length / 2 - 1] + dated[dated.length / 2]) / 2))
    : null;
  late.sort((a, b) => a.notice_minutes - b.notice_minutes);

  return {
    by_notice: GROUP_ORDER.map(n => groups.get(n)).filter((g): g is NoticeGroup => !!g),
    changed_after_slot: after,
    undated,
    median_notice: median === null ? null : formatNotice(median),
    median_notice_minutes: median,
    within_24h_detail: late.slice(0, DETAIL_MAX),
    within_24h_detail_note: late.length > DETAIL_MAX ? `The ${DETAIL_MAX} shortest of ${late.length} are listed; the group total counts all of them.` : undefined,
    basis:
      'Notice = the booking\'s slot time minus when it was cancelled, to the minute. Groups: within 24 hours, then each day ' +
      '(1-2 days means 24 to 48 hours before), then over 7 days. SevenRooms does not stamp the cancellation itself, so it is ' +
      'dated by the booking\'s LAST change, which for a cancelled booking is normally the cancellation. A booking edited again ' +
      'after it was cancelled is dated by that later edit, so the short-notice groups can be slightly OVER-counted, never ' +
      'under-counted. changed_after_slot were last touched after the booking time, so their notice cannot be told; report them ' +
      'as such, never as late cancellations. Say this in one line when quoting the split.',
  };
}
