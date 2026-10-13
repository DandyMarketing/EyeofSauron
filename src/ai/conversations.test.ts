import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFromQuestion, cleanTitle, isConversationKind, inTurnOrder } from './conversations.js';

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

test('only chat and plan are kinds, so a typo cannot list the other page\'s threads', () => {
  assert.equal(isConversationKind('chat'), true);
  assert.equal(isConversationKind('plan'), true);
  for (const bad of ['Plan', 'plans', '', undefined, null, 'chat ']) assert.equal(isConversationKind(bad), false);
});

test('a question comes before its answer even when they share a timestamp', () => {
  // Khai, 13 Oct 2026: a saved plan reopened with the answer above the
  // question, because both rows took the same now() and a random uuid broke
  // the tie.
  const t1 = '2026-10-13T08:00:00.000Z', t2 = '2026-10-13T08:05:00.000Z';
  const rows = [
    { role: 'assistant', content: 'table of owners', created_at: t2 },
    { role: 'assistant', content: 'first answer', created_at: t1 },
    { role: 'user', content: 'yes for now', created_at: t2 },
    { role: 'user', content: 'first question', created_at: t1 },
  ];
  assert.deepEqual(inTurnOrder(rows).map(r => r.content), ['first question', 'first answer', 'yes for now', 'table of owners']);
  // Rows saved with distinct times keep their times.
  const later = [
    { role: 'assistant', content: 'a', created_at: '2026-10-13T09:00:00.001Z' },
    { role: 'user', content: 'q', created_at: '2026-10-13T09:00:00.000Z' },
  ];
  assert.deepEqual(inTurnOrder(later).map(r => r.content), ['q', 'a']);
});
