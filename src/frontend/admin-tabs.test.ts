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

// --- what splitting render() into tabs can silently break -------------------

/**
 * Extract a top-level function's source from admin.html.
 *
 * Handles `async function`, destructured parameters and nested braces, because
 * the naive versions of all three produced wrong answers while debugging this.
 */
function functionBody(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is not defined in admin.html`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;

  let k = src.indexOf('(', src.indexOf(`function ${name}(`));
  let parens = 0;
  for (;; k++) {
    if (src[k] === '(') parens++;
    else if (src[k] === ')' && --parens === 0) break;
  }
  const open = src.indexOf('{', k);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const SECTION_RENDERERS = [
  'renderInvite', 'renderRoleSlot', 'renderUsers', 'renderSystem', 'renderAlerts',
  'renderPending', 'renderNotes', 'renderXero', 'renderAccountMap', 'renderFees',
  'renderIntegrations', 'renderUpload',
];

test('NO SECTION TOUCHES AN ELEMENT FROM ANOTHER TAB', () => {
  /**
   * The defect this test exists for, and it shipped. render() was one 950-line
   * function building every section into one page, so a handler could be
   * written four hundred lines below the markup it drives and nothing cared —
   * everything was on screen by the end. Split into tabs it matters
   * enormously: the note form's handler had ended up among the Meta handlers,
   * so opening CONNECTIONS ran `getElementById('note-add-btn').addEventListener`
   * against a form that lives on KNOWLEDGE, and took the whole tab down with
   * "Cannot read properties of null".
   *
   * A section may only reach for ids it creates itself.
   */
  const html = admin();
  const offenders: string[] = [];

  for (const name of SECTION_RENDERERS) {
    const body = functionBody(html, name);
    const used = new Set([...body.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
    const made = new Set([
      ...[...body.matchAll(/id="([^"]+)"/g)].map(m => m[1]),
      ...[...body.matchAll(/\.id = '([^']+)'/g)].map(m => m[1]),
    ]);
    for (const id of used) {
      if (!made.has(id)) offenders.push(`${name} reaches for #${id}, which it does not create`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('no section function is swallowed by an unclosed comment', () => {
  /**
   * The other defect that shipped, and the nastier one: the cut between two
   * sections landed INSIDE a comment block, so `renderInvite` ended with a
   * dangling `/**` that swallowed its own closing brace and the whole
   * `function renderRoleSlot(root) {` line after it. The result is valid
   * JavaScript — it parses, the compile check passes — and renderRoleSlot
   * simply does not exist. Opening People died with "renderRoleSlot is not
   * defined".
   *
   * Every section function must therefore actually BE a function at runtime,
   * which is what a balanced body proves.
   */
  const html = admin();
  for (const name of SECTION_RENDERERS) {
    const body = functionBody(html, name);
    assert.ok(body.startsWith('function ') || body.startsWith('async function '), `${name} is not a top-level function`);
    // A body whose first statement is a comment continuation means the cut
    // landed mid-comment, even when the braces happen to balance.
    const firstLine = body.split('\n')[1] ?? '';
    assert.ok(
      !/^\s*\*(?!\/)/.test(firstLine),
      `${name} starts inside a comment block — the previous function is swallowing it: ${firstLine.trim()}`,
    );
  }
});

test('every tab loader only calls renderers that exist', () => {
  const html = admin();
  for (const loader of ['loadAttention', 'loadPeople', 'loadConnections', 'loadAccounting', 'loadKnowledge']) {
    const body = functionBody(html, loader);
    for (const called of [...body.matchAll(/\b(render[A-Z]\w*)\(/g)].map(m => m[1])) {
      assert.ok(
        html.includes(`function ${called}(`),
        `${loader} calls ${called}(), which is not defined — the tab will fail to open`,
      );
    }
  }
});

/**
 * The upload list: a result must land on the file it is about.
 *
 * The server groups a batch by venue and business date, emits the product mix
 * before the operations report, handles hourly sales in a pass of its own
 * afterwards, and pushes any parse failure ahead of all of it. So its results
 * come back in ITS order and sometimes in a different count — and the page read
 * `results[j]` onto `files[j]`.
 *
 * In the happy case every row says "Ingested" and nothing looks wrong, which is
 * why it survived. The moment one file in a batch fails, the failure is reported
 * against a DIFFERENT file, sending somebody to inspect a file that is fine.
 * Exactly the shape of the bug that caused this: an accurate-looking message
 * pointing at the wrong thing.
 */
test('an upload result is matched to its row by filename, not by position', () => {
  const html = admin();
  const body = functionBody(html, 'doUpload');

  assert.ok(
    /dataset\.fname === r\.filename/.test(body),
    'doUpload no longer matches a result to its row by filename',
  );
  assert.ok(
    !/document\.getElementById\('ufile-' \+ \(i\+j\)\)[^]]*?r\.status/s.test(body),
    'doUpload is back to indexing results positionally against the batch',
  );
  // And the row must carry the name for that to find anything.
  assert.ok(
    /dataset\.fname\s*=\s*f\.name/.test(functionBody(html, 'renderUploadList')),
    'renderUploadList no longer records the filename on the row',
  );
});

test('the upload list shows what the server actually said', () => {
  // Every failure path on /ingest/revel computes a `detail` — the parse error,
  // the reconciliation difference, the row count — and this page used to throw
  // all of them away and show a one-word status with nothing to act on.
  const body = functionBody(admin(), 'doUpload');
  assert.ok(/r\.detail/.test(body), 'doUpload ignores the detail the server returns');
  assert.ok(admin().includes('.fdetail'), 'there is no style for the detail line, so it will squeeze into the row');
});

test('a Revel operations ingest checks the payments against the Grand Total', () => {
  /**
   * `paymentsReconcile()` existed and nothing called it, which is the failure
   * this codebase keeps finding one layer up: a guard that is written, tested,
   * and never reached. It must run on the ingest path, and it must WARN rather
   * than block — a mismatch means the method/card-brand list does not recognise
   * something, not that the figures are wrong, and refusing the day would throw
   * away real sales over a classification question.
   */
  const src = server();
  assert.ok(src.includes('paymentsReconcile(ops.operations.payments)'), 'the operations ingest no longer checks the payment totals');
  assert.match(src, /WARNING: \$\{warning\}/, 'the payment mismatch is no longer reported in the upload result');

  // The block it sits in must not bail out. `continue` there would lose the day.
  const after = src.slice(src.indexOf('paymentsReconcile(ops.operations.payments)'));
  const block = after.slice(0, after.indexOf('await logIngestion'));
  assert.ok(!/\bcontinue\b|\bthrow\b/.test(block), 'a payment mismatch now blocks the ingest — it must only warn');
});
