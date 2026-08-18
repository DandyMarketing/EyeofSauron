import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import {
  ingestMetaInsights, isMetaBlockedError, isMetaAuthError,
  PLATFORM_METRICS, TOTAL_VALUE_METRICS,
} from '../ingest/meta.js';
import { requireSchema } from '../lib/schema-check.js';

/**
 * Two years of social history, fetched slowly enough not to get us blocked.
 *
 * Run by hand, never on a schedule. It makes thousands of calls where the
 * nightly job makes twenty.
 *
 * Three things shape this, and all three come from getting it wrong first:
 *
 * PACING. 153 calls in a burst from a new token tripped Meta's automated
 * security and blocked the app for a day. This paces every call and defaults
 * to a slow rate. Two years across three accounts is roughly 2,300 requests --
 * at 1.2 seconds each that is about 45 minutes, and 45 minutes of patience is
 * cheaper than another day locked out.
 *
 * RESUMABILITY. A run this long will be interrupted. Days already in the
 * warehouse are skipped, so stopping it and starting it again costs nothing
 * and never double-fetches.
 *
 * STOPPING. If Meta blocks or rate-limits us, this exits immediately. Carrying
 * on would deepen exactly the problem it just hit, and a backfill is never
 * urgent enough to be worth that.
 *
 * `followers_count` is NOT backfilled and cannot be: Meta serves no history for
 * the follower total. That series starts the day we began capturing it and
 * there is no way to fill what came before.
 */

const arg = (name: string, fallback: number) => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const days = Math.min(Math.max(arg('days', 730), 1), 730);   // Meta serves 2 years, and no more
const paceMs = Math.max(arg('pace', 1200), 200);
const windowDays = Math.min(Math.max(arg('window', 30), 1), 30);  // Meta caps a daily series request at 30 days
const onlySlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1];

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Meta's ways of saying "stop". Shared with the post backfill, which needs it too. */
const isBlockedError = isMetaBlockedError;

console.log(`Meta backfill — ${days} days back, ${windowDays}-day windows, ${paceMs}ms between calls`);
console.log('Run by hand only. Safe to stop and restart: days already stored are skipped.\n');

// Before a single call to Meta, for the same reason as the post backfill.
await requireSchema();

const { data: accounts, error } = await supabase
  .from('social_accounts')
  .select('platform, account_id, account_name, venue_id, venues(name, slug)')
  .not('venue_id', 'is', null)
  .eq('is_active', true);

if (error) {
  console.error(`Could not read social_accounts: ${error.message}`);
  process.exit(1);
}

const targets = (accounts ?? []).filter((a: any) => {
  if ((PLATFORM_METRICS[a.platform] ?? []).length === 0 && (TOTAL_VALUE_METRICS[a.platform] ?? []).length === 0) return false;
  return !onlySlug || a.venues?.slug === onlySlug;
});

if (targets.length === 0) {
  console.error(onlySlug ? `No mapped account matched --venue=${onlySlug}.` : 'No mapped accounts with metrics configured.');
  process.exit(1);
}

/**
 * Which metric decides whether a window has already been done.
 *
 * One representative metric instead of all twelve, because they are written
 * together and checking each would be twelve queries answering one question.
 *
 * That reasoning has a hole, and Fat Prince found it. Metrics do NOT always
 * land together: `views` had all 729 days while `reach` had 678, missing 29 at
 * the start and 22 scattered inside. Because the marker was complete, every
 * window looked done, every window was skipped, and re-running could never
 * repair `reach` -- the gap was permanent and silent.
 *
 * So the marker is now a flag. `--marker=reach` re-checks coverage by reach and
 * refills exactly the windows it is missing from, at no cost for the ones it
 * already has. The default stays cheap for the ordinary case.
 *
 * Do NOT set this to `follower_count`: Meta serves only the last 30 days of it,
 * so every older window would look incomplete forever and the backfill would
 * re-fetch the entire history on every run.
 */
const MARKER_METRIC = process.argv.find(a => a.startsWith('--marker='))?.split('=')[1] ?? 'views';

if (MARKER_METRIC === 'follower_count' || MARKER_METRIC === 'followers_count') {
  console.error(`--marker=${MARKER_METRIC} would never be satisfied: Meta serves no usable history for it.`);
  console.error('Every window would look incomplete and the whole history would be re-fetched each run.');
  process.exit(1);
}

console.log(`Completeness judged by "${MARKER_METRIC}". A window is skipped when it has ${windowDays} day(s) of it.`);
console.log('Other metrics can still be short — re-run with --marker=<metric> to repair a specific one.\n');

let totalStored = 0;
let windowsSkipped = 0;
let blocked = false;
let authFailed = false;

for (const a of targets as any[]) {
  if (authFailed) break;
  const label = `${a.account_name ?? a.account_id} (${a.venues?.name ?? a.venue_id})`;
  console.log(`\n${label}`);

  // Oldest first. A backfill interrupted halfway should leave a contiguous
  // history with a gap at the recent end, which the nightly job then closes on
  // its own -- rather than an archipelago nobody can reason about.
  for (let offset = days; offset > 0 && !blocked && !authFailed; offset -= windowDays) {
    const start = isoDay(Date.now() - offset * DAY_MS);
    const end = isoDay(Date.now() - Math.max(offset - windowDays + 1, 1) * DAY_MS);

    const { count } = await supabase
      .from('social_daily')
      .select('business_date', { count: 'exact', head: true })
      .eq('venue_id', a.venue_id)
      .eq('metric', MARKER_METRIC)
      .gte('business_date', start)
      .lte('business_date', end);

    if ((count ?? 0) >= windowDays) {
      windowsSkipped++;
      continue;
    }

    try {
      const r = await ingestMetaInsights(a.platform, a.account_id, start, end, undefined, windowDays, paceMs);
      totalStored += r.rows;
      console.log(`  ${start} → ${end}: ${r.rows} rows${r.rows === 0 ? ' (nothing returned)' : ''}`);

      for (const [metric, reason] of Object.entries(r.failed_metrics ?? {})) {
        if (isMetaAuthError(reason)) {
          console.error(`\n  STOPPING — the token is not valid: ${metric} — ${reason}`);
          authFailed = true;
          break;
        }
        if (isBlockedError(reason)) {
          console.error(`\n  STOPPING — Meta is refusing calls: ${metric} — ${reason}`);
          blocked = true;
          break;
        }
      }
    } catch (e: any) {
      const message = String(e?.message ?? e);

      // A dead token before a missing window. Both arrive as an error on one
      // window, and without this check an expired token reads as "no data this
      // far back is normal" -- so the run walks every remaining window printing
      // `skipped`, stores nothing, and exits 0. Waiting does not fix it, and a
      // backfill that reports success having stored nothing is worse than one
      // that fails.
      if (isMetaAuthError(message)) {
        console.error(`\n  STOPPING — the token is not valid: ${message}`);
        authFailed = true;
        break;
      }
      if (isBlockedError(message)) {
        console.error(`\n  STOPPING — Meta is refusing calls: ${message}`);
        blocked = true;
        break;
      }
      // A window Meta has no data for is normal this far back; keep going.
      console.log(`  ${start} → ${end}: skipped — ${message.slice(0, 160)}`);
    }

    await new Promise(r => setTimeout(r, paceMs));
  }
}

console.log(`\n${totalStored} rows stored. ${windowsSkipped} window(s) already had data and were skipped.`);

if (authFailed) {
  console.error('\nStopped because Meta rejected the token. Waiting will not fix this.');
  console.error('Update META_SYSTEM_USER_TOKEN — in the Railway sealed variable AND in .env if running locally —');
  console.error('then run this again. Everything already stored will be skipped.');
  console.error('A process reads its environment once at start, so a run in flight when the token');
  console.error('was rotated keeps using the old one until it is restarted.');
  process.exit(1);
}

if (blocked) {
  console.error('\nStopped early because Meta blocked or throttled us.');
  console.error('Leave it several hours, then run this again — everything already stored will be skipped.');
  process.exit(1);
}

console.log('Backfill complete. followers_count is not included and cannot be: Meta serves no history for it.');
process.exit(0);
