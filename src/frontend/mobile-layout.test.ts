/**
 * The mobile layout rules, pinned after four real bugs were reported from a
 * phone on 3 Oct 2026 and reproduced at 390px.
 *
 * WHAT THIS TEST IS AND IS NOT. It cannot prove a layout — that took a browser,
 * and the numbers are recorded below and in BUILD_LOG. What it CAN do is hold
 * the specific constructs whose absence caused each bug, so the fix cannot be
 * undone by a tidy-up that looks harmless. Every assertion here corresponds to
 * something that was measured broken.
 *
 * The four, as reported:
 *   1. The five Meta probe buttons rendered on top of one another.
 *   2. The StaffAny date fields were white boxes on a dark page.
 *   3. An AI context note rendered ONE CHARACTER PER LINE, hundreds tall.
 *   4. The page scrolled sideways: 557px of content in a 375px viewport, so
 *      every table's right-hand column was unreachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const admin = () => readFileSync('public/admin.html', 'utf8');

test('a wrapping button row cannot overlap itself', () => {
  /**
   * The buttons were inline-block elements separated by a space. That is fine
   * while they fit on one line; when they wrap, an inline-block box taller than
   * the inherited line-height overlaps the line above it. Flex removes the
   * dependency on a font metric entirely.
   */
  const html = admin();
  assert.match(html, /\.btn-row\s*\{[^}]*display:\s*flex/, 'admin.html lost the .btn-row flex rule');
  assert.match(html, /\.btn-row\s*\{[^}]*flex-wrap:\s*wrap/, '.btn-row must wrap, or the buttons run off the screen instead');

  // And the two groups that were broken must actually be inside one.
  for (const id of ['meta-discover-btn', 'staffany-probe-btn']) {
    const at = html.indexOf(id);
    assert.ok(at > 0, `${id} is gone — check this test still describes the page`);
    const before = html.slice(Math.max(0, at - 700), at);
    assert.ok(
      before.includes('btn-row'),
      `the button group containing ${id} is not inside a .btn-row — on a phone those buttons will overlap`,
    );
  }
});

test('every input is styled, not just the ones inside a known form', () => {
  /**
   * `.invite-form input` and `.modal input` were styled; a bare `input` was
   * not. The two StaffAny date fields were the only inputs outside both, so
   * they rendered with the browser default — white, mid-dark-page.
   */
  const html = admin();
  assert.match(
    html,
    /\n\s*input\s*\{[^}]*background:\s*var\(--bg\)/,
    'admin.html has no bare `input` rule — a new input outside a styled form will render white',
  );
  assert.match(
    html,
    /\n\s*input\s*\{[^}]*color-scheme:\s*dark/,
    'without color-scheme: dark the date picker icon is drawn black on black by the browser, and CSS cannot reach it',
  );
});

test('a sentence is never broken mid-word', () => {
  /**
   * `.fname` began life holding filenames, where `word-break: break-all` is
   * right. The notes list reused the class for sentences, and once the column
   * was squeezed break-all rendered a note one character per line.
   */
  const html = admin();
  const rule = html.match(/\.file-item \.fname \{[^}]*\}/);
  assert.ok(rule, '.file-item .fname rule is gone');
  assert.ok(
    !rule[0].includes('break-all'),
    `word-break: break-all is back on .fname — it breaks sentences mid-word: ${rule[0]}`,
  );
  assert.ok(
    rule[0].includes('min-width: 0'),
    'without min-width: 0 the note cannot shrink and pushes the row wider than the phone',
  );
});

test('wide tables scroll themselves instead of widening the page', () => {
  const html = admin();

  // The wrapper, and the mechanism that puts every table inside one.
  assert.match(html, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/, 'admin.html lost the .table-scroll rule');
  assert.ok(html.includes('function makeTablesScrollable'), 'makeTablesScrollable is gone');
  assert.ok(html.includes('new MutationObserver'), 'the observer is gone — tables rendered after load would be left unwrapped');
  assert.ok(html.includes('watchForTables();'), 'watchForTables is never called, so nothing wraps anything');

  /**
   * The minimum must stay ON THE TABLE and not on the scrolling box. Putting
   * `display: block; overflow-x: auto` on a table that also carries
   * `min-width: 520px` makes the scrolling box 520px wide, which overflows a
   * 375px phone exactly as before — measured, computed style came back
   * `display=block overflowX=auto width=520px` with the page still 557px.
   */
  const matrix = html.match(/\.role-matrix table \{[^}]*\}/);
  assert.ok(matrix, '.role-matrix table rule is gone');
  if (matrix[0].includes('min-width')) {
    assert.ok(
      !/display:\s*block/.test(matrix[0]),
      'a table with a min-width must not also be the scrolling box — wrap it in .table-scroll instead',
    );
  }
});

test('the pages that render markdown tables all handle a wide one', () => {
  /**
   * index.html had this from the start; briefing.html and plan.html were simply
   * missed, and a six-column table of venue figures took plan.html to 409px of
   * content in a 375px viewport. These tables carry no min-width, so the table
   * itself may be the scrolling box — the admin page's wrapper is needed only
   * where a minimum exists.
   */
  const surfaces: [string, RegExp][] = [
    ['index.html', /\.bubble table \{[^}]*\}/],
    ['briefing.html', /\.rec-body table \{[^}]*\}/],
    ['plan.html', /\.msg\.agent \.bubble table \{[^}]*\}/],
  ];

  for (const [page, re] of surfaces) {
    const rule = readFileSync(`public/${page}`, 'utf8').match(re);
    assert.ok(rule, `${page}: the markdown table rule this test watches is gone`);
    assert.match(
      rule[0],
      /overflow-x:\s*auto/,
      `${page} has no overflow handling on its tables — a wide one widens the whole page on a phone`,
    );
    assert.match(
      rule[0],
      /display:\s*block/,
      `${page}: overflow-x does nothing on a table box without display: block`,
    );
  }
});

test('no page sets a fixed pixel width that a phone cannot honour', () => {
  /**
   * A `width: NNNpx` on a layout element is the simplest way to reintroduce
   * sideways scrolling. `min-width` is allowed — the role matrix needs one, and
   * it is handled by a scroll wrapper — but a hard width is not.
   *
   * OFF-CANVAS RULES ARE EXEMPT, and that exemption is specific rather than a
   * weakening. briefing.html stages the shareable PNG in an element held at
   * `position: fixed; left: -10000px`, sized to 760px so the exported image has
   * a fixed width whatever phone it was made on. It contributes nothing to the
   * page's layout. Matching it would have meant either a false failure every
   * run or deleting this check, and the second is how a check dies.
   */
  const offCanvas = (rule: string) => /left:\s*-\d{3,}px/.test(rule);

  for (const page of readdirSync('public').filter(f => f.endsWith('.html'))) {
    const html = readFileSync(`public/${page}`, 'utf8');
    const offenders: string[] = [];

    for (const block of html.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const [, selector, body] = block;
      if (offCanvas(body)) continue;
      for (const w of body.matchAll(/(?:^|[^-\w])width:\s*(\d{3,})px/g)) {
        if (Number(w[1]) > 420) offenders.push(`${selector.trim().split('\n').pop()} → ${w[1]}px`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `public/${page} sets a fixed width wider than a phone, and nothing can shrink it: ${offenders.join('; ')}`,
    );
  }
});
