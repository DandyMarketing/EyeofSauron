/**
 * The shared markdown renderer, RUN rather than read.
 *
 * pages.test.ts asserts that every page loads this one file and keeps no copy
 * of its own. That is the structural half. This is the behavioural half: the
 * three copies drifted in ways that each produced wrong OUTPUT, and only output
 * catches that.
 *
 * It runs the real `public/markdown.js` inside a minimal DOM — the module needs
 * `document.createElement` for escaping and `window` to publish itself, and
 * nothing else. No browser, no test harness, same file the browser loads.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The smallest DOM that `markdown.js` needs: escapeHtml's textContent trick. */
function loadRenderer(): (text: string) => string {
  const win: any = {};
  const doc = {
    createElement() {
      return {
        _t: '',
        set textContent(v: string) {
          this._t = v;
        },
        get innerHTML() {
          // Exactly what a browser does with textContent -> innerHTML.
          return this._t
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
      };
    },
  };
  const src = readFileSync('public/markdown.js', 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(win, doc);
  assert.equal(typeof win.renderMarkdown, 'function', 'markdown.js did not publish renderMarkdown');
  return win.renderMarkdown;
}

const render = loadRenderer();

describe('the drift that three copies had produced', () => {
  test('italics render — plan.html had no rule for them at all', () => {
    // A definition line would have shown its asterisks on that page alone.
    assert.match(render('a *word* here'), /<em>word<\/em>/);
  });

  test('a wholly italic paragraph becomes a subordinate note', () => {
    const out = render('*Gross = food + beverage · Net = gross less discounts*');
    assert.match(out, /<p class="figure-note">Gross = food \+ beverage · Net = gross less discounts<\/p>/);
  });

  test('a sentence with two emphasised words stays a normal paragraph', () => {
    // The whole point of the "first </em> is the last thing" test: otherwise an
    // ordinary sentence is demoted to a footnote.
    const out = render('*Food* rose while *beverage* fell');
    assert.match(out, /^<p>/);
    assert.ok(!out.includes('figure-note'), out);
  });

  test('bold still wins over italic', () => {
    // Order matters: **x** parsed as italics first gives two empty spans.
    assert.match(render('**bold**'), /<strong>bold<\/strong>/);
    assert.ok(!render('**bold**').includes('<em>'), render('**bold**'));
  });

  test('a dead thumbnail degrades to its alt text, on every page now', () => {
    // briefing.html left a broken-image icon, which reads as data we lost
    // rather than a signed url that aged out.
    const out = render('![a plate](https://cdn.example/x.jpg)');
    assert.match(out, /class="post-thumb"/);
    assert.match(out, /onerror=/);
  });
});

describe('escaping, which two of the three pages skipped', () => {
  test('markup in the text is inert', () => {
    const out = render('look: <img src=x onerror=alert(1)>');
    assert.ok(!/<img/.test(out), out);
    assert.match(out, /&lt;img/);
  });

  test('a signed url survives escaping, which is why it was skipped', () => {
    /**
     * `&` becomes `&amp;`, and an HTML parser decodes entities inside an
     * attribute value, so the browser resolves the src back to the real url.
     * Verified in a real browser before this was changed.
     */
    const out = render('![x](https://cdn.example/x.jpg?a=1&sig=zz)');
    assert.match(out, /src="https:\/\/cdn\.example\/x\.jpg\?a=1&amp;sig=zz"/);
  });

  test('a non-https url is dropped rather than rendered', () => {
    // The renderer writes into innerHTML, so a url is a live attribute.
    assert.equal(render('[click](javascript:alert(1))').includes('<a '), false);
    assert.match(render('[click](javascript:alert(1))'), /click/);
  });
});

describe('tables', () => {
  const table = [
    '| Metric | Value |',
    '|---|---|',
    '| Gross sales | $3,639.00 |',
    '| Net sales | $3,759.26 |',
  ].join('\n');

  test('render as a real table', () => {
    const out = render(table);
    assert.match(out, /<table><thead><tr><th>Metric<\/th><th>Value<\/th><\/tr><\/thead>/);
    assert.match(out, /<td>Gross sales<\/td><td>\$3,639\.00<\/td>/);
  });

  test('an empty cell in the middle keeps its column', () => {
    // Dropping it shifts every later value one place left — which once printed
    // a row's covers under "Avg Party Size".
    const out = render(['| a | b | c |', '|---|---|---|', '| 1 |  | 3 |'].join('\n'));
    assert.match(out, /<td>1<\/td><td><\/td><td>3<\/td>/);
  });

  test('a short row leaves a blank cell rather than re-aligning the rest', () => {
    const out = render(['| a | b | c |', '|---|---|---|', '| 1 | 2 |'].join('\n'));
    assert.match(out, /<td>1<\/td><td>2<\/td><td><\/td>/);
  });

  test('the paragraph after a table is not swallowed by it', () => {
    /**
     * The table regex consumes the newline that ENDED the last row, so without
     * a trailing blank the next paragraph never splits off as its own block and
     * is returned verbatim inside the table's — losing its <p> entirely. It
     * cost every paragraph after a table its spacing, on all three pages.
     */
    const out = render(table + '\n\nBeverage carried the week.');
    assert.match(out, /<\/table><p>Beverage carried the week\.<\/p>/);
  });

  test('a definition line under a table is still recognised as a note', () => {
    // This is the case that found the bug above: it was being glued to the
    // table and never became a paragraph at all.
    const out = render(table + '\n\n*Gross = food + beverage*');
    assert.match(out, /<\/table><p class="figure-note">Gross = food \+ beverage<\/p>/);
  });
});

describe('lists', () => {
  test('bullets wrap in a ul', () => {
    assert.match(render('- one\n- two'), /<ul><li>one<\/li>\n?<li>two<\/li><\/ul>/);
  });

  test('an asterisk bullet works too — only plan.html used to accept it', () => {
    assert.match(render('* one\n* two'), /<ul><li>one<\/li>/);
  });

  test('a numbered list gets an ol, not loose li elements', () => {
    /**
     * Every old copy converted "1." to <li> AFTER wrapping the bullets, so an
     * ordered list rendered as orphaned <li> with no parent — no numbers, no
     * indent. Silent, and wrong on every page.
     */
    const out = render('1. first\n2. second');
    assert.match(out, /<ol><li>first<\/li>/);
    assert.ok(!/<ul><li>first/.test(out), out);
  });

  test('a bullet list and a numbered list do not merge into one container', () => {
    const out = render('- a\n\n1. b');
    assert.match(out, /<ul><li>a<\/li><\/ul>/);
    assert.match(out, /<ol><li>b<\/li><\/ol>/);
  });

  test('the internal list markers never reach the output', () => {
    // They are NUL-delimited so they cannot collide with real content, but a
    // leaked marker would be invisible in the DOM and corrupt the text.
    for (const input of ['- a\n- b', '1. a\n2. b', '- a\n\n1. b', 'plain text']) {
      assert.ok(!render(input).includes('\u0000'), input);
    }
  });
});

test('headings, through h4', () => {
  assert.match(render('# A'), /<h1>A<\/h1>/);
  assert.match(render('#### D'), /<h4>D<\/h4>/);
});

test('a plain paragraph keeps its line breaks', () => {
  assert.match(render('one\ntwo'), /<p>one<br>two<\/p>/);
});
