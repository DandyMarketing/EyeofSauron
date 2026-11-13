/**
 * Documents people upload to Query and Plan, turned into text (Khai, 13 Nov
 * 2026: "they sometimes may have a file they want to upload to compare with
 * something"). PDF, Excel/CSV and Word, decided with Khai.
 *
 * TEXT IS WHAT IS KEPT, never the file: the extracted text is stored with the
 * conversation for 30 days (conversation_files, migration 069) and the upload
 * itself is discarded once read. So everything that matters must survive into
 * the text -- tables as rows, a spreadsheet's every sheet, and the totals.
 *
 * TOTALS ARE COMPUTED HERE, NOT BY THE MODEL. Adding up four hundred rows is
 * exactly the arithmetic a model gets wrong while sounding sure, and Sauron's
 * rule is that no figure comes from the model's head. Each spreadsheet column
 * that is mostly numbers gets its sum and count, worked out over EVERY row --
 * including rows cut from the text to keep it within size -- and a row that
 * calls itself a total is left out of the sum and named, so a sheet's own
 * "Total" line is not counted twice.
 *
 * PURE apart from the parsers, so it is tested without a database or the API.
 * A scanned PDF has no text to extract; it comes back marked `needsVision`
 * and the server has Claude read it (file-store.ts).
 */
import XLSX from 'xlsx';
import JSZip from 'jszip';

export type FileKind = 'pdf' | 'spreadsheet' | 'docx';

/** 10 MB: a phone photo of a PDF is well under; a raw export of a year is not. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** About 30,000 tokens per file. Sent with every question in the conversation. */
export const MAX_TEXT_CHARS = 120_000;

export interface Extracted {
  kind: FileKind;
  text: string;
  /** "3 sheets, 412 rows" / "12 pages" -- shown on the file's chip. */
  summary: string;
  truncated: boolean;
  notes: string[];
  /** A PDF with no text layer (a scan): Claude must read the pages. */
  needsVision?: boolean;
  pages?: number;
}

/** What a file is, from its name; or a sentence saying why it cannot be read. */
export function kindOf(filename: string): FileKind | { error: string } {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) return 'spreadsheet';
  if (ext === 'docx') return 'docx';
  if (ext === 'doc') return { error: 'Old Word files (.doc) cannot be read. Open it in Word and save it as .docx, then upload that.' };
  if (['numbers', 'pages', 'key'].includes(ext)) return { error: 'Apple Numbers/Pages files cannot be read. Export it as Excel, PDF or Word first.' };
  return { error: 'Only PDF, Excel (.xlsx, .xls), CSV and Word (.docx) files can be uploaded.' };
}

export async function extractText(buf: Buffer, filename: string): Promise<Extracted> {
  const kind = kindOf(filename);
  if (typeof kind !== 'string') throw new Error(kind.error);
  if (kind === 'spreadsheet') return spreadsheetText(buf, filename);
  if (kind === 'docx') return docxText(buf);
  return pdfText(buf);
}

// --- spreadsheets ------------------------------------------------------------

const TOTAL_ROW = /^\s*(grand\s+|sub[\s-]?)?totals?\b/i;
const fmt = (n: number) => n.toLocaleString('en-SG', { maximumFractionDigits: 2 });

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, ' ').trim();
  // A comma inside a cell would split it in the CSV-ish output.
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ColumnTotal { column: string; sum: number; values: number }

/**
 * Sums for the columns that are mostly numbers, over every row below the
 * header. Rows that call themselves totals are skipped and counted.
 */
export function columnTotals(rows: unknown[][]): { totals: ColumnTotal[]; skippedTotalRows: number; headerRow: number } {
  const headerRow = rows.findIndex(r => r.some(c => c !== null && c !== undefined && String(c).trim() !== ''));
  if (headerRow < 0) return { totals: [], skippedTotalRows: 0, headerRow: -1 };
  const header = rows[headerRow];
  const width = Math.max(...rows.map(r => r.length));
  const sums = new Array(width).fill(0);
  const counts = new Array(width).fill(0);
  const filled = new Array(width).fill(0);
  let skipped = 0;
  for (const r of rows.slice(headerRow + 1)) {
    if (r.some(c => typeof c === 'string' && TOTAL_ROW.test(c))) { skipped++; continue; }
    for (let i = 0; i < width; i++) {
      const c = r[i];
      if (c === null || c === undefined || c === '') continue;
      filled[i]++;
      if (typeof c === 'number' && Number.isFinite(c)) { sums[i] += c; counts[i]++; }
    }
  }
  const totals: ColumnTotal[] = [];
  for (let i = 0; i < width; i++) {
    // Mostly numbers, and enough of them for a total to mean something.
    if (counts[i] >= 3 && counts[i] >= filled[i] * 0.8) {
      const name = header[i] !== null && header[i] !== undefined && String(header[i]).trim() ? String(header[i]).trim() : `Column ${XLSX.utils.encode_col(i)}`;
      totals.push({ column: name, sum: Math.round(sums[i] * 100) / 100, values: counts[i] });
    }
  }
  return { totals, skippedTotalRows: skipped, headerRow };
}

function spreadsheetText(buf: Buffer, filename: string): Extracted {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: filename.toLowerCase().endsWith('.csv') ? false : undefined });
  const notes: string[] = [];
  const sections: string[] = [];
  let truncated = false;
  let rowsAll = 0;
  const budgetPerSheet = Math.floor(MAX_TEXT_CHARS / Math.max(1, wb.SheetNames.length));

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false }) as unknown[][])
      .filter(r => r.some(c => c !== null && c !== ''));
    rowsAll += rows.length;
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const lines = rows.map(r => r.map(cellText).join(',').replace(/,+$/, ''));
    const { totals, skippedTotalRows } = columnTotals(rows);

    let body = '';
    let kept = 0;
    for (const line of lines) {
      if (body.length + line.length + 1 > budgetPerSheet) break;
      body += line + '\n';
      kept++;
    }
    const cut = kept < lines.length;
    if (cut) truncated = true;

    let section = `=== Sheet "${name}" (${rows.length} rows x ${width} columns) ===\n${body}`;
    if (cut) section += `[Rows ${kept + 1}-${rows.length} are NOT shown here, to keep the file within size. The column totals below still cover every row.]\n`;
    if (totals.length) {
      section += `Column totals, computed by Sauron's server over all ${rows.length - 1} data rows (numbers only)` +
        (skippedTotalRows ? `, leaving out ${skippedTotalRows} row(s) that call themselves a total` : '') + ':\n' +
        totals.map(t => `- ${t.column}: ${fmt(t.sum)} (${t.values} values)`).join('\n') + '\n';
    }
    sections.push(section);
  }
  if (truncated) notes.push('Some rows are too many to include as text; the totals cover every row, but a question about a particular row beyond those shown cannot be answered from this upload.');
  const sheets = wb.SheetNames.length;
  return {
    kind: 'spreadsheet',
    text: sections.join('\n'),
    summary: `${sheets} sheet${sheets === 1 ? '' : 's'}, ${rowsAll} rows`,
    truncated,
    notes,
  };
}

// --- Word ----------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e])
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

/** The visible text of a run of WordprocessingML: text, tabs and breaks. */
function runsText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>/g)) {
    out += m[1] !== undefined ? decode(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return out;
}

function paragraphText(p: string): string {
  const text = runsText(p).trim();
  if (!text) return '';
  const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? '';
  const level = style.match(/^Heading(\d)$/i)?.[1];
  if (level) return `${'#'.repeat(Math.min(6, Number(level)))} ${text}`;
  if (/<w:numPr>/.test(p)) return `- ${text}`;
  return text;
}

export function docxXmlToText(xml: string): string {
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const out: string[] = [];
  // Tables first, kept as rows of cells; the paragraphs inside them are theirs.
  const parts = body.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/);
  for (const part of parts) {
    if (part.startsWith('<w:tbl>')) {
      const rows = part.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
      const lines = rows.map(tr => (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? [])
        .map(tc => (tc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(paragraphText).filter(Boolean).join(' ').replace(/\|/g, '/'))
        .join(' | '));
      if (lines.length) out.push(lines.map(l => `| ${l} |`).join('\n'));
    } else {
      for (const p of part.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
        const t = paragraphText(p);
        if (t) out.push(t);
      }
    }
  }
  return out.join('\n\n');
}

async function docxText(buf: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('That does not look like a Word document (no document body inside).');
  let text = docxXmlToText(await doc.async('string'));
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS) + '\n[The rest of the document is NOT shown here, to keep it within size.]';
  return {
    kind: 'docx',
    text,
    summary: `${text.split(/\s+/).filter(Boolean).length.toLocaleString('en-SG')} words`,
    truncated,
    notes: truncated ? ['The document is longer than Sauron reads at once; only the first part was kept.'] : [],
  };
}

// --- PDF -------------------------------------------------------------------------

/** Below this many characters a page on average, the PDF is a scan. */
const SCANNED_CHARS_PER_PAGE = 40;

async function pdfText(buf: Buffer): Promise<Extracted> {
  const { getDocumentProxy, extractText: pdfExtract } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await pdfExtract(pdf, { mergePages: false });
  const chars = text.reduce((n, t) => n + t.trim().length, 0);
  if (chars < SCANNED_CHARS_PER_PAGE * totalPages) {
    return { kind: 'pdf', text: '', summary: `${totalPages} page${totalPages === 1 ? '' : 's'}`, truncated: false, notes: [], needsVision: true, pages: totalPages };
  }
  let out = text.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join('\n\n');
  const truncated = out.length > MAX_TEXT_CHARS;
  if (truncated) out = out.slice(0, MAX_TEXT_CHARS) + '\n[The remaining pages are NOT shown here, to keep the file within size.]';
  return {
    kind: 'pdf',
    text: out,
    summary: `${totalPages} page${totalPages === 1 ? '' : 's'}`,
    truncated,
    notes: truncated ? ['The PDF is longer than Sauron reads at once; only the first pages were kept.'] : [],
    pages: totalPages,
  };
}
