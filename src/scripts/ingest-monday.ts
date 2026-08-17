import 'dotenv/config';
import { fetchBoardItems, ingestMondayItems, getVenueBoards } from '../ingest/monday.js';
import { logIngestion } from '../ingest/log.js';

const apiToken = process.env.MONDAY_API_TOKEN;
if (!apiToken) {
  console.error('Missing MONDAY_API_TOKEN environment variable');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

if (dryRun) console.log('=== DRY RUN — no database writes ===\n');

console.log('Monday.com meal period ingestion\n');

const venueBoards = getVenueBoards();
let totalInserted = 0, totalUpdated = 0, totalMerged = 0;
let totalLocked = 0, totalBlocked = 0, totalSkipped = 0;
const reconciliationFailures: string[] = [];
const postLockChanges: string[] = [];

for (const [slug, config] of Object.entries(venueBoards)) {
  for (const boardId of config.boards) {
    console.log(`${slug} (board ${boardId}):`);

    let items;
    try {
      items = await fetchBoardItems(boardId, apiToken);
    } catch (err: any) {
      console.error(`  FETCH ERROR: ${err.message}`);
      await logIngestion({
        venue_id: config.venueId,
        report_type: 'monday_meals' as any,
        filename: `board:${boardId}`,
        status: 'ingestion_error',
        error_message: err.message,
      });
      continue;
    }

    console.log(`  Fetched ${items.length} items`);

    const results = await ingestMondayItems(slug, items, { dryRun });

    for (const r of results) {
      switch (r.action) {
        case 'inserted': totalInserted++; break;
        case 'updated': totalUpdated++; break;
        case 'merged': totalMerged++; break;
        case 'locked': totalLocked++; break;
        case 'blocked': totalBlocked++; break;
        case 'skipped': totalSkipped++; break;
      }

      if (r.error && r.action === 'blocked') {
        postLockChanges.push(`${slug} ${r.date}: ${r.error}`);
        console.warn(`  [BLOCKED] ${r.date}: post-lock change detected`);
      } else if (r.error) {
        console.error(`  [ERROR] ${r.date}: ${r.error}`);
      }

      if (r.reconciliation && !r.reconciliation.passed) {
        const msg = `${slug} ${r.date}: Monday $${r.reconciliation.mondayGross.toFixed(2)} vs Revel $${r.reconciliation.revelGross.toFixed(2)} (diff $${r.reconciliation.difference.toFixed(2)})`;
        reconciliationFailures.push(msg);
        console.warn(`  [RECON FAIL] ${msg}`);
      }

      if (r.action === 'locked') {
        console.log(`  [LOCKED] ${r.date}: reconciled & frozen`);
      }
    }

    const actions = results.reduce((acc, r) => {
      acc[r.action] = (acc[r.action] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`  Results: ${JSON.stringify(actions)}`);

    if (!dryRun) {
      await logIngestion({
        venue_id: config.venueId,
        report_type: 'monday_meals' as any,
        filename: `board:${boardId}`,
        status: totalSkipped > 0 ? 'ingestion_error' : 'success',
        row_count: results.filter(r => r.action !== 'skipped' && r.action !== 'blocked').length,
      });
    }
  }
}

console.log('\n--- Summary ---');
console.log(`Inserted:  ${totalInserted} (new Monday-only rows)`);
console.log(`Updated:   ${totalUpdated} (meal periods refreshed)`);
console.log(`Merged:    ${totalMerged} (added to Revel row, awaiting exact match)`);
console.log(`Locked:    ${totalLocked} (reconciled to the cent, frozen)`);
console.log(`Blocked:   ${totalBlocked} (post-lock change rejected)`);
console.log(`Skipped:   ${totalSkipped} (errors)`);

if (reconciliationFailures.length > 0) {
  console.log(`\nRECONCILIATION FAILURES (${reconciliationFailures.length}):`);
  console.log('  Monday meal period totals do NOT match Revel daily totals.');
  console.log('  These rows are ingested but NOT locked — they need review.');
  for (const w of reconciliationFailures) {
    console.log(`  - ${w}`);
  }
}

if (postLockChanges.length > 0) {
  console.log(`\nPOST-LOCK CHANGES BLOCKED (${postLockChanges.length}):`);
  console.log('  Someone changed data on Monday.com after it was reconciled & locked.');
  console.log('  Changes were REJECTED. Alerts logged to reconciliation_alerts table.');
  for (const w of postLockChanges) {
    console.log(`  - ${w}`);
  }
}

if (reconciliationFailures.length === 0 && postLockChanges.length === 0) {
  console.log('\nAll clear — no reconciliation issues.');
}

// Exit non-zero ONLY for an execution error.
//
// This used to exit 1 on post-lock changes too, which made Railway show the
// service as failed on every run while the job was working perfectly -- it had
// fetched every board, rejected the changes correctly, and logged the alerts.
// A data-quality finding is not a job failure: the cron's status answers "did
// this run", not "is the data clean". Conflating them means the service is red
// forever, and the day it genuinely breaks the red looks identical.
//
// Data health is reported where it belongs: reconciliation_alerts, surfaced
// through /watchdog and resolvable by a human.
process.exit(totalSkipped > 0 ? 1 : 0);
