import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthWindow, summariseUsage, type SummaryRow } from './ai-usage-summary.js';

test('a month is a Singapore calendar month', () => {
  assert.deepEqual(monthWindow('2026-10', '2026-10-22'),
    { key: '2026-10', label: 'October 2026', from: '2026-10-01T00:00:00+08:00', to: '2026-11-01T00:00:00+08:00' });
  assert.equal(monthWindow('2026-12', 'x').to, '2027-01-01T00:00:00+08:00');
  assert.equal(monthWindow(null, '2026-10-22').key, '2026-10', 'defaults to this month');
  assert.equal(monthWindow('2026-13', '2026-10-22').key, '2026-10', 'nonsense falls back');
});

const row = (o: Partial<SummaryRow>): SummaryRow => ({
  user_id: 'u1', feature: 'query', model: 'claude-opus-5', calls: 1, answers: 1,
  input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, web_searches: 0, cost_usd: 0, unpriced: 0, ...o,
});

test('per person, by feature and model, with System apart and a total of everything', () => {
  const s = summariseUsage([
    row({ calls: 5, answers: 3, cost_usd: 0.5 }),
    row({ feature: 'plan', calls: 7, answers: 2, cost_usd: 1.25 }),
    row({ model: 'claude-sonnet-5', calls: 2, answers: 2, cost_usd: 0.02 }),
    row({ user_id: 'u2', calls: 1, answers: 1, cost_usd: 0.1 }),
    row({ user_id: null, feature: 'system', calls: 40, answers: 3, cost_usd: 2, model: 'claude-opus-5' }),
    row({ user_id: 'u2', model: 'mystery', calls: 1, answers: 1, cost_usd: 0, unpriced: 1 }),
  ], monthWindow('2026-10', '2026-10-22'));

  assert.equal(s.people.u1.cost_usd, 1.77);
  assert.equal(s.people.u1.answers, 7);
  assert.equal(s.people.u1.by_feature.plan?.calls, 7);
  assert.equal(s.people.u1.by_model['claude-sonnet-5'].cost_usd, 0.02);
  assert.equal(s.people.u2.unpriced, 1);
  assert.equal(s.system?.cost_usd, 2);
  assert.equal(s.total.cost_usd, 3.87, 'people + System = the whole bill');
});
