/**
 * The one markdown renderer. Loaded by every page that shows an answer.
 *
 * WHY THIS FILE EXISTS. There were three copies of `renderMarkdown` -- in
 * index.html, briefing.html and plan.html -- and they had drifted to 3934, 2704
 * and 1493 characters. That is not a tidiness complaint. The drift had already
 * cost real behaviour, and each case was invisible from the page it broke:
 *
 *   - plan.html had NO single-asterisk rule, so italics arrived there as
 *     literal asterisks while the other two rendered them. A definition line --
 *     the thing added on 4 Oct 2026 so figures explain themselves -- would have
 *     shown its punctuation on that page alone.
 *   - index.html replaced a dead Instagram thumbnail with a link; briefing.html
 *     left a broken-image icon, which reads as data we lost.
 *   - plan.html escaped its input and the other two did not, so the same model
 *     output was trusted differently depending on which page it landed on.
 *   - a fix to the table rule had to be made three times, and the third was a
 *     separate edit that could simply have been forgotten.
 *
 * The codebase already learned this once: card-export.js says "two copies of an
 * exporter drift and the one that drifts is the one used less". This was three.
 *
 * LOADED AS A CLASSIC SCRIPT, deliberately, not a module. index.html and
 * briefing.html have plain inline scripts and plan.html has a module; a global
 * is visible to all three, whereas a static import is legal only in the module
 * and pages.test.ts rejects one in an inline module anyway. It is a `src`
 * script so the browser's preload scanner can start it while the document is
 * still parsing -- a dynamic import() could not begin until the parse finished.
 */

(function () {
  'use strict';

  /**
   * Escape FIRST, always, on every page.
   *
   * index.html and briefing.html passed the model's text straight into
   * innerHTML. Nothing exploited it, but the text is not purely the model's:
   * finance notes typed by staff on the Monday board and Instagram captions
   * both travel through an answer, and the renderer cannot tell them apart.
   *
   * This does NOT break the signed CDN urls it first appears to. `&` becomes
   * `&amp;`, and an HTML parser decodes entities inside an attribute value, so
   * `src="...?a=1&amp;sig=zz"` resolves to `...?a=1&sig=zz`. Verified in a
   * browser rather than reasoned about, because that assumption is exactly why
   * two of the three pages skipped escaping.
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /**
   * https only, and no quotes or angle brackets.
   *
   * This renderer writes into innerHTML, so a url is not text -- it is a live
   * attribute. `javascript:` would run, and a quote would end the attribute and
   * let anything follow. Allowlisted rather than blocklisted: everything that
   * is not plainly an https url becomes nothing.
   */
  function safeUrl(u) {
    return /^https:\/\//i.test(u) ? u.replace(/["'<>]/g, '') : '';
  }

  /**
   * A paragraph that is ENTIRELY italic is a definition line, not emphasis.
   *
   * Sauron puts "what each figure means" under a table in italics, and it has
   * to read as subordinate to the analysis rather than competing with it. The
   * page styles .figure-note smaller and muted. Detected from the markup, so
   * the model needs no special syntax and every page behaves the same.
   *
   * The test is that the block opens with <em> and the FIRST </em> also ends
   * it. "*A* and *B*" is two emphasised words in a sentence and stays a normal
   * paragraph.
   */
  function wholeItalicBlock(block) {
    if (!block.startsWith('<em>') || !block.endsWith('</em>')) return null;
    if (block.indexOf('</em>') !== block.length - 5) return null;
    return block.slice(4, -5);
  }

  /**
   * Split "| a | b |" into cells.
   *
   * Only the leading and trailing empties either side of the outer pipes are
   * dropped. An empty cell in the MIDDLE is a real column: discarding it shifts
   * every later value one place left, which once printed a row's covers under
   * "Avg Party Size".
   */
  function splitTableRow(row) {
    const parts = row.split('|');
    if (parts.length && parts[0].trim() === '') parts.shift();
    if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
    return parts.map(function (c) { return c.trim(); });
  }

  function renderMarkdown(text) {
    let html = escapeHtml(text);

    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    /**
     * Instagram signs its thumbnail urls and they expire within days. onerror
     * therefore swaps a dead image for its alt text rather than leaving a
     * broken-image icon, which reads as data we lost instead of a link that
     * aged out. briefing.html did not have this; now every page does.
     */
    html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      const safe = safeUrl(url);
      if (!safe) return '';
      const altText = String(alt).replace(/["'<>]/g, '');
      return '<img class="post-thumb" src="' + safe + '" alt="' + altText + '" loading="lazy" ' +
             'referrerpolicy="no-referrer" ' +
             'onerror="this.classList.add(\'expired\');this.alt=\'image expired\'">';
    });

    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, linkText, url) {
      const safe = safeUrl(url);
      if (!safe) return linkText;
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
    });

    // Bold before italic, or **x** is eaten as two single-asterisk spans.
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, function (m, headerRow, sepRow, bodyRows) {
      const headers = splitTableRow(headerRow);
      let table = '<table><thead><tr>';
      headers.forEach(function (h) { table += '<th>' + h + '</th>'; });
      table += '</tr></thead><tbody>';
      bodyRows.trim().split('\n').forEach(function (row) {
        if (!row.trim()) return;
        const cells = splitTableRow(row);
        // Pad short rows and drop overflow so every row keeps the header's
        // shape. A ragged row leaves a blank cell, never re-aligns the rest.
        while (cells.length < headers.length) cells.push('');
        table += '<tr>';
        for (let i = 0; i < headers.length; i++) table += '<td>' + cells[i] + '</td>';
        table += '</tr>';
      });
      table += '</tbody></table>';
      /**
       * The trailing '\n\n' matters. This regex consumes the newline that ENDED
       * the last row, so without it the next paragraph has a single newline in
       * front of it, never splits off as its own block, and is returned
       * verbatim inside the table's block -- losing its <p> entirely. It cost
       * every paragraph directly after a table its spacing, silently, and it
       * stopped the definition line from ever being seen as a paragraph.
       */
      return table + '\n\n';
    });

    /**
     * Lists, wrapped in the RIGHT container.
     *
     * The old versions turned "1." into a bare <li> AFTER wrapping the bullets,
     * so an ordered list rendered as loose <li> elements with no parent at all
     * -- no numbers, no indent. Both are marked here and the runs are wrapped
     * once, by type.
     *
     * `*` is accepted as a bullet as well as `-`: plan.html took both and the
     * other two did not, and a model that writes "* item" should not render a
     * stray asterisk on two pages out of three. Italics are already converted
     * above, so a whole-italic definition line no longer starts with an
     * asterisk and cannot be mistaken for a bullet here.
     */
    html = html.replace(/^[-*] (.+)$/gm, '\u0000UL\u0000<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '\u0000OL\u0000<li>$1</li>');
    // Each run ends its own block, for the same reason the table rule does:
    // the run regex swallows the newline after its last item, so without this
    // the next paragraph is glued to the list and loses its <p>.
    function wrapRuns(src, mark, tag) {
      const re = new RegExp('(?:\\u0000' + mark + '\\u0000<li>.*<\\/li>\\n?)+', 'g');
      return src.replace(re, function (run) {
        const items = run.split('\u0000' + mark + '\u0000').join('').trim();
        return '<' + tag + '>' + items + '</' + tag + '>\n\n';
      });
    }
    html = wrapRuns(html, 'UL', 'ul');
    html = wrapRuns(html, 'OL', 'ol');

    return html.split('\n\n').map(function (block) {
      block = block.trim();
      if (!block) return '';
      if (block.startsWith('<h') || block.startsWith('<ul') || block.startsWith('<ol') ||
          block.startsWith('<table') || block.startsWith('<img')) return block;
      const note = wholeItalicBlock(block);
      if (note !== null) return '<p class="figure-note">' + note.replace(/\n/g, '<br>') + '</p>';
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  window.renderMarkdown = renderMarkdown;
  // Exported for the tests, which check the pieces that have broken before.
  window.__md = { escapeHtml: escapeHtml, safeUrl: safeUrl, wholeItalicBlock: wholeItalicBlock, splitTableRow: splitTableRow };
})();
