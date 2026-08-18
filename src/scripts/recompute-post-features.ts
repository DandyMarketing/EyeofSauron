import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { featuresOf, postedHourOf } from '../parsers/meta/features.js';
import { requireSchema } from '../lib/schema-check.js';

/**
 * Fill in derived post features for rows that predate them.
 *
 * Touches no API. Every feature is a pure function of the caption and the
 * timestamp, both already in the warehouse, so this is safe to run at any time
 * -- including while a Meta backfill is going, since it writes to rows by id
 * rather than upserting over what the backfill is landing.
 *
 * Run it after any post backfill, and again whenever a definition here changes.
 * That second case is the reason these live in code rather than being computed
 * once at ingest: a derivation you cannot re-run is a derivation you can never
 * correct.
 *
 * By default it only visits rows never featured (caption_length is null).
 * `--all` re-derives everything, which is what to use after changing a
 * definition.
 */

const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');
const BATCH = 500;

console.log(all
  ? 'Recomputing features for EVERY post.'
  : 'Recomputing features for posts that have none yet.');
if (dryRun) console.log('=== DRY RUN — no writes ===');

await requireSchema();

let scanned = 0;
let updated = 0;
let unreadableTimestamps = 0;

/**
 * Two different paging rules, because the two modes move differently.
 *
 * `--all` reads a fixed set, so the offset has to advance or it re-reads page
 * one forever.
 *
 * The default reads only rows with no features, and every write REMOVES a row
 * from that set. The set shrinks under the cursor, so advancing the offset as
 * well would step straight over rows and leave them unfeatured with nothing
 * reporting it. Reading from zero each time is correct there -- the filter is
 * the cursor.
 *
 * A dry run writes nothing, so the shrinking never happens and it must advance
 * by offset in both modes. Without that it loops forever on the same page.
 */
let offset = 0;

while (true) {
  let query = supabase
    .from('social_posts')
    .select('id, caption, published_at')
    .order('id')
    .range(offset, offset + BATCH - 1);

  if (!all) query = query.is('caption_length', null);

  const { data, error } = await query;
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!data || data.length === 0) break;

  scanned += data.length;

  for (const row of data) {
    const features = featuresOf(row.caption);
    const posted_hour = postedHourOf(row.published_at);
    if (posted_hour === null) unreadableTimestamps++;

    if (dryRun) continue;

    const { error: writeError } = await supabase
      .from('social_posts')
      .update({ ...features, posted_hour })
      .eq('id', row.id);

    if (writeError) {
      console.error(`Update failed for ${row.id}: ${writeError.message}`);
      process.exit(1);
    }
    updated++;
  }

  console.log(`  ${scanned} scanned, ${updated} updated`);

  if (data.length < BATCH) break;
  if (all || dryRun) offset += BATCH;
}

console.log(`\n${scanned} post(s) scanned, ${updated} updated.`);

if (unreadableTimestamps > 0) {
  console.log(`${unreadableTimestamps} had a timestamp that could not be read — posted_hour left null for those.`);
}

if (!dryRun && updated === 0 && scanned === 0) {
  console.log('Nothing to do — every post already has features.');
}

process.exit(0);
