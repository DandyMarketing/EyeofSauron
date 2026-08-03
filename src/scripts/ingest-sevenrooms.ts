import 'dotenv/config';
import {
  authenticate,
  ingestReservations,
  getSevenroomsVenues,
} from '../ingest/sevenrooms.js';
import { logIngestion } from '../ingest/log.js';

// Trim and strip wrapping quotes. Both are 128-char hex, and the API rejects
// the credential outright for a single leading space, a trailing newline, or
// a surrounding quote -- all trivially easy to pick up when pasting a value
// that long into a dashboard, and all indistinguishable from a wrong secret
// in the resulting 401.
function cleanCredential(v: string | undefined): string | undefined {
  if (!v) return v;
  // Strip ALL whitespace, not just the ends. These credentials are 128-char
  // hex, so no internal whitespace is ever legitimate -- and a value that long
  // is usually copied from somewhere that wrapped it, carrying a newline into
  // the middle of the string. The API rejects that with a plain 401, identical
  // to a wrong secret, which is near-impossible to spot in a dashboard field
  // that soft-wraps anyway. Quotes are stripped for the same reason.
  return v.replace(/\s+/g, '').replace(/^["']|["']$/g, '');
}

const clientId = cleanCredential(process.env.SEVENROOMS_CLIENT_ID);
const clientSecret = cleanCredential(process.env.SEVENROOMS_CLIENT_SECRET);

// Print which variables are present before doing anything else. A cron whose
// config is wrong otherwise dies silently -- no rows written, no log entry,
// indistinguishable from a schedule that never fired.
// Report lengths, never values. Both SevenRooms credentials are 128-char hex
// strings -- indistinguishable by eye -- so a swapped or truncated paste is
// invisible without this. Anything other than 128 is the bug.
function describe(raw: string | undefined, cleaned: string | undefined): string {
  if (!cleaned) return 'MISSING';
  const fixed = raw !== cleaned ? ' [whitespace/quotes stripped — fix the value in Railway]' : '';
  const bad = cleaned.length !== 128 ? '  <-- EXPECTED 128' : '';
  return `set(len ${cleaned.length})${fixed}${bad}`;
}
console.log('env: ' + [
  `SUPABASE_URL=${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`,
  `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING'}`,
  `SEVENROOMS_CLIENT_ID=${describe(process.env.SEVENROOMS_CLIENT_ID, clientId)}`,
  `SEVENROOMS_CLIENT_SECRET=${describe(process.env.SEVENROOMS_CLIENT_SECRET, clientSecret)}`,
].join('  '));

if (!clientId || !clientSecret) {
  console.error('Missing SEVENROOMS_CLIENT_ID or SEVENROOMS_CLIENT_SECRET environment variable');
  // Record the misconfiguration if we can reach the database, so the failure
  // shows up in ingestion-status rather than as an absence of runs.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { logIngestion: log } = await import('../ingest/log.js');
    const { getSevenroomsVenues: venues } = await import('../ingest/sevenrooms.js');
    for (const cfg of Object.values(venues())) {
      await log({
        venue_id: cfg.venueId,
        report_type: 'sevenrooms' as any,
        filename: 'sevenrooms:config-error',
        status: 'ingestion_error',
        error_message: `Missing ${!clientId ? 'SEVENROOMS_CLIENT_ID' : ''}${!clientId && !clientSecret ? ' and ' : ''}${!clientSecret ? 'SEVENROOMS_CLIENT_SECRET' : ''}`,
      }).catch(() => {});
    }
  }
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function daysAhead(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

const dryRun = process.argv.includes('--dry-run');

// Reservations mutate after the fact -- a booking becomes COMPLETE or NO_SHOW
// well after it was made -- so we always re-pull a window rather than just
// yesterday. Hourly cron runs pass a tight --days window; the default of 7 is
// for manual catch-up runs.
const windowDays = Number(arg('days') ?? 7);
if (!Number.isFinite(windowDays) || windowDays < 0) {
  console.error(`Invalid --days "${arg('days')}" (expected a non-negative number)`);
  process.exit(1);
}

// Sauron is an operations tool, so the forward book matters as much as
// history: "how many are we expecting tonight" is a more common question than
// anything about last month. Reservations exist in SevenRooms weeks ahead, so
// every run pulls forward as well as back.
const forwardDays = Number(arg('forward') ?? 60);
if (!Number.isFinite(forwardDays) || forwardDays < 0) {
  console.error(`Invalid --forward "${arg('forward')}" (expected a non-negative number)`);
  process.exit(1);
}

const fromDate = arg('from') ?? daysAgo(windowDays);
const toDate = arg('to') ?? daysAhead(forwardDays);
const onlyVenue = arg('venue');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [label, value] of [['from', fromDate], ['to', toDate]]) {
  if (!DATE_RE.test(value)) {
    console.error(`Invalid --${label} date "${value}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
}
if (fromDate > toDate) {
  console.error(`--from (${fromDate}) is after --to (${toDate})`);
  process.exit(1);
}

if (dryRun) console.log('=== DRY RUN — no database writes ===\n');
console.log(`SevenRooms reservation ingestion: ${fromDate} .. ${toDate}\n`);

let token: string;
try {
  token = await authenticate(clientId, clientSecret);
  console.log('Authenticated.\n');
} catch (err: any) {
  console.error(`AUTH FAILED: ${err.message}`);
  if (/401/.test(err.message)) {
    console.error('  A 401 means the credentials were rejected, not that they are absent.');
    console.error('  Both values are 128-char hex and look identical -- check they are not');
    console.error('  swapped, and that neither was truncated when pasted.');
  }
  // Record it. Previously this exited without logging, so an auth failure was
  // indistinguishable from a cron that never fired.
  for (const cfg of Object.values(getSevenroomsVenues())) {
    await logIngestion({
      venue_id: cfg.venueId,
      report_type: 'sevenrooms' as any,
      filename: 'sevenrooms:auth-error',
      status: 'ingestion_error',
      error_message: err.message,
    }).catch(() => {});
  }
  process.exit(1);
}

const venues = getSevenroomsVenues();
let totalFetched = 0, totalUpserted = 0, totalSkipped = 0;
const failures: string[] = [];

for (const [slug, config] of Object.entries(venues)) {
  if (onlyVenue && slug !== onlyVenue) continue;

  console.log(`${config.name} (${slug}):`);
  try {
    const s = await ingestReservations(slug, token, fromDate, toDate, { dryRun });
    totalFetched += s.fetched;
    totalUpserted += s.upserted;
    totalSkipped += s.skipped;

    const dupNote = s.duplicates > 0 ? ` | deduped ${s.duplicates}` : '';
    console.log(`  fetched ${s.fetched} | upserted ${s.upserted} | skipped ${s.skipped}${dupNote}`);
    for (const e of s.errors) {
      console.error(`  [ERROR] ${e}`);
      failures.push(`${slug}: ${e}`);
    }

    if (!dryRun) {
      await logIngestion({
        venue_id: config.venueId,
        report_type: 'sevenrooms' as any,
        filename: `sevenrooms:${fromDate}..${toDate}`,
        status: s.errors.length > 0 ? 'ingestion_error' : 'success',
        row_count: s.upserted,
        error_message: s.errors.join('; ') || undefined,
      });
    }
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
    failures.push(`${slug}: ${err.message}`);
    if (!dryRun) {
      await logIngestion({
        venue_id: config.venueId,
        report_type: 'sevenrooms' as any,
        filename: `sevenrooms:${fromDate}..${toDate}`,
        status: 'ingestion_error',
        error_message: err.message,
      });
    }
  }
}

console.log('\n--- Summary ---');
console.log(`Fetched:  ${totalFetched}`);
console.log(`Upserted: ${totalUpserted}`);
console.log(`Skipped:  ${totalSkipped} (missing id or date)`);

if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll clear.');
