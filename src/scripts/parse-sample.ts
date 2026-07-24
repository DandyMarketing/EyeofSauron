import { readFileSync } from 'node:fs';
import { parseFilename, parseProductMix, parseOperationsReport, reconcile } from '../parsers/revel/index.js';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log('Usage: tsx src/scripts/parse-sample.ts <file1.csv> [file2.csv ...]');
  console.log('  Pass Product Mix + Operations CSVs to parse and reconcile.');
  process.exit(0);
}

interface ParsedFile {
  filename: string;
  meta: ReturnType<typeof parseFilename>;
  data: ReturnType<typeof parseProductMix> | ReturnType<typeof parseOperationsReport>;
}

const parsed: ParsedFile[] = [];

for (const filepath of files) {
  const filename = filepath.split('/').pop()!;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Parsing: ${filename}`);
  console.log('='.repeat(60));

  const meta = parseFilename(filename);
  console.log(`  Report type : ${meta.reportType}`);
  console.log(`  Venue key   : ${meta.venueKey}`);
  console.log(`  Business date: ${meta.businessDate}`);

  const content = readFileSync(filepath, 'utf-8');

  if (meta.reportType === 'product_mix') {
    const rows = parseProductMix(content);
    const products = rows.filter(r => r.rowType === 'Product');
    const modifiers = rows.filter(r => r.rowType === 'Modifier');
    const totalSales = products.reduce((s, r) => s + r.sales, 0);
    const totalQty = products.reduce((s, r) => s + r.qty, 0);

    console.log(`  Total rows  : ${rows.length} (${products.length} products, ${modifiers.length} modifiers)`);
    console.log(`  Total sales : $${totalSales.toFixed(2)}`);
    console.log(`  Total qty   : ${totalQty}`);

    const pctSum = products.reduce((s, r) => s + r.pctTotal, 0);
    console.log(`  % total sum : ${pctSum.toFixed(2)}%`);

    parsed.push({ filename, meta, data: rows });
  } else {
    const ops = parseOperationsReport(content);
    console.log(`  Gross sales : $${ops.grossProductSales.taxedGrossSales.toFixed(2)}`);
    console.log(`  Net sales   : $${ops.netSales.totalSales.toFixed(2)}`);
    console.log(`  Discounts   : $${ops.discounts.total.toFixed(2)}`);
    console.log(`  Tax total   : $${ops.taxes.taxTotal.toFixed(2)}`);
    console.log(`  Tips        : $${ops.tipsTotal.toFixed(2)}`);
    console.log(`  Net to acct : $${ops.netToAccountFor.toFixed(2)}`);
    console.log(`  Transactions: ${ops.servicePerformance.totalTransactions}`);
    console.log(`  Guests      : ${ops.servicePerformance.totalGuests}`);
    console.log(`  Avg check   : $${ops.servicePerformance.avgCheck.toFixed(2)}`);

    console.log(`  Sales by class:`);
    for (const c of ops.salesByClass) {
      console.log(`    ${c.class}: $${c.grossSales.toFixed(2)} gross / $${c.netTotals.toFixed(2)} net`);
    }

    console.log(`  Payments:`);
    for (const p of ops.payments.filter(p => !p.isSubType)) {
      console.log(`    ${p.type}: ${p.qty} txns / $${p.total.toFixed(2)}`);
    }

    parsed.push({ filename, meta, data: ops });
  }
}

// Reconciliation: match Product Mix + Operations pairs by venueKey + businessDate
const pmFiles = parsed.filter(p => p.meta.reportType === 'product_mix');
const opsFiles = parsed.filter(p => p.meta.reportType === 'operations');

for (const pm of pmFiles) {
  const ops = opsFiles.find(
    o => o.meta.venueKey === pm.meta.venueKey && o.meta.businessDate === pm.meta.businessDate,
  );
  if (!ops) continue;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Reconciliation: ${pm.meta.venueKey} / ${pm.meta.businessDate}`);
  console.log('='.repeat(60));

  const result = reconcile(
    pm.data as ReturnType<typeof parseProductMix>,
    ops.data as ReturnType<typeof parseOperationsReport>,
  );

  console.log(`  Product Mix gross : $${result.productMixGrossSales.toFixed(2)}`);
  console.log(`  Operations gross  : $${result.operationsGrossSales.toFixed(2)}`);
  console.log(`  Difference        : $${result.difference.toFixed(2)}`);
  console.log(`  Tolerance         : $${result.tolerance.toFixed(2)}`);
  console.log(`  Result            : ${result.passed ? 'PASS' : 'FAIL'}`);
}
