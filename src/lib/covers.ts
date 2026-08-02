import { supabase } from './supabase.js';

/**
 * Covers come from SevenRooms, not Revel.
 *
 * This is a deliberate decision: Revel knows how many people paid but not
 * when they ate, so it can never give a brunch/lunch/dinner split. SevenRooms
 * carries the meal period, the walk-in vs reservation mix, no-shows and
 * cancellations -- none of which Revel can see.
 *
 * The tradeoff is that SevenRooms counts the BOOKED party size (max_guests);
 * its arrived_guests field is not populated by the venues. So a SevenRooms
 * cover count is only as good as the team's data entry. That is handled by
 * operational SOP -- staff log walk-ins and adjust party sizes -- and
 * enforced by the variance check below, which compares against Revel's
 * paid-guest count and surfaces any venue/date where the two drift apart.
 *
 * Revenue always stays with Revel. SevenRooms sees only bookings that were
 * linked to a POS ticket, so it is never a revenue source.
 */

export interface CoversSummary {
  business_date: string;
  covers: number;              // completed covers -- the headline number
  booked_covers: number;       // includes cancellations and no-shows
  walk_in_covers: number;
  cancelled_covers: number;
  no_show_covers: number;
  by_shift: Record<string, number>;   // completed covers per meal period
  bookings: number;
}

const COMPLETE = 'Complete';
const CANCELED = 'Canceled';
const NO_SHOW = 'No Show';

/**
 * Fetch SevenRooms covers for a venue across a date range, one summary per day.
 * Returns an empty map when no reservations exist -- callers must handle the
 * gap rather than silently reporting zero covers.
 */
export async function getCovers(
  venueId: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, CoversSummary>> {
  // Page explicitly. PostgREST caps a single response at 1000 rows, and a
  // wide date range across a busy venue exceeds that easily -- 60 days of
  // Fat Prince is ~1650 reservations. Without paging the tail is dropped
  // silently, which reads as "no SevenRooms data" for the most recent dates
  // rather than as an error.
  const PAGE = 1000;
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('reservations')
      .select('business_date, party_size, status_simple, shift_category, is_walk_in')
      .eq('venue_id', venueId)
      .gte('business_date', fromDate)
      .lte('business_date', toDate)
      .order('business_date', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) return new Map();
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const out = new Map<string, CoversSummary>();

  for (const r of rows) {
    const date = r.business_date;
    let s = out.get(date);
    if (!s) {
      s = {
        business_date: date,
        covers: 0,
        booked_covers: 0,
        walk_in_covers: 0,
        cancelled_covers: 0,
        no_show_covers: 0,
        by_shift: {},
        bookings: 0,
      };
      out.set(date, s);
    }

    const size = Number(r.party_size ?? 0);
    s.bookings++;
    s.booked_covers += size;

    if (r.status_simple === COMPLETE) {
      s.covers += size;
      const shift = (r.shift_category ?? 'UNKNOWN').toLowerCase();
      s.by_shift[shift] = (s.by_shift[shift] ?? 0) + size;
      if (r.is_walk_in) s.walk_in_covers += size;
    } else if (r.status_simple === CANCELED) {
      s.cancelled_covers += size;
    } else if (r.status_simple === NO_SHOW) {
      s.no_show_covers += size;
    }
  }

  return out;
}

export interface CoversVariance {
  sevenrooms_covers: number | null;
  revel_guests: number | null;
  variance: number | null;        // sevenrooms - revel
  status: 'ok' | 'minor' | 'review' | 'missing';
}

/**
 * Compare SevenRooms covers against Revel's paid-guest count.
 *
 * Since SevenRooms is the system of record for covers, any gap means the
 * floor SOP was not followed -- a walk-in never entered, or a party size
 * left at its booked value when fewer turned up. This is the signal that
 * makes the SevenRooms-first decision safe: it is visible, per venue and
 * per day, rather than quietly wrong.
 */
export function coversVariance(
  sevenroomsCovers: number | null | undefined,
  revelGuests: number | null | undefined,
): CoversVariance {
  const sr = sevenroomsCovers ?? null;
  const rv = revelGuests ?? null;
  if (sr === null || rv === null) {
    return { sevenrooms_covers: sr, revel_guests: rv, variance: null, status: 'missing' };
  }
  const variance = sr - rv;
  const abs = Math.abs(variance);
  const status: CoversVariance['status'] = abs === 0 ? 'ok' : abs <= 2 ? 'minor' : 'review';
  return { sevenrooms_covers: sr, revel_guests: rv, variance, status };
}
