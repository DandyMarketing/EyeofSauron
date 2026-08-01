import 'dotenv/config';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CUTOFF_DATE = '2026-07-29';

const VENUE_MAP: Record<string, string> = {
  FAT_PRINCE: 'c0d03a78-7d28-4a4a-a908-d1719110e881',
  Firangi_Superstar: 'a0838494-04a6-4f04-8c1f-a8a2e01a3c07',
  Neon_Pigeon: '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5',
};

interface ProductMixRecord {
  venue_id: string;
  business_date: string;
  row_type: string;
  class: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  subcategory: string;
  parent_product: string | null;
  qty: number;
  weight: number;
  non_taxable_sales: number;
  taxable_sales: number;
  sales: number;
  pct_total: number;
  cogs: number;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseDateHeader(header: string): string | null {
  // Format: "Fri 08/01/2025" -> "2025-08-01"
  const match = header.trim().match(/\w+ (\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month}-${day}`;
}

function detectVenueFromFilename(filename: string): string | null {
  for (const [key, venueId] of Object.entries(VENUE_MAP)) {
    if (filename.includes(key)) return venueId;
  }
  return null;
}

function detectFixedColumns(headerRow: string[]): number {
  // Firangi has "Parent Product" as an extra column
  // Fixed columns end where "Quantity" first appears
  for (let i = 0; i < headerRow.length; i++) {
    if (headerRow[i].trim() === 'Quantity') return i;
  }
  return 6;
}

async function processFile(filepath: string): Promise<number> {
  const filename = filepath.split('/').pop() || filepath;
  const venueId = detectVenueFromFilename(filename);
  if (!venueId) {
    console.error(`Could not detect venue from filename: ${filename}`);
    return 0;
  }

  const venueName = Object.entries(VENUE_MAP).find(([, id]) => id === venueId)?.[0] ?? 'Unknown';
  console.log(`\nProcessing ${venueName}...`);

  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 3) {
    console.error('File too short');
    return 0;
  }

  // Row 0: date headers
  const dateHeaderFields = parseCSVLine(lines[0]);
  // Row 1: column headers (Class, Name, ...)
  const columnHeaders = parseCSVLine(lines[1]);

  const fixedCols = detectFixedColumns(columnHeaders);
  console.log(`  Fixed columns: ${fixedCols} (${columnHeaders.slice(0, fixedCols).join(', ')})`);

  // Parse dates from row 0 — each date has 2 columns (Quantity, Total)
  const dates: { index: number; date: string }[] = [];
  for (let i = fixedCols; i < dateHeaderFields.length; i++) {
    const parsed = parseDateHeader(dateHeaderFields[i]);
    if (parsed && parsed < CUTOFF_DATE) {
      dates.push({ index: i, date: parsed });
    }
  }

  console.log(`  Date columns found: ${dates.length} (${dates[0]?.date} to ${dates[dates.length - 1]?.date})`);

  // Check if "Parent Product" is one of the fixed columns
  const hasParentProduct = columnHeaders.slice(0, fixedCols).some(
    h => h.trim().toLowerCase() === 'parent product'
  );

  const allRecords: ProductMixRecord[] = [];

  // Process product rows (skip header rows 0 and 1)
  for (let rowIdx = 2; rowIdx < lines.length; rowIdx++) {
    const fields = parseCSVLine(lines[rowIdx]);
    if (!fields[0]?.trim()) continue;

    let colOffset = 0;
    const cls = fields[0]?.trim() || '';
    const name = fields[1]?.trim() || '';
    let parentProduct: string | null = null;
    let sku: string, barcode: string, category: string, subcategory: string;

    if (hasParentProduct) {
      parentProduct = fields[2]?.trim() || null;
      sku = fields[3]?.trim() || '';
      barcode = fields[4]?.trim() || '';
      category = fields[5]?.trim() || '';
      subcategory = fields[6]?.trim() || '';
    } else {
      sku = fields[2]?.trim() || '';
      barcode = fields[3]?.trim() || '';
      category = fields[4]?.trim() || '';
      subcategory = fields[5]?.trim() || '';
    }

    // For each date, grab Quantity and Total
    for (const { index, date } of dates) {
      const qtyStr = fields[index]?.trim() || '';
      const totalStr = fields[index + 1]?.trim() || '';

      const qty = qtyStr ? parseFloat(qtyStr) : 0;
      const sales = totalStr ? parseFloat(totalStr.replace(/,/g, '')) : 0;

      if (qty === 0 && sales === 0) continue;

      allRecords.push({
        venue_id: venueId,
        business_date: date,
        row_type: 'Product',
        class: cls,
        name,
        sku,
        barcode,
        category,
        subcategory,
        parent_product: parentProduct,
        qty,
        weight: 0,
        non_taxable_sales: 0,
        taxable_sales: sales,
        sales,
        pct_total: 0,
        cogs: 0,
      });
    }
  }

  console.log(`  Records to insert: ${allRecords.length}`);

  if (allRecords.length === 0) return 0;

  // Group by date to delete existing data first
  const byDate = new Map<string, ProductMixRecord[]>();
  for (const rec of allRecords) {
    const arr = byDate.get(rec.business_date) ?? [];
    arr.push(rec);
    byDate.set(rec.business_date, arr);
  }

  console.log(`  Unique dates: ${byDate.size}`);

  // Delete existing data for these dates, then insert in chunks
  const sortedDates = [...byDate.keys()].sort();
  let inserted = 0;

  for (const date of sortedDates) {
    const records = byDate.get(date)!;

    // Delete existing rows for this venue+date
    const { error: delError } = await supabase
      .from('product_mix')
      .delete()
      .eq('venue_id', venueId)
      .eq('business_date', date);

    if (delError) {
      console.error(`  Delete failed for ${date}: ${delError.message}`);
      continue;
    }

    // Compute pct_total per date
    const totalSales = records.reduce((sum, r) => sum + r.sales, 0);
    if (totalSales > 0) {
      for (const rec of records) {
        rec.pct_total = Math.round((rec.sales / totalSales) * 10000) / 100;
      }
    }

    // Insert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const { error } = await supabase.from('product_mix').insert(chunk);
      if (error) {
        console.error(`  Insert failed for ${date} chunk ${i}: ${error.message}`);
      } else {
        inserted += chunk.length;
      }
    }
  }

  console.log(`  Inserted: ${inserted} records across ${byDate.size} dates`);
  return inserted;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: npx tsx scripts/backfill-product-mix.ts <file1.csv> <file2.csv> ...');
    process.exit(1);
  }

  console.log(`Backfill product mix — ${files.length} files`);
  console.log(`Cutoff date: ${CUTOFF_DATE} (only inserting dates before this)`);

  let total = 0;
  for (const file of files) {
    const count = await processFile(file);
    total += count;
  }

  console.log(`\nDone. Total records inserted: ${total}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
