import 'dotenv/config';
import { authenticate, getSevenroomsVenues } from '../ingest/sevenrooms.js';
import { summarise, verdict, type GuestProbeResult } from '../lib/sevenrooms-guest-probe.js';

/**
 * Does the reservations endpoint carry guest identity?
 *
 * One question, and the whole live-join design rests on it. See the long note
 * in src/lib/sevenrooms-guest-probe.ts for why it matters.
 *
 *   npm run probe:guest -- --venue=neon-pigeon --start=2026-10-01 --end=2026-10-07
 *
 * READ ONLY. Nothing is written to SevenRooms and nothing at all is written to
 * the warehouse. NO PERSONAL DATA IS PRINTED -- the output reports which fields
 * exist and how often, never a value, because a privacy probe that leaks guest
 * names into a terminal and a CI log has defeated itself.
 */

const ID = process.env.SEVENROOMS_CLIENT_ID;
const SECRET = process.env.SEVENROOMS_CLIENT_SECRET;
if (!ID || !SECRET) {
  console.error('SEVENROOMS_CLIENT_ID / SEVENROOMS_CLIENT_SECRET are not set. They are sealed variables on Railway.');
  process.exit(1);
}

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

const venues = getSevenroomsVenues();
const slug = arg('venue') ?? Object.keys(venues)[0];
const venue = (venues as Record<string, { sevenroomsId: string; name: string }>)[slug];
if (!venue) {
  console.error(`Unknown venue "${slug}". One of: ${Object.keys(venues).join(', ')}`);
  process.exit(1);
}

// A week is plenty to see which fields exist, and the smallest window that
// still catches a field only some bookings carry.
const today = new Date();
const end = arg('end') ?? today.toISOString().slice(0, 10);
const start = arg('start') ?? new Date(today.getTime() - 7 * 86400_000).toISOString().slice(0, 10);

const result: GuestProbeResult = {
  window: { start, end },
  venue: venue.name,
  reservations_sampled: 0,
  identity: [],
  undeclared_fields: [],
  client_id_coverage: { withId: 0, withoutId: 0 },
  errors: [],
};

try {
  const token = await authenticate(ID, SECRET);

  const params = new URLSearchParams({
    venue_id: venue.sevenroomsId,
    from_date: start,
    to_date: end,
    limit: '100',
  });
  const res = await fetch(`https://api.sevenrooms.com/2_4/reservations?${params}`, {
    headers: { Authorization: token },
  });

  if (!res.ok) {
    result.errors.push(`reservations: HTTP ${res.status}`);
  } else {
    const json: any = await res.json();
    const rows: Array<Record<string, unknown>> = json?.data?.results ?? json?.data ?? [];
    result.reservations_sampled = rows.length;
    Object.assign(result, summarise(rows));
  }
} catch (e: any) {
  result.errors.push(e?.message ?? String(e));
}

console.log(`SevenRooms guest-identity probe — ${result.venue}, ${start} to ${end}`);
console.log('Read only. No personal data is printed: fields and counts, never values.\n');

if (result.errors.length) {
  for (const e of result.errors) console.log(`ERROR: ${e}`);
  console.log('');
}

console.log(`reservations sampled: ${result.reservations_sampled}`);
console.log(`client_id present on: ${result.client_id_coverage.withId} / ${result.reservations_sampled}\n`);

console.log('field'.padEnd(18) + 'present'.padEnd(10) + 'type'.padEnd(10) + 'shape');
console.log('-'.repeat(60));
for (const f of result.identity) {
  console.log(f.field.padEnd(18) + String(f.present).padEnd(10) + f.type.padEnd(10) + f.shape);
}

if (result.undeclared_fields.length) {
  console.log(`\nFields in the payload this codebase does not know about:\n  ${result.undeclared_fields.join(', ')}`);
  console.log('  (names only — no values were read from them)');
}

console.log(`\n${verdict(result)}`);
