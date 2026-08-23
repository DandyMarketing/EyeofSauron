import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { requireSchema } from '../lib/schema-check.js';
import { fetchMediaThumbnails } from '../ingest/meta.js';
import { classifierPrompt, classificationTool, parseClassification } from '../ai/post-classifier.js';

/**
 * Classify posts by what they are ABOUT.
 *
 * Run by hand, and safe to stop and restart: a post that already has a category
 * is skipped, so a killed run resumes where it left off rather than paying for
 * the same thousand posts twice.
 *
 * SENDS THE IMAGE, NOT JUST THE CAPTION, and that is the difference between
 * this working and not. Dish, Drink, Room, Lifestyle and Team are distinctions
 * about what is in the picture, and a caption very often says none of it -- a
 * cocktail post captioned "Friday." is unclassifiable from text and obvious
 * from the image. `classified_from` records which was used, because a
 * caption-only pass and a caption+image pass are not comparable and must never
 * be averaged together.
 *
 * Image URLs are fetched fresh per batch because Instagram's CDN links are
 * signed and expire within days -- the same reason they are never stored.
 */

const client = new Anthropic();

const arg = (name: string, fallback: number) => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const limit = Math.min(Math.max(arg('limit', 200), 1), 2000);
const batchSize = Math.min(Math.max(arg('batch', 20), 1), 50);
const onlySlug = process.argv.find(a => a.startsWith('--venue='))?.split('=')[1];
const captionOnly = process.argv.includes('--caption-only');
const dryRun = process.argv.includes('--dry-run');

/**
 * Sonnet, not Opus. This is a judgement about a picture against nine written
 * definitions -- a recognition task, not a reasoning one -- and it runs a
 * thousand times. Opus would cost 1.67x for an answer that is not better at
 * telling a plate of food from a cocktail.
 */
const MODEL = process.env.SAURON_MODEL_CLASSIFY?.trim() || 'claude-sonnet-5';

/**
 * Fail before doing any work, not fifty posts in.
 *
 * The first real run was on a service that has Meta and Supabase credentials
 * but no ANTHROPIC_API_KEY, and it reported fifty identical "Could not resolve
 * authentication method" failures -- one per post, each looking like a problem
 * with that post. The cause was one missing variable, and the run had to be
 * read to the bottom to see that every single line said the same thing.
 *
 * Same rule as requireSchema(): a job that cannot possibly succeed should say
 * so before it starts, and name the fix.
 */
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('ANTHROPIC_API_KEY is not set on this service.');
  console.error('');
  console.error('The classifier needs BOTH: Meta credentials for the images and an Anthropic');
  console.error('key for the judgement. Add ANTHROPIC_API_KEY to this service\'s variables —');
  console.error('the same value the web service uses — and run it again.');
  process.exit(1);
}

console.log(`Post classification — up to ${limit} post(s), ${MODEL}`);
console.log(captionOnly
  ? 'CAPTION ONLY. Subject is largely invisible in a caption; expect lower confidence and do not mix these with an image pass.\n'
  : 'Caption + image. Image URLs are fetched fresh per batch — Instagram CDN links expire.\n');

await requireSchema();

let query = supabase
  .from('social_posts')
  .select('id, post_id, caption, media_type, permalink, published_at, venue_id, venues(name, slug)')
  .is('category', null)
  .eq('content_type', 'post')
  .order('published_at', { ascending: false })
  .limit(limit);

if (onlySlug) {
  const { data: venue } = await supabase.from('venues').select('id').eq('slug', onlySlug).maybeSingle();
  if (!venue) {
    console.error(`No venue with slug "${onlySlug}".`);
    process.exit(1);
  }
  query = query.eq('venue_id', venue.id);
}

const { data: posts, error } = await query;

if (error) {
  console.error(`Could not read social_posts: ${error.message}`);
  process.exit(1);
}

if (!posts || posts.length === 0) {
  console.log('Nothing to classify — every post already has a category.');
  process.exit(0);
}

console.log(`${posts.length} unclassified post(s).\n`);

if (dryRun) {
  console.log('=== DRY RUN — no API calls, no writes ===');
  const byVenue = new Map<string, number>();
  for (const p of posts as any[]) {
    const name = p.venues?.name ?? p.venue_id;
    byVenue.set(name, (byVenue.get(name) ?? 0) + 1);
  }
  for (const [venue, count] of byVenue) console.log(`  ${venue}: ${count}`);
  process.exit(0);
}

const SYSTEM = classifierPrompt();
const TOOL = classificationTool();

let classified = 0;
let skipped = 0;
const problems: string[] = [];
const categoryCounts = new Map<string, number>();

for (let i = 0; i < posts.length; i += batchSize) {
  const batch = (posts as any[]).slice(i, i + batchSize);

  // Fresh CDN urls for the whole batch in one go. Never stored: the links are
  // signed and die within days.
  let thumbnails: Record<string, string> = {};
  if (!captionOnly) {
    try {
      thumbnails = await fetchMediaThumbnails(batch.map(p => p.post_id));
    } catch (e: any) {
      // A batch with no images is still classifiable from captions, just less
      // well. Reported rather than silently downgraded.
      problems.push(`thumbnails unavailable for a batch of ${batch.length}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  for (const post of batch) {
    const imageUrl = thumbnails[post.post_id];
    const usedImage = Boolean(imageUrl);

    const content: any[] = [];
    if (usedImage) {
      content.push({ type: 'image', source: { type: 'url', url: imageUrl } });
    }
    content.push({
      type: 'text',
      text: [
        `Venue: ${post.venues?.name ?? 'unknown'}`,
        `Media type: ${post.media_type ?? 'unknown'}`,
        `Caption: ${post.caption ? String(post.caption).slice(0, 1500) : '(no caption)'}`,
        usedImage ? '' : 'NO IMAGE AVAILABLE — judge from the caption alone and lower your confidence accordingly.',
      ].filter(Boolean).join('\n'),
    });

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [TOOL as any],
        // Forced, so the schema is enforced by the API rather than by hoping
        // the model returns clean JSON.
        tool_choice: { type: 'tool', name: 'classify_post' },
        messages: [{ role: 'user', content }],
      });

      const call = response.content.find(b => b.type === 'tool_use') as any;
      const parsed = parseClassification(call?.input);

      if (!parsed.ok) {
        skipped++;
        problems.push(`${post.permalink ?? post.post_id}: ${parsed.reason}`);
        continue;
      }

      const { error: writeError } = await supabase
        .from('social_posts')
        .update({
          ...parsed.value,
          classified_at: new Date().toISOString(),
          classifier_model: MODEL,
          classified_from: usedImage ? 'caption+image' : 'caption',
        })
        .eq('id', post.id);

      if (writeError) {
        skipped++;
        problems.push(`${post.permalink ?? post.post_id}: write failed — ${writeError.message}`);
        continue;
      }

      classified++;
      categoryCounts.set(parsed.value.category, (categoryCounts.get(parsed.value.category) ?? 0) + 1);
    } catch (e: any) {
      skipped++;
      problems.push(`${post.permalink ?? post.post_id}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  console.log(`  ${Math.min(i + batchSize, posts.length)}/${posts.length} — ${classified} classified, ${skipped} skipped`);
}

console.log(`\n${classified} post(s) classified, ${skipped} skipped.`);

if (categoryCounts.size > 0) {
  console.log('\nDistribution:');
  for (const [category, count] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category}: ${count}`);
  }
}

/**
 * Said out loud. A skipped post is a post that will silently never appear in
 * any category analysis, and a run that skipped two hundred of them looks
 * identical to one that skipped none.
 */
if (problems.length > 0) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems.slice(0, 25)) console.log(`  - ${p}`);
  if (problems.length > 25) console.log(`  ... and ${problems.length - 25} more`);
}

// Skipping everything is a failure however politely it was reported.
process.exit(classified === 0 && posts.length > 0 ? 1 : 0);
