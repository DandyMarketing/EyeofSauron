/**
 * Grouping posts by what they ARE, to answer "what kind of post works".
 *
 * Pure functions over rows already fetched, so the awkward parts -- which
 * posts to exclude, when a group is too small to mean anything -- are testable
 * without a database.
 *
 * The whole point is to make a weak finding LOOK weak. Thirty posts a month
 * against ten hashtags is three posts a group, and three posts will happily
 * produce a 40% difference out of nothing at all. Every group therefore carries
 * its sample size, and the caller is told plainly when a comparison is too thin
 * to lean on.
 */


/**
 * A flag's bucket, or nothing at all.
 *
 * Null means the post was never judged -- a different thing from judged-absent,
 * and the distinction the collaborator_count fix had to learn the hard way.
 */
function flagBucket(value: boolean | null | undefined, whenTrue: string, whenFalse: string): string[] {
  if (value === null || value === undefined) return [];
  return [value ? whenTrue : whenFalse];
}

export type Dimension =
  | 'hashtag' | 'mention' | 'media_type' | 'media_product_type' | 'weekday'
  | 'time_of_day' | 'caption_length' | 'has_question' | 'is_collab'
  /**
   * What the post is ABOUT, not what it is. Layer 1 answers "reels beat
   * images" and cannot answer what to post next; this is the axis marketing
   * actually plans on.
   */
  | 'category'
  /** Flags cut ACROSS category — a trend-format reel of a cocktail is both. */
  | 'shows_people' | 'has_call_to_action' | 'is_repost' | 'is_trend';

export interface PostLike {
  business_date: string;
  media_type: string | null;
  /** Null means NOT YET CLASSIFIED — never a group of its own. */
  category?: string | null;
  shows_people?: boolean | null;
  has_call_to_action?: boolean | null;
  is_repost?: boolean | null;
  is_trend?: boolean | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  caption_length: number | null;
  has_question: boolean | null;
  posted_hour: number | null;
  metrics: Record<string, number> | null;
  media_product_type?: string | null;
  collaborator_count?: number | null;
}

export interface PatternGroup {
  group: string;
  posts: number;
  median: number;
  mean: number;
  best: number;
  worst: number;
  /** True when this group is too small to draw a conclusion from on its own. */
  thin: boolean;
}

export interface PatternResult {
  dimension: Dimension;
  metric: string;
  posts_considered: number;
  posts_excluded_missing_metric: number;
  posts_excluded_no_feature: number;
  /**
   * True when one post can land in several groups at once -- hashtags and
   * mentions. Group sizes then sum to more than the post count, and no group is
   * a share of the whole.
   */
  overlapping_groups: boolean;
  groups: PatternGroup[];
  caveats: string[];
}

/**
 * Below this, a group is reported but marked thin.
 *
 * Five is not a statistical threshold and is not offered as one -- it is the
 * point below which a single unusually good post moves the median. The number
 * exists so that "we should post more carousels" cannot be said off the back of
 * two carousels without the thinness being visible in the same breath.
 */
export const MIN_MEANINGFUL_SAMPLE = 5;

/** Sunday-first, matching Postgres and the weekday charts already built. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Time bands chosen for a restaurant rather than for a marketing calendar.
 *
 * They line up with service, because the question behind "when should we post"
 * is usually "how long before service should we post". Bands are inclusive of
 * the start hour and exclusive of the next.
 */
const TIME_BANDS: Array<{ label: string; from: number; to: number }> = [
  { label: 'overnight (00-05)', from: 0, to: 6 },
  { label: 'morning (06-10)', from: 6, to: 11 },
  { label: 'lunch (11-14)', from: 11, to: 15 },
  { label: 'afternoon (15-17)', from: 15, to: 18 },
  { label: 'dinner (18-21)', from: 18, to: 22 },
  { label: 'late (22-23)', from: 22, to: 24 },
];

function timeBand(hour: number): string {
  return TIME_BANDS.find(b => hour >= b.from && hour < b.to)?.label ?? 'unknown';
}

/**
 * Caption length bands.
 *
 * Instagram truncates at roughly 125 characters behind a "more" link, which is
 * the only boundary here with a mechanism behind it. The others are round
 * numbers and are labelled as bands rather than thresholds so nobody reads
 * precision into them.
 */
function captionBand(length: number): string {
  if (length === 0) return 'no caption';
  if (length < 125) return 'short (under 125, no "more" link)';
  if (length < 400) return 'medium (125-399)';
  return 'long (400+)';
}

/** Which groups one post belongs to. Several, for hashtags and mentions. */
function groupsFor(post: PostLike, dimension: Dimension): string[] {
  switch (dimension) {
    case 'hashtag':
      return post.hashtags ?? [];
    case 'mention':
      return post.mentions ?? [];
    case 'media_type':
      return post.media_type ? [post.media_type] : [];
    // The right column for "do reels work". media_type says VIDEO for both a
    // feed video and a reel, and the two are distributed nothing alike.
    case 'media_product_type':
      return post.media_product_type ? [post.media_product_type] : [];
    // Null is NOT "solo" -- it means the post predates capturing this, and
    // calling it solo is how a collab breakout gets credited to its content.
    case 'is_collab':
      return post.collaborator_count === null || post.collaborator_count === undefined
        ? []
        : [post.collaborator_count > 0 ? 'published with a collaborator' : 'solo'];
    /**
     * Null is NOT a category. An unclassified post has not been judged, and
     * grouping it as "unknown" would put the classifier's backlog on the same
     * footing as a real subject and drag every average toward it.
     */
    case 'category':
      return post.category ? [post.category] : [];
    // Same rule for every flag: null means never judged, false means judged
    // absent. Collapsing them would make a flag a majority-false column that
    // means nothing.
    case 'shows_people':
      return flagBucket(post.shows_people, 'shows people', 'no people');
    case 'has_call_to_action':
      return flagBucket(post.has_call_to_action, 'asks for something', 'no ask');
    case 'is_repost':
      return flagBucket(post.is_repost, 'reposted', 'made by the venue');
    case 'is_trend':
      return flagBucket(post.is_trend, 'trend format', 'straight post');
    case 'weekday': {
      const d = new Date(`${post.business_date}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? [] : [WEEKDAYS[d.getUTCDay()]];
    }
    case 'time_of_day':
      return post.posted_hour === null ? [] : [timeBand(post.posted_hour)];
    case 'caption_length':
      return post.caption_length === null ? [] : [captionBand(post.caption_length)];
    case 'has_question':
      return post.has_question === null ? [] : [post.has_question ? 'asks a question' : 'no question'];
  }
}

const OVERLAPPING: Dimension[] = ['hashtag', 'mention'];

/**
 * What a raw ratio needs before it can be ranked on.
 *
 * The first version of `contention` was comments divided by likes and nothing
 * else, and the top of the list came back as posts with THREE likes and one
 * comment, scoring 0.333 and beating everything real. A ratio with a tiny
 * denominator is not a small signal, it is noise wearing a number.
 *
 * `baseline` is the account's own comments-per-like across the posts in scope;
 * `k` is how much evidence a post needs before it is judged on its own record
 * rather than on the account's. Set to the median like count, so a typical post
 * is judged half on itself and half on the baseline, a 3-like post is pulled
 * almost entirely to the baseline, and an 800-like post barely moves.
 *
 * This is the same thin-sample rule already applied to GROUPS, finally applied
 * to individual posts -- which is where it was needed first and was missing.
 */
export interface RatioContext {
  baseline: number;
  k: number;
  /** The venue's median post reach, for judging a breakout against its own normal. */
  medianReach: number;
}

function shrinkRatio(numerator: number, denominator: number, ctx: RatioContext): number {
  return (numerator + ctx.k * ctx.baseline) / (denominator + ctx.k);
}

/** The account's own rate and how much evidence to demand, from the posts in scope. */
export function ratioContextFrom(posts: PostLike[]): RatioContext {
  let comments = 0;
  let likes = 0;
  const likeCounts: number[] = [];

  for (const p of posts) {
    const c = p.metrics?.comments;
    const l = p.metrics?.likes;
    if (typeof c === 'number' && typeof l === 'number' && l > 0) {
      comments += c;
      likes += l;
      likeCounts.push(l);
    }
  }

  const reaches = posts
    .map(p => p.metrics?.reach)
    .filter((r): r is number => typeof r === 'number' && r > 0);

  const med = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  // Median, never mean. One post at 141,241 against a normal of 800 would drag
  // a mean to several thousand and make every ordinary post look like a
  // failure -- which is the same distortion that made ranking by mean wrong.
  const medianReach = med(reaches);

  if (likeCounts.length === 0) return { baseline: 0, k: 1, medianReach };

  return {
    baseline: likes > 0 ? comments / likes : 0,
    // At least 1, or a set of near-zero-like posts would divide by nothing and
    // reintroduce the exact instability this exists to remove.
    k: Math.max(med(likeCounts), 1),
    medianReach,
  };
}

/**
 * The value being compared, for one post.
 *
 * `engagement_rate` is interactions over reach rather than over followers, and
 * that is a deliberate choice with a real limitation. Over followers would need
 * the follower count AS AT the post's date, and Meta serves no history for the
 * follower total -- so for anything before we started capturing it, there is no
 * honest denominator. Reach is available on every post and needs no
 * reconstruction. What it does NOT control for is that reach itself grows with
 * the account, so it measures how hard the people who saw it responded, not how
 * many people it deserved to reach.
 */
function valueOf(post: PostLike, metric: string, ctx: RatioContext): number | null {
  const m = post.metrics ?? {};

  /**
   * Comments per like. A proxy for how CONTESTED a post was.
   *
   * Praise costs a tap; disagreement costs typing. So a post people argued
   * about carries far more comments per like than a popular one, and the two
   * are otherwise indistinguishable from reach alone.
   *
   * Khai's examples: a Neon Pigeon duck gyoza post that people said looked like
   * siew mai, and a Firangi chutney post that people said was made wrong. Both
   * went far. Ranking those on reach would conclude "do more of this", which is
   * a confident, well-evidenced recommendation to pick fights with your own
   * customers. This exists so the difference can be stated instead.
   *
   * It is a proxy and not a sentiment reading: a genuinely great post can also
   * draw discussion. High contention means "go and look", never "this was bad".
   */
  /**
   * How far a post travelled beyond this venue's normal, as a multiple.
   *
   * THE MEASURE THAT ACTUALLY FINDS A BREAKOUT. Neon Pigeon's foie gras duck
   * gyoza reel reached 141,241 against a median of about 800 -- roughly 150
   * times normal. It was found by looking for it, not by any measure we had:
   * `contention` ranked it near the BOTTOM, because 65 comments against 5,330
   * likes is far below the account's own rate. A post can escape the follower
   * base entirely and be perfectly uncontroversial while doing it.
   *
   * Against the venue's own median rather than an absolute threshold, because
   * 2,000 reach is a triumph for one account and a bad night for another.
   */
  if (metric === 'reach_multiple') {
    const reach = m.reach;
    if (typeof reach !== 'number' || ctx.medianReach <= 0) return null;
    return reach / ctx.medianReach;
  }

  if (metric === 'contention') {
    const comments = m.comments;
    const likes = m.likes;
    if (typeof comments !== 'number' || typeof likes !== 'number' || likes === 0) return null;
    return shrinkRatio(comments, likes, ctx);
  }

  if (metric === 'engagement_rate') {
    const interactions = m.total_interactions;
    const reach = m.reach;
    if (typeof interactions !== 'number' || typeof reach !== 'number' || reach === 0) return null;
    return interactions / reach;
  }
  return typeof m[metric] === 'number' ? m[metric] : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Group posts by a feature and describe how each group performed.
 *
 * Sorted by MEDIAN, not by mean. One post going unusually well drags a mean
 * upwards and would put a group of three at the top of the list on the strength
 * of a single fluke -- which is exactly the wrong answer to "what should we do
 * more of". The mean is still returned, because a big gap between the two is
 * itself worth seeing: it says the group's success rests on one post.
 */
export function groupPosts(
  posts: PostLike[],
  dimension: Dimension,
  metric: string,
  limit = 15,
): PatternResult {
  const ctx = ratioContextFrom(posts);
  const buckets = new Map<string, number[]>();
  let missingMetric = 0;
  let missingFeature = 0;
  let considered = 0;

  for (const post of posts) {
    const value = valueOf(post, metric, ctx);

    // A metric Meta does not report for that media type is ABSENT, not zero.
    // Counting it as zero would make images look terrible at video metrics --
    // a fact about Meta's reporting dressed up as a fact about the content.
    if (value === null) {
      missingMetric++;
      continue;
    }

    const groups = groupsFor(post, dimension);
    if (groups.length === 0) {
      missingFeature++;
      continue;
    }

    considered++;
    for (const g of groups) {
      const existing = buckets.get(g);
      if (existing) existing.push(value);
      else buckets.set(g, [value]);
    }
  }

  const groups: PatternGroup[] = [...buckets.entries()]
    .map(([group, values]) => ({
      group,
      posts: values.length,
      median: median(values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      best: Math.max(...values),
      worst: Math.min(...values),
      thin: values.length < MIN_MEANINGFUL_SAMPLE,
    }))
    .sort((a, b) => b.median - a.median)
    .slice(0, limit);

  const caveats: string[] = [];

  if (considered === 0) {
    caveats.push(
      'No post carried both this feature and this metric. This is missing data, not a finding — do not describe it as poor performance.',
    );
  }

  if (missingFeature > 0) {
    caveats.push(
      `${missingFeature} post(s) had no value for this feature and were left out. If that number is large, features may not have been computed for this period yet.`,
    );
  }

  if (missingMetric > 0) {
    caveats.push(
      `${missingMetric} post(s) did not carry ${metric} and were EXCLUDED, not counted as zero. Meta does not report every metric for every media type.`,
    );
  }

  if (groups.length > 0 && groups.every(g => g.thin)) {
    caveats.push(
      `Every group has fewer than ${MIN_MEANINGFUL_SAMPLE} posts. This is too thin to support a recommendation — report it as a hint worth watching, not as a finding.`,
    );
  } else if (groups.some(g => g.thin)) {
    caveats.push(
      `Groups marked thin have fewer than ${MIN_MEANINGFUL_SAMPLE} posts and can swing wildly on one post. Do not rank them against the larger groups as though the comparison were equal.`,
    );
  }

  if (dimension === 'is_collab') {
    caveats.push(
      'A collab post appears on BOTH accounts and reaches the collaborator\'s audience too, so its reach is not comparable to a solo post\'s. If collabs lead here, the finding is about distribution rather than about content — say so, and do not report it as "this kind of content works".',
    );
  }

  if (dimension === 'media_product_type') {
    caveats.push(
      'REELS and FEED are distribution surfaces, not content types. Reels are pushed to non-followers and feed posts largely are not, so a gap between them says more about how Instagram distributes than about what the venue made.',
    );
  }

  if (OVERLAPPING.includes(dimension)) {
    caveats.push(
      'One post can appear in several groups here, so group sizes add up to more than the post count and no group is a share of the whole.',
    );
  }

  if (metric === 'reach_multiple') {
    caveats.push(
      'reach_multiple is a post\'s reach divided by this venue\'s MEDIAN post reach, so 1.0 is a normal post and 150 means it escaped the follower base entirely. Distribution on Instagram is extremely skewed: a handful of posts do the overwhelming majority of the reach, so never average this and never quote a mean. A breakout is also mostly a fact about the algorithm rather than about the venue — say what the post was, not that the venue can repeat it on demand.',
    );
  }

  if (metric === 'contention') {
    caveats.push(
      'contention is comments per like, shrunk toward the account\'s own average so a post with three likes cannot top the list. It measures how much a post was DISCUSSED, and discussion has several causes: a giveaway asking people to tag a friend, a question in the caption, or genuine disagreement. It does NOT distinguish between them — that needs the comment text. So never call a high figure controversy without reading the comments, and never recommend repeating a high-reach post without checking it: if a post travelled because people disagreed with it, saying "do more of this" is telling the venue to pick fights with its own customers.',
    );
  }

  if (metric === 'engagement_rate') {
    caveats.push(
      'engagement_rate is interactions divided by REACH, not by followers — it measures how hard the people who saw a post responded, not how many it deserved to reach. It flatters posts with small but responsive audiences.',
    );
  }

  return {
    dimension,
    metric,
    posts_considered: considered,
    posts_excluded_missing_metric: missingMetric,
    posts_excluded_no_feature: missingFeature,
    overlapping_groups: OVERLAPPING.includes(dimension),
    groups,
    caveats,
  };
}
