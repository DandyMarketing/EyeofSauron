import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseFilename, parseProductMix, parseOperationsReport, reconcile } from '../parsers/revel/index.js';
import { resolveVenueId, ingestProductMix, ingestOperations } from '../ingest/revel.js';
import type { ProductMixRow, OperationsData, FilenameMetadata } from '../parsers/revel/types.js';

interface ParsedFile {
  filepath: string;
  meta: FilenameMetadata;
  productMix?: ProductMixRow[];
  operations?: OperationsData;
}

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log('Usage: tsx src/scripts/ingest.ts <file1.csv> [file2.csv ...]');
  console.log('  Parses Revel CSV files, reconciles matched pairs, and ingests into Supabase.');
  process.exit(0);
}

const parsed: ParsedFile[] = [];

for (const filepath of files) {
  const filename = filepath.split('/').pop()!;
  const meta = parseFilename(filename);
  const content = readFileSync(filepath, 'utf-8');

  if (meta.reportType === 'product_mix') {
    parsed.push({ filepath, meta, productMix: parseProductMix(content) });
  } else {
    parsed.push({ filepath, meta, operations: parseOperationsReport(content) });
  }
  console.log(`Parsed: ${filename} (${meta.reportType}, ${meta.venueKey}, ${meta.businessDate})`);
}

// Group by venueKey + businessDate
const groups = new Map<string, { pm?: ParsedFile; ops?: ParsedFile }>();
for (const p of parsed) {
  const key = `${p.meta.venueKey}|${p.meta.businessDate}`;
  const group = groups.get(key) ?? {};
  if (p.productMix) group.pm = p;
  if (p.operations) group.ops = p;
  groups.set(key, group);
}

let failures = 0;

for (const [key, { pm, ops }] of groups) {
  const [venueKey, businessDate] = key.split('|');
  console.log(`\n--- ${venueKey} / ${businessDate} ---`);

  let venueId: string;
  try {
    venueId = await resolveVenueId(venueKey);
  } catch (e: any) {
    console.error(`  SKIP: ${e.message}`);
    failures++;
    continue;
  }

  // Reconcile if both files present
  if (pm?.productMix && ops?.operations) {
    const result = reconcile(pm.productMix, ops.operations);
    console.log(`  Reconciliation: ${result.passed ? 'PASS' : 'FAIL'} (diff $${result.difference.toFixed(2)})`);
    if (!result.passed) {
      console.error(`  SKIP: reconciliation failed — product_mix=$${result.productMixGrossSales.toFixed(2)} vs operations=$${result.operationsGrossSales.toFixed(2)}`);
      failures++;
      continue;
    }
  }

  // Ingest product mix
  if (pm?.productMix) {
    try {
      const count = await ingestProductMix(venueId, businessDate, pm.productMix);
      console.log(`  Product mix: ${count} rows ingested`);
    } catch (e: any) {
      console.error(`  FAIL product_mix: ${e.message}`);
      failures++;
    }
  }

  // Ingest operations
  if (ops?.operations) {
    try {
      await ingestOperations(venueId, businessDate, ops.operations);
      console.log(`  Operations: ingested`);
    } catch (e: any) {
      console.error(`  FAIL operations: ${e.message}`);
      failures++;
    }
  }
}

console.log(`\nDone. ${failures === 0 ? 'All succeeded.' : `${failures} failure(s).`}`);
process.exit(failures > 0 ? 1 : 0);
