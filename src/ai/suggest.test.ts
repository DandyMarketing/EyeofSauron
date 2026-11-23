import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestion, suggestPrompt, SUGGEST_MAX_CHARS } from './suggest.js';

test('a suggestion is one clean line', () => {
  assert.equal(cleanSuggestion('"How did lunch compare with last week?"'), 'How did lunch compare with last week?');
  assert.equal(cleanSuggestion('Suggestion: Show me the same for Neon Pigeon'), 'Show me the same for Neon Pigeon');
  assert.equal(cleanSuggestion('\n\nWhich dishes drove it?\nAlso maybe...'), 'Which dishes drove it?');
  assert.equal(cleanSuggestion(''), null);
  assert.equal(cleanSuggestion('ok'), null);
  assert.equal(cleanSuggestion(null), null);
});

test('a long suggestion is cut at a word, never mid-word', () => {
  const long = 'Could you break down the cancellations by booking channel and by party size for the last four weeks please and also compare';
  const s = cleanSuggestion(long)!;
  assert.ok(s.length <= SUGGEST_MAX_CHARS + 1);
  assert.ok(s.endsWith('…'));
  assert.ok(!/\s…$/.test(s));
});

test('the prompt asks Plan for a reply and Query for a question, and forbids new figures', () => {
  const plan = suggestPrompt('plan', 'Ticketed', 'Agreed. What price per head?');
  assert.match(plan.system, /REPLY to the planner/);
  const chat = suggestPrompt('chat', 'Sales last week?', 'Net sales were $41,200.');
  assert.match(chat.system, /FOLLOW-UP QUESTION/);
  for (const p of [plan, chat]) assert.match(p.system, /No figures, dates or names that do not appear/);
});

test('a long answer is sent by its end, where the next step sits', () => {
  const answer = 'x'.repeat(10000) + ' What price per head?';
  assert.match(suggestPrompt('plan', 'q', answer).user, /What price per head\?$/);
});
