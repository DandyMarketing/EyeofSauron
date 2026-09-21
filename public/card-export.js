/**
 * Turning a card on screen into something you can send.
 *
 * ONE MODULE, TWO SURFACES. This began inside briefing.html and the chat needed
 * the same thing: a table of figures and a chart that somebody wants to forward
 * to a manager. Copying it would have produced two exporters drifting apart,
 * and the one that drifts is always the one used less — so it moved here and
 * both pages import it.
 *
 * WHY BOTH A PDF AND AN IMAGE. A PDF arrives in WhatsApp as an attachment with
 * a filename, which on a phone between services is a thing nobody opens. An
 * image previews in the thread, so it gets read where it lands. The cost is
 * real and stated: an image's text is not selectable, searchable or
 * translatable, and a markdown table flattens into run-together prose. The
 * image is the sharing format; the PDF is the keeping format.
 */

const PNG_W = 1080;           /* WhatsApp shows this at full width without resampling. */
const PNG_PAD = 48;
const PNG_BG = '#14141f';
const PNG_TEXT = '#e4e4ef';
const PNG_MUTED = '#8888a0';
const PNG_ACCENT = '#e8933a';

/** Wrap text to a width, returning the lines. */
export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * An SVG string to an Image, at a known size.
 *
 * THE WIDTH ATTRIBUTE HAS TO BE REWRITTEN. chart-svg.ts emits
 * `width="100%"` with a viewBox and no height, which is right for a responsive
 * page and meaningless to an Image: a percentage has nothing to be a percentage
 * OF, and browsers fall back to a default box that is not the chart's shape. So
 * the viewBox is read and concrete pixel dimensions are set before serialising.
 */
export function svgToImage(svgText, width) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const box = (svg.getAttribute('viewBox') || '0 0 720 360').split(/[\s,]+/).map(Number);
  const ratio = box[3] > 0 ? box[3] / box[2] : 0.5;
  const height = Math.round(width * ratio);

  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const serialised = new XMLSerializer().serializeToString(svg);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialised);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img: img, width: width, height: height });
    // A chart that will not load loses the chart, not the image. The caller
    // treats a rejection as "draw the text without it".
    img.onerror = () => reject(new Error('chart image failed to load'));
    img.src = url;
  });
}


/**
 * A DOM table as aligned monospace lines.
 *
 * Monospace because alignment is what makes a table readable, and a
 * proportional font would leave the columns ragged. Padded to the widest cell
 * per column rather than to a fixed width, so a table of short values does not
 * sprawl across the image.
 */
export function tableLines(table) {
  const rows = [...table.querySelectorAll('tr')]
    .map(tr => [...tr.querySelectorAll('th, td')].map(c => c.textContent.trim()));
  if (rows.length === 0) return [];

  const cols = Math.max(...rows.map(r => r.length));
  const widths = [];
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(...rows.map(r => (r[i] ?? '').length));
  }

  const out = [];
  rows.forEach((row, i) => {
    out.push(
      row.map((cell, i2) => (i2 === cols - 1 ? cell : cell.padEnd(widths[i2] + 2))).join('').trimEnd(),
    );
    // A rule under the header, so the first row reads as labels rather than as
    // the first set of figures.
    if (i === 0 && table.querySelector('thead')) {
      out.push(widths.map(w => '-'.repeat(w)).join('  '));
    }
  });
  return out;
}

export async function cardToPng(card, opts = {}) {
  const headline = opts.headline ?? (card.querySelector('.rec-headline')?.textContent?.trim() || '');
  const tag = opts.tag ?? (card.querySelector('.rec-tag')?.textContent?.trim() || '');
  const confidence = opts.meta ?? (card.querySelector('.rec-confidence')?.textContent?.trim() || '');

  /**
   * The body as plain text, from the RENDERED element.
   *
   * Reading textContent off the DOM rather than re-parsing the markdown means
   * the image says exactly what the page says. A table becomes run-together
   * text, which is the honest limit of this format -- the PDF is where a table
   * survives, and the button beside this one is how you get it.
   */
  const bodyEl = opts.bodyEl ?? card.querySelector('.rec-body') ?? card;
  /**
   * Prose AND TABLES, in document order.
   *
   * This used to select only `p, li, h2, h3, h4`, which meant a table was
   * silently DROPPED — not flattened, as the comment here used to claim,
   * simply absent. On a briefing recommendation that was a quiet loss. On a
   * chat answer it is fatal: the reply people most want to forward is a table
   * of figures, and an image of it showing the prose and the chart but none of
   * the numbers looks complete and is not. A picture that omits the thing it
   * is a picture of is worse than no picture.
   */
  const blocks = [];
  for (const el of bodyEl?.querySelectorAll('p, li, h2, h3, h4, table') || []) {
    // A <p> inside a <td> would otherwise be emitted twice, once on its own and
    // once inside its table.
    if (el.tagName !== 'TABLE' && el.closest('table')) continue;

    if (el.tagName === 'TABLE') {
      const rows = tableLines(el);
      if (rows.length) blocks.push({ mono: true, lines: rows });
    } else {
      const text = el.textContent.trim();
      if (text) blocks.push({ mono: false, text });
    }
  }

  // Charts first, because their height decides the canvas height.
  const svgs = [...(bodyEl?.querySelectorAll('svg') || [])];
  const chartW = PNG_W - PNG_PAD * 2;
  const charts = [];
  for (const svg of svgs) {
    try {
      charts.push(await svgToImage(svg.outerHTML, chartW));
    } catch (e) {
      console.warn('[briefing] a chart could not be rasterised; the image will omit it', e);
    }
  }

  // Measured on a scratch context first: the canvas cannot be sized until the
  // text has been wrapped, and wrapping needs a context with the right fonts.
  const scratch = document.createElement('canvas').getContext('2d');
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  scratch.font = '600 40px ' + FONT;
  const headlineLines = wrapText(scratch, headline, chartW);

  const MONO = '23px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
  const HEAD_LH = 52, BODY_LH = 40, MONO_LH = 34;

  /**
   * Laid out before the canvas is sized, because the height cannot be known
   * until every line is wrapped, and wrapping needs a context with the right
   * font set on it.
   */
  const laid = [];
  for (const block of blocks) {
    if (block.mono) {
      scratch.font = MONO;
      // NOT wrapped. A table row that folds loses its alignment and stops being
      // a table; a long one is clipped by the canvas edge instead, which is
      // visibly wrong rather than quietly wrong.
      laid.push({ mono: true, lines: block.lines, lh: MONO_LH });
    } else {
      scratch.font = '26px ' + FONT;
      laid.push({ mono: false, lines: wrapText(scratch, block.text, chartW), lh: BODY_LH });
    }
  }
  let height = PNG_PAD
    + headlineLines.length * HEAD_LH
    + 18
    + 32                                    /* the tag row */
    + 24
    + laid.reduce((sum, b) => sum + b.lines.length * b.lh + 14, 0)
    + charts.reduce((sum, c) => sum + c.height + 28, 0)
    + 30                                    /* the footer line */
    + PNG_PAD;

  const canvas = document.createElement('canvas');
  canvas.width = PNG_W;
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = PNG_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // The accent rule down the left, so the image is recognisably the same object
  // as the card it came from.
  ctx.fillStyle = PNG_ACCENT;
  ctx.fillRect(0, 0, 8, canvas.height);

  let y = PNG_PAD + 8;

  ctx.fillStyle = PNG_TEXT;
  ctx.font = '600 40px ' + FONT;
  ctx.textBaseline = 'top';
  for (const line of headlineLines) { ctx.fillText(line, PNG_PAD, y); y += HEAD_LH; }

  y += 18;
  ctx.fillStyle = PNG_MUTED;
  ctx.font = '24px ' + FONT;
  ctx.fillText([tag, confidence].filter(Boolean).join('   ·   '), PNG_PAD, y);
  y += 32 + 24;

  ctx.fillStyle = PNG_TEXT;
  for (const block of laid) {
    ctx.font = block.mono ? MONO : '26px ' + FONT;
    for (const line of block.lines) { ctx.fillText(line, PNG_PAD, y); y += block.lh; }
    y += 14;
  }

  for (const chart of charts) {
    y += 28;
    // The chart is drawn for a dark app and carries no background of its own.
    ctx.fillStyle = '#14141c';
    ctx.fillRect(PNG_PAD, y, chart.width, chart.height);
    ctx.drawImage(chart.img, PNG_PAD, y, chart.width, chart.height);
    y += chart.height;
  }

  /**
   * Where it came from, on the image itself.
   *
   * An image gets forwarded past the person it was sent to, and a set of
   * figures with no source attached is exactly what this product exists to stop
   * people acting on.
   */
  y += 30;
  ctx.fillStyle = PNG_MUTED;
  ctx.font = '22px ' + FONT;
  ctx.fillText('Sauron · The Dandy Collection · ' + new Date().toISOString().split('T')[0], PNG_PAD, y);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      // toBlob hands back null on a tainted canvas. It should not happen -- the
      // SVG is inlined as a data URL with no external references -- but a null
      // here would otherwise surface as a File constructor error three frames
      // away from the cause.
      blob ? resolve(blob) : reject(new Error('canvas could not be exported — the chart may have tainted it'));
    }, 'image/png');
  });
}
