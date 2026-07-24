import { parse } from 'csv-parse/sync';
import type { ProductMixRow } from './types.js';

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, m => HTML_ENTITIES[m]);
}

function num(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.trim().replace(/[%,]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function str(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : decodeEntities(trimmed);
}

export function parseProductMix(csvContent: string): ProductMixRow[] {
  const records: string[][] = parse(csvContent, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (records.length < 2) {
    throw new Error('Product Mix CSV has no data rows');
  }

  const headers = records[0].map(h => h.trim());
  const col = new Map<string, number>();
  headers.forEach((h, i) => col.set(h, i));

  const required = ['Row Type', 'Name', 'Qty'];
  for (const r of required) {
    if (!col.has(r)) {
      throw new Error(`Product Mix CSV missing required column: ${r}`);
    }
  }

  const rows: ProductMixRow[] = [];

  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    const rowType = str(r[col.get('Row Type')!]);
    if (rowType !== 'Product' && rowType !== 'Modifier') continue;

    const nonTax = num(r[col.get('Non-Taxable Sales')!]);
    const taxable = num(r[col.get('Taxable Sales')!]);

    rows.push({
      rowType,
      class: str(r[col.get('Class')!]),
      name: str(r[col.get('Name')!]) ?? '',
      sku: str(r[col.get('SKU')!]),
      barcode: str(r[col.get('Barcode')!]),
      category: str(r[col.get('Product Category')!]),
      subcategory: str(r[col.get('Product Subcategory')!]),
      parentProduct: col.has('Parent Product') ? str(r[col.get('Parent Product')!]) : null,
      qty: num(r[col.get('Qty')!]),
      weight: num(r[col.get('Weight')!]),
      nonTaxableSales: nonTax,
      taxableSales: taxable,
      sales: nonTax + taxable,
      pctTotal: num(r[col.get('% Total Sales')!]),
      cogs: num(r[col.get('COGS')!]),
    });
  }

  return rows;
}
