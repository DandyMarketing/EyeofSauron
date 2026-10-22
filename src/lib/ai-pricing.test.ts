import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callCost, priceFor, passOf, featureOf, MODEL_PRICES } from './ai-pricing.js';

test('a call is costed from its tokens at the list price', () => {
  // Opus 5: $5 in, $25 out, cache read $0.50, cache write $6.25 per million.
  assert.equal(callCost('claude-opus-5', { input_tokens: 1_000_000 }), 5);
  assert.equal(callCost('claude-opus-5', { output_tokens: 1_000_000 }), 25);
  assert.equal(callCost('claude-opus-5', { cache_read: 1_000_000 }), 0.5);
  assert.equal(callCost('claude-opus-5', { cache_write: 1_000_000 }), 6.25);
  // A typical Query round: 3,000 fresh in, 40,000 cached, 1,200 out, one search.
  assert.equal(callCost('claude-opus-5', { input_tokens: 3000, cache_read: 40000, output_tokens: 1200, web_searches: 1 }), 0.075);
  assert.equal(callCost('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 12);
});

test('the longest model prefix wins, and an unknown model is unpriced rather than free', () => {
  assert.equal(priceFor('claude-opus-5-5')?.input, 4, 'Opus 5.5 is not priced as Opus 5');
  assert.equal(priceFor('claude-opus-5')?.input, 5);
  assert.equal(priceFor('claude-opus-5-20261001')?.input, 5, 'a dated id still prices');
  assert.equal(priceFor('claude-opus-50'), null, 'a prefix is a whole segment');
  assert.equal(callCost('some-other-model', { input_tokens: 1000 }), null);
});

test('a planner pass is named by its forced tool, and is Plan', () => {
  assert.equal(passOf({ tool_choice: { type: 'tool', name: 'record_event_pnl' } }, 'x'), 'plan_pnl');
  assert.equal(passOf({ tools: [{ name: 'record_task_titles' }] }, 'x'), 'plan_task_names');
  assert.equal(passOf({}, 'title'), 'title');
  assert.equal(featureOf('u1', 'plan_pnl', 'query'), 'plan');
  assert.equal(featureOf('u1', 'chat', 'plan'), 'plan', 'the planner conversation itself');
  assert.equal(featureOf('u1', 'chat', null), 'query');
  assert.equal(featureOf(null, 'recommendation', null), 'system', 'nobody signed in');
});

test("migration 065's backfill uses the same prices as this file", () => {
  const sql = readFileSync('supabase/migrations/065_ai_usage.sql', 'utf8');
  // The three CASEs in order: input, output, cache read.
  const block = sql.slice(sql.indexOf('cross join lateral ('));
  for (const [model, p] of Object.entries(MODEL_PRICES)) {
    const values = [...block.matchAll(new RegExp(`like '${model}%'\\s+then ([0-9.]+)`, 'g'))].map(m => Number(m[1]));
    assert.deepEqual(values, [p.input, p.output, p.cacheRead], `${model}: SQL ${values} vs ${[p.input, p.output, p.cacheRead]}`);
  }
  assert.match(sql, /\* p\.inp \* 1\.25/, 'cache write is 1.25x input in both');
});
