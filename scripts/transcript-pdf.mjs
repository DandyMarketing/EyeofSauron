import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright-core';

const REDACT_MONEY = process.argv.includes('--redact-money');

const SRC = '/home/user/EyeofSauron/docs/session-transcript.md';
const OUT = REDACT_MONEY
  ? '/home/user/EyeofSauron/docs/session-transcript-redacted.pdf'
  : '/home/user/EyeofSauron/docs/session-transcript.pdf';
const HTML_OUT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  REDACT_MONEY ? 'transcript-redacted.html' : 'transcript.html',
);

const MONTHS = ['January','February','March','April','May','June','July','August',
  'September','October','November','December'];

const prettyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

let md = fs.readFileSync(SRC, 'utf8');

// Drop the source H1 and the intro block; the title page carries them.
const lines = md.split('\n');
const firstTurn = lines.findIndex((l) => /^### (Claude|Khai)\s+·/.test(l));
const intro = lines.slice(0, firstTurn).join('\n');
md = lines.slice(firstTurn).join('\n');

// One turn names five individuals in the same sentence as their salary split.
// The project's own rule is that personal pay never leaves the building, and a
// document being handed outside is the case that rule exists for. The sentence
// keeps its meaning without the names.
const REDACTED = [];
const personal = (re, replacement) => {
  md = md.replace(re, (m) => { REDACTED.push(m); return replacement; });
};

personal(
  /fairuz, leong khai git, salvin and 2 interns salary nessim and mikhail/gi,
  'five named staff [names redacted]',
);

// A ledger line quoted verbatim to argue that the whole-ledger export is too
// revealing to ingest — carrying one employee's name, shift, hours and pay. The
// argument survives the redaction; the point being made was that the line
// exposes a person, and it does. This one goes from EVERY external copy, with
// or without the money redaction, because it is personal pay rather than a
// commercial figure.
personal(
  /Shawn Yap Wei Yang, SGD 140\.00/g,
  '[name redacted], SGD [pay redacted]',
);

// Commit trailers are dropped for an external copy. The Claude-Session line is
// a link into a private conversation, and the co-author line adds nothing to a
// document that is a Claude transcript from cover to last page. The markdown in
// the repository keeps both.
md = md.replace(/^(Co-Authored-By|Claude-Session):.*$\n?/gm, '');

// Turn headers become styled speaker bars. The rewrite happens AFTER markdown
// parsing, not before: injecting raw HTML into the markdown makes marked treat
// the paragraph following the blank line as part of the HTML block, and that
// paragraph's own markdown then renders as literal asterisks and backticks.
let turns = 0;
const body = marked
  .parse(md, { mangle: false, headerIds: false })
  .replace(
    /<h3[^>]*>\s*(Claude|Khai)\s*·\s*(\d{4}-\d{2}-\d{2})\s*<\/h3>/g,
    (_, who, iso) => {
      turns++;
      return `<h3 class="turn ${who.toLowerCase()}"><span class="who">${who}</span>` +
             `<span class="when">${prettyDate(iso)}</span></h3>`;
    },
  );

/**
 * Money redaction.
 *
 * The figure is REMOVED, not covered. A black rectangle drawn over a number in
 * a PDF editor leaves the number in the file, selectable and extractable by
 * anyone who copies the page; this rebuilds from the markdown, so the digits
 * never reach the PDF at all.
 *
 * Every box is the SAME WIDTH whatever it replaces. A box sized to its digits
 * tells the reader how many there were, which gives away the order of
 * magnitude — the one thing a redacted figure is meant to withhold.
 *
 * Three rules, and the narrowness is the point. Rule A is exact: every `$` in
 * this document introduces an amount, verified by listing them, so it cannot
 * mis-fire. Rules B and C are a checked list rather than a clever pattern,
 * because the obvious generalisation — a number near a money word — matches
 * years, account codes, migration numbers, HTTP statuses and row counts, and a
 * redaction that eats the account codes has destroyed the document to hide
 * nothing.
 */
const MONEY_RULES = [
  // A: anything carrying a currency symbol. The symbol stays; the amount goes.
  { re: /((?:US|S|SG)?\$)\s?\d[\d,]*(?:\.\d+)?[KkMm]?/g, keep: '$1' },
  // B: bare comma-grouped amounts written to the cent — 45,166.87, 11,246.00.
  { re: /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g, keep: '' },
  // B2: the same, spelled with a currency code instead of a symbol.
  { re: /\bSGD ?\d[\d,]*(?:\.\d+)?/g, keep: 'SGD ' },
  // C: checked exceptions — every bare figure in this document that is money,
  //    found by listing all of them and reading the sentence around each. The
  //    covers, guest counts, row counts, character counts, token limits,
  //    account codes and years that share the same shape are left alone.
  { re: /\b(?:12\.00|20\.80)\b/g, keep: '' },
  // 13,080 is a ledger line; the rest are one revenue decomposition printed
  //    as a fixed-width block. Each appears exactly once outside it.
  { re: /\b(?:13,080|48,210|42,905|5,305|4,180|1,020)\b/g, keep: '' },
  // …and the last term of that block, too short to match on its own.
  { re: /(Combined effect\s+−)105\b/g, keep: '$1' },
  { re: /\b[Tt]welve dollars\b/g, keep: '' },
  { re: /\btwenty dollars eighty\b/g, keep: '' },
  { re: /(rather than the )twelve(?= you expected)/g, keep: '$1' },
];

const BOX = '<span class="rd" aria-label="redacted"></span>';

function redactMoney(htmlIn) {
  let count = 0;
  // Split on tags so a replacement can never land inside an attribute or
  // corrupt the markup the parser just produced.
  const out = htmlIn
    .split(/(<[^>]*>)/)
    .map((seg) => {
      if (seg.startsWith('<')) return seg;
      for (const { re, keep } of MONEY_RULES) {
        seg = seg.replace(re, (...args) => {
          count++;
          const prefix = keep ? args[1] : '';
          return prefix + BOX;
        });
      }
      return seg;
    })
    .join('');
  return { html: out, count };
}

let moneyRedacted = 0;
let renderBody = body;
if (REDACT_MONEY) {
  const r = redactMoney(body);
  renderBody = r.html;
  moneyRedacted = r.count;
}

// Figures for the title page, read from the source rather than restated.
const coversMatch = intro.match(/Covers (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
const from = coversMatch ? prettyDate(coversMatch[1]) : '';
const to = coversMatch ? prettyDate(coversMatch[2]) : '';
const commits = (md.match(/^\*\*[0-9a-f]{7} · /gm) || []).length;

const css = `
  @page {
    size: A4;
    margin: 20mm 18mm 18mm 18mm;
  }
  @page :first { margin: 0; }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body {
    font-family: "Liberation Serif", Georgia, serif;
    font-size: 10.5pt;
    line-height: 1.5;
    color: #14181f;
    margin: 0;
  }

  /* ---- title page ---- */
  .cover {
    height: 297mm;
    box-sizing: border-box;
    padding: 60mm 24mm 24mm 24mm;
    page-break-after: always;
    break-after: page;
    border-top: 14mm solid #14181f;
  }
  .cover .eyebrow {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 9pt;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: #6b7280;
    margin: 0 0 14mm 0;
  }
  .cover h1 {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 30pt;
    line-height: 1.15;
    font-weight: 700;
    margin: 0 0 6mm 0;
    letter-spacing: -0.01em;
  }
  .cover .sub {
    font-size: 13pt;
    color: #374151;
    margin: 0 0 18mm 0;
    max-width: 120mm;
  }
  .cover dl {
    display: grid;
    grid-template-columns: 38mm 1fr;
    row-gap: 3.2mm;
    margin: 0 0 16mm 0;
    font-size: 10pt;
    max-width: 130mm;
  }
  .cover dt {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 8.5pt;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #6b7280;
    padding-top: 0.6mm;
  }
  .cover dd { margin: 0; color: #14181f; }
  .cover .note {
    border-left: 2.5pt solid #d1d5db;
    padding-left: 5mm;
    font-size: 9.5pt;
    color: #4b5563;
    max-width: 120mm;
  }
  .cover .note p { margin: 0 0 2.5mm 0; }

  /* ---- speaker bars ---- */
  h3.turn {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 10pt;
    font-weight: 700;
    margin: 9mm 0 3mm 0;
    padding: 1.6mm 3mm;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    break-after: avoid;
    page-break-after: avoid;
    break-inside: avoid;
  }
  h3.turn .when {
    font-weight: 400;
    font-size: 8.5pt;
    letter-spacing: 0.04em;
  }
  h3.turn.claude { background: #f3f4f6; color: #14181f; border-left: 3pt solid #14181f; }
  h3.turn.claude .when { color: #6b7280; }
  h3.turn.khai   { background: #14181f; color: #ffffff; border-left: 3pt solid #14181f; }
  h3.turn.khai .when { color: #b6bcc6; }
  h3.turn:first-of-type { margin-top: 0; }

  /* ---- headings inside a turn ---- */
  h1, h2, h4, h5, h6 {
    font-family: "DejaVu Sans", sans-serif;
    break-after: avoid;
    page-break-after: avoid;
    line-height: 1.3;
  }
  h1 { font-size: 15pt; margin: 7mm 0 2.5mm; }
  h2 { font-size: 12pt; margin: 6mm 0 2.5mm; font-weight: 700; }
  h4 { font-size: 10.5pt; margin: 5mm 0 2mm; }
  h5, h6 { font-size: 10pt; margin: 4mm 0 2mm; }

  p { margin: 0 0 3mm 0; orphans: 2; widows: 2; }
  strong { font-weight: 700; }

  ul, ol { margin: 0 0 3mm 0; padding-left: 6mm; }
  li { margin: 0 0 1.2mm 0; }

  a { color: #14181f; text-decoration: none; border-bottom: 0.5pt solid #9ca3af; }

  code {
    font-family: "DejaVu Sans Mono", monospace;
    font-size: 8.5pt;
    background: #f3f4f6;
    padding: 0.3mm 1mm;
    border-radius: 1mm;
    word-break: break-word;
  }
  pre {
    font-family: "DejaVu Sans Mono", monospace;
    font-size: 8pt;
    line-height: 1.42;
    background: #f7f8fa;
    border: 0.5pt solid #e0e3e8;
    border-left: 2.5pt solid #9ca3af;
    padding: 2.5mm 3mm;
    margin: 0 0 3.5mm 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  blockquote {
    margin: 0 0 3mm 0;
    padding-left: 4mm;
    border-left: 2pt solid #d1d5db;
    color: #4b5563;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 9pt;
    margin: 0 0 4mm 0;
    break-inside: avoid;
  }
  th, td {
    border: 0.5pt solid #d1d5db;
    padding: 1.4mm 2mm;
    text-align: left;
    vertical-align: top;
  }
  th {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 8.5pt;
    background: #f3f4f6;
    font-weight: 700;
  }

  hr {
    border: 0;
    border-top: 0.5pt solid #d1d5db;
    margin: 8mm 0;
  }

  img { max-width: 100%; }

  /* Fixed width on purpose: a box sized to the number it replaces leaks the
     magnitude of the number it replaces. */
  .rd {
    display: inline-block;
    width: 9mm;
    height: 0.92em;
    background: #14181f;
    vertical-align: -0.12em;
    border-radius: 0.4mm;
  }
  pre .rd, code .rd { width: 8mm; background: #14181f; }

  .cover .redacted-mark {
    margin: 0 0 8mm 0;
    padding: 3mm 4mm;
    background: #14181f;
    color: #ffffff;
    font-family: "DejaVu Sans", sans-serif;
    font-size: 9pt;
    max-width: 120mm;
  }
  .cover .redacted-mark strong {
    display: block;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: 8.5pt;
    margin-bottom: 1.5mm;
  }
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Project Sauron — working session transcript</title>
<style>${css}</style>
</head><body>
<section class="cover">
  <p class="eyebrow">The Dandy Collection</p>
  <h1>Project&nbsp;Sauron<br>Working session transcript${REDACT_MONEY ? '<br><span style="font-size:18pt;color:#6b7280;">Figures redacted</span>' : ''}</h1>
  <p class="sub">Building an AI business advisor for a multi-venue food&nbsp;&amp;&nbsp;beverage group.</p>
  <dl>
    <dt>Period</dt><dd>${from} &ndash; ${to}</dd>
    <dt>Dialogue turns</dt><dd>${turns}</dd>
    <dt>Commits</dt><dd>${commits}</dd>
    <dt>Participants</dt><dd>Khai Leong &middot; Claude&nbsp;Code</dd>
    <dt>Generated</dt><dd>${prettyDate(new Date().toISOString().slice(0, 10))}</dd>
  </dl>
  ${REDACT_MONEY ? `<div class="redacted-mark">
    <strong>Commercially redacted copy</strong>
    Every monetary amount has been removed and replaced with a fixed-width mark.
    The figures are absent from this file, not hidden beneath it. Percentages,
    ratios, cover counts and dates are unchanged, so the reasoning can still be
    followed.
  </div>` : ''}
  <div class="note">
    <p>The dialogue only. Tool calls, file contents and command output are excluded;
    what remains is the conversation and the reasoning in it.</p>
    <p>The commits this session produced are listed at the end, and each carries its
    own explanation of the decision behind it.</p>
  </div>
</section>
${renderBody}
</body></html>`;

fs.writeFileSync(HTML_OUT, html);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('file://' + HTML_OUT, { waitUntil: 'load' });
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `
    <div style="width:100%;font-family:DejaVu Sans,sans-serif;font-size:7pt;color:#9ca3af;
                padding:0 18mm;display:flex;justify-content:space-between;">
      <span>Project Sauron &mdash; working session transcript</span>
      <span class="pageNumber"></span>
    </div>`,
  margin: { top: '20mm', bottom: '16mm', left: '18mm', right: '18mm' },
});
await browser.close();

const bytes = fs.statSync(OUT).size;
console.log(`money=${moneyRedacted} redacted=${REDACTED.length} turns=${turns} commits=${commits} range=${from} .. ${to}`);
console.log(`wrote ${OUT} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
