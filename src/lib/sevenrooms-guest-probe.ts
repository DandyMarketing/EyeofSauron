/**
 * Can we read a guest's IDENTITY live, so we never have to store it?
 *
 * THE QUESTION THIS ANSWERS. The warehouse deliberately holds no guest name,
 * email or phone -- `mapReservation()` drops all of them at ingest, and the
 * only guest key stored is the opaque `sevenrooms_client_id`. A guest-profile
 * feature needs identity on the screen, and there are two ways to get it: copy
 * it into Supabase, or fetch it from SevenRooms at the moment somebody looks.
 *
 * The second keeps every name out of our database permanently. Under the PDPA
 * that shrinks two obligations to nothing -- Protection and Retention -- because
 * you cannot lose or over-keep what you never wrote. It does not touch the
 * obligations that follow USE rather than storage, and nothing here pretends
 * otherwise.
 *
 * It depends on one fact nobody has verified: that the reservations endpoint we
 * ALREADY call returns the identity fields. `mapReservation()`'s comment says
 * it does, naming first_name, last_name, email, phone_number, notes and tags --
 * but that comment records what somebody saw once, and a comment is not a probe.
 * If it holds, the live join needs no new API surface, no new credentials and
 * no new scope: one endpoint, already authenticated, already in production.
 *
 * THIS PROBE PRINTS NO PERSONAL DATA, EVER. It reports which fields are
 * PRESENT, their type, and how many rows carried them -- never a value. A
 * diagnostic for a privacy design that leaks guest names into a terminal and a
 * CI log would be self-defeating, and `redact()` below is the only way a value
 * can reach the output.
 */

export interface FieldReport {
  /** The field name as SevenRooms spells it. */
  field: string;
  /** How many of the sampled reservations carried a non-null value. */
  present: number;
  /** typeof the first non-null value seen. Never the value. */
  type: string;
  /** Length band only, for strings. Tells us a phone is a phone, not what it is. */
  shape: string;
}

export interface GuestProbeResult {
  window: { start: string; end: string };
  venue: string;
  reservations_sampled: number;
  /** Every identity field we would need for a profile, and whether it arrives. */
  identity: FieldReport[];
  /** Fields seen in the payload that this codebase does not know about. */
  undeclared_fields: string[];
  /** Whether every sampled row carried the key the warehouse joins on. */
  client_id_coverage: { withId: number; withoutId: number };
  errors: string[];
}

/**
 * The fields a guest profile would need from SevenRooms, live.
 *
 * `notes` and `tags` are included because they are where a venue records
 * "allergic to shellfish" and "food writer" -- the human-entered knowledge that
 * is worth more than anything an automated web search would find, and that we
 * currently discard. They are also the most sensitive thing in the payload,
 * which is exactly why they should be read at the point of service and never
 * copied.
 */
const IDENTITY_FIELDS = [
  'first_name', 'last_name', 'full_name', 'email', 'phone_number',
  'notes', 'client_notes', 'tags', 'client_tags', 'reference_code',
  'birthday', 'anniversary', 'client_id',
] as const;

/** Everything `mapReservation()` already consumes, so "undeclared" means new. */
const KNOWN_FIELDS = new Set([
  'id', 'client_id', 'date', 'shift_category', 'status', 'status_simple',
  'booked_by', 'is_vip', 'max_guests', 'arrival_time', 'real_datetime_of_slot',
  'seated_time', 'left_time', 'duration', 'table_numbers', 'check_numbers',
  'total_net_payment', 'total_gross_payment', 'onsite_payment_tax',
  'created', 'updated',
]);

/**
 * A value, reduced to something that cannot identify anybody.
 *
 * The ONLY path from a payload value to the output. A string becomes a length
 * band, an array becomes its length, everything else becomes its type. There is
 * deliberately no option to print the real thing, not even behind a flag: a
 * flag is something somebody turns on while debugging at 1am and forgets.
 */
export function redact(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') {
    const n = value.length;
    const band = n === 0 ? 'empty' : n < 10 ? '<10 chars' : n < 40 ? '10-40 chars' : '40+ chars';
    return `string, ${band}`;
  }
  if (typeof value === 'object') return `object(${Object.keys(value as object).length} keys)`;
  return typeof value;
}

/**
 * Summarise a sample of reservations without revealing one of them.
 *
 * Pure, so it is testable without credentials -- which matters, because the
 * container this was written in has none and the probe itself could not be run
 * here. The HTTP half is a thin caller around this.
 */
export function summarise(rows: Array<Record<string, unknown>>): {
  identity: FieldReport[];
  undeclared_fields: string[];
  client_id_coverage: { withId: number; withoutId: number };
} {
  const identity: FieldReport[] = [];

  for (const field of IDENTITY_FIELDS) {
    let present = 0;
    let type = 'absent';
    let shape = 'absent';
    for (const r of rows) {
      const v = r[field];
      if (v === null || v === undefined || v === '') continue;
      present++;
      if (type === 'absent') { type = Array.isArray(v) ? 'array' : typeof v; shape = redact(v); }
    }
    identity.push({ field, present, type, shape });
  }

  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  const undeclared = [...seen]
    .filter(k => !KNOWN_FIELDS.has(k) && !(IDENTITY_FIELDS as readonly string[]).includes(k))
    .sort();

  let withId = 0;
  for (const r of rows) if (r.client_id) withId++;

  return {
    identity,
    undeclared_fields: undeclared,
    client_id_coverage: { withId, withoutId: rows.length - withId },
  };
}

/**
 * Whether the live join is viable, stated as a sentence rather than left to
 * whoever reads the table.
 *
 * A probe that prints twelve rows and no verdict gets read as "it worked".
 */
export function verdict(r: GuestProbeResult): string {
  const got = (f: string) => (r.identity.find(x => x.field === f)?.present ?? 0) > 0;
  const named = got('full_name') || (got('first_name') && got('last_name'));

  if (r.reservations_sampled === 0) return 'INCONCLUSIVE — no reservations in the window, so nothing was tested.';
  if (!named) {
    return 'NO — the reservations endpoint does not return a guest name, so the live join needs a ' +
           'separate client endpoint and this probe cannot confirm one exists. Ask SevenRooms.';
  }
  const coverage = r.client_id_coverage.withId / r.reservations_sampled;
  const lines = ['YES — identity arrives on the endpoint we already call, so the live join needs no new API surface.'];
  if (coverage < 0.95) {
    lines.push(
      `BUT client_id is missing on ${r.client_id_coverage.withoutId} of ${r.reservations_sampled} rows ` +
      `(${Math.round(coverage * 100)}% coverage). Those bookings can show identity but have no history to join to — ` +
      'the profile must say "first visit we can see", never imply the guest is new.',
    );
  }
  if (!got('notes') && !got('client_notes')) {
    lines.push('Guest notes did not come back on this endpoint. That is the highest-value field for service ' +
               'prep, so it is worth asking SevenRooms where it lives before designing around its absence.');
  }
  return lines.join('\n');
}
