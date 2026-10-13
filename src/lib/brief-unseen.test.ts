import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unseenCount } from './brief-unseen.js';

const wk = (period_end: string, generated_at: string, status = 'new') => ({ period_end, generated_at, status });

test('the badge counts the latest week only, and only what came after the last visit', () => {
  const items = [
    wk('2026-10-12', '2026-10-13T00:30:00Z'), wk('2026-10-12', '2026-10-13T00:31:00Z'),
    wk('2026-10-12', '2026-10-13T00:32:00Z', 'dismissed'),
    wk('2026-10-05', '2026-10-06T00:30:00Z'),
  ];
  assert.equal(unseenCount(items, null), 2, 'never opened: this week, less what was dismissed');
  assert.equal(unseenCount(items, '2026-10-13T08:00:00Z'), 0, 'opened since it was written');
  assert.equal(unseenCount(items, '2026-10-10T08:00:00Z'), 2, 'opened last week: this week is new');
  assert.equal(unseenCount([], null), 0);
});
