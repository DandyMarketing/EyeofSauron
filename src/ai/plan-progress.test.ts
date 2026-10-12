import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseProgress, planTranscript, DECISION_LABELS, progressTool } from './plan-progress.js';
import { PLAYBOOK } from './event-playbook.js';

test('every playbook decision has a short label, and the tool offers exactly the playbook keys', () => {
  for (const r of PLAYBOOK) assert.ok(DECISION_LABELS[r.key], r.key);
  const keys = (progressTool().input_schema.properties.settled.items.properties.key as any).enum;
  assert.deepEqual(keys, PLAYBOOK.map(r => r.key));
});

test('counts settled against what applies, ignoring keys the model made up', () => {
  const p = summariseProgress({
    settled: [
      { key: 'date_and_why', summary: 'NYE 31 Dec, a strong night' },
      { key: 'product_shape', summary: 'Ticketed at all four rooms' },
      { key: 'date_and_why', summary: 'duplicate' },
      { key: 'vibes', summary: 'not a playbook key' },
    ],
    not_applicable: ['ad_spend', 'date_and_why'],
    waiting_on: [{ item: 'Barter rooftop contract', who: 'Barter' }, { item: '' }],
    next: 'scope',
  });
  assert.equal(p.counts.settled, 2);
  // 20 decisions, one not applicable; date_and_why was settled so it still counts.
  assert.equal(p.counts.applicable, PLAYBOOK.length - 1);
  assert.deepEqual(p.not_applicable, ['ad_spend']);
  assert.equal(p.settled.find(s => s.key === 'date_and_why')?.summary, 'NYE 31 Dec, a strong night');
  assert.deepEqual(p.waiting_on, [{ item: 'Barter rooftop contract', who: 'Barter' }]);
  assert.deepEqual(p.next, { key: 'scope', label: 'One event or several' });
  assert.equal(p.stages.reduce((n, s) => n + s.applicable, 0), p.counts.applicable);
});

test('nothing usable is an empty board, not a crash', () => {
  const p = summariseProgress(null);
  assert.equal(p.counts.settled, 0);
  assert.equal(p.counts.applicable, PLAYBOOK.length);
  assert.equal(p.next?.key, 'objective');
});

test('the transcript never calls the person the planner', () => {
  const t = planTranscript([{ role: 'user', content: 'i still need a fourth' }, { role: 'assistant', content: 'Noted.' }]);
  assert.match(t, /^THE PERSON PLANNING: i still need a fourth/);
  assert.doesNotMatch(t, /^PLANNER:/m);
});
