import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * The public watchdog must never carry a figure or a venue name.
 *
 * FOUND 23 Sep 2026, in the audit before the alpha launch. /watchdog has no
 * authentication — deliberately, so an external uptime monitor can read it —
 * and it was returning the FULL report, including open_alerts, whose detail is
 * built as "Monday $12,345 vs Revel $12,300 (out by $45)" beside the venue name
 * and the date. Anyone who knew the URL could read daily gross revenue per
 * named venue without logging in.
 *
 * RLS was never the issue. The handler queries with the service role, which
 * bypasses it, and the route asked for no session at all. BUILD_LOG 4.4 through
 * a different door: there the tables had no RLS, here the table is fine and the
 * route in front of it was not.
 *
 * This reads the SOURCE rather than calling the endpoint, because the endpoint
 * needs a database and the thing worth pinning is the shape of what it returns.
 * Crude, and it fails loudly if somebody re-adds a field that carries detail.
 */
const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

function routeBody(path: string): string {
  const start = SERVER.indexOf(`app.get('${path}'`);
  assert.ok(start > -1, `${path} is not registered`);
  const next = SERVER.indexOf('\napp.', start + 10);
  return SERVER.slice(start, next === -1 ? undefined : next);
}

test('the public watchdog is still public', () => {
  // If this ever needs a session, an external monitor breaks silently and
  // nobody notices until an outage goes unreported. That is a real cost, so
  // the route staying open is deliberate and pinned.
  const body = routeBody('/watchdog');
  assert.ok(!body.includes('requireAuth('), '/watchdog now requires a session');
  assert.ok(!body.includes('requireOwner('), '/watchdog now requires an owner');
});

test('the public watchdog returns counts, never the report', () => {
  const body = routeBody('/watchdog');

  // Spreading the report back in is exactly how the leak was written the first
  // time: `return c.json({ healthy, knowledge, social, ...report })`.
  assert.ok(!/\.\.\.report/.test(body), '/watchdog spreads the full report again');

  for (const field of ['open_alerts:', 'recent_errors:', 'missing:']) {
    const line = body.split('\n').find(l => l.includes(field)) ?? '';
    assert.ok(
      /\.length/.test(line),
      `/watchdog returns ${field} as something other than a count: ${line.trim()}`,
    );
  }
});

test('the detailed report requires an owner', () => {
  const body = routeBody('/admin/api/watchdog');
  assert.ok(body.includes('requireOwner('), 'the detailed watchdog lost its owner check');
});

test('the alert detail that carries revenue is only on the guarded route', () => {
  // checkDataGaps builds "Monday $X vs Revel $Y". Wherever that report is
  // spread wholesale, an owner check must be beside it.
  const pub = routeBody('/watchdog');
  assert.ok(
    !pub.includes('report.open_alerts[') && !/open_alerts\s*,/.test(pub),
    'the public route references alert detail',
  );
});
