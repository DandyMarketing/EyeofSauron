import 'dotenv/config';
import { fetchBoardItems, ingestMondayItems, getVenueBoards } from '../ingest/monday.js';
import { logIngestion } from '../ingest/log.js';

const apiToken = process.env.MONDAY_API_TOKEN;
if (!apiToken) {
  console.error('Missing MONDAY_API_TOKEN environment variable');
  process.exit(1);
}

const lookbackDays = parseInt(process.argv[2] || '7', 10);
const dryRun = process.argv.includes('--dry-run');

if (dryRun) console.log('=== DRY RUN — no database writes ===\n');

console.log(`Monday.com meal period ingestion — last ${lookbackDays} days\n`);

const venueBoards = getVenueBoards();
let totalInserted = 0, totalUpdated = 0, totalMerged = 0, totalSkipped = 0;
let reconciliationWarnings: string[] = [];

for (const [slug, config] of Object.entries(venueBoards)) {
  for (const boardId of config.boards) {
    console.log(`${slug} (board ${boardId}):`);

    let items;
    try {
      items = await fetchBoardItems(boardId, apiToken, lookbackDays);
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
      if (r.action === 'inserted') totalInserted++;
      if (r.action === 'updated') totalUpdated++;
      if (r.action === 'merged') totalMerged++;
      if (r.action === 'skipped') totalSkipped++;

      if (r.error) {
        console.error(`  [ERROR] ${r.date}: ${r.error}`);
      }

      if (r.reconciliation && !r.reconciliation.passed) {
        const msg = `${slug} ${r.date}: Monday $${r.reconciliation.mondayGross.toFixed(2)} vs Revel $${r.reconciliation.revelGross.toFixed(2)} (diff $${r.reconciliation.difference.toFixed(2)})`;
        reconciliationWarnings.push(msg);
        console.warn(`  [RECON WARN] ${msg}`);
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
        status: 'success',
        row_count: results.filter(r => r.action !== 'skipped').length,
      });
    }
  }
}

console.log('\n--- Summary ---');
console.log(`Inserted: ${totalInserted}`);
console.log(`Updated:  ${totalUpdated}`);
console.log(`Merged:   ${totalMerged} (Revel + Monday meal periods)`);
console.log(`Skipped:  ${totalSkipped}`);

if (reconciliationWarnings.length > 0) {
  console.log(`\n⚠ ${reconciliationWarnings.length} RECONCILIATION WARNING(S):`);
  for (const w of reconciliationWarnings) {
    console.log(`  ${w}`);
  }
} else {
  console.log('\nReconciliation: all merged rows within tolerance');
}

process.exit(totalSkipped > 0 ? 1 : 0);
