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
    name: 'Firangi Superstar',
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
 * SevenRooms refuses to page beyond 4000 results for a single query --
 * "Result set limited to 4000 results". Any date range busier than that
 * cannot be read in one go, so ranges are split into windows small enough to
 * stay under it, and a window that still hits the cap is halved and retried.
 */
const MAX_RESULT_SET = 4000;
const DEFAULT_WINDOW_DAYS = 28;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** Page through one window. Throws CAP_HIT if the window is too busy to read. */
const CAP_HIT = Symbol('result-set-cap');

async function fetchWindow(
  token: string,
  sevenroomsVenueId: string,
  fromDate: string,
  toDate: string,
): Promise<RawReservation[]> {
  const rows: RawReservation[] = [];
  let cursor: number | null = null;
  let guard = 0;

  while (guard++ < 200) {
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

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 400 && /limited to \d+ results/i.test(body)) throw CAP_HIT;
      throw new Error(`SevenRooms reservations failed: HTTP ${res.status}`);
    }

    const json: any = await res.json();
    const results: RawReservation[] = json?.data?.results ?? [];
    rows.push(...results);

    // Treat reaching the cap as a truncated read, not a complete one. Silently
    // returning 4000 of 5000 rows would look like a successful ingest.
    if (rows.length >= MAX_RESULT_SET) throw CAP_HIT;

    const next = json?.data?.cursor;
    if (next === null || next === undefined || results.length === 0) break;
    cursor = next;
  }

  return rows;
}

/**
 * Fetch every reservation for a venue across a date range, splitting the range
 * into windows that stay under the API's 4000-result ceiling.
 */
export async function fetchReservations(
  token: string,
  sevenroomsVenueId: string,
  fromDate: string,
  toDate: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<RawReservation[]> {
  const all: RawReservation[] = [];

  for (let start = fromDate; start <= toDate; start = addDays(start, windowDays)) {
    const rawEnd = addDays(start, windowDays - 1);
    const end = rawEnd > toDate ? toDate : rawEnd;
    all.push(...(await fetchRangeSplitting(token, sevenroomsVenueId, start, end)));
    if (end === toDate) break;
  }

  return all;
}

/** Fetch one window, halving it if the venue was busy enough to hit the cap. */
async function fetchRangeSplitting(
  token: string,
  sevenroomsVenueId: string,
  from: string,
  to: string,
): Promise<RawReservation[]> {
  try {
    return await fetchWindow(token, sevenroomsVenueId, from, to);
  } catch (err) {
    if (err !== CAP_HIT) throw err;

    const span = daysBetween(from, to);
    if (span < 1) {
      // A single day over the cap is not splittable further. Surface it rather
      // than returning a partial day and calling the ingest a success.
      throw new Error(
        `SevenRooms returned more than ${MAX_RESULT_SET} results for a single day (${from}); cannot page past the API limit`,
      );
    }

    const mid = addDays(from, Math.floor(span / 2));
    const left = await fetchRangeSplitting(token, sevenroomsVenueId, from, mid);
    const right = await fetchRangeSplitting(token, sevenroomsVenueId, addDays(mid, 1), to);
    return [...left, ...right];
  }
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
  /** Rows the API returned more than once -- see the pagination note below. */
  duplicates: number;
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

  const summary: IngestSummary = { slug, fetched: 0, upserted: 0, skipped: 0, duplicates: 0, errors: [] };

  const raw = await fetchReservations(token, config.sevenroomsId, fromDate, toDate);
  summary.fetched = raw.length;

  // Deduplicate by reservation id, keeping the last copy seen.
  //
  // SevenRooms paginates by integer offset. During service the underlying set
  // is changing under us -- a booking created or updated between two page
  // requests shifts every later row along, which can return the same row on
  // consecutive pages. Postgres then rejects the whole batch with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  //
  // The same race can also push a row across a page boundary so it is never
  // returned at all. That is not fixable here, but it is self-healing: every
  // run re-pulls a multi-day window, so a row missed once is picked up next run.
  const byId = new Map<string, ReservationRow>();
  for (const r of raw) {
    if (!r.id || !r.date) {
      summary.skipped++;
      continue;
    }
    byId.set(r.id, mapReservation(r, config.venueId));
  }
  const rows = [...byId.values()];
  summary.duplicates = raw.length - summary.skipped - rows.length;

  if (options.dryRun || rows.length === 0) {
    summary.upserted = options.dryRun ? rows.length : 0;
    return summary;
  }

  // Upsert in batches -- a wide date range can exceed a comfortable payload.
  // Retry transient network failures: a multi-year backfill pushes hundreds of
  // batches, and a single connection reset would otherwise drop 500 rows and
  // still report the run as mostly successful.
  const BATCH = 500;
  const MAX_ATTEMPTS = 4;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { error } = await supabase
        .from('reservations')
        .upsert(batch, { onConflict: 'sevenrooms_id' });

      if (!error) {
        summary.upserted += batch.length;
        lastError = '';
        break;
      }

      lastError = error.message;
      const transient = /timeout|connect|reset|network|fetch failed|502|503|504/i.test(error.message);
      if (!transient || attempt === MAX_ATTEMPTS) break;

      // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }

    if (lastError) {
      summary.errors.push(`batch ${i}-${i + batch.length}: ${lastError}`);
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
