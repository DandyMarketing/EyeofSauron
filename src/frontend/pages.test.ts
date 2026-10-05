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
  /**
   * The advice is now ONE LINE at the top that opens in place, not a panel in
   * the scroll — weekly content was taking daily screen space. The period still
   * has to be on it: the engine reviews a week that has CLOSED while the
   * figures below are whatever period is selected, and without the dates the
   * two read as a contradiction.
   */
  const home = readFileSync('public/index.html', 'utf8');

  assert.ok(
    !/This week.s advice/.test(home),
    'the advice claims to be about this week — the engine reviews the week that CLOSED',
  );
  assert.ok(home.includes('function adviceLine('), 'the advice is not a collapsible line');
  assert.match(home, /advice-when/, 'the summary line does not carry the period');
  assert.ok(home.includes('fmtRange(start, latest)'), 'the advice no longer prints the period it covers');
  assert.match(home, /you review the closed week and act during this one/);
});

test('the advice sits above the figures and the ask bar is pinned', () => {
  /**
   * Khai: "the briefing and advice from previous week needs to live
   * differently it's distracting and that ask function at the bottom is more
   * useful." The advice is weekly content in a daily surface, so it collapses;
   * the ask box is the only unbounded thing on the page and it was last, after
   * five panels.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const render = home.slice(home.indexOf("document.getElementById('app').innerHTML ="), home.indexOf('function tile('));

  assert.ok(
    render.indexOf('adviceLine(') < render.indexOf('periodChips('),
    'the advice should lead — the brief says the recommendations are the product',
  );
  assert.ok(home.includes('function askBar('), 'the ask box is not a pinned bar');
  assert.match(home, /\.askbar\s*\{[^}]*position: fixed/s, 'the ask bar is not fixed to the viewport');
  assert.match(home, /main \{ padding-bottom: \d+px; \}/, 'nothing reserves room for the bar, so it covers the last panel');
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
  assert.match(home, /The weekly run has produced nothing newer than this in/);
  // And it is visible from the collapsed line, or nobody opens it to find out.
  assert.match(home, /' · out of date'/);
  assert.match(home, /\.advice\.stale\s*\{/);
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

test('spend per head appears wherever average check does, and above it', () => {
  /**
   * Khai, 4 Oct 2026: "we only take average per person. You can put average
   * check there but it's not a priority. Average spend per head is a priority."
   *
   * The first version of the dashboard's detail table carried average check and
   * NO spend per head, which contradicts the brief in as many words: average
   * check is revenue per BILL, it rises simply because parties are larger, and
   * quoting it alone says as much about table mix as about how well a venue
   * sells. tools.ts: "report it as secondary context, never on its own."
   *
   * The order is the fix, not the presence — both belong on the page, and the
   * per-person one has to be the one the eye reaches first.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const sph = home.indexOf("['Spend per head'");
  const chk = home.indexOf("['Average check'");

  assert.ok(sph > 0, 'the dashboard table has no spend per head — the metric this business actually runs on');
  assert.ok(chk > 0, 'average check has gone entirely; it is useful context, just not the lead');
  assert.ok(sph < chk, 'average check is listed above spend per head — the per-person figure leads');

  // And in the headline tiles, where there is no room for both to be equal.
  assert.match(home, /tile\('Spend per head'/, 'spend per head is no longer a headline tile');
});

/**
 * Retention is on the dashboard, and it is a MONTHLY figure on a weekly page.
 *
 * It cannot be weekly: a week holds too few returning guests for the rate to
 * mean anything, which is why create_chart forces both retention measures to
 * monthly whatever it is asked for. The underlying function will happily
 * compute a week — that is the trap. It returns a number, the number is
 * arithmetically right, and it is not a measurement.
 */
test('the monthly panels are introduced by their month, not by the week above', () => {
  /**
   * The month used to sit in the retention panel's own heading. It moved to a
   * shared section heading when cost of sales joined it, because the page now
   * carries THREE periods -- this week to date, the last complete month, and
   * the week the advice reviewed -- and a reader on a phone will not track
   * three. The property is unchanged: the period is on the page rather than
   * implied by the figures above it.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.ok(home.includes('function retentionPanel('), 'the dashboard has no retention panel');
  assert.ok(home.includes('function costPanel('), 'the dashboard has no cost of sales panel');
  assert.ok(home.includes('function monthlySection('), 'the monthly panels are no longer introduced together');
  assert.match(home, /Last complete month · <strong>' \+ esc\(month\.label\)/, 'the month is not named above the monthly panels');
  assert.match(home, /Monthly, not weekly/, 'nothing tells the reader retention is not the week above it');
});

test('cost of sales shows what it could not classify, as a row', () => {
  /**
   * Cost-of-sales accounts that are neither food nor beverage by name are
   * EXCLUDED from both percentages, and an unmapped account looks identical to
   * packaging from the ratio. A food cost quoted while several thousand dollars
   * sits unexplained is the most misleading figure on the page, so it is a row
   * rather than a footnote.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /Not food or beverage/);
  assert.match(home, /Excluded from both percentages/);
  // And purchases-not-consumption, which is the first thing an operator asks.
  assert.match(home, /PURCHASES in the month, not consumption/);
});

test('a missing P&L says missing, never zero', () => {
  // "No P&L ingested" and "this venue had no costs" are wildly different
  // answers and only one of them is ever true.
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /It is missing, not zero/);
});

test('the guest mix is a pie, and every slice carries its count', () => {
  /**
   * Khai, 4 Oct 2026: "Guest retention can be represented as a pie chart." It is
   * the one shape a pie is actually right for — new, returning and crossed-from-
   * a-sister-venue are mutually exclusive and sum to the booked guests — and the
   * question being asked ("how much of my room is new") is a proportion before
   * it is a number.
   *
   * THE COUNTS SURVIVED THE REDRAW, which is the property this protects. Repeat
   * share FALLS when a venue attracts a lot of new guests, because they enlarge
   * the bottom of the fraction; a venue that has stopped winning anyone new
   * posts a rising retention rate all the way down. A pie of bare percentages
   * is read backwards even more easily than a table of them, so the total and
   * each slice's own count are on the page.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function retentionPanel('), home.indexOf('\nfunction advice'));

  assert.match(fn, /class="pie"/, 'the guest mix is not drawn as a pie');
  assert.match(fn, /New to the group/, 'the new-guest slice is gone');
  assert.match(fn, /Been here before/, 'the returning slice is gone');
  assert.match(fn, /From a sister venue/, 'the cross-venue slice is gone');

  // The denominator, and each slice's count beside its percentage.
  assert.match(fn, /num\(total\)/, 'the booked-guest total is not on the page');
  assert.match(fn, /num\(sl\.n\)/, 'the slices are percentages with no counts');
  assert.match(fn, /read it next to the booked-guest count/);

  /**
   * A slice of exactly the whole cannot be drawn as an arc — start and end
   * coincide and the path collapses. A venue with no returning guests at all
   * would render an empty circle, on live data, silently.
   */
  assert.match(fn, /frac >= 0\.9999/, 'a single full slice would draw as nothing');

  /**
   * WALK-INS ARE NOT A SLICE. They carry no booking so they cannot be matched to
   * a guest; including them would stop the parts summing to the whole, which is
   * the only thing a pie promises. They stay as a count beside it.
   */
  assert.match(fn, /Walk-ins/, 'walk-ins vanished with the table');
  assert.ok(!/label: 'Walk-ins'/.test(fn), 'walk-ins are a pie slice, so the parts no longer sum to the whole');
});

test('a month with too little history behind it is withheld, not shown low', () => {
  // Guests who did come back are invisible before the records start, so the
  // rate is understated — and the shortfall shrinks every month as history
  // fills, drawing a rise that is the database filling up.
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /if \(r\.withheld\)/);
  assert.match(home, /appear to improve every month as the records fill/);
});

test('the guest panel says which WINDOW "been here before" means', () => {
  /**
   * Khai, 4 Oct 2026: "perhaps it should be all time — people who had been
   * guest in our life time." Under the 365-day rule a guest who first came in
   * 2023 and ate here last month was counted as NEW TO THE GROUP, which is not
   * a cautious reading of the data but a false statement about somebody we have
   * a record of.
   *
   * The chart tools keep the 365-day window, deliberately, because a widening
   * lookback makes a TREND climb for no business reason. So the same words now
   * mean two windows on two surfaces, and the panel has to name its own — or
   * somebody reads 26% here and 18% on a chart and trusts neither again.
   *
   * AND IT NAMES THE DATE. "Ever" can only reach the first booking ingested, so
   * the horizon is printed rather than letting "before" sound absolute.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function retentionPanel('), home.indexOf('\nfunction advice'));
  assert.match(fn, /Ever, not just the last year/, 'the panel does not say which window it means');
  assert.match(fn, /r\.horizon && r\.horizon\.from/, 'the horizon date is never shown');

  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.match(lib, /p_lookback: LIFETIME_LOOKBACK_DAYS/, 'the dashboard still asks for a fixed year');
  // Per venue, because the earliest row across the group claims history behind
  // a venue that joined later.
  assert.match(lib, /\.eq\('venue_id', v\.id\)\.order\('business_date'/, 'one horizon is used for every venue');
});

test('the forward book counts EXPECTED covers, not completed ones', () => {
  /**
   * A future booking comes back from SevenRooms as status_simple 'Incomplete'
   * and never 'Complete', so any count keyed on completion reports ZERO for
   * every upcoming date. The live panel showed `TODAY 49, MON 0, TUE 0, WED 0`
   * at Neon Pigeon, which reads as nobody having booked all week — the worst
   * shape of wrong, because an empty book is a plausible thing for a dashboard
   * to be telling you and somebody would have acted on it.
   *
   * Both figures are now supplied per day and `serviceDays` picks between them
   * by where the date sits, so the test is that BOTH reach it — a strip built
   * from `covers` alone is the original bug and one built from `expected`
   * alone shows a past day's cancellations as covers that were served.
   */
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  const strip = lib.slice(lib.indexOf('const service = serviceDays('), lib.indexOf('const service = serviceDays(') + 900);
  assert.match(strip, /expected: c\?\.expected_covers \?\? 0/, 'the book is back on completed covers');
  assert.match(strip, /completed: c\?\.covers \?\? 0/, 'a settled day would show its bookings, not its covers');
});

test('the service strip labels each day with the basis its number is on', () => {
  /**
   * Khai, 4 Oct 2026: "if it's past current date you will look for the
   * uncompleted reservations, on the day you will take the snapshot at that
   * point and before is the completed."
   *
   * Three measurements in one row is only safe because each cell says which it
   * is. Today is the dangerous one: at 11am it is almost entirely book and at
   * 11pm almost entirely actual, and it looks identical throughout.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function servicePanel('), home.indexOf('function periodCostPanel('));

  assert.match(fn, /u\.basis === 'completed' \? 'actual'/, 'a settled day is not labelled');
  assert.match(fn, /'booked'/, 'a future day is not labelled');
  assert.match(fn, /class="basis"/, 'the basis is computed but never drawn');

  // The three-way split, which is the operational question the panel exists for.
  assert.match(fn, /eaten/);
  assert.match(fn, /in the room/);
  assert.match(fn, /still to come/);

  /**
   * A DIARY SPLIT MUST NOT LOOK LIKE A MEASUREMENT. Where no table has been
   * marked seated, "in the room" means "their slot has passed" — a schedule,
   * not an observation — and it is greyed for exactly that reason.
   */
  assert.match(fn, /s\.seating_tracked \? '' : ' diary'/, 'an estimate renders like a measurement');
  assert.match(home, /\.nowbar div\.est b \{/, 'the diary style is referenced but not defined');
  assert.match(fn, /s\.seating_tracked \? '' : ' class="est"'/, 'the book is greyed along with the estimates');
});

test('the snapshot says how old it is, measured on the server', () => {
  /**
   * A snapshot is the one figure on this page that is wrong within an hour of
   * being right, and an hourly ingest that died on Tuesday renders exactly like
   * one that ran a minute ago.
   *
   * ON THE SERVER'S CLOCK. Computing the age in the browser makes it depend on
   * the phone being set correctly — and a device an hour out would report a
   * dead ingest as fresh, which is the failure this is for.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function servicePanel('), home.indexOf('function periodCostPanel('));
  assert.match(fn, /v\.synced_label/, 'the page never shows how fresh the snapshot is');
  assert.ok(!/Date\.now\(\)/.test(fn), 'the sync age is computed from the browser clock');

  const lib = readFileSync('src/lib/service-day.ts', 'utf8');
  assert.match(lib, /export function syncAge/);
});

test('a failed retention read costs the panel, never the page', () => {
  // The RPC has timed out in production before (22 Sep 2026). A dashboard that
  // will not load because one panel could not be computed is the worse outcome.
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.match(lib, /async function buildRetention/);
  assert.ok(lib.includes('return null;'), 'buildRetention no longer degrades to null on failure');
  assert.match(lib, /console\.warn\(`\[dashboard\] retention/, 'a retention failure is silent');
});

/**
 * The period selector, and the reason the default moves.
 *
 * Khai, 4 Oct 2026: "we usually go through our previous week on Tuesday, this
 * rolling would not give an image of last week on Tuesday, is there a way to
 * fix that but still keep the rolling wtd."
 *
 * Week to date on a Tuesday is two days of trade, so a page that can only ever
 * show the week in progress cannot support the one review meeting that actually
 * happens. The server opens on the completed week on Monday and Tuesday and on
 * the week in progress from Wednesday.
 */
test('the dashboard offers four periods and lights the active one', () => {
  const home = readFileSync('public/index.html', 'utf8');
  for (const kind of ['wtd', 'last_week', 'mtd', 'last_month']) {
    assert.ok(home.includes(`'${kind}'`), `the ${kind} period is not offered`);
  }
  assert.ok(home.includes('function periodChips('), 'there is no period selector');
  assert.match(home, /p\[0\] === period \? ' on' : ''/, 'the active period is not marked');
});

test('the period comes back from the SERVER, not assumed by the page', () => {
  /**
   * The default moves with the day of the week, so a page that assumed "wtd"
   * would light the wrong chip on a Monday and label a completed week as the
   * week in progress. It reads window.kind out of the response instead.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /period = payload\.window\.kind;/, 'the page assumes a period rather than reading the one served');
  assert.match(home, /esc\(w\.label\)/, 'the heading does not follow the period');
});

test('an unknown period is rejected by the API rather than defaulted', () => {
  // It arrives as a query parameter, so it is user input. Falling back silently
  // would render one period under another one's label — the single thing this
  // page has had to be fixed for twice.
  const server = readFileSync('src/server.ts', 'utf8');
  assert.match(server, /!isPeriodKind\(requested\)/);
  assert.match(server, /bad_period/);
});

test('a comparison the figures cannot explain is shown, not buried', () => {
  /**
   * A span with one fewer Saturday, or a month end with no matching date in the
   * month before. Both land as a movement and neither is the business — 31 days
   * against 28 is about 10% more trading before anybody sells anything.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /w\.warnings && w\.warnings\.length/, 'period warnings are never rendered');
  assert.match(home, /\.window-warn\s*\{/, 'there is no style for a period warning, so it reads as body text');
});

/**
 * Cost of sales at the period's own grain, from supplier bills.
 *
 * Khai, correcting me: "a weekly cogs is based on the same week sales, invoices
 * are uploaded at their best daily." I had said a cost percentage could only be
 * monthly because the P&L's finest grain is a month. Bills carry a DATE, so the
 * purchases side always had daily resolution — the monthly limit belonged to
 * one source, not to the measurement.
 */
test('the dashboard shows a bill-derived cost for the selected period', () => {
  const home = readFileSync('public/index.html', 'utf8');
  assert.ok(home.includes('function periodCostPanel('), 'there is no period cost panel');
  assert.match(home, /payload\.period_costs/, 'the page never reads the bill-derived figures');
  // Beside the ledger one, not instead of it: bills are earlier and noisier,
  // the ledger is slower and settled.
  assert.ok(
    home.indexOf('periodCostPanel(payload, v, w)') < home.indexOf('monthlySection(payload, v)'),
    'the bill-derived panel should sit above the monthly ledger one, not replace it',
  );
});

test('an under-covered cost figure is never printed as a percentage', () => {
  /**
   * Measured at Neon Pigeon for June 2026: bills explain food purchases at
   * roughly 100% and COGS Beverages at ZERO — drink is bought on a card or
   * coded to inventory and journalled out later, so it never touches a bill.
   * Printed anyway, a beverage cost of 0.9% looks like the best bar in
   * Singapore. That is the most flattering way this product could lie.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /if \(!s\.usable\)/, 'an unusable figure is rendered the same as a usable one');
  assert.match(home, /only ' \+ pct\(s\.coverage_pct\) \+ ' on bills/, 'the coverage is not stated in place of the number');
  assert.match(home, /\.unusable\s*\{/, 'there is no style distinguishing an unusable figure');
  // And the coverage is beside every figure that IS shown.
  assert.match(home, /' covered<\/span>/);
});

/**
 * A chart with no numbers on it is decoration.
 *
 * Khai, 4 Oct 2026, looking at the live dashboard: "pointless having a chart
 * with no numbers on it." Right — the first version drew seven bars and
 * labelled none of them, so a reader could see that Wednesday beat Thursday and
 * could not tell you what either was worth. The decision an operator is making
 * is about money, not about a shape.
 */
test('the daily chart puts its figures on the bars', () => {
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));

  assert.match(fn, /k\(d\.gross_sales\)/, 'the bars carry no value label');
  assert.match(fn, /const k = n => n >= 1000/, 'there is no compact money format for a bar label');
  // And the story, in words, from the same rows the bars are drawn from.
  assert.match(fn, /Biggest day /);
  assert.match(fn, /Beverage ran highest on /);
});

test('a long period switches layout instead of overlapping', () => {
  /**
   * Month to date is up to 31 bars. A value above each one is mush and seven
   * weekday letters become thirty-one. Past ten bars it switches to gridlines
   * carrying the scale and dates every seventh day — so a dense chart still has
   * numbers on it, just not one per bar.
   *
   * The switch is on the DATA, not the period NAME, so a part-week and a
   * part-month both land in the right layout.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));

  assert.match(fn, /const dense = days\.length > 10;/, 'the layout no longer adapts to the number of days');
  assert.match(fn, /\[0, 0\.5, 1\]\.forEach/, 'a dense chart has no gridlines, so it has no scale at all');
  assert.match(fn, /i % 7 === 0/, 'a dense chart labels every day, which is unreadable at 390px');
});

test('a closed day is never drawn as a zero bar', () => {
  // A zero draws as a collapse, and Firangi closes every Sunday. The chart
  // layer already has this rule and the dashboard must not disagree with it.
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));
  assert.match(fn, /if \(d\.gross_sales === null\)/);
  assert.match(fn, /'closed'/);
});

test('the chart shows the mix in the same bars as the daily shape', () => {
  /**
   * Khai: "Chart needs relevant numbers to tell the story it can show the daily
   * breakdown on the chart the mix all in 1." Two charts would be two scrolls on
   * a phone, and the question is a single one — was Friday big, and was it big
   * on drink.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));

  assert.match(fn, /FOOD_FILL/, 'the bars are not split by class');
  assert.match(fn, /BEV_FILL/);
  assert.match(fn, /d\.food_sales/, 'the food segment is not drawn from the food figure');
  assert.match(home, /\.legend\s*\{/, 'there is no legend, so the two colours mean nothing');
});

test('the stack sums to its own label, not to net sales', () => {
  /**
   * The mix is defined on food + beverage. Labelling a stack of those two with
   * NET sales would put a number above a bar that its own segments do not add
   * up to — net carries the service charge and is net of discounts. That is
   * worse than no stack at all, and it is the kind of thing nobody would catch
   * by eye because both figures are real.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));

  assert.match(fn, /const totals = days\.map\(d => d\.gross_sales\)/, 'the scale is not the stacked total');
  assert.match(fn, /\(d\.gross_sales \/ max\)/, 'the bar height is not drawn from the stacked total');
  // And the page has to say the tiles are a different quantity.
  assert.match(fn, /Net sales in the tiles above is a different figure/);
});

/**
 * The ask bar answers HERE, and does not just move the question somewhere else.
 *
 * Khai, 4 Oct 2026: "What is the point of the ask if you just move it to the
 * chat." None — it prefilled a box on another page, which is a worse version of
 * tapping Chat, and it cost the reader the numbers they were asking about. The
 * answer now arrives on top of the figures that prompted it, which is also what
 * the brief means by the dashboard and the advice living in one surface.
 */
test('the dashboard answers in place rather than navigating away', () => {
  const home = readFileSync('public/index.html', 'utf8');

  assert.ok(home.includes('async function askNow('), 'the dashboard does not ask anything itself');
  assert.match(home, /fetch\('\/ask\/stream'/, 'the dashboard does not call the engine');
  assert.ok(
    !/location\.href = '\/chat\.html\?q=/.test(home),
    'the ask bar still navigates to the chat — that is the thing it was fixed for',
  );
  assert.match(home, /id="ask-sheet"/, 'there is nowhere for the answer to appear');
});

test('the question the server was sent is shown, not hidden', () => {
  /**
   * The venue and the period are appended to the question, because "why was
   * Thursday quiet" is unanswerable without knowing which Thursday and whose —
   * /ask takes a question and history and nothing else. Adding to somebody's
   * words without showing them is how a figure ends up answering a question
   * nobody asked.
   */
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /const context = v\.slug === 'group'/, 'no venue or period context is attached');
  assert.match(home, /class="ask-ctx"/, 'the appended context is never shown to the reader');
  assert.match(home, /question \+ '\\n\\n' \+ context/, 'the context is not actually sent');
});

test('a stream that cannot be had falls back to the plain route', () => {
  /**
   * This is the first page people open. A stream-only feature failing where a
   * proxy buffers SSE would read as the product being down rather than one
   * route being — the same rule as the web-search tool costing the feature and
   * never the chat.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('async function askNow('), home.indexOf('function askBar('));
  assert.match(fn, /fetch\('\/ask', \{ method: 'POST'/, 'there is no non-streaming fallback');
  assert.match(fn, /Could not reach Sauron/, 'a dead network reports nothing to the reader');
});

test('continuing in chat carries the thread, not a blank box', () => {
  // Otherwise the follow-up starts a new conversation with no memory of what
  // was just asked — the version of this that looks helpful and is not.
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /\/chat\.html' \+ \(askConversationId \? '\?c=' \+ encodeURIComponent\(askConversationId\)/);

  const chat = readFileSync('public/chat.html', 'utf8');
  assert.match(chat, /params\.get\('c'\)/, 'the chat ignores the thread it is handed');
  assert.match(chat, /openConversation\(thread\)/, 'the chat does not open the handed-over thread');
});

test('each segment carries its own share of the day', () => {
  /**
   * Khai: "you can also put the %mix of the sales into the charts." The dollar
   * total says how big the day was; the split says what it was made of, which
   * is the thing that MOVES and the reason to look at the chart rather than the
   * table. Inside the block rather than beside it, so the colour does the
   * labelling and there is no legend lookup mid-bar.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));

  assert.match(fn, /const share = \(part, segTop, segH, fill\)/, 'segments carry no share label');
  assert.match(fn, /share\(d\.beverage_sales \?\? 0, top, bevH/);
  assert.match(fn, /share\(d\.food_sales \?\? 0, top \+ bevH, foodH/);
});

test('a segment too small for its label does not get one', () => {
  /**
   * A label taller than its own block hangs outside it and reads as belonging
   * to the segment next door — which on a stacked bar means reporting the
   * beverage share as the food share. A 3% sliver is self-evidently small
   * without a number on it, and the total above the bar is always there, so
   * nothing is ever left unlabelled.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));
  assert.match(fn, /if \(segH < 11\) return '';/, 'a share label is drawn whatever the segment height');
});

test('the legend carries the period mix, not just the colours', () => {
  // A key that only says which colour is which is a line of screen doing almost
  // nothing. With the share on it, it is also the anchor the per-bar
  // percentages move around.
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function chartPanel('), home.indexOf('function bookPanel('));
  assert.match(fn, /const periodFood = days\.reduce/);
  assert.match(fn, /sharePct\(periodBev\)/);
  assert.match(home, /\.legend b \{/, 'the legend share has no style, so it reads as part of the label');
});

/**
 * The six-month cost LINE is off, and the cost of computing it is off with it.
 *
 * Khai, 4 Oct 2026: "Cost of sales chart section not necessary no need the same
 * treatment for now." It is the most expensive thing the dashboard request could
 * ask for — six months of P&L and six months of product mix per venue — so a
 * payload field nobody draws is latency an operator on mobile data pays for
 * nothing. That is what this asserts: not merely that the panel is gone, but
 * that the queries behind it are not still running.
 *
 * `cost-trend.ts`, its tests and `buildCostTrend` all stay, because "for now"
 * is not "never" and the three wrong pictures they protect against (a missing
 * month drawn as 0%, a gap joined across, an axis anchored at zero) are still
 * the right answers whenever it comes back.
 */
test('the cost trend is not computed while nothing draws it', () => {
  const home = readFileSync('public/index.html', 'utf8');
  assert.ok(!home.includes('costTrendPanel('), 'the cost trend panel is back on the page');

  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.ok(!/await Promise\.all\(\[[^\]]*buildCostTrend/s.test(lib),
    'buildCostTrend still runs on every dashboard request');
  // Kept, not deleted — re-enabling must stay a one-line change.
  assert.match(lib, /async function buildCostTrend/, 'the builder was deleted rather than switched off');
});

/**
 * Forecast covers, under the service strip.
 *
 * Khai, 4 Oct 2026: "Next to make would be just under upcoming reservations,
 * forecasted reservations ... based on daily seasonality from previous year."
 * Then: "Build it but explain it." The method lives in src/lib/forecast.ts and
 * is tested there; these hold the panel and the wiring to what was decided.
 */
test('the forecast panel sits directly under the service strip', () => {
  const home = readFileSync('public/index.html', 'utf8');
  assert.ok(home.includes('servicePanel(v, w) + forecastPanel(payload, v)'),
    'the forecast is defined but not rendered under the service strip');
});

test('the forecast carries its track record on the panel', () => {
  /**
   * A forecast nobody scores is indistinguishable from a guess, and the number
   * that decides whether to call in another pair of hands is the one that most
   * needs its accuracy beside it — not in a report somebody might open.
   */
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function forecastPanel('), home.indexOf('function periodCostPanel('));
  assert.match(fn, /f\.accuracy/, 'the backtest is computed but not shown');
  assert.match(fn, /Typical miss/);
  assert.match(fn, /Last year(’|\\u2019)s way/, "Khai's method is not shown beside the one in use");
  assert.match(fn, /In range/, 'nothing says whether the range means what it says');
});

test('the forecast draws the book as a fact and the rest as an estimate', () => {
  const home = readFileSync('public/index.html', 'utf8');
  const fn = home.slice(home.indexOf('function forecastPanel('), home.indexOf('function periodCostPanel('));
  // The booked number is ALWAYS on the bar — inside when it fits, above when not.
  const booked = fn.match(/num\(d\.booked\)/g) ?? [];
  assert.ok(booked.length >= 2, 'a short bar loses its booked number');
  // A forecast below the book is a line across it, never a shorter bar: the
  // book is a fact and must not be drawn smaller than it is.
  assert.match(fn, /d\.mid < d\.booked/);
  // Last year's method, night by night, not only in the table.
  assert.match(fn, /d\.last_year !== null/);
  // A closed night says so in words.
  assert.match(fn, /closed<\/text>/);
});

test('the forecast starts from the same book the strip above prints', () => {
  /**
   * Two reads a few hundred milliseconds apart could disagree by a booking, and
   * a forecast built on 61 under a cell saying 62 is a discrepancy somebody
   * will spend ten minutes on.
   */
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.match(lib, /out\[i\]\.service\s*\n?\s*\.filter\(d => d\.basis === 'book'\)/, 'the forecast reads its own book');
});

test('a failed forecast costs the panel, never the page, and names the likely cause', () => {
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  const load = lib.slice(lib.indexOf('async function loadForecastInputs('), lib.indexOf('function assembleForecast('));
  assert.match(load, /051_cover_pickup\.sql/, 'an unapplied migration would look like a venue with no history');
  // And the panel wrapper turns any failure into a missing panel, logged.
  assert.match(lib, /console\.warn\(`\[dashboard\] \$\{name\} unavailable/);
});

/**
 * Speed, 4 Oct 2026. Khai: "The load of the dashboard is slower a lot."
 *
 * Measured locally on production-sized data: the forecast added ~260 ms of
 * query and ~250 ms of CPU, and the lifetime retention change nearly doubled
 * that query — all of it waiting behind the sales and covers batch, because the
 * panels that need only the DATE started only after it finished. These hold
 * the repair in place.
 */
test('the date-only panels start BEFORE the lookup the core waits on', () => {
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  const fn = lib.slice(lib.indexOf('export async function buildDashboard('), lib.indexOf('async function loadForecastInputs('));
  const firstAwait = fn.indexOf("await supabaseAdmin\n    .from('daily_operations')");
  assert.ok(firstAwait > 0, 'the data-through lookup has moved; update this test');
  for (const started of ['retentionCache.get(', 'costsCache.get(', 'forecastCache.get(', 'getDayMoments(', 'getClosedWeekdays(']) {
    const at = fn.indexOf(started);
    assert.ok(at > 0 && at < firstAwait, `${started} starts after the first await — serialised again`);
  }
});

test('the slow panels are cached by hour, and sales and covers never are', () => {
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  for (const c of ['retentionCache', 'costsCache', 'periodCostsCache', 'forecastCache']) {
    assert.match(lib, new RegExp(`const ${c} = new HourlyCache`), `${c} is gone`);
  }
  // The token is the Singapore day and hour: the ingest is hourly at most.
  assert.match(lib, /const token = `\$\{day\}\|\$\{hour\}`/);
  // The live figures must never pass through a cache.
  assert.ok(!/Cache\.get\([^)]*readOperations/.test(lib), 'sales were put behind the cache');
  assert.ok(!/Cache\.get\([^)]*getCovers/.test(lib), 'covers were put behind the cache');
});

test('an optional panel holds the page only briefly, and says when it is still coming', () => {
  /**
   * Cold, a panel gets a short grace after the core and then ships as "still
   * calculating". Without the page side of that it would fall through to its
   * EMPTY state — "no P&L ingested" about a figure seconds away.
   */
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.match(lib, /settleWithin\(c\.value, PANEL_GRACE_MS\)/);
  assert.match(lib, /pending\.push\(name\)/);

  const home = readFileSync('public/index.html', 'utf8');
  for (const [fn, key] of [
    ['retentionPanel', 'retention'], ['costPanel', 'costs'],
    ['periodCostPanel', 'period_costs'], ['forecastPanel', 'forecast'],
  ]) {
    const body = home.slice(home.indexOf(`function ${fn}(`), home.indexOf(`function ${fn}(`) + 400);
    assert.match(body, new RegExp(`calculating\\(payload, '${key}'`), `${fn} shows its empty state while still computing`);
  }
});

test('every load is measured, in the logs and in the browser', () => {
  const lib = readFileSync('src/lib/dashboard.ts', 'utf8');
  assert.match(lib, /console\.log\(\s*`\[dashboard\] \$\{timings\.total\.ms\}ms`/);
  const server = readFileSync('src/server.ts', 'utf8');
  assert.match(server, /c\.header\('Server-Timing'/);
});


/**
 * Where the answer sits. Khai, 5 Oct 2026: "the result covers the entire screen
 * so then no point, no place to reference. it should be side by side" — and on
 * mobile, "a certain % of the screen so you can still see the dashboard".
 *
 * An answer about the figures that hides the figures defeats the reason it is
 * on this page instead of in the chat.
 */
test('on a desktop the answer is a column BESIDE the dashboard, not over it', () => {
  const home = readFileSync('public/index.html', 'utf8');
  const wide = home.slice(home.indexOf('@media (min-width: 1100px)'), home.indexOf('@media (min-width: 1100px)') + 900);
  // The page makes room, so nothing is underneath the answer — header included.
  assert.match(wide, /body\.answer-open \{ padding-right: var\(--side-w\); \}/, 'the answer is laid over the dashboard');
  assert.match(wide, /body\.answer-open \.ask-sheet \{[^}]*top: 0; bottom: 0;[^}]*right: 0; width: var\(--side-w\)/s);
  // The ask bar sits under the dashboard, so a follow-up is typed beside its answer.
  assert.match(wide, /body\.answer-open \.askbar \{ right: var\(--side-w\); \}/);
});

test('on a phone the answer takes half the screen and can be expanded', () => {
  const home = readFileSync('public/index.html', 'utf8');
  const narrow = home.slice(home.indexOf('@media (max-width: 1099px)'), home.indexOf('@media (max-width: 1099px)') + 600);
  assert.match(narrow, /\.ask-sheet \{ max-height: 50vh; max-height: 50dvh; \}/, 'the sheet covers the dashboard again');
  // And the page behind can still scroll every panel into the visible half.
  assert.match(narrow, /body\.answer-open main \{ padding-bottom: calc\(50vh \+ 86px\)/);
  assert.match(home, /id="ask-size"/, 'a long answer cannot be expanded');
  assert.match(home, /classList\.toggle\('tall'\)/);
});

test('closing the answer, or re-rendering, gives the page its full width back', () => {
  const home = readFileSync('public/index.html', 'utf8');
  assert.match(home, /document\.body\.classList\.add\('answer-open'\)/);
  const removals = home.match(/document\.body\.classList\.remove\('answer-open'\)/g) ?? [];
  assert.ok(removals.length >= 2, 'a closed or re-rendered answer leaves an empty gutter');
});
