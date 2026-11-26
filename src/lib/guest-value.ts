/**
 * What each kind of guest SPENDS (Khai, 26 Nov 2026), from guest_value()
 * (migration 072): the same guests and groups as retention, with the POS bill
 * Revel's SevenRooms integration writes onto each booking.
 *
 * Every per-head figure divides by the covers of the bookings that CARRY a
 * spend, never all covers, and each group says how many of its bookings that
 * was. Under 95% the group is marked thin: a partial spend over a full
 * headcount would understate it, and nothing else in an answer would show it.
 */

export const VALUE_GROUPS = ['returning_here', 'crossed_from_sister', 'new_to_group'] as const;
export type ValueGroup = typeof VALUE_GROUPS[number];

export interface ValueRow {
  guest_group: string; guests: number; bookings: number; covers: number;
  linked_bookings: number; linked_covers: number; spend: number;
}

export interface GroupValue {
  guests: number;
  bookings: number;
  covers: number;
  visits_per_guest: number | null;
  spend: number;
  spend_per_cover: number | null;
  spend_per_booking: number | null;
  /** Spend in the period per guest, from the bookings that carried one. */
  spend_per_guest: number | null;
  linked_pct: number | null;
  thin: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const div = (a: number, b: number) => (b > 0 ? r2(a / b) : null);

export const THIN_BELOW_PCT = 95;

export function groupValue(row: ValueRow | undefined): GroupValue {
  const g = row ?? { guest_group: '', guests: 0, bookings: 0, covers: 0, linked_bookings: 0, linked_covers: 0, spend: 0 };
  const linked = g.bookings > 0 ? Math.round(1000 * g.linked_bookings / g.bookings) / 10 : null;
  return {
    guests: g.guests,
    bookings: g.bookings,
    covers: g.covers,
    visits_per_guest: div(g.bookings, g.guests),
    spend: r2(g.spend),
    spend_per_cover: div(g.spend, g.linked_covers),
    spend_per_booking: div(g.spend, g.linked_bookings),
    spend_per_guest: div(g.spend, g.guests),
    linked_pct: linked,
    thin: linked !== null && linked < THIN_BELOW_PCT,
  };
}

/** One venue's rows (or all venues' rows summed) into the three groups. */
export function valueByGroup(rows: ValueRow[]): Record<ValueGroup, GroupValue> {
  const sum = new Map<string, ValueRow>();
  for (const r of rows) {
    const s = sum.get(r.guest_group) ?? { guest_group: r.guest_group, guests: 0, bookings: 0, covers: 0, linked_bookings: 0, linked_covers: 0, spend: 0 };
    s.guests += Number(r.guests); s.bookings += Number(r.bookings); s.covers += Number(r.covers);
    s.linked_bookings += Number(r.linked_bookings); s.linked_covers += Number(r.linked_covers); s.spend += Number(r.spend);
    sum.set(r.guest_group, s);
  }
  return Object.fromEntries(VALUE_GROUPS.map(k => [k, groupValue(sum.get(k))])) as Record<ValueGroup, GroupValue>;
}

export const VALUE_NOTE =
  'Spend is the POS bill SevenRooms holds on each booking (Revel writes it there), so it covers BOOKED guests only: walk-ups never in SevenRooms are not in it, ' +
  'and booked spend is roughly 86-92% of a venue\'s net sales. Per cover divides by the covers of bookings that carried a spend. A guest is counted by the SevenRooms ' +
  'profile the booking is under -- usually whoever booked -- so a regular booked by a friend counts as the friend. Where a group is marked thin, fewer than 95% of its ' +
  'bookings carried a spend: say so beside the figure.';
