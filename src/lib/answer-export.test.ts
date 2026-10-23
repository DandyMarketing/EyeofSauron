import { test } from 'node:test';
import assert from 'node:assert';
import ExcelJS from 'exceljs';
import { parseCell, invalidExport, sheetName, exportFileName, buildAnswerWorkbook, LIMITS } from './answer-export.js';

test('money, percentages and plain numbers become numbers that still read as written', () => {
  assert.deepStrictEqual(parseCell('$5,974'), { value: 5974, numFmt: '"$"#,##0;-"$"#,##0' });
  assert.deepStrictEqual(parseCell('$105.31'), { value: 105.31, numFmt: '"$"#,##0.00;-"$"#,##0.00' });
  assert.strictEqual(parseCell('−$1,200').value, -1200);
  assert.strictEqual(parseCell('S$63,815.40').value, 63815.4);
  assert.deepStrictEqual(parseCell('38.6%'), { value: 38.6, numFmt: '0.0"%"' });
  assert.strictEqual(parseCell('−13%').value, -13);
  assert.strictEqual(parseCell('+4.2%').value, 4.2);
  assert.match(parseCell('+4.2%').numFmt!, /^\+/);
  assert.deepStrictEqual(parseCell('1,234'), { value: 1234, numFmt: '#,##0' });
  assert.deepStrictEqual(parseCell(' 606 '), { value: 606, numFmt: '0' });
  // A year stays a year to look at.
  assert.deepStrictEqual(parseCell('2022'), { value: 2022, numFmt: '0' });
});

test('anything that is not cleanly one figure stays as the text it was', () => {
  // Two figures in one cell: turning it into either would lose the other.
  assert.deepStrictEqual(parseCell('87 (−13%)'), { value: '87 (−13%)' });
  assert.deepStrictEqual(parseCell('Apr–Jun 2022'), { value: 'Apr–Jun 2022' });
  assert.deepStrictEqual(parseCell('Neon Pigeon'), { value: 'Neon Pigeon' });
  assert.deepStrictEqual(parseCell('007'), { value: '007' });
  assert.deepStrictEqual(parseCell('1,23'), { value: '1,23' });
  assert.deepStrictEqual(parseCell(''), { value: '' });
});

test('an ISO date is a date; an impossible one is text', () => {
  const d = parseCell('2026-10-13');
  assert.ok(d.value instanceof Date);
  assert.strictEqual((d.value as Date).toISOString().slice(0, 10), '2026-10-13');
  assert.deepStrictEqual(parseCell('2026-02-30'), { value: '2026-02-30' });
});

test('a payload is refused when it is not a table, or bigger than any answer', () => {
  const ok = { question: 'q', text: ['a'], tables: [{ headers: ['A'], rows: [['1']] }] };
  assert.strictEqual(invalidExport(ok), null);
  assert.match(invalidExport({ tables: [] })!, /no table/);
  assert.match(invalidExport(null)!, /Nothing/);
  assert.match(invalidExport({ tables: [{ headers: ['A'] }] })!, /without its rows/);
  assert.match(invalidExport({ tables: [{ headers: ['A'], rows: ['x'] }] })!, /wrong shape/);
  assert.match(invalidExport({ tables: [{ headers: ['A'], rows: [[{}]] }] })!, /not text/);
  assert.match(invalidExport({ tables: [{ headers: ['A'], rows: [['x'.repeat(LIMITS.cell + 1)]] }] })!, /too long/);
  assert.match(invalidExport({ tables: Array(LIMITS.tables + 1).fill(ok.tables[0]) })!, /At most/);
  assert.match(invalidExport({ ...ok, text: 'not a list' })!, /answer text/);
});

test('sheet names are ones Excel accepts, and never collide', () => {
  const taken = new Set<string>(['answer']);
  assert.strictEqual(sheetName('Half-year summary', 0, taken), 'Half-year summary');
  assert.strictEqual(sheetName('Half-year summary', 1, taken), 'Half-year summary (2)');
  assert.strictEqual(sheetName(undefined, 2, taken), 'Table 3');
  assert.strictEqual(sheetName('Answer', 3, taken), 'Answer (2)');
  assert.strictEqual(sheetName('Sales: Jan/Feb [draft]?', 4, taken), 'Sales Jan Feb draft');
  assert.ok(sheetName('x'.repeat(40), 5, taken).length <= 31);
});

test('the file name says what was asked and when', () => {
  assert.strictEqual(
    exportFileName('Export the half-year table for Neon Pigeon to Excel', '2026-10-23'),
    'sauron-export-the-half-year-table-for-neon-pigeon-to-2026-10-23.xlsx',
  );
  assert.strictEqual(exportFileName('', '2026-10-23'), 'sauron-answer-2026-10-23.xlsx');
});

test('the workbook holds each table as shown, with the answer beside it', async () => {
  const wb = await buildAnswerWorkbook({
    question: 'Neon Pigeon by half-year',
    text: ['Food & beverage sales = food + drink, no service charge.', '', '2022 H1 is three months only.'],
    tables: [{
      caption: 'Half-year summary',
      headers: ['Half-year', 'F&B sales', 'Covers', 'Food share'],
      rows: [['2022 H1', '$412,330', '4,102', '38.6%'], ['2022 H2', '$901,004.50', '9,877', '37.9%']],
    }],
  }, '2026-10-23');

  // Round-tripped through a real file, so what is checked is what Excel opens.
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await wb.xlsx.writeBuffer() as any);

  assert.deepStrictEqual(back.worksheets.map(w => w.name), ['Half-year summary', 'Answer']);
  const ws = back.getWorksheet('Half-year summary')!;
  assert.strictEqual(ws.getCell('A1').value, 'Half-year summary');
  assert.match(String(ws.getCell('A2').value), /exactly as the answer showed them/);
  assert.deepStrictEqual((ws.getRow(4).values as any[]).slice(1), ['Half-year', 'F&B sales', 'Covers', 'Food share']);
  assert.strictEqual(ws.getCell('A5').value, '2022 H1');
  assert.strictEqual(ws.getCell('B5').value, 412330);
  assert.strictEqual(ws.getCell('B6').value, 901004.5);
  assert.strictEqual(ws.getCell('C6').value, 9877);
  assert.strictEqual(ws.getCell('D5').value, 38.6);
  assert.strictEqual(ws.getCell('D5').numFmt, '0.0"%"');

  const a = back.getWorksheet('Answer')!;
  assert.match(String(a.getCell('A1').value), /Neon Pigeon by half-year/);
  // Blank paragraphs dropped, the rest kept in order.
  assert.strictEqual(a.getCell('A4').value, 'Food & beverage sales = food + drink, no service charge.');
  assert.strictEqual(a.getCell('A5').value, '2022 H1 is three months only.');
});
