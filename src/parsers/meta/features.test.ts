import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashtagsOf, mentionsOf, captionLengthOf, hasQuestion, featuresOf, postedHourOf,
} from './features.js';

describe('hashtagsOf', () => {
  test('pulls tags out of an ordinary caption', () => {
    assert.deepEqual(
      hashtagsOf('New menu tonight #sgfood #neonpigeon'),
      ['sgfood', 'neonpigeon'],
    );
  });

  test('case is flattened so one tag is not counted as two', () => {
    // Instagram treats these as the same tag. Grouping them separately would
    // split the tag's performance in half and make both halves look weak.
    assert.deepEqual(hashtagsOf('#SundayRoast #sundayroast'), ['sundayroast']);
  });

  test('a repeated tag is counted once', () => {
    assert.deepEqual(hashtagsOf('#bar #bar #bar'), ['bar']);
  });

  test('reads non-Latin tags', () => {
    // Singapore captions carry these. An ASCII-only pattern would return an
    // empty list and read as "this venue does not use hashtags".
    assert.deepEqual(hashtagsOf('美味しい #新加坡 #ラーメン'), ['新加坡', 'ラーメン']);
  });

  test('stops at punctuation rather than swallowing it', () => {
    assert.deepEqual(hashtagsOf('#cocktails, #wine.'), ['cocktails', 'wine']);
  });

  test('a caption with no tags, or no caption at all, is empty not null', () => {
    assert.deepEqual(hashtagsOf('just dinner'), []);
    assert.deepEqual(hashtagsOf(null), []);
    assert.deepEqual(hashtagsOf(undefined), []);
  });
});

describe('mentionsOf', () => {
  test('pulls handles out', () => {
    assert.deepEqual(mentionsOf('with @fatprincesg and @neonpigeon'), ['fatprincesg', 'neonpigeon']);
  });

  test('a trailing full stop is punctuation, not part of the handle', () => {
    // "thanks @fatprince." is one account, not a different one.
    assert.deepEqual(mentionsOf('thanks @fatprince.'), ['fatprince']);
  });

  test('a dot inside a handle is kept', () => {
    assert.deepEqual(mentionsOf('@neon.pigeon'), ['neon.pigeon']);
  });

  test('an email address is not a mention', () => {
    // Counting it would credit a collaboration that never happened.
    assert.deepEqual(mentionsOf('book at hello@dandy.sg'), []);
  });

  test('the same handle twice counts once', () => {
    assert.deepEqual(mentionsOf('@chef @chef'), ['chef']);
  });
});

describe('captionLengthOf', () => {
  test('counts the whole caption including tags', () => {
    // That is what a reader scrolls past.
    assert.equal(captionLengthOf('abc #tag'), 8);
  });

  test('no caption is zero, not null', () => {
    assert.equal(captionLengthOf(null), 0);
  });
});

describe('hasQuestion', () => {
  test('a question mark counts', () => {
    assert.equal(hasQuestion('Who is joining us tonight?'), true);
  });

  test('a full-width question mark counts too', () => {
    // A Chinese or Japanese caption asks with this character, and missing it
    // would understate exactly the posts most likely to differ.
    assert.equal(hasQuestion('今晚来吗？'), true);
  });

  test('a statement does not', () => {
    assert.equal(hasQuestion('Doors open at six.'), false);
    assert.equal(hasQuestion(null), false);
  });
});

describe('featuresOf', () => {
  test('returns every feature for one caption', () => {
    const f = featuresOf('Chef @rahul is in tonight — joining us? #firangi #sgeats');
    assert.deepEqual(f.hashtags, ['firangi', 'sgeats']);
    assert.deepEqual(f.mentions, ['rahul']);
    assert.equal(f.has_question, true);
    assert.ok(f.caption_length > 0);
  });

  test('an empty caption gives empty features, never nulls', () => {
    // A row with nulls in these columns cannot be told apart from a row that
    // predates the feature. Empty means "we looked and there were none".
    assert.deepEqual(featuresOf(null), {
      hashtags: [], mentions: [], caption_length: 0, has_question: false,
    });
  });
});

describe('postedHourOf — Singapore clock time', () => {
  test('converts UTC to the local hour', () => {
    // 12:30 UTC is 20:30 in Singapore.
    assert.equal(postedHourOf('2026-08-16T12:30:00Z'), 20);
  });

  test('a late post keeps its real hour even though it trades to the night before', () => {
    // 18:00 UTC is 2am Singapore. business_date files this against the previous
    // night; the posting hour is still 2am, and that is the question worth
    // asking here -- when to post, not which night it belongs to.
    assert.equal(postedHourOf('2026-08-16T18:00:00Z'), 2);
  });

  test('an unreadable timestamp is null, not a guess', () => {
    assert.equal(postedHourOf('whenever'), null);
  });
});
