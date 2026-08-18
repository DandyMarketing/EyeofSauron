import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { backfillMetaPosts, ACCOUNT_FIELDS } from '../ingest/meta.js';

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

const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

console.log(`Meta post backfill — back to ${sinceIso.slice(0, 10)}, ${paceMs}ms between insight calls`);
console.log('Run by hand only. Safe to stop and restart: posts already stored with metrics are not re-fetched.\n');

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
let anyBlocked = false;
const findings: string[] = [];

for (const a of targets as any[]) {
  const label = `${a.account_name ?? a.account_id} (${a.venues?.name ?? a.venue_id})`;
  console.log(`\n${label}`);

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
      findings.push(`${label}: ${r.without_metrics} post(s) stored without metrics — Meta would not report on them`);
    }

    // Ran out of posts before reaching the cutoff. Normal for a younger
    // account, and worth saying so nobody reads a short history as a failure.
    if (!r.reached_cutoff && !r.blocked) {
      findings.push(`${label}: history ends at ${r.oldest_seen?.slice(0, 10) ?? 'no posts'} — the account has nothing older, this is not a gap`);
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

console.log(`\n${totalFetched} post(s) fetched.`);

if (findings.length > 0) {
  console.log(`\nFINDINGS (${findings.length}):`);
  for (const f of findings) console.log(`  - ${f}`);
}

if (anyBlocked) {
  console.error('\nStopped early because Meta blocked or throttled us.');
  console.error('Leave it several hours, then run this again — posts already stored are skipped.');
  process.exit(1);
}

console.log('Post backfill complete.');
process.exit(0);
