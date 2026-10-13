import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the daily report is for owners only, refused on the server', () => {
  /**
   * Khai, 13 Oct 2026: Daily is the WhatsApp preview and only owners use it
   * for now. The dashboard hides the link from everyone else, but a hidden
   * link is a hint -- the API refusing is the control, and this pins it.
   */
  const src = readFileSync('src/server.ts', 'utf8');
  const start = src.indexOf("app.get('/api/daily-report'");
  assert.ok(start > 0, 'the daily report route has moved');
  const handler = src.slice(start, src.indexOf('\n});', start));
  const guard = handler.indexOf('if (!user.isOwner)');
  assert.ok(guard > 0, 'the daily report must refuse anyone who is not an owner');
  assert.ok(guard < handler.indexOf('buildDailyReport('), 'the owner check must come before the report is built');
  const dash = readFileSync('public/index.html', 'utf8');
  assert.match(dash, /<a href="\/daily\.html" id="daily-link" hidden>/, 'the Daily link starts hidden');
});
