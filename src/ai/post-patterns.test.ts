import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupPosts, MIN_MEANINGFUL_SAMPLE, type PostLike } from './post-patterns.js';

const post = (over: Partial<PostLike> = {}): PostLike => ({
  business_date: '2026-08-15',
  media_type: 'IMAGE',
  hashtags: [],
  mentions: [],
  caption_length: 100,
  has_question: false,
  posted_hour: 19,
  metrics: { reach: 1000, total_interactions: 100 },
  ...over,
});

describe('groupPosts — grouping by what a post is', () => {
  test('groups by media type and reports the sample size', () => {
    const result = groupPosts([
      post({ media_type: 'REELS', metrics: { reach: 3000 } }),
      post({ media_type: 'REELS', metrics: { reach: 1000 } }),
      post({ media_type: 'IMAGE', metrics: { reach: 500 } }),
    ], 'media_type', 'reach');

    const reels = result.groups.find(g => g.group === 'REELS')!;
    assert.equal(reels.posts, 2);
    assert.equal(reels.median, 2000);
    assert.equal(result.posts_considered, 3);
  });

  test('ranks by median, not mean, so one fluke cannot win', () => {
    // A group of three where one post went viral has a huge mean and an
    // ordinary median. Ranking on the mean would answer "what should we do more
    // of" with "whatever got lucky once".
    const result = groupPosts([
      post({ media_type: 'REELS', metrics: { reach: 100 } }),
      post({ media_type: 'REELS', metrics: { reach: 100 } }),
      post({ media_type: 'REELS', metrics: { reach: 100_000 } }),
      post({ media_type: 'IMAGE', metrics: { reach: 900 } }),
      post({ media_type: 'IMAGE', metrics: { reach: 1100 } }),
    ], 'media_type', 'reach');

    assert.equal(result.groups[0].group, 'IMAGE');
    const reels = result.groups.find(g => g.group === 'REELS')!;
    assert.equal(reels.median, 100);
    assert.ok(reels.mean > 30_000);  // the gap is the tell, and it is returned
  });

  test('a post missing the metric is EXCLUDED, never counted as zero', () => {
    // Meta reports no views for a still image. Zero would say the image got no
    // views, which is a claim about the content rather than about the API.
    const result = groupPosts([
      post({ media_type: 'REELS', metrics: { views: 500 } }),
      post({ media_type: 'IMAGE', metrics: { reach: 900 } }),
    ], 'media_type', 'views');

    assert.equal(result.posts_considered, 1);
    assert.equal(result.posts_excluded_missing_metric, 1);
    assert.equal(result.groups.length, 1);
    assert.ok(result.caveats.some(c => c.includes('EXCLUDED, not counted as zero')));
  });

  test('a post can be in several hashtag groups at once, and that is flagged', () => {
    const result = groupPosts([
      post({ hashtags: ['sgfood', 'cocktails'], metrics: { reach: 1000 } }),
    ], 'hashtag', 'reach');

    assert.equal(result.groups.length, 2);
    assert.equal(result.posts_considered, 1);
    assert.equal(result.overlapping_groups, true);
    assert.ok(result.caveats.some(c => c.includes('more than the post count')));
  });

  test('media type does NOT overlap', () => {
    const result = groupPosts([post()], 'media_type', 'reach');
    assert.equal(result.overlapping_groups, false);
  });
});

/**
 * The findings this produces are weak by nature -- thirty posts a month split
 * ten ways is three posts a group, and three posts will produce a 40% gap out
 * of pure noise. Making that visible is the job.
 */
describe('groupPosts — refusing to make a thin sample look solid', () => {
  test('a small group is marked thin', () => {
    const result = groupPosts([
      post({ media_type: 'REELS', metrics: { reach: 100 } }),
      post({ media_type: 'REELS', metrics: { reach: 200 } }),
    ], 'media_type', 'reach');

    assert.equal(result.groups[0].thin, true);
  });

  test('a group at the threshold is not thin', () => {
    const posts = Array.from({ length: MIN_MEANINGFUL_SAMPLE }, () =>
      post({ media_type: 'REELS', metrics: { reach: 100 } }));
    const result = groupPosts(posts, 'media_type', 'reach');
    assert.equal(result.groups[0].thin, false);
  });

  test('when every group is thin, the caveat says not to recommend on it', () => {
    const result = groupPosts([
      post({ media_type: 'REELS', metrics: { reach: 100 } }),
      post({ media_type: 'IMAGE', metrics: { reach: 200 } }),
    ], 'media_type', 'reach');

    assert.ok(result.caveats.some(c => c.includes('too thin to support a recommendation')));
  });

  test('no matching data says so as missing, not as poor performance', () => {
    // The difference matters: "nothing was posted with that tag" and "posts
    // with that tag did badly" lead to opposite decisions.
    const result = groupPosts([], 'hashtag', 'reach');
    assert.equal(result.posts_considered, 0);
    assert.ok(result.caveats.some(c => c.includes('missing data, not a finding')));
  });

  test('posts with no features computed yet are reported separately', () => {
    // A whole period showing nothing because the recompute has not run must not
    // read as a venue that used no hashtags.
    const result = groupPosts([
      post({ hashtags: null, metrics: { reach: 500 } }),
      post({ hashtags: ['sgfood'], metrics: { reach: 900 } }),
    ], 'hashtag', 'reach');

    assert.equal(result.posts_excluded_no_feature, 1);
    assert.ok(result.caveats.some(c => c.includes('features may not have been computed')));
  });
});

describe('groupPosts — derived dimensions', () => {
  test('weekday comes from the trading date, not the publish clock', () => {
    // 2026-08-15 is a Saturday. A 2am post on the 16th carries business_date
    // 2026-08-15 and must group as Saturday, matching how sales are dated.
    const result = groupPosts([
      post({ business_date: '2026-08-15', posted_hour: 2, metrics: { reach: 100 } }),
    ], 'weekday', 'reach');
    assert.equal(result.groups[0].group, 'Saturday');
  });

  test('time of day uses the real posting hour, not the trading date', () => {
    // The same post: filed against Saturday's trade, and genuinely posted
    // overnight. Both are true and only this one answers "when should we post".
    const result = groupPosts([
      post({ business_date: '2026-08-15', posted_hour: 2, metrics: { reach: 100 } }),
    ], 'time_of_day', 'reach');
    assert.equal(result.groups[0].group, 'overnight (00-05)');
  });

  test('caption length bands separate captions cut off by the "more" link', () => {
    const result = groupPosts([
      post({ caption_length: 40, metrics: { reach: 100 } }),
      post({ caption_length: 900, metrics: { reach: 200 } }),
    ], 'caption_length', 'reach');

    const labels = result.groups.map(g => g.group).sort();
    assert.deepEqual(labels, ['long (400+)', 'short (under 125, no "more" link)']);
  });
});

describe('engagement_rate', () => {
  test('is interactions over reach, and says so', () => {
    const result = groupPosts([
      post({ media_type: 'IMAGE', metrics: { reach: 1000, total_interactions: 50 } }),
    ], 'media_type', 'engagement_rate');

    assert.equal(result.groups[0].median, 0.05);
    assert.ok(result.caveats.some(c => c.includes('divided by REACH, not by followers')));
  });

  test('a post with no reach is excluded rather than dividing by zero', () => {
    const result = groupPosts([
      post({ metrics: { reach: 0, total_interactions: 5 } }),
    ], 'media_type', 'engagement_rate');

    assert.equal(result.posts_considered, 0);
    assert.equal(result.posts_excluded_missing_metric, 1);
  });
});

/**
 * Khai's observation, from two real posts: a Neon Pigeon duck gyoza people said
 * looked like siew mai, and a Firangi chutney people said was made wrong. Both
 * travelled a long way. On reach alone they look like triumphs, and the
 * recommendation that follows is "do more of this" -- which is advice to pick
 * fights with your own customers, delivered with a straight face and real
 * numbers behind it.
 */
describe('contention — telling an argument apart from a hit', () => {
  test('a post discussed far above the account average ranks top', () => {
    const result = groupPosts([
      post({ media_type: 'CAROUSEL_ALBUM', metrics: { likes: 800, comments: 12 } }),
      post({ media_type: 'IMAGE', metrics: { likes: 300, comments: 90 } }),
    ], 'media_type', 'contention');

    assert.equal(result.groups[0].group, 'IMAGE');
    assert.ok(result.groups[0].median > result.groups[1].median);
  });

  test('a three-like post cannot top the list', () => {
    // THE BUG THIS REPLACED. Raw comments/likes made 1 comment on 3 likes score
    // 0.333 and beat every real post -- the first live run returned exactly
    // that, a page of posts with single-digit likes above a giveaway that drew
    // eighteen genuine comments. A ratio on a tiny denominator is not a small
    // signal, it is noise wearing a number.
    const noisy = post({ media_type: 'IMAGE', metrics: { likes: 3, comments: 1 } });
    const real = post({ media_type: 'REELS', metrics: { likes: 44, comments: 18 } });
    const ordinary = Array.from({ length: 20 }, () =>
      post({ media_type: 'CAROUSEL_ALBUM', metrics: { likes: 40, comments: 2 } }));

    const result = groupPosts([noisy, real, ...ordinary], 'media_type', 'contention');
    assert.equal(result.groups[0].group, 'REELS');
    assert.ok(
      result.groups.findIndex(g => g.group === 'REELS') <
      result.groups.findIndex(g => g.group === 'IMAGE'),
      'the 3-like post outranked the genuinely discussed one',
    );
  });

  test('says outright that this is argument, not quality', () => {
    const result = groupPosts([
      post({ metrics: { likes: 100, comments: 50 } }),
    ], 'media_type', 'contention');

    const caveat = result.caveats.find(c => c.includes('DISCUSSED'));
    assert.ok(caveat, 'no caveat explaining what contention measures');
    // Must not claim it proves disagreement: giveaways drive comments too, and
    // the first live run was topped by exactly that -- a "tag a friend" post.
    assert.ok(caveat!.includes('giveaway'));
    assert.ok(caveat!.includes('pick fights'));
  });

  test('a post with no likes is excluded rather than dividing by zero', () => {
    const result = groupPosts([
      post({ metrics: { likes: 0, comments: 5 } }),
    ], 'media_type', 'contention');
    assert.equal(result.posts_considered, 0);
  });
});

/**
 * The measure that works, added after the one that did not.
 *
 * Neon Pigeon's foie gras duck gyoza reel reached 141,241 against a median of
 * about 800. `contention` ranked it near the BOTTOM -- 65 comments on 5,330
 * likes is well below the account's own rate -- so the post it was built to
 * find was the post it was worst at finding. A post can escape the follower
 * base completely while being entirely uncontroversial.
 */
describe('reach_multiple — finding a post that escaped the follower base', () => {
  const ordinary = () => post({ media_type: 'IMAGE', metrics: { reach: 800, likes: 20, comments: 1 } });

  test('a normal post scores about 1', () => {
    const result = groupPosts(Array.from({ length: 9 }, ordinary), 'media_type', 'reach_multiple');
    assert.equal(result.groups[0].median, 1);
  });

  test('the gyoza reel is found, at roughly 150x', () => {
    const viral = post({ media_type: 'REELS', metrics: { reach: 141_241, likes: 5330, comments: 65 } });
    const result = groupPosts([...Array.from({ length: 20 }, ordinary), viral], 'media_type', 'reach_multiple');

    const reels = result.groups.find(g => g.group === 'REELS')!;
    assert.ok(reels.median > 100, `expected a large multiple, got ${reels.median}`);
    assert.equal(result.groups[0].group, 'REELS');
  });

  test('contention would have MISSED that post — the reason this measure exists', () => {
    const viral = post({ media_type: 'REELS', metrics: { reach: 141_241, likes: 5330, comments: 65 } });
    const chatty = post({ media_type: 'IMAGE', metrics: { reach: 1500, likes: 44, comments: 18 } });
    const result = groupPosts([...Array.from({ length: 20 }, ordinary), viral, chatty], 'media_type', 'contention');

    // The chatty post outranks the viral one on contention. That is correct
    // behaviour for contention and exactly why it must not be used to find
    // breakouts.
    assert.equal(result.groups[0].group, 'IMAGE');
  });

  test('warns that reach is skewed and a breakout is not a repeatable choice', () => {
    const result = groupPosts([ordinary()], 'media_type', 'reach_multiple');
    const caveat = result.caveats.find(c => c.includes('skewed'));
    assert.ok(caveat, 'no caveat about skew');
    assert.ok(caveat!.includes('never quote a mean') || caveat!.includes('never average'));
  });
});

// ---------------------------------------------------------------------------
// Layer 2: what a post is ABOUT
// ---------------------------------------------------------------------------

/**
 * Every other dimension describes what a post IS. Only category says what it is
 * about, and that is the axis marketing plans on — "reels beat images" cannot
 * be acted on, "dish out-reaches lifestyle two to one" can.
 */

const classified = (over: any = {}) => ({
  business_date: '2026-08-01',
  media_type: 'IMAGE',
  hashtags: [],
  mentions: [],
  caption_length: 40,
  has_question: false,
  posted_hour: 19,
  metrics: { reach: 1000, total_interactions: 100 },
  ...over,
});

test('posts group by what they are about', () => {
  const result = groupPosts(
    [
      classified({ category: 'dish' }),
      classified({ category: 'dish' }),
      classified({ category: 'lifestyle' }),
    ] as any,
    'category',
    'reach',
  );
  assert.deepEqual(result.groups.map(g => g.group).sort(), ['dish', 'lifestyle']);
  assert.equal(result.groups.find(g => g.group === 'dish')!.posts, 2);
});

test('an UNCLASSIFIED post is excluded, never grouped as unknown', () => {
  // A null category means nobody has judged it. Grouping it would put the
  // classifier's backlog on the same footing as a real subject and drag every
  // average toward it.
  const result = groupPosts(
    [classified({ category: 'dish' }), classified({ category: null })] as any,
    'category',
    'reach',
  );
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].group, 'dish');
  // Counted as excluded rather than vanishing, so a mostly-unclassified period
  // is visible instead of looking like a small sample.
  assert.equal(result.posts_excluded_no_feature, 1);
});

test('a flag splits into two named buckets', () => {
  const result = groupPosts(
    [
      classified({ is_trend: true }),
      classified({ is_trend: false }),
      classified({ is_trend: false }),
    ] as any,
    'is_trend',
    'reach',
  );
  const byGroup = Object.fromEntries(result.groups.map(g => [g.group, g.posts]));
  assert.equal(byGroup['trend format'], 1);
  assert.equal(byGroup['straight post'], 2);
});

test('a flag that was never judged is excluded, not counted as false', () => {
  // "Judged absent" and "never judged" are different. Collapsing them turns a
  // flag into a majority-false column that means nothing — the same mistake
  // collaborator_count made with solo posts.
  const result = groupPosts(
    [classified({ shows_people: true }), classified({ shows_people: null })] as any,
    'shows_people',
    'reach',
  );
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].group, 'shows people');
  assert.equal(result.posts_excluded_no_feature, 1);
});

test('flags cut across category rather than replacing it', () => {
  // A trending-audio reel of a cocktail is a drink post wearing a trend format.
  // Grouping the same posts two ways must give two different, valid answers —
  // which is what makes "do trend formats work" answerable with the subject
  // held constant.
  const posts = [
    classified({ category: 'drink', is_trend: true }),
    classified({ category: 'drink', is_trend: false }),
    classified({ category: 'dish', is_trend: true }),
  ] as any;

  assert.equal(groupPosts(posts, 'category', 'reach').groups.length, 2);
  assert.equal(groupPosts(posts, 'is_trend', 'reach').groups.length, 2);
});

test('a making video and a plated shot are both dish, and separable', () => {
  // Khai spotted this at fifty posts: the team presenting or building a dish is
  // correctly category "dish" by the taxonomy's own rule — the food is the
  // subject — which left a build and a finished plate indistinguishable. As a
  // FLAG the subject is held constant and the format becomes the variable.
  const posts = [
    classified({ category: 'dish', shows_process: true, metrics: { reach: 4000 } }),
    classified({ category: 'dish', shows_process: false, metrics: { reach: 1000 } }),
  ] as any;

  assert.equal(groupPosts(posts, 'category', 'reach').groups.length, 1);

  const byFormat = groupPosts(posts, 'shows_process', 'reach');
  assert.equal(byFormat.groups.length, 2);
  assert.equal(byFormat.groups.find(g => g.group === 'shows it being made')!.median, 4000);
});

test('shows_process is not shows_people — a guest eating shows one and not the other', () => {
  const posts = [classified({ category: 'dish', shows_people: true, shows_process: false })] as any;
  assert.equal(groupPosts(posts, 'shows_people', 'reach').groups[0].group, 'shows people');
  assert.equal(groupPosts(posts, 'shows_process', 'reach').groups[0].group, 'shows the finished thing');
});

test('posts classified before the flag existed are excluded from it', () => {
  // The first fifty were judged against a taxonomy without this flag. Null
  // means never judged, and counting them as false would say every one of them
  // showed a finished plate.
  const result = groupPosts([classified({ shows_process: null })] as any, 'shows_process', 'reach');
  assert.equal(result.groups.length, 0);
  assert.equal(result.posts_excluded_no_feature, 1);
});
