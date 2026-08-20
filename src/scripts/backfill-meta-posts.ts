import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { backfillMetaPosts, refreshMetaPostFields, ACCOUNT_FIELDS } from '../ingest/meta.js';
import { requireSchema } from '../lib/schema-check.js';

/**
 * Two years of individual posts, fetched slowly enough not to get us blocked.
 *
 * Run by hand, never on a schedule. The nightly job reads the most recent
 * hundred posts, which is right for keeping up and useless for looking back.
 *
 * WHY THIS EXISTS. The question worth answering is not "which post won last
 * week" but "what kind of post wins" -- and that needs a sample. Thirty posts
 * a month per venue against ten content categories is three posts a cell,
 * which is a hunch dressed as a finding. Two years is roughly seven hundred
 * posts a venue, and that is enough to say something and mean it.
 *
 * WHAT IT COSTS. One listing call per hundred posts, plus one insights call
 * per post that needs one. Around 700 posts a venue at 3 seconds each is
 * roughly 35 minutes per venue. Run one venue at a time.
 *
 * WHAT IT WILL NOT DO. It does not re-request a post we already hold metrics
 * for, so a second run costs almost nothing. And it stops the moment Meta
 * starts refusing, because a backfill is never urgent enough to be worth
 * another day locked out.
 */

const arg = (name: string, fallback: number) => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const days = Math.min(Math.max(arg('days', 730), 1), 3650);
const paceMs = Math.max(arg('pace', 3000), 200);
const onlySlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1];
const dryRun = process.argv.includes('--dry-run');

/**
 * Refresh the listing fields on posts already stored, and fetch nothing else.
 *
 * For columns added AFTER the posts were ingested. The ordinary backfill skips
 * a post once it has metrics -- that skip is what makes restarting free, and it
 * also means a new column stays null on everything already stored, looking
 * perfectly healthy while being empty.
 *
 * Costs a listing call per hundred posts and no per-post calls at all: about a
 * dozen requests for two years across three venues, against roughly a thousand
 * for a real backfill.
 */
const fieldsOnly = process.argv.includes('--fields-only');

const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

console.log(`Meta post backfill — back to ${sinceIso.slice(0, 10)}, ${paceMs}ms between insight calls`);
console.log(fieldsOnly
  ? 'FIELDS ONLY — refreshing listing fields on stored posts. No insights calls, no metrics touched.\n'
  : 'Run by hand only. Safe to stop and restart: posts already stored with metrics are not re-fetched.\n');

// Before a single call to Meta. Twenty minutes into a run is the worst
// possible moment to discover a column is missing -- and it is exactly when
// this failed on 18 Aug 2026, twice.
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
  // Same gate as everywhere else: an empty field list means we have no working
  // vocabulary for that platform, and Facebook Pages are still in that state.
  if ((ACCOUNT_FIELDS[a.platform] ?? []).length === 0) return false;
  return !onlySlug || a.venues?.slug === onlySlug;
});

if (targets.length === 0) {
  console.error(onlySlug
    ? `No mapped account matched --venue=${onlySlug}.`
    : 'No mapped Instagram accounts. Map them on the admin page first.');
  process.exit(1);
}

if (dryRun) {
  console.log('=== DRY RUN — no calls, no writes ===');
  for (const a of targets as any[]) {
    console.log(`  would back-fill ${a.account_name ?? a.account_id} (${a.venues?.name ?? a.venue_id})`);
  }
  process.exit(0);
}

let totalFetched = 0;
let totalUpdated = 0;
let anyBlocked = false;
let anyAuthFailed = false;
const findings: string[] = [];

for (const a of targets as any[]) {
  const label = `${a.account_name ?? a.account_id} (${a.venues?.name ?? a.venue_id})`;
  console.log(`\n${label}`);

  if (fieldsOnly) {
    try {
      const r = await refreshMetaPostFields(a.platform, a.account_id, {
        sinceIso,
        paceMs,
        onPage: p => console.log(`  page ${p.page}: ${p.updated} updated so far`),
      });
      totalUpdated += r.updated;
      console.log(`  ${r.pages} page(s), ${r.seen} listed, ${r.updated} updated`);
      if (r.blocked) {
        anyBlocked = true;
        console.error('  STOPPED — Meta began refusing calls.');
        break;
      }
    } catch (e: any) {
      console.error(`  FAILED — ${e?.message ?? e}`);
      process.exit(1);
    }
    continue;
  }

  try {
    const r = await backfillMetaPosts(a.platform, a.account_id, {
      sinceIso,
      paceMs,
      onPage: p => console.log(
        `  page ${p.page}: ${p.seen} listed, ${p.fetched} stored, oldest so far ${p.oldest?.slice(0, 10) ?? '—'}`,
      ),
    });

    totalFetched += r.fetched;
    console.log(
      `  ${r.pages} page(s), ${r.seen} post(s) listed, ${r.fetched} fetched, ` +
      `${r.skipped_already_current} already held, oldest ${r.oldest_seen?.slice(0, 10) ?? '—'}`,
    );

    if (r.without_metrics > 0) {
      findings.push(`${label}: ${r.without_metrics} post(s) stored without metrics — Meta said: ${r.metrics_error ?? 'no reason captured'}`);
    }

    // Ran out of posts before reaching the cutoff. Normal for a younger
    // account, and worth saying so nobody reads a short history as a failure.
    if (!r.reached_cutoff && !r.blocked && !r.auth_failed) {
      findings.push(`${label}: history ends at ${r.oldest_seen?.slice(0, 10) ?? 'no posts'} — the account has nothing older, this is not a gap`);
    }

    if (r.auth_failed) {
      // Not the same problem as a throttle, and not fixed by the same thing.
      // Waiting cures a block; only a human updating a secret cures this.
      anyAuthFailed = true;
      console.error(`  STOPPED — Meta rejected the token: ${r.stop_reason}`);
      console.error('  Everything fetched before that point was stored.');
      break;
    }

    if (r.blocked) {
      anyBlocked = true;
      console.error(`  STOPPED — Meta began refusing calls. Everything fetched before that point was stored.`);
      break;
    }
  } catch (e: any) {
    console.error(`  FAILED — ${e?.message ?? e}`);
    process.exit(1);
  }
}

// Report what the run actually did. In fields-only mode no insights are
// fetched by design, so printing "0 post(s) fetched" under a line saying 327
// rows were updated reads as a run that achieved nothing -- the same shape as
// every other silent-success bug this file has had.
console.log(fieldsOnly
  ? `\n${totalUpdated} post(s) updated. No insights were fetched — that is what --fields-only means.`
  : `\n${totalFetched} post(s) fetched.`);

if (findings.length > 0) {
  console.log(`\nFINDINGS (${findings.length}):`);
  for (const f of findings) console.log(`  - ${f}`);
}

if (anyAuthFailed) {
  console.error('\nStopped because Meta rejected the token. Waiting will not fix this.');
  console.error('Update META_SYSTEM_USER_TOKEN — in the Railway sealed variable AND in .env if running locally —');
  console.error('then run this again. Posts already stored with metrics are skipped.');
  console.error('A process reads its environment once at start, so a run in flight when the token');
  console.error('was rotated keeps using the old one until it is restarted.');
  process.exit(1);
}

if (anyBlocked) {
  console.error('\nStopped early because Meta blocked or throttled us.');
  console.error('Leave it several hours, then run this again — posts already stored are skipped.');
  process.exit(1);
}

console.log(fieldsOnly ? 'Field refresh complete.' : 'Post backfill complete.');
process.exit(0);
