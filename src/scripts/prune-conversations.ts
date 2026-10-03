/**
 * Delete chat history past the retention window.
 *
 * A YEAR, measured from the LAST message rather than the first, settled with
 * Khai on 3 Oct 2026. Chats are personal data and PDPA is on the Phase 4 list,
 * so "keep forever" is a choice nobody made rather than a default. Measuring
 * from the last message means a thread somebody keeps returning to keeps
 * living; measuring from the first would delete the most useful one they have
 * on its first birthday.
 *
 * IT REPORTS WHAT IT DELETED, every time, including zero. A retention job
 * running silently is indistinguishable from one that stopped running, which is
 * the failure this codebase keeps finding — the unapplied migrations, the
 * search that was never configured, the reach metric with a permanent hole.
 *
 *   npm run prune:chats              -- the default 365 days
 *   npm run prune:chats -- --days=90 -- a shorter window
 *   npm run prune:chats -- --dry-run -- count without deleting
 */

import 'dotenv/config';
import { supabaseAdmin } from '../auth/session.js';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
};

const days = Number(arg('days') ?? 365);
const dryRun = process.argv.includes('--dry-run');

if (!Number.isFinite(days) || days < 1) {
  console.error(`--days must be a positive number; got ${arg('days')}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(`Conversation retention: ${days} days (anything last touched before ${cutoff.slice(0, 10)}).`);

  /**
   * Counted first, always — including on a real run.
   *
   * The function returns how many it removed, but a count taken beforehand is
   * what makes a dry run possible and what makes a surprising number visible
   * BEFORE the rows are gone rather than after.
   */
  const { count, error: countError } = await supabaseAdmin
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .lt('updated_at', cutoff);

  if (countError) {
    console.error(`Could not count expiring conversations: ${countError.message}`);
    console.error('If migration 050 has not been run, run it first.');
    process.exit(1);
  }

  const expiring = count ?? 0;
  if (expiring === 0) {
    console.log('Nothing to delete. 0 conversations are past the window.');
    return;
  }

  if (dryRun) {
    console.log(`DRY RUN: ${expiring} conversation(s) would be deleted. Nothing was changed.`);
    return;
  }

  const { data, error } = await supabaseAdmin.rpc('prune_old_conversations', { older_than_days: days });
  if (error) {
    console.error(`Prune failed: ${error.message}`);
    process.exit(1);
  }

  const removed = typeof data === 'number' ? data : expiring;
  console.log(`Deleted ${removed} conversation(s). Their messages went with them by cascade.`);

  // Said out loud when the two disagree: a mismatch means rows were written
  // between the count and the delete, which is fine, or that the function is
  // not deleting what the count thought it would, which is not.
  if (removed !== expiring) {
    console.warn(`Counted ${expiring} before deleting and removed ${removed}. ` +
      'A small difference is new activity during the run; a large one is worth looking at.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
