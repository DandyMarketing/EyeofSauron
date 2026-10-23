/**
 * A Query answer's tables as an Excel workbook (Khai, 23 Oct 2026, after issue
 * report 68ccfe2d: a user asked three times for the half-year table as Excel and
 * was told three times it was attached. No file existed -- Query had no way to
 * make one -- so the model invented the action, and on the third try invented
 * having checked it).
 *
 * THE TABLE ON THE SCREEN, NOT A SECOND QUERY. The page sends the cells of the
 * tables it rendered, read off the DOM, and this lays them out. So the file
 * cannot say anything the answer did not, and a table the model assembled from
 * nine separate queries -- the case that was reported -- exports as it reads.
 * Re-running a tool instead would export one query's rows, which is a different
 * table from the one the person asked for.
 *
 * NOTHING IS READ FROM THE WAREHOUSE HERE, so there is nothing to scope: the
 * workbook holds what the browser already showed this person. Numbers are
 * turned back into numbers ("$5,974" -> 5974, formatted as money) so the sheet
 * can be summed and charted; anything that is not cleanly one number stays as
 * the text it was, because a guessed number is worse than a string.
 */

import ExcelJS from 'exceljs';

export interface AnswerTable {
  /** The heading above the table in the answer, if there was one. */
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface AnswerExport {
  question: string;
  /** The answer as text, paragraph by paragraph: definitions and caveats travel with the figures. */
  text: string[];
  tables: AnswerTable[];
}

/** Bounds on what a browser may send. A real answer is far inside every one. */
export const LIMITS = { tables: 20, rows: 2000, cols: 50, cell: 500, question: 500, lines: 400, line: 4000 };

const HEAD: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: 'FFFFFFFF' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } },
};

export interface Cell { value: string | number | Date; numFmt?: string }

const decimals = (s: string) => (s.includes('.') ? s.split('.')[1].length : 0);
const places = (n: number) => (n > 0 ? '.' + '0'.repeat(n) : '');

/**
 * One cell's text as Excel should hold it. Money, percentages, plain numbers
 * and ISO dates become values with a format that shows them as they were
 * written; everything else stays text. "87 (-13%)" is two figures and is NOT
 * a number -- it stays as written rather than losing half of itself.
 */
export function parseCell(raw: string): Cell {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // A unicode minus or en dash before a figure is a minus sign.
  const t = text.replace(/^[−–]/, '-').replace(/^([+-])\s+/, '$1');

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (d.getUTCMonth() === +iso[2] - 1) return { value: d, numFmt: 'yyyy-mm-dd' };
  }

  const money = /^([+-]?)S?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t);
  if (money) {
    const n = Number(money[2].replace(/,/g, '') + (money[3] ?? ''));
    const dp = money[3] ? money[3].length - 1 : 0;
    return { value: money[1] === '-' ? -n : n, numFmt: `"$"#,##0${places(dp)};-"$"#,##0${places(dp)}` };
  }

  const pct = /^([+-]?)(\d+(?:\.\d+)?)\s?%$/.exec(t);
  if (pct) {
    const n = Number(pct[2]);
    const dp = decimals(pct[2]);
    // Shown with the sign it was written with: a change column reads "+4.2%".
    const fmt = pct[1] === '+' ? `+0${places(dp)}"%";-0${places(dp)}"%";0${places(dp)}"%"` : `0${places(dp)}"%"`;
    return { value: pct[1] === '-' ? -n : n, numFmt: fmt };
  }

  const num = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t);
  if (num) {
    const n = Number(num[2].replace(/,/g, '') + (num[3] ?? ''));
    // A leading zero ("007", an id or a code) is text, not seven.
    if (/^0\d/.test(num[2])) return { value: text };
    const dp = num[3] ? num[3].length - 1 : 0;
    // Separators only where the answer wrote them: a year, 2022, is not "2,022".
    return { value: num[1] === '-' ? -n : n, numFmt: `${num[2].includes(',') ? '#,##0' : '0'}${places(dp)}` };
  }

  return { value: text };
}

/** Why a payload cannot be exported, or null when it can. */
export function invalidExport(p: any): string | null {
  if (!p || typeof p !== 'object') return 'Nothing to export.';
  if (!Array.isArray(p.tables) || p.tables.length === 0) return 'This answer has no table to export.';
  if (p.tables.length > LIMITS.tables) return `At most ${LIMITS.tables} tables can go in one file.`;
  for (const t of p.tables) {
    if (!t || !Array.isArray(t.headers) || !Array.isArray(t.rows)) return 'A table arrived without its rows.';
    if (t.rows.length > LIMITS.rows) return `A table has more than ${LIMITS.rows} rows.`;
    const width = Math.max(t.headers.length, ...t.rows.map((r: any) => (Array.isArray(r) ? r.length : Infinity)));
    if (!Number.isFinite(width)) return 'A table row arrived in the wrong shape.';
    if (width > LIMITS.cols) return `A table has more than ${LIMITS.cols} columns.`;
    const cells = [t.caption, ...t.headers, ...t.rows.flat()];
    if (cells.some((c: any) => c != null && (typeof c !== 'string' || c.length > LIMITS.cell))) return 'A table cell is too long or not text.';
  }
  if (p.text != null && (!Array.isArray(p.text) || p.text.length > LIMITS.lines || p.text.some((l: any) => typeof l !== 'string' || l.length > LIMITS.line))) {
    return 'The answer text arrived in the wrong shape.';
  }
  if (p.question != null && typeof p.question !== 'string') return 'The question arrived in the wrong shape.';
  return null;
}

/** A worksheet name Excel accepts: 31 characters, none of []:*?/\, unique in the book. */
export function sheetName(wanted: string | undefined, index: number, taken: Set<string>): string {
  const clean = (wanted ?? '').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
  let name = clean || `Table ${index + 1}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = (clean || `Table ${index + 1}`).slice(0, 31 - suffix.length).trim() + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

export function exportFileName(question: string, today: string): string {
  const full = (question || 'answer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Cut at a word, not through one.
  const slug = full.length <= 50 ? full : full.slice(0, 51).replace(/-[^-]*$/, '');
  return `sauron-${slug || 'answer'}-${today}.xlsx`;
}

export async function buildAnswerWorkbook(p: AnswerExport, today: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sauron';
  const question = (p.question ?? '').slice(0, LIMITS.question).trim();
  const taken = new Set<string>(['answer']);

  p.tables.forEach((t, i) => {
    const ws = wb.addWorksheet(sheetName(t.caption, i, taken), { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.getCell('A1').value = t.caption?.trim() || question || 'Sauron';
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value =
      `From Sauron's answer${question && t.caption ? ` to "${question}"` : ''}, exported ${today}. ` +
      'The figures are exactly as the answer showed them; definitions and caveats are on the Answer sheet.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

    const width = Math.max(t.headers.length, ...t.rows.map(r => r.length));
    const head = ws.getRow(4);
    for (let c = 0; c < width; c++) {
      const cell = head.getCell(c + 1);
      cell.value = t.headers[c] ?? '';
      cell.font = HEAD.font!;
      cell.fill = HEAD.fill!;
      cell.alignment = { wrapText: true, vertical: 'middle' };
    }

    const widths = Array.from({ length: width }, (_, c) => Math.max(10, (t.headers[c] ?? '').length + 2));
    t.rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      for (let c = 0; c < width; c++) {
        const raw = r[c] ?? '';
        const parsed = parseCell(raw);
        const cell = row.getCell(c + 1);
        cell.value = parsed.value;
        if (parsed.numFmt) cell.numFmt = parsed.numFmt;
        widths[c] = Math.max(widths[c], Math.min(60, raw.length + 2));
      }
    });
    widths.forEach((w, c) => { ws.getColumn(c + 1).width = w; });
  });

  // The words around the tables: what each figure means, and what not to read
  // into it. A spreadsheet forwarded without them is a set of numbers anyone can
  // compare with the wrong thing.
  const a = wb.addWorksheet('Answer');
  a.getColumn(1).width = 120;
  a.getCell('A1').value = question ? `Question: ${question}` : 'Sauron answer';
  a.getCell('A1').font = { bold: true, size: 13 };
  a.getCell('A2').value = `Exported from Sauron on ${today}.`;
  a.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };
  (p.text ?? []).filter(l => l.trim()).forEach((line, i) => {
    const cell = a.getCell(`A${4 + i}`);
    cell.value = line.trim();
    cell.alignment = { wrapText: true, vertical: 'top' };
  });

  return wb;
}
