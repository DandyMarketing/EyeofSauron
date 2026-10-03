/**
 * The admin page's tabs, and the one property that makes them honest.
 *
 * The page used to load thirteen sections and eleven API calls on every visit,
 * nine of them for panels nobody was looking at. Each tab now fetches nothing
 * until it is opened, and the default tab is the one that answers "is anything
 * wrong".
 *
 * THE THING WORTH GUARDING is not the speed, it is the badge. If nothing loads
 * until you click, nothing can tell you a tab needs attention — the review
 * queue and the alert count become invisible until somebody goes looking, and
 * an approval queue nobody sees is one that grows. Lazy tabs without counts are
 * faster and worse, so the counts are asserted here rather than trusted to
 * survive the next tidy-up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const admin = () => readFileSync('public/admin.html', 'utf8');
const server = () => readFileSync('src/server.ts', 'utf8');

const TAB_IDS = ['attention', 'people', 'connections', 'accounting', 'knowledge'];

test('every tab exists and has a loader', () => {
  const html = admin();
  for (const id of TAB_IDS) {
    assert.ok(html.includes(`id: '${id}'`), `the ${id} tab is gone from TABS`);
  }
  for (const fn of ['loadAttention', 'loadPeople', 'loadConnections', 'loadAccounting', 'loadKnowledge']) {
    assert.ok(html.includes(`async function ${fn}(`), `${fn} is missing`);
  }
});

test('Attention is the default', () => {
  // It is the reason people open this page. Any other default makes the fast
  // path the wrong one.
  assert.match(admin(), /const DEFAULT_TAB = 'attention';/);
});

test('NO TAB FETCHES UNTIL IT IS OPENED', () => {
  /**
   * The whole point. Every data read must sit inside a load* function or a
   * render function those call — never at the top of init, where it would run
   * on every visit regardless of which tab is wanted.
   *
   * The exceptions are listed rather than pattern-matched: the summary counts
   * (needed whichever tab opens) and the Attention tab's own three reads, which
   * are prefetched only when Attention is the tab being opened.
   */
  const html = admin();
  const init = html.slice(html.indexOf('(async function init()'), html.indexOf('async function api('));

  const allowed = [
    '/admin/api/summary',
    '/admin/api/alerts',
    '/admin/api/notes?status=pending',
    '/admin/api/system?days=3',
  ];
  const fetched = [...init.matchAll(/prefetch\('([^']+)'\)/g)].map(m => m[1]);
  for (const path of fetched) {
    assert.ok(allowed.includes(path), `init prefetches ${path}, which belongs to a tab and should wait until it is opened`);
  }

  // And the ones that were moved off the critical path must stay off it.
  for (const path of ['/admin/api/users', '/admin/api/notes\'', '/admin/api/xero/connections', '/admin/api/account-map', '/admin/api/fee-acknowledgements', '/admin/api/staffany/sections']) {
    assert.ok(!init.includes(path), `init still loads ${path} — that is a tab's data, fetched before anybody asked for the tab`);
  }
});

test('the prefetched requests are TAKEN, not fetched a second time', () => {
  // take() hands over the in-flight request prefetch() started; api() would
  // issue a fresh one, so the page would quietly make each of these twice.
  const html = admin();
  for (const path of ['/admin/api/alerts', '/admin/api/notes?status=pending', '/admin/api/system?days=3', '/admin/api/summary']) {
    assert.ok(
      html.includes(`take('${path}')`),
      `${path} is prefetched but not taken — it will be requested twice`,
    );
  }
});

test('the counts endpoint exists and returns counts, not rows', () => {
  const src = server();
  assert.ok(src.includes("app.get('/admin/api/summary'"), '/admin/api/summary is gone — the tabs lose their badges');

  const handler = src.slice(src.indexOf("app.get('/admin/api/summary'"), src.indexOf("app.get('/admin/api/alerts'"));
  assert.ok(
    handler.includes('head: true'),
    'the summary must use head:true — it runs on every page load and must stay cheap, which means counts and not rows',
  );
  assert.ok(handler.includes('requireOwner'), 'the summary is not owner-gated');
});

test('the badge counts the same thing the panel it points at does', () => {
  /**
   * A badge saying 3 beside a tab showing 5 is worse than no badge: it teaches
   * people the number is decorative. Both of these were got wrong on the first
   * attempt — `resolved_at is null` instead of `resolved = false`, and
   * `status = 'error'` instead of "not success or closed" — so they are pinned
   * against the queries they have to agree with.
   */
  const src = server();
  const handler = src.slice(src.indexOf("app.get('/admin/api/summary'"), src.indexOf("app.get('/admin/api/alerts'"));

  assert.ok(
    handler.includes(".eq('resolved', false)"),
    "the alert count must match /admin/api/alerts, which filters on resolved = false",
  );
  assert.ok(
    handler.includes(".not('status', 'in', '(success,closed)')"),
    "the ingestion-error count must match checkDataGaps(), which excludes success AND closed — 'closed' is a normal outcome for a venue that does not trade that day",
  );
});

test('the open tab is in the URL', () => {
  // So a refresh keeps your place and a link can point somebody at the thing
  // you are talking about.
  const html = admin();
  assert.ok(html.includes("history.replaceState(null, '', '#' + id)"), 'the tab no longer travels in the URL');
  assert.ok(html.includes("addEventListener('hashchange'"), 'back/forward between tabs is broken');
});

test('a failed tab can be retried', () => {
  // `loaded` is set before the load resolves so a double click cannot start
  // two. If a failure left it set, the panel would stay broken until a full
  // reload with no way to retry.
  const html = admin();
  const openTab = html.slice(html.indexOf('async function openTab('), html.indexOf('/**\n * ATTENTION'));
  assert.ok(openTab.includes('loaded.add(id)'), 'openTab no longer guards against a double click');
  assert.ok(openTab.includes('loaded.delete(id)'), 'a failed tab is never retried — it stays empty for ever');
});
