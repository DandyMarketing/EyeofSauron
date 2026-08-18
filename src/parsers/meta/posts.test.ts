import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { businessDateOf, metricsFrom, toPostRow, metricsForMediaType } from './posts.js';

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
