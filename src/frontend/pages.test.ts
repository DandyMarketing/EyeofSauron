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

/**
 * EVERY page that signs a person in must load the fast way — including the one
 * somebody adds next year.
 *
 * DISCOVERED, NOT LISTED, and that is the entire point. This began as four
 * hardcoded filenames, which covers exactly the pages that already existed and
 * silently exempts every future one — the same shape as the test that skipped
 * plan.html for being a module and reported a pass. The rule is applied to any
 * page that touches the auth client, so a new page is covered by existing, not
 * by somebody remembering to add it here.
 *
 * None of these is a style preference. Each one was a measured cost:
 *   - a serial /api/config is a whole round trip for two public strings, spent
 *     before the 60 KB download that is the expensive half has even started;
 *   - a missing modulepreload means that download cannot BEGIN until the entire
 *     document has parsed, because a dynamic import() is invisible to the
 *     browser's preload scanner (measured: it starts at 23ms with the link, and
 *     the script that would ask for it does not run until 26ms);
 *   - a third-party module host put 302ms of TLS on the critical path of every
 *     page, for a 531-byte file that then fetched seven more.
 */
const authPages = pages.filter((p) =>
  readFileSync(`public/${p}`, 'utf8').includes("import('/vendor/supabase.js')"),
);

test('every page that signs someone in was found', () => {
  // A filter that matched nothing would make every check below pass by
  // examining nothing at all.
  assert.ok(authPages.length >= 5, `only found ${authPages.length} auth pages: ${authPages.join(', ')}`);
  for (const expected of ['index.html', 'login.html', 'admin.html']) {
    assert.ok(authPages.includes(expected), `${expected} no longer loads the auth client — check this test`);
  }
});

for (const page of authPages) {
  test(`${page}: loads the auth client without a serial round trip in front of it`, () => {
    const html = readFileSync(`public/${page}`, 'utf8');

    /**
     * The config must be resolved IN THE SAME Promise.all as the client import,
     * whether it comes from the inlined value or the fetch behind it. What is
     * forbidden is awaiting it first — that is the round trip at the front of
     * the chain that nothing else could start behind.
     */
    assert.match(
      html,
      /Promise\.all\(\[\s*\n\s*(window\.__SAURON_CONFIG__ \?\? )?fetch\('\/api\/config'\)/,
      `public/${page} resolves /api/config outside the Promise.all with the client import — that is a serial round trip`,
    );

    /**
     * And the config should be inlined, so in the normal case there is no
     * request at all. The fetch above is the fallback, not the path.
     */
    assert.ok(
      html.includes('<!--SAURON_CONFIG-->'),
      `public/${page} has no <!--SAURON_CONFIG--> marker — the server cannot inline the config, so every load pays a round trip for two public strings`,
    );
    assert.ok(
      html.includes('window.__SAURON_CONFIG__'),
      `public/${page} never reads the inlined config, so the marker is doing nothing`,
    );

    assert.ok(
      html.includes('rel="modulepreload" href="/vendor/supabase.js"'),
      `public/${page} has no modulepreload for /vendor/supabase.js — the download then waits for the whole document to parse`,
    );
  });
}

test('no page re-introduces a third-party origin', () => {
  // The front end is entirely self-hosted, which is a performance fact before
  // it is a privacy one: a cold third-party origin costs DNS, TCP and TLS on
  // the critical path, and none of that is under our control.
  for (const page of pages) {
    const html = readFileSync(`public/${page}`, 'utf8');
    const externals = [...html.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/([^/"']+)/gi)].map(m => m[1]);
    const imports = [...html.matchAll(/import\(\s*["']https?:\/\/([^/"']+)/gi)].map(m => m[1]);
    assert.deepEqual(
      [...externals, ...imports],
      [],
      `public/${page} loads from ${[...externals, ...imports].join(', ')} — vendor it into public/vendor/ instead`,
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

test('a page using the hidden attribute also neutralises display rules', () => {
  /**
   * `hidden` works by the BROWSER's stylesheet setting `display: none`, and any
   * author rule that sets display beats it. `#history-panel { display: flex }`
   * left the chat's conversation dropdown permanently on screen, covering the
   * header — and because the list only loads when the panel is opened through
   * its own function, it sat on "Loading…" for ever while the control that
   * would have opened it properly was underneath it.
   *
   * Shipped, and reported as "cannot load". The cause was invisible from the
   * symptom, which is why the rule is asserted rather than remembered: any page
   * relying on `hidden` needs the reset, and the next element with a display
   * rule will hit exactly this.
   */
  for (const page of readdirSync('public').filter(f => f.endsWith('.html'))) {
    const html = readFileSync(`public/${page}`, 'utf8');

    // Only pages that actually use the attribute on an element.
    if (!/<[a-z-]+[^>]*\shidden(\s|>)/i.test(html)) continue;

    assert.match(
      html,
      /\[hidden\]\s*\{[^}]*display:\s*none/,
      `public/${page} uses the hidden attribute but has no "[hidden] { display: none }" reset — ` +
        `any element it hides that also has a display rule will stay on screen`,
    );
  }
});

/**
 * ONE markdown renderer, and no page may keep a private copy.
 *
 * There were three, at 3934, 2704 and 1493 characters, and the drift had
 * already cost real behaviour — plan.html rendered no italics at all, so the
 * definition line would have shown its asterisks on that page alone;
 * briefing.html left a broken-image icon where index.html substituted the alt
 * text; plan.html escaped its input and the other two did not, so the same
 * model output was trusted differently depending on where it landed.
 *
 * Each of those was invisible from the page it broke, which is why this is a
 * test and not a convention.
 */
const markdownPages = pages.filter((p) =>
  readFileSync(`public/${p}`, 'utf8').includes('renderMarkdown('),
);

test('every page that renders an answer was found', () => {
  assert.ok(markdownPages.length >= 3, `only found ${markdownPages.length}: ${markdownPages.join(', ')}`);
  for (const expected of ['index.html', 'briefing.html', 'plan.html']) {
    assert.ok(markdownPages.includes(expected), `${expected} no longer renders markdown — check this test`);
  }
});

for (const page of markdownPages) {
  test(`${page}: uses the shared renderer rather than its own`, () => {
    const html = readFileSync(`public/${page}`, 'utf8');

    assert.ok(
      !/function renderMarkdown\s*\(/.test(html),
      `public/${page} has its own renderMarkdown again — that is how three copies drifted apart`,
    );
    assert.ok(
      !/function wholeItalicBlock\s*\(/.test(html),
      `public/${page} has its own copy of wholeItalicBlock`,
    );
    assert.ok(
      html.includes('<script src="/markdown.js"></script>'),
      `public/${page} calls renderMarkdown but never loads it — the page will throw`,
    );

    /**
     * Loaded BEFORE the page's own script, and as a classic script.
     *
     * A `src` script is visible to the preload scanner so it starts during the
     * parse, where a dynamic import() could not begin until the parse finished.
     * Classic rather than a module because two of these pages have plain inline
     * scripts, which cannot import.
     */
    assert.ok(
      html.indexOf('<script src="/markdown.js">') < html.indexOf('renderMarkdown('),
      `public/${page} loads the renderer after the code that calls it`,
    );
    assert.ok(
      !/<script[^>]+src="\/markdown\.js"[^>]*type="module"/.test(html),
      `public/${page} loads the renderer as a module, so window.renderMarkdown is never set`,
    );
  });

  test(`${page}: styles the two classes the shared renderer emits`, () => {
    // The renderer is shared; the styling is not, so a page that gains it must
    // bring the rules or the output arrives unstyled.
    const html = readFileSync(`public/${page}`, 'utf8');
    assert.match(
      html,
      /\.figure-note\s*\{[^}]*font-size:\s*0?\.8em[^}]*\}/s,
      `public/${page} has no smaller font for .figure-note — definitions compete with the analysis`,
    );
    assert.match(
      html,
      /\.figure-note\s*\{[^}]*color:\s*var\(--text-muted\)[^}]*\}/s,
      `public/${page} does not mute the definition line`,
    );
    assert.match(
      html,
      /\.post-thumb\.expired\s*\{/,
      `public/${page} has no rule for an expired thumbnail — a dead Instagram url leaves a broken icon`,
    );
  });
}

test('the shared renderer escapes before it does anything else', () => {
  /**
   * index.html and briefing.html passed model text straight into innerHTML.
   * Nothing exploited it, but the text is not purely the model's: finance notes
   * typed by staff on the Monday board and Instagram captions both travel
   * through an answer, and the renderer cannot tell them apart.
   */
  const md = readFileSync('public/markdown.js', 'utf8');
  assert.match(md, /let html = escapeHtml\(text\);/, 'the renderer no longer escapes its input');
  assert.ok(
    md.indexOf('let html = escapeHtml(text)') < md.indexOf("html.replace(/^#### "),
    'escaping must happen before any markup is produced',
  );
  // https only, or a url becomes an attribute in a live document.
  assert.match(md, /\/\^https:\\\/\\\/\/i\.test\(u\)/, 'safeUrl no longer allowlists https');
});

/**
 * The home page IS the dashboard, and the chat moved to /chat.html.
 *
 * Done by renaming rather than by routing: `serveStatic` serves index.html at
 * `/`, so the file that is index.html is the home page and there is no route to
 * get wrong. That makes it easy to undo by accident too, which is why it is
 * asserted.
 *
 * The brief's reason for the move: "the dashboard and the AI advice must live
 * in one integrated surface" — the analytics are table stakes and the
 * recommendations are the product, so splitting them across two tabs is the one
 * thing it says not to do.
 */
test('the home page is the dashboard', () => {
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /<title>Dashboard - Sauron<\/title>/, 'index.html is no longer the dashboard');
  assert.ok(home.includes("fetch('/api/dashboard'"), 'the home page does not load the dashboard');
  assert.ok(pages.includes('chat.html'), 'chat.html is gone — the chat has nowhere to live');
});

test('the dashboard loads its data and its advice in parallel, not in a chain', () => {
  /**
   * This is the page people open most, on a phone on mobile data between
   * services. The dashboard read touches two weeks of daily_operations and
   * reservations across every venue in scope; putting the terms check or
   * /api/me in front of it was what made the briefing page slow (BUILD_LOG 5.6).
   */
  const home = readFileSync('public/index.html', 'utf8');
  const dashAt = home.indexOf('const dash = fetchDashboard();');
  const recsAt = home.indexOf('const recs = fetchRecommendations();');
  const gateAt = home.indexOf("const gate = import('/terms-gate.js')");
  const meAt = home.indexOf("const mePromise = fetch('/api/me'");

  assert.ok(dashAt > 0, 'the dashboard fetch is no longer started early');
  assert.ok(recsAt > dashAt, 'the recommendations fetch should start alongside, not before');
  assert.ok(gateAt > dashAt && meAt > dashAt, 'the terms gate and /api/me must not be awaited in front of the data');

  // And the correctness half: a gate that had to appear means both requests
  // were issued before an acceptance existed and were correctly refused.
  assert.ok(
    home.includes("terms === 'already'"),
    'the dashboard must re-fetch when the terms gate had to appear — speed must not change an answer',
  );
});

test('every page offers the dashboard, and none still calls / the chat', () => {
  // The nav is hand-written on each page, so a new page is the obvious place
  // for this to drift. A link reading "Chat" that points at / now lands on the
  // dashboard, which is the confusing half-migration worth preventing.
  for (const page of ['chat.html', 'briefing.html', 'plan.html', 'admin.html']) {
    const html = readFileSync(`public/${page}`, 'utf8');
    assert.match(html, /<a href="\/"[^>]*>Dashboard<\/a>/, `public/${page} has no link to the dashboard`);
    assert.ok(
      !/<a href="\/"[^>]*>Chat<\/a>/.test(html),
      `public/${page} still labels / as "Chat" — it is the dashboard now`,
    );
  }
});

/**
 * The advice on the dashboard is about a DIFFERENT WEEK from the figures above
 * it, and the page has to say so.
 *
 * Khai, 4 Oct 2026: "the briefing is already 1 week old. It's for the previous
 * week so if the dashboard is for this week then that briefing is irrelevant.
 * It might confuse people."
 *
 * Right about the confusion, and the first version made it worse by heading the
 * panel "This week's advice" — which is false. The engine runs on
 * `lastCompleteWeek()` because only a quiet WEEK is news; the figures above are
 * week to date. They are not in conflict once labelled: you review the week
 * that closed and act during the week in progress.
 */
test('the dashboard names the period its advice covers', () => {
  const home = readFileSync('public/index.html', 'utf8');

  assert.ok(
    !/This week.s advice/.test(home),
    'the advice panel claims to be about this week — the engine reviews the week that CLOSED',
  );
  assert.match(home, /Advice from the week just reviewed/);
  // The actual dates, not just a word: "a completed week" with no period is
  // still something a reader has to take on trust.
  assert.ok(home.includes('fmtRange(start, latest)'), 'the panel no longer prints the period it covers');
});

test('the dashboard never mixes two periods of advice under one heading', () => {
  /**
   * /api/recommendations returns up to 60 rows ordered by generated_at across
   * EVERY period, so taking the top three could silently put last week's advice
   * beside the week before's. Invisible, because each item is individually
   * correct.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.ok(
    home.includes('r.period_end === latest'),
    'the advice panel no longer filters to a single period',
  );
  assert.ok(
    home.includes("r.status !== 'dismissed'"),
    'dismissed advice is shown again — somebody already decided against it',
  );
});

test('stale advice is reported rather than dressed up as current', () => {
  // A complete week ends between one and seven days before any given day, so a
  // period older than ten means the weekly run has not fired. Showing
  // fortnight-old advice under a fresh heading is "it worked, it looked fine,
  // it was doing nothing".
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /ageDays > 10/);
  assert.match(home, /The weekly run has not produced anything newer/);
});

test('the engine is told not to call the reviewed week "this week"', () => {
  // The panel's label cannot fix prose inside the recommendation body. A
  // recommendation saying "discounts hit 6.1% this week" sitting under live
  // week-to-date figures names the wrong week.
  const prompt = readFileSync('src/ai/recommendation.ts', 'utf8');
  assert.match(prompt, /NEVER CALL IT "THIS WEEK"/);
  assert.ok(
    !/preparing this week's briefing/.test(prompt),
    'the prompt still frames the briefing as being about "this week"',
  );
});
