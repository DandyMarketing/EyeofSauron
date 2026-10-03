/**
 * The front end has no test harness, and the one failure that costs everything
 * is the cheapest to catch: a syntax error in a page's inline script.
 *
 * WHY THIS EXISTS. The boot sequence on four pages was hand-edited to run its
 * requests in parallel instead of in a six-deep chain. A misplaced brace in any
 * of them produces a BLANK PAGE -- not a degraded one, not a slow one -- and
 * `tsc` never looks inside an HTML file, so the whole 906-test suite would pass
 * and the app would be down. That is the shape of defect this codebase keeps
 * finding: it worked, it looked fine, it was doing nothing.
 *
 * `new Function(src)` COMPILES WITHOUT RUNNING, which is the whole trick. The
 * page's script expects a browser -- document, window, fetch -- and none of it
 * executes here; a SyntaxError is thrown at compile time and anything else is
 * never reached.
 *
 * A MODULE SCRIPT IS WRAPPED IN AN ASYNC FUNCTION BODY, not skipped. Top-level
 * await is legal in a module and a syntax error inside a plain function, so the
 * naive version of this test silently covered nothing on plan.html -- whose
 * script is `type="module"` -- and reported a pass. That is the same defect this
 * test exists to catch, one layer up. Wrapped in `async () => { ... }` the
 * awaits are legal and a real syntax error still throws.
 *
 * The one thing that shape cannot hold is a static `import`/`export`
 * declaration, which is only legal at a module's top level. No page has one
 * today, and a page that gains one fails here with a message saying so rather
 * than quietly dropping out of the check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

type Block = { type: string | null; body: string; index: number };

/** Every <script> element's attributes and body, in document order. */
export function scriptBlocks(html: string): Block[] {
  const out: Block[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    // An external script has no body to check.
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const typeMatch = attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i);
    out.push({ type: typeMatch ? typeMatch[1] : null, body: m[2], index: m.index });
  }
  return out;
}

function lineOf(html: string, index: number): number {
  return html.slice(0, index).split('\n').length;
}

const pages = readdirSync('public').filter((f) => f.endsWith('.html'));

test('the app pages are all present', () => {
  // Otherwise a glob that matched nothing would make every check below vacuous.
  for (const expected of ['index.html', 'briefing.html', 'plan.html', 'admin.html', 'login.html']) {
    assert.ok(pages.includes(expected), `public/${expected} is missing`);
  }
});

for (const page of pages) {
  test(`${page}: every inline script compiles`, () => {
    const html = readFileSync(`public/${page}`, 'utf8');
    const blocks = scriptBlocks(html);

    for (const b of blocks) {
      const isModule = b.type === 'module';

      if (isModule && /^[ \t]*(import|export)[\s{*]/m.test(b.body)) {
        assert.fail(
          `public/${page} line ~${lineOf(html, b.index)}: this module has a static ` +
            `import/export, which this check cannot compile. Move it to a file in ` +
            `public/ and load it with src=, or extend this test — do not leave the ` +
            `page unchecked.`,
        );
      }

      try {
        // Compiles; never runs. A module's body goes inside an async arrow so
        // its top-level awaits are legal.
        // eslint-disable-next-line no-new-func
        new Function(isModule ? `(async () => {\n${b.body}\n})` : b.body);
      } catch (e) {
        const err = e as Error;
        assert.fail(
          `public/${page} line ~${lineOf(html, b.index)}: ${err.name}: ${err.message}`,
        );
      }
    }
  });
}

test('the compile check actually rejects broken code', () => {
  // Without this the whole file above could be passing because it compiles
  // nothing, which is precisely the failure it was written to catch.
  assert.throws(() => new Function('(async () => {\nif (a { b();\n})'), SyntaxError);
  assert.throws(() => new Function('function f() { return 1;'), SyntaxError);

  // And the module shape must really accept top-level await, or every module
  // page would fail for the wrong reason and somebody would relax the test.
  assert.doesNotThrow(() => new Function('(async () => {\nconst x = await f();\n})'));
});

test('a module script is actually being checked somewhere', () => {
  // plan.html is type="module" and the first version of this test skipped it in
  // silence. If no page exercises the module branch, that branch is untested
  // and the next module page will be skipped the same way.
  const withModules = pages.filter((p) =>
    scriptBlocks(readFileSync(`public/${p}`, 'utf8')).some((b) => b.type === 'module'),
  );
  assert.ok(
    withModules.length > 0,
    'no page has an inline module script — the module branch above is now dead code',
  );
});

test('the boot sequence is parallel on the pages that were changed', () => {
  // Not a style preference. These four pages each had config-then-import as two
  // serial round trips, and the fix is one Promise.all. Reverting it costs a
  // round trip on every load and leaves no trace anybody would notice, so it is
  // asserted rather than remembered.
  for (const page of ['index.html', 'briefing.html', 'plan.html', 'admin.html']) {
    const html = readFileSync(`public/${page}`, 'utf8');
    assert.match(
      html,
      /Promise\.all\(\[\s*\n\s*fetch\('\/api\/config'\)/,
      `public/${page} fetches /api/config serially again — it should be in the Promise.all with the client import`,
    );
    assert.ok(
      html.includes('rel="modulepreload" href="/vendor/supabase.js"'),
      `public/${page} lost the modulepreload — the bundle then waits for the whole document to parse`,
    );
  }
});

test('the briefing starts its own data fetch before the checks it does not need', () => {
  // The point of the change on this page: /api/recommendations is a database
  // read and it was SIXTH in a chain of six. If it ever goes back to being
  // awaited after /api/me, the page is slow again for no stated reason.
  const html = readFileSync('public/briefing.html', 'utf8');
  const fetchAt = html.indexOf('const briefing = fetchBriefing();');
  const meAt = html.indexOf("const mePromise = fetch('/api/me'");
  const gateAt = html.indexOf("const gate = import('/terms-gate.js')");

  assert.ok(fetchAt > 0, 'briefing.html no longer starts fetchBriefing() early');
  assert.ok(meAt > fetchAt, '/api/me should be started after, not awaited before, the briefing fetch');
  assert.ok(gateAt > fetchAt, 'the terms module should be started after the briefing fetch');

  // And the correctness half of it: a gate that had to appear means the
  // parallel request was refused, so it must be re-issued.
  assert.ok(
    html.includes("terms === 'already' ? await briefing : await fetchBriefing()"),
    'briefing.html must re-fetch when the terms gate had to appear — the parallel request was made before acceptance existed',
  );
});

test('enforceTerms still reports which case it was', () => {
  // briefing.html depends on 'already' specifically. A refactor that went back
  // to returning true would make the re-fetch branch dead and silently serve a
  // 403 page to anybody accepting the terms for the first time.
  const gate = readFileSync('public/terms-gate.js', 'utf8');
  assert.ok(gate.includes("return 'already'"), "terms-gate must return 'already' when nothing was shown");
  assert.ok(gate.includes("resolve('accepted')"), "terms-gate must resolve 'accepted' after acceptance");
  assert.ok(gate.includes("return 'skipped'"), "terms-gate must return 'skipped' when the check itself failed");
});
