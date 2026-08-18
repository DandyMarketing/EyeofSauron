import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  businessDateOf, metricsFrom, toPostRow, metricsForMediaType,
  selectForInsights, pageReachesBack,
} from './posts.js';

/**
 * The whole point of storing posts in this warehouse is putting them beside
 * covers and revenue. That only works if a post lands on the night it came
 * out of -- which for a restaurant is not the same as the calendar day.
 */
describe('businessDateOf — a trading day, not a calendar day', () => {
  test('a post during dinner belongs to that day', () => {
    // 8pm Singapore on the 16th.
    assert.equal(businessDateOf('2026-08-16T12:00:00Z'), '2026-08-16');
  });

  test('a post at 2am belongs to the night before', () => {
    // 2am Singapore on the 17th — that is Saturday night's service, and the
    // night whose covers it should sit beside. Filing it on the 17th would put
    // the busiest posts of the week against the quietest trading day and make
    // the correlation read backwards.
    assert.equal(businessDateOf('2026-08-16T18:00:00Z'), '2026-08-16');
  });

  test('a post at 4am belongs to the new day', () => {
    // Past the 3am boundary: 4am Singapore on the 17th.
    assert.equal(businessDateOf('2026-08-16T20:00:00Z'), '2026-08-17');
  });

  test('3am exactly starts the new day', () => {
    assert.equal(businessDateOf('2026-08-16T18:59:59Z'), '2026-08-16');
    assert.equal(businessDateOf('2026-08-16T19:00:00Z'), '2026-08-17');
  });

  test('refuses a timestamp it cannot read', () => {
    // Guessing a date here silently files a post against the wrong night.
    assert.throws(() => businessDateOf('last tuesday'), /unreadable timestamp/);
  });
});

describe('metricsFrom — both shapes Meta returns', () => {
  test('reads the plain series shape', () => {
    assert.deepEqual(
      metricsFrom({ data: [{ name: 'reach', values: [{ value: 1200 }] }] }),
      { reach: 1200 },
    );
  });

  test('reads the total_value shape', () => {
    assert.deepEqual(
      metricsFrom({ data: [{ name: 'likes', total_value: { value: 84 } }] }),
      { likes: 84 },
    );
  });

  test('a metric Meta did not report is ABSENT, not zero', () => {
    // Zero would claim the post got no saves. Absent says Meta does not report
    // saves for that media type, which is a different statement entirely.
    const out = metricsFrom({ data: [{ name: 'reach', values: [{ value: 5 }] }, { name: 'saved' }] });
    assert.deepEqual(out, { reach: 5 });
    assert.ok(!('saved' in out));
  });

  test('an empty or malformed response is empty, not a crash', () => {
    assert.deepEqual(metricsFrom({}), {});
    assert.deepEqual(metricsFrom({ data: [null, {}] }), {});
    assert.deepEqual(metricsFrom(undefined), {});
  });
});

describe('toPostRow', () => {
  const media = {
    id: '17900000000000000',
    timestamp: '2026-08-16T12:30:00+0000',
    media_type: 'IMAGE',
    permalink: 'https://www.instagram.com/p/ABC123/',
    caption: 'New menu drops tonight',
  };

  test('keeps the raw timestamp and derives the trading day from it', () => {
    const row = toPostRow(media, { reach: 900 })!;
    assert.equal(row.published_at, '2026-08-16T12:30:00.000Z');
    assert.equal(row.business_date, '2026-08-16');
    assert.equal(row.metrics.reach, 900);
    assert.equal(row.permalink, media.permalink);
  });

  test('a post with no id or no timestamp is dropped', () => {
    // Neither can be stored nor joined to anything.
    assert.equal(toPostRow({ timestamp: media.timestamp }), null);
    assert.equal(toPostRow({ id: '1' }), null);
    assert.equal(toPostRow(null), null);
  });

  test('an unreadable timestamp drops the post rather than guessing a date', () => {
    assert.equal(toPostRow({ id: '1', timestamp: 'whenever' }), null);
  });

  test('a very long caption is trimmed, not dropped', () => {
    // People paste whole menus. Enough to recognise the post, not enough to
    // bloat every query that returns it.
    const row = toPostRow({ ...media, caption: 'x'.repeat(5000) })!;
    assert.equal(row.caption!.length, 2000);
  });

  test('missing optional fields become null, not undefined', () => {
    const row = toPostRow({ id: '1', timestamp: media.timestamp })!;
    assert.equal(row.caption, null);
    assert.equal(row.permalink, null);
    assert.equal(row.media_type, null);
  });
});

describe('metricsForMediaType', () => {
  test('video gets views, a still image does not', () => {
    // Meta rejects the WHOLE request when one metric does not apply to the
    // media type, so asking an image for views loses its likes too.
    assert.ok(metricsForMediaType('VIDEO').includes('views'));
    assert.ok(!metricsForMediaType('IMAGE').includes('views'));
  });

  test('an unknown type falls back to the metrics every post has', () => {
    assert.deepEqual(metricsForMediaType(null), metricsForMediaType('IMAGE'));
    assert.deepEqual(metricsForMediaType('SOMETHING_NEW'), metricsForMediaType('IMAGE'));
  });
});

/**
 * This decides the entire cost of a post backfill. One listing call covers a
 * hundred posts; insights are one call EACH, and 153 calls in a burst is what
 * got the app blocked for a day. Fetching too much is an outage; fetching too
 * little leaves posts in the warehouse with no numbers on them.
 */
describe('selectForInsights — what still needs a call', () => {
  const old = { id: 'old', timestamp: '2024-01-05T12:00:00+0000' };
  const recent = { id: 'recent', timestamp: '2026-08-17T12:00:00+0000' };
  const cutoff = '2026-08-04T00:00:00.000Z';

  test('a settled post we already hold metrics for is not re-fetched', () => {
    // Its numbers stopped moving long ago. Re-reading it cannot change a thing.
    assert.deepEqual(selectForInsights([old], new Set(['old']), cutoff), []);
  });

  test('a post we have never seen is fetched however old it is', () => {
    assert.deepEqual(selectForInsights([old], new Set(), cutoff), [old]);
  });

  test('one settled post being held does not spare its neighbours', () => {
    // The caller passes only the posts it holds USABLE metrics for, so a row
    // that exists with an empty metrics object -- a failed insights call --
    // arrives here absent from the set and is retried. Keying on "we have a
    // row" instead would make that failure permanent: the row exists, so
    // nothing ever looks at it again.
    const another = { id: 'another', timestamp: '2024-02-05T12:00:00+0000' };
    assert.deepEqual(selectForInsights([old, another], new Set(['old']), cutoff), [another]);
  });

  test('a recent post is re-fetched even though we already have metrics', () => {
    // Engagement accrues for days after publishing, so what we stored on the
    // night is already out of date.
    assert.deepEqual(selectForInsights([recent], new Set(['recent']), cutoff), [recent]);
  });

  test('items with no id or timestamp are dropped rather than fetched', () => {
    // Neither can be stored, so a call spent on one is a call wasted.
    assert.deepEqual(selectForInsights([{ id: 'x' }, { timestamp: recent.timestamp }], new Set(), cutoff), []);
  });
});

describe('pageReachesBack — when to stop paging', () => {
  const cutoff = '2025-01-01T00:00:00.000Z';

  test('a page entirely inside the window keeps paging', () => {
    assert.equal(pageReachesBack([{ timestamp: '2026-05-01T00:00:00+0000' }], cutoff), false);
  });

  test('one item older than the cutoff stops it', () => {
    // Meta returns media newest first, so once a page crosses the cutoff every
    // later page is older still. Continuing would page back through years of
    // history nobody asked for.
    assert.equal(pageReachesBack(
      [{ timestamp: '2026-05-01T00:00:00+0000' }, { timestamp: '2024-05-01T00:00:00+0000' }],
      cutoff,
    ), true);
  });

  test('an empty page stops it', () => {
    // The account has run out of history. That is the ordinary end of a
    // backfill, not a fault -- and treating it as "keep going" would loop.
    assert.equal(pageReachesBack([], cutoff), true);
  });

  test('an unreadable timestamp does not end the run on its own', () => {
    // One bad item is not evidence we have reached the cutoff.
    assert.equal(pageReachesBack([{ timestamp: 'whenever' }], cutoff), false);
  });
});

/**
 * Graph OMITS the collaborators field for a solo post rather than returning an
 * empty list. Reading that as "unknown" marked every solo post in the warehouse
 * unknown -- and since is_collab correctly refuses to guess at nulls, the
 * collab-versus-solo comparison came back with collabs only and no baseline to
 * compare them against.
 */
describe('collaborator_count — zero and unknown are different', () => {
  const media = { id: '1', timestamp: '2026-08-16T12:00:00+0000' };

  test('a solo post is ZERO when the listing asked for collaborators', () => {
    assert.equal(toPostRow(media, {}, true)!.collaborator_count, 0);
  });

  test('the same post is UNKNOWN when the listing did not ask', () => {
    // Stories, whose listing requests a shorter field set. A confident zero
    // there would be an unverified claim.
    assert.equal(toPostRow(media, {}, false)!.collaborator_count, null);
  });

  test('collaborators present are counted whether asked for or not', () => {
    const collab = { ...media, collaborators: { data: [{ id: 'a' }, { id: 'b' }] } };
    assert.equal(toPostRow(collab, {}, true)!.collaborator_count, 2);
    assert.equal(toPostRow(collab, {}, false)!.collaborator_count, 2);
  });

  test('an empty collaborators array is zero, not unknown', () => {
    const empty = { ...media, collaborators: { data: [] } };
    assert.equal(toPostRow(empty, {}, false)!.collaborator_count, 0);
  });
});
