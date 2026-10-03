import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromQuestion, cleanTitle } from './conversations.js';

test('a title comes from the question, trimmed to something readable', () => {
  assert.equal(titleFromQuestion('How did Neon Pigeon do last week?'), 'How did Neon Pigeon do last week?');
  assert.equal(titleFromQuestion('  spaced   out   question  '), 'spaced out question');
});

test('a long question is cut at a WORD boundary', () => {
  // Cutting mid-word reads as corruption rather than as a summary.
  const long = 'Why did beverage margin at Neon Pigeon fall between June and July and what should I do about it';
  const title = titleFromQuestion(long);
  assert.ok(title.length <= 61, `too long: ${title.length}`);
  assert.ok(title.endsWith('…'));
  assert.ok(!/\w…$/.test(title.replace('…', '')) || title.includes(' '), 'should break on a space');
  assert.ok(long.startsWith(title.replace('…', '')), 'the title must be a prefix of the question');
});

test('an empty question still produces a usable name', () => {
  // A row that cannot be written without a model answering is a row that is
  // lost whenever the model fails.
  assert.equal(titleFromQuestion(''), 'New conversation');
  assert.equal(titleFromQuestion('   '), 'New conversation');
  assert.equal(titleFromQuestion(undefined as any), 'New conversation');
});

test('a single very long word does not produce an empty title', () => {
  const title = titleFromQuestion('x'.repeat(200));
  assert.ok(title.length > 10, `degenerate title: ${title}`);
});

test('a model reply becomes a usable title, or is rejected', () => {
  assert.equal(cleanTitle('Neon Pigeon beverage margin'), 'Neon Pigeon beverage margin');
  // Models wrap titles in quotes and add full stops unprompted.
  assert.equal(cleanTitle('"Fat Prince covers last week."'), 'Fat Prince covers last week');
  assert.equal(cleanTitle('  Title: Labour across venues  '), 'Labour across venues');
  assert.equal(cleanTitle('Weekly\ncovers\ntrend'), 'Weekly covers trend');
});

test('AN ANSWER IS NOT A TITLE, and is rejected so the fallback stands', () => {
  /**
   * The failure that would be visible and ugly: a model that answers the
   * question instead of naming it would put a paragraph of figures in the
   * sidebar. A refusal or an apology would go there instead. Anything that is
   * not short is not a title.
   */
  const essay = 'Neon Pigeon took $12,480 across 284 covers last week, which is up 4.2% on the week before, driven mostly by Friday.';
  assert.equal(cleanTitle(essay), '');
  assert.equal(cleanTitle("I'm sorry, but I cannot determine a title without more information about what you are asking."), '');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle('   '), '');
  assert.equal(cleanTitle(undefined as any), '');
});
