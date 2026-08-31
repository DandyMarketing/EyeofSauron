import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { probeMediaFields, probeCommentsAccess } from '../ingest/meta.js';
import { requireSchema, SOCIAL_SCHEMA } from '../lib/schema-check.js';

/**
 * What Meta will actually give us about a post, before we design around it.
 *
 * Three questions, none of which should be answered by reading documentation
 * and hoping:
 *
 * 1. Can we re-request `media_url`? The classifier needs to see the picture,
 *    and stored URLs expire -- so the whole image-classification plan rests on
 *    Graph reissuing them on demand.
 * 2. Is there ANY audio metadata on a reel? Trends live in audio. If Graph
 *    exposes none, trend detection is caption-guessing and should be sold as
 *    such rather than as a feature.
 * 3. May this token read comments? That decides whether "why did people argue
 *    about the gyoza" is answerable at all.
 *
 * Cheap: about forty calls, paced. Writes nothing.
 */

const paceMs = Number(process.argv.find(a => a.startsWith('--pace='))?.split('=')[1] ?? 300);

console.log('Probing what Meta exposes per media item. Read-only, nothing is stored.\n');

await requireSchema(SOCIAL_SCHEMA);

/**
 * Candidate fields.
 *
 * Documented ones first so a total failure is obvious (if `id` is rejected the
 * problem is the token, not the field), then the speculative audio names. Graph
 * rejects an unknown field by name, so asking is how we find out -- there is no
 * endpoint that lists them.
 */
const CANDIDATE_FIELDS = [
  // Known-good, as a control.
  'id', 'caption', 'media_type', 'media_product_type', 'permalink', 'timestamp',
  'like_count', 'comments_count', 'is_comment_enabled',
  // The one the classifier depends on.
  'media_url', 'thumbnail_url', 'children',
  // Speculative: anything that might carry audio or trend signal.
  'music_metadata', 'audio_name', 'original_sound', 'media_metadata',
  'alt_text', 'collaborators', 'shortcode', 'owner', 'username',
];

// One reel and one still, because the answer may differ by type -- and it is
// the reel we actually care about for audio.
const { data: reel } = await supabase
  .from('social_posts')
  .select('post_id, media_type, permalink, business_date')
  .eq('content_type', 'post')
  .in('media_type', ['VIDEO', 'REELS'])
  .order('published_at', { ascending: false })
  .limit(1)
  .maybeSingle();

const { data: image } = await supabase
  .from('social_posts')
  .select('post_id, media_type, permalink, business_date')
  .eq('content_type', 'post')
  .eq('media_type', 'IMAGE')
  .order('published_at', { ascending: false })
  .limit(1)
  .maybeSingle();

if (!reel && !image) {
  console.error('No posts in the warehouse to probe. Run the post backfill first.');
  process.exit(1);
}

for (const subject of [reel, image]) {
  if (!subject) continue;

  console.log(`\n=== ${subject.media_type} — ${subject.business_date} ===`);
  console.log(`    ${subject.permalink ?? '(no permalink)'}\n`);

  const { available, rejected } = await probeMediaFields(subject.post_id, CANDIDATE_FIELDS, paceMs);

  console.log(`  AVAILABLE (${Object.keys(available).length}):`);
  for (const [field, sample] of Object.entries(available)) {
    console.log(`    ${field.padEnd(22)} ${sample}`);
  }

  console.log(`\n  REJECTED (${Object.keys(rejected).length}):`);
  for (const [field, reason] of Object.entries(rejected)) {
    console.log(`    ${field.padEnd(22)} ${reason.slice(0, 110)}`);
  }

  // Comments: shape and counts only. A probe that prints what people wrote puts
  // personal data in a deploy log, which is somewhere it can never be deleted
  // from and was never meant to reach.
  const comments = await probeCommentsAccess(subject.post_id);
  console.log('\n  COMMENTS:');
  if (comments.allowed) {
    console.log(`    readable — ${comments.count} returned, fields: ${comments.fields_present?.join(', ')}`);
  } else {
    console.log(`    NOT readable — ${comments.reason?.slice(0, 200)}`);
  }
}

console.log(`
WHAT TO DO WITH THIS

  media_url available     -> image classification is on. If it is rejected or
                             empty, the classifier reads captions only and will
                             be materially worse.
  any audio field         -> trend detection has a real signal. If none appear,
                             say plainly that trend is caption-guessing.
  comments readable       -> "why did they argue" becomes answerable. Store text
                             and sentiment ONLY, never usernames: we need to
                             know that people said the gyoza looked like siu
                             mai, never who said it.
`);

process.exit(0);
