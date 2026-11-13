import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } from 'docx';
import { extractText, kindOf, columnTotals, docxXmlToText, MAX_TEXT_CHARS } from './file-extract.js';

test('file kinds by name; unreadable kinds say what to do', () => {
  assert.equal(kindOf('Invoice.PDF'), 'pdf');
  assert.equal(kindOf('sales.xlsx'), 'spreadsheet');
  assert.equal(kindOf('old.xls'), 'spreadsheet');
  assert.equal(kindOf('export.csv'), 'spreadsheet');
  assert.equal(kindOf('brief.docx'), 'docx');
  assert.match((kindOf('brief.doc') as any).error, /save it as \.docx/);
  assert.match((kindOf('photo.jpg') as any).error, /Only PDF/);
});

test('column totals skip a sheet\'s own total row and non-number columns', () => {
  const rows = [
    ['Supplier', 'Date', 'Amount', 'Note'],
    ['Fresh Co', '2026-10-01', 100.5, 'x'],
    ['Fresh Co', '2026-10-02', 200, null],
    ['Meat Ltd', '2026-10-03', 300.25, 'y'],
    ['Total', null, 600.75, null],
  ];
  const t = columnTotals(rows);
  assert.deepEqual(t.totals, [{ column: 'Amount', sum: 600.75, values: 3 }]);
  assert.equal(t.skippedTotalRows, 1);
});

test('an Excel workbook: every sheet, its rows, and totals computed by the server', async () => {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('Bills');
  a.addRow(['Supplier', 'Amount']);
  for (let i = 1; i <= 5; i++) a.addRow([`Supplier ${i}`, i * 10]);
  a.addRow(['Grand total', 150]);
  const b = wb.addWorksheet('Notes');
  b.addRow(['Said', 'Who']);
  b.addRow(['Order more limes, please', 'Chef']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const x = await extractText(buf, 'bills.xlsx');
  assert.equal(x.kind, 'spreadsheet');
  assert.equal(x.summary, '2 sheets, 9 rows');
  assert.match(x.text, /=== Sheet "Bills" \(7 rows x 2 columns\) ===/);
  assert.match(x.text, /Supplier 3,30/);
  assert.match(x.text, /- Amount: 150 \(5 values\)/);
  assert.match(x.text, /leaving out 1 row\(s\) that call themselves a total/);
  assert.match(x.text, /"Order more limes, please",Chef/);
  assert.equal(x.truncated, false);
});

test('a CSV reads like a one-sheet workbook', async () => {
  const csv = 'Item,Qty,Sales\nLaksa,3,45\nSatay,5,60\nTeh,2,8\n';
  const x = await extractText(Buffer.from(csv), 'mix.csv');
  assert.match(x.text, /- Qty: 10 \(3 values\)/);
  assert.match(x.text, /- Sales: 113 \(3 values\)/);
});

test('a huge sheet is cut to size, says so, and its totals still cover every row', async () => {
  const lines = ['Name,Amount'];
  for (let i = 0; i < 20000; i++) lines.push(`A fairly long supplier name number ${i},1`);
  const x = await extractText(Buffer.from(lines.join('\n')), 'big.csv');
  assert.ok(x.text.length <= MAX_TEXT_CHARS + 2000);
  assert.equal(x.truncated, true);
  assert.match(x.text, /are NOT shown here/);
  assert.match(x.text, /- Amount: 20,000 \(20000 values\)/);
});

test('a Word document keeps headings, lists of text and tables as rows', async () => {
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: 'Proposal', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun('Partner fee is '), new TextRun({ text: '$2,500', bold: true }), new TextRun(' per night.')] }),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [new Paragraph('Item')] }), new TableCell({ children: [new Paragraph('Cost')] })] }),
      new TableRow({ children: [new TableCell({ children: [new Paragraph('DJ & sound')] }), new TableCell({ children: [new Paragraph('$1,200')] })] }),
    ] }),
  ] }] });
  const buf = await Packer.toBuffer(doc);
  const x = await extractText(buf, 'proposal.docx');
  assert.equal(x.kind, 'docx');
  assert.match(x.text, /^# Proposal/m);
  assert.match(x.text, /Partner fee is \$2,500 per night\./);
  assert.match(x.text, /\| Item \| Cost \|\n\| DJ & sound \| \$1,200 \|/);
});

test('Word XML: tabs, breaks and entities', () => {
  const xml = '<w:body><w:p><w:r><w:t>A</w:t><w:tab/><w:t xml:space="preserve">B &amp; C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body>';
  assert.equal(docxXmlToText(xml), 'A\tB & C\nD');
});

/** A one-page PDF with real text, written by hand: no PDF library needed. */
function textPdf(lines: string[]): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td ' + lines.map((l, i) => (i ? '0 -16 Td ' : '') + `(${l}) Tj`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a PDF with text is read page by page', async () => {
  const x = await extractText(textPdf(['Invoice 1042 from Fresh Co', 'Limes 20kg  $84.00', 'Total due  $84.00']), 'inv.pdf');
  assert.equal(x.kind, 'pdf');
  assert.equal(x.needsVision, undefined);
  assert.equal(x.summary, '1 page');
  assert.match(x.text, /--- Page 1 ---/);
  assert.match(x.text, /Invoice 1042 from Fresh Co/);
  assert.match(x.text, /\$84\.00/);
});

test('a PDF with no text layer is a scan, and is marked for Claude to read', async () => {
  const x = await extractText(textPdf([]), 'scan.pdf');
  assert.equal(x.needsVision, true);
  assert.equal(x.pages, 1);
  assert.equal(x.text, '');
});
