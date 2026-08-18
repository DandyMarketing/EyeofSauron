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
