import { supabase } from '../lib/supabase.js';

const API_BASE = 'https://api.sevenrooms.com/2_4';

/**
 * SevenRooms venue keys -> our warehouse venue_id.
 *
 * The group ("The Dandy Partnership") also contains California Republic,
 * Lo Quay, The Dandy Collection and a dead "DNU The Prince". Only the three
 * venues we warehouse are mapped here; an unmapped venue is skipped rather
 * than guessed at.
 */
export const SEVENROOMS_VENUES: Record<string, { venueId: string; sevenroomsId: string; name: string }> = {
  'neon-pigeon': {
    venueId: '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5',
    sevenroomsId: 'ahNzfnNldmVucm9vbXMtc2VjdXJlchwLEg9uaWdodGxvb3BfVmVudWUYgID0h4ft-AoM',
    name: 'Neon Pigeon',
  },
  'fat-prince': {
    venueId: 'c0d03a78-7d28-4a4a-a908-d1719110e881',
    sevenroomsId: 'ahNzfnNldmVucm9vbXMtc2VjdXJlchwLEg9uaWdodGxvb3BfVmVudWUYgID0p8-exAsM',
    name: 'Fat Prince',
  },
  'super-firangi': {
    venueId: 'a0838494-04a6-4f04-8c1f-a8a2e01a3c07',
    // SevenRooms calls this venue "Firangi Superstar"
    sevenroomsId: 'ahNzfnNldmVucm9vbXMtc2VjdXJlchwLEg9uaWdodGxvb3BfVmVudWUYgID0-9f4jgsM',
    name: 'Super Firangi',
  },
};

export function getSevenroomsVenues() {
  return SEVENROOMS_VENUES;
}

/**
 * Exchange client credentials for a bearer token.
 * Unlike Monday's static token, this one expires after ~24h, so every run
 * authenticates fresh rather than caching across invocations.
 */
export async function authenticate(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  const res = await fetch(`${API_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`SevenRooms auth failed: HTTP ${res.status}`);
  const json: any = await res.json();
  const token = json?.data?.token;
  if (!token) throw new Error(`SevenRooms auth returned no token: ${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

export interface RawReservation {
  id: string;
  client_id?: string | null;
  date: string;
  shift_category?: string | null;
  status?: string | null;
  status_simple?: string | null;
  booked_by?: string | null;
  is_vip?: boolean | null;
  max_guests?: number | null;
  arrival_time?: string | null;
  real_datetime_of_slot?: string | null;
  seated_time?: string | null;
  left_time?: string | null;
  duration?: number | null;
  table_numbers?: string[] | null;
  check_numbers?: string | null;
  total_net_payment?: number | null;
  total_gross_payment?: number | null;
  onsite_payment_tax?: number | null;
  created?: string | null;
  updated?: string | null;
}

/**
 * Fetch every reservation for a venue across a date range, following the
 * cursor until the API stops returning one. The cursor is an integer offset.
 */
export async function fetchReservations(
  token: string,
  sevenroomsVenueId: string,
  fromDate: string,
  toDate: string,
): Promise<RawReservation[]> {
  const all: RawReservation[] = [];
  let cursor: number | null = null;
  let guard = 0;

  while (guard++ < 500) {
    const params = new URLSearchParams({
      venue_id: sevenroomsVenueId,
      from_date: fromDate,
      to_date: toDate,
      limit: '200',
    });
    if (cursor !== null) params.set('cursor', String(cursor));

    const res = await fetch(`${API_BASE}/reservations?${params}`, {
      headers: { Authorization: token },
    });
    if (!res.ok) throw new Error(`SevenRooms reservations failed: HTTP ${res.status}`);

    const json: any = await res.json();
    const results: RawReservation[] = json?.data?.results ?? [];
    all.push(...results);

    const next = json?.data?.cursor;
    if (next === null || next === undefined || results.length === 0) break;
    cursor = next;
  }

  return all;
}

/**
 * SevenRooms mixes timezones inside a single record:
 *   arrival_time / real_datetime_of_slot -> venue-local (SGT)
 *   seated_time / left_time / created / updated -> UTC
 * These helpers keep that distinction explicit so it can't be lost.
 */
function utcToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(' ', 'T');
  return s.endsWith('Z') ? s : `${s}Z`;
}

function localNaive(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.trim().replace(' ', 'T');
}

export interface ReservationRow {
  venue_id: string;
  business_date: string;
  sevenrooms_id: string;
  sevenrooms_client_id: string | null;
  shift_category: string | null;
  status: string | null;
  status_simple: string | null;
  booked_by: string | null;
  is_walk_in: boolean;
  is_vip: boolean;
  party_size: number;
  arrival_time: string | null;
  slot_local: string | null;
  seated_at: string | null;
  left_at: string | null;
  duration_min: number | null;
  table_numbers: string[] | null;
  pos_ticket_id: string | null;
  payment_net: number | null;
  payment_gross: number | null;
  payment_tax: number | null;
  source_created_at: string | null;
  source_updated_at: string | null;
}

/**
 * Map a raw SevenRooms reservation to a warehouse row.
 *
 * Deliberately drops first_name, last_name, email, phone_number, notes,
 * tags and reference codes. Guest CRM is a separate, separately-secured
 * concern -- see 009_reservations.sql.
 */
export function mapReservation(r: RawReservation, venueId: string): ReservationRow {
  return {
    venue_id: venueId,
    business_date: r.date,
    sevenrooms_id: r.id,
    sevenrooms_client_id: r.client_id ?? null,
    shift_category: r.shift_category ?? null,
    status: r.status ?? null,
    status_simple: r.status_simple ?? null,
    booked_by: r.booked_by ?? null,
    is_walk_in: (r.booked_by ?? '').trim().toLowerCase() === 'walk in',
    is_vip: r.is_vip === true,
    party_size: r.max_guests ?? 0,
    arrival_time: r.arrival_time ?? null,
    slot_local: localNaive(r.real_datetime_of_slot),
    seated_at: utcToIso(r.seated_time),
    left_at: utcToIso(r.left_time),
    duration_min: r.duration ?? null,
    table_numbers: r.table_numbers?.length ? r.table_numbers.map(String) : null,
    pos_ticket_id: r.check_numbers ? String(r.check_numbers) : null,
    payment_net: r.total_net_payment ?? null,
    payment_gross: r.total_gross_payment ?? null,
    payment_tax: r.onsite_payment_tax ?? null,
    source_created_at: utcToIso(r.created),
    source_updated_at: utcToIso(r.updated),
  };
}

export interface IngestSummary {
  slug: string;
  fetched: number;
  upserted: number;
  skipped: number;
  errors: string[];
}

export async function ingestReservations(
  slug: string,
  token: string,
  fromDate: string,
  toDate: string,
  options: { dryRun?: boolean } = {},
): Promise<IngestSummary> {
  const config = SEVENROOMS_VENUES[slug];
  if (!config) throw new Error(`Unknown venue: ${slug}`);

  const summary: IngestSummary = { slug, fetched: 0, upserted: 0, skipped: 0, errors: [] };

  const raw = await fetchReservations(token, config.sevenroomsId, fromDate, toDate);
  summary.fetched = raw.length;

  const rows: ReservationRow[] = [];
  for (const r of raw) {
    if (!r.id || !r.date) {
      summary.skipped++;
      continue;
    }
    rows.push(mapReservation(r, config.venueId));
  }

  if (options.dryRun || rows.length === 0) {
    summary.upserted = options.dryRun ? rows.length : 0;
    return summary;
  }

  // Upsert in batches -- a wide date range can exceed a comfortable payload.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('reservations')
      .upsert(batch, { onConflict: 'sevenrooms_id' });
    if (error) {
      summary.errors.push(`batch ${i}-${i + batch.length}: ${error.message}`);
    } else {
      summary.upserted += batch.length;
    }
  }

  return summary;
}

/**
 * Roll reservations up per meal period, for cross-checking against the
 * hand-entered Monday.com figures and against Revel.
 */
export interface ShiftRollup {
  shift: string;
  bookedCovers: number;
  completedCovers: number;
  walkInCovers: number;
  lostCovers: number;
  bookings: number;
  netPayment: number;
  grossPayment: number;
}

export function rollupByShift(rows: ReservationRow[]): ShiftRollup[] {
  const byShift = new Map<string, ReservationRow[]>();
  for (const r of rows) {
    const k = r.shift_category ?? 'UNKNOWN';
    const arr = byShift.get(k) ?? [];
    arr.push(r);
    byShift.set(k, arr);
  }

  const out: ShiftRollup[] = [];
  for (const [shift, rs] of [...byShift.entries()].sort()) {
    const sum = (f: (r: ReservationRow) => boolean) =>
      rs.filter(f).reduce((a, r) => a + (r.party_size || 0), 0);
    out.push({
      shift,
      bookings: rs.length,
      bookedCovers: sum(() => true),
      completedCovers: sum(r => r.status_simple === 'Complete'),
      walkInCovers: sum(r => r.is_walk_in),
      lostCovers: sum(r => r.status_simple === 'Canceled' || r.status_simple === 'No Show'),
      netPayment: rs.reduce((a, r) => a + (r.payment_net || 0), 0),
      grossPayment: rs.reduce((a, r) => a + (r.payment_gross || 0), 0),
    });
  }
  return out;
}
