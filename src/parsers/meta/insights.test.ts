import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseInsights, dayFromEndTime, coerceValue, missingDays } from './insights.js';

/** Shaped like a Meta Insights response: end_time closes the window. */
const SAMPLE = {
  data: [
    {
      name: 'reach',
      period: 'day',
      values: [
        { value: 1200, end_time: '2026-08-11T07:00:00+0000' }, // describes 10 Aug
        { value: 1850, end_time: '2026-08-12T07:00:00+0000' }, // describes 11 Aug
      ],
    },
    {
      name: 'profile_views',
      period: 'day',
      values: [
        { value: 64, end_time: '2026-08-11T07:00:00+0000' },
        { value: 91, end_time: '2026-08-12T07:00:00+0000' },
      ],
    },
  ],
};

describe('dayFromEndTime — the off-by-one that would poison every join', () => {
  test('a value stamped with the 11th describes the 10th', () => {
    // Meta stamps a daily figure with the END of its window. Stored verbatim,
    // every metric shifts forward a day and campaign reach lines up against
    // the wrong night's covers — a correlation that looks real and is not.
    assert.equal(dayFromEndTime('2026-08-11T07:00:00+0000'), '2026-08-10');
  });

  test('computed in UTC, not the server’s local zone', () => {
    // Read with local getters this shifts date on any server off UTC, which
    // is the bug this function exists to prevent reintroducing.
    assert.equal(dayFromEndTime('2026-08-01T07:00:00+0000'), '2026-07-31');
  });

  test('handles a month and a year boundary', () => {
    assert.equal(dayFromEndTime('2026-03-01T07:00:00+0000'), '2026-02-28');
    assert.equal(dayFromEndTime('2027-01-01T07:00:00+0000'), '2026-12-31');
  });

  test('an unparseable timestamp is null, not today', () => {
    assert.equal(dayFromEndTime('not-a-date'), null);
    assert.equal(dayFromEndTime(''), null);
  });
});

describe('coerceValue', () => {
  test('numbers and numeric strings', () => {
    assert.equal(coerceValue(1200), 1200);
    assert.equal(coerceValue('1200'), 1200);
    assert.equal(coerceValue(0), 0);
  });

  test('a breakdown object is skipped, not flattened', () => {
    // A by-country or by-age object is not a daily scalar; turning it into one
    // number would invent a figure.
    assert.equal(coerceValue({ SG: 900, MY: 300 }), null);
    assert.equal(coerceValue(null), null);
    assert.equal(coerceValue(undefined), null);
    assert.equal(coerceValue('n/a'), null);
  });
});

describe('normaliseInsights', () => {
  const rows = normaliseInsights(SAMPLE);

  test('produces one row per metric per day', () => {
    assert.equal(rows.length, 4);
  });

  test('keys every row to the day it describes', () => {
    const reach = rows.filter(r => r.metric === 'reach');
    assert.deepEqual(reach.map(r => r.business_date), ['2026-08-10', '2026-08-11']);
    assert.equal(reach.find(r => r.business_date === '2026-08-10')?.value, 1200);
  });

  test('keeps the platform’s own metric name', () => {
    // Meta renames metrics on its own schedule; storing its name verbatim is
    // what lets a figure be traced back after a rename.
    assert.deepEqual([...new Set(rows.map(r => r.metric))], ['reach', 'profile_views']);
  });

  test('skips non-daily periods', () => {
    // A lifetime or 28-day total stored against one date would be read as
    // that day's figure.
    const mixed = {
      data: [
        { name: 'reach', period: 'day', values: [{ value: 10, end_time: '2026-08-11T07:00:00+0000' }] },
        { name: 'follower_count', period: 'lifetime', values: [{ value: 99999, end_time: '2026-08-11T07:00:00+0000' }] },
      ],
    };
    assert.deepEqual(normaliseInsights(mixed).map(r => r.metric), ['reach']);
  });

  test('skips unreadable entries rather than defaulting them to zero', () => {
    // A metric that silently becomes 0 reads as "no reach that day" — a
    // finding about the business rather than a parsing failure.
    const dirty = {
      data: [{
        name: 'reach',
        period: 'day',
        values: [
          { value: 500, end_time: '2026-08-11T07:00:00+0000' },
          { value: { SG: 1 }, end_time: '2026-08-12T07:00:00+0000' },
          { value: 700, end_time: 'garbage' },
        ],
      }],
    };
    const out = normaliseInsights(dirty);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, 500);
  });
});

describe('normaliseInsights — failed fetches must be loud', () => {
  test('an empty response throws rather than returning nothing', () => {
    assert.throws(() => normaliseInsights({}), /no data array/);
    assert.throws(() => normaliseInsights({ data: [] }), /no data array/);
  });

  test('a response with no usable rows throws', () => {
    assert.throws(
      () => normaliseInsights({ data: [{ name: 'reach', period: 'day', values: [] }] }),
      /zero usable rows/,
    );
  });
});

describe('missingDays', () => {
  test('names the days that came back with nothing', () => {
    // Stories metrics expire after ~24h and cannot be backfilled, so a gap is
    // permanent and has to be visible when it happens.
    const rows = normaliseInsights(SAMPLE);
    assert.deepEqual(missingDays(rows, '2026-08-09', '2026-08-12'), ['2026-08-09', '2026-08-12']);
  });

  test('a complete range reports nothing missing', () => {
    assert.deepEqual(missingDays(normaliseInsights(SAMPLE), '2026-08-10', '2026-08-11'), []);
  });
});
