/**
 * An answer's tables as an Excel file, for Query, Plan and Weekly Recommends
 * (issue report 68ccfe2d, 23 Oct 2026: asked three times for a table as Excel,
 * told three times it was attached, and no file existed).
 *
 * The tables are read off the page as RENDERED, so the file holds exactly what
 * the reader is looking at; /api/export/answer only lays them out. ONE module
 * for the three pages, for the reason card-export.js is one: two copies of an
 * exporter drift, and the one that drifts is the one used less.
 */

const cellText = el => el.textContent.replace(/\s+/g, ' ').trim();

/** Each table's heading, header row and body rows, in the order shown. */
export function answerTables(body) {
  return [...body.querySelectorAll('table')].map(table => {
    // The heading above the table names its sheet: the nearest h1-h4, or a
    // paragraph that is nothing but bold text, before the previous table.
    let caption = '';
    for (let el = table.previousElementSibling; el && el.tagName !== 'TABLE'; el = el.previousElementSibling) {
      const boldOnly = el.tagName === 'P' && el.children.length === 1 && el.firstElementChild.tagName === 'STRONG' &&
        cellText(el) === cellText(el.firstElementChild);
      if (/^H[1-4]$/.test(el.tagName) || boldOnly) { caption = cellText(el); break; }
    }
    const headers = [...table.querySelectorAll('thead th')].map(cellText);
    const rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(cellText));
    return { caption, headers, rows };
  });
}

/**
 * Build and download. `title` names the file and heads the Answer sheet: the
 * question in Query and Plan, the headline in Weekly Recommends.
 */
export async function downloadAnswerExcel(body, title, token, btn) {
  const label = btn.textContent;
  btn.textContent = 'Building...';
  btn.classList.add('working');
  try {
    // The words around the tables carry the definitions and caveats, so they
    // go in too, on their own sheet. A bar of buttons is not the answer.
    const text = [...body.querySelectorAll('p, li, h1, h2, h3, h4')]
      .filter(el => !el.closest('table') && !el.closest('.teach-bar'))
      .map(cellText)
      .filter(Boolean);
    const res = await fetch('/api/export/answer', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: title || '', text, tables: answerTables(body) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not build the Excel file.');
    }
    const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'sauron-answer.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    // Not revoked at once: Safari cancels a download whose URL disappears.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    console.error('[excel] export failed', e);
    alert((e && e.message) || 'Could not build the Excel file.');
  } finally {
    btn.textContent = label;
    btn.classList.remove('working');
  }
}
