import XLSX from 'xlsx';
import type { HourlySalesRow, HourlySalesData } from './types.js';

const TIME_RE = /^(\d{1,2}):00\s*(AM|PM)\s*-\s*\d{1,2}:59\s*(AM|PM)$/i;

function parseHour(timeLabel: string): number | null {
  const m = timeLabel.match(TIME_RE);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const ampm = m[2].toUpperCase();
  if (ampm === 'AM' && hour === 12) hour = 0;
  else if (ampm === 'PM' && hour !== 12) hour += 12;
  return hour;
}

function num(v: any): number {
  if (v == null || v === '' || v === '-') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,$%]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function parseHourlySalesXlsx(buffer: Buffer): HourlySalesData {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });

  const hours: HourlySalesRow[] = [];
  let totalTx = 0, totalItems = 0, totalSales = 0;

  for (const row of rows) {
    const timeLabel = String(row['Time'] ?? '').trim();
    if (timeLabel.toLowerCase().startsWith('total')) continue;

    const hour = parseHour(timeLabel);
    if (hour === null) continue;

    const transactions = num(row['# Transactions']);
    const items = num(row['# Items']);
    const avgRaw = row['Avg. Sales/Check'];
    const avgCheck = avgRaw === '-' || avgRaw === '' ? null : num(avgRaw);
    const sales = num(row['Sales']);
    const pctRaw = row['% Sales'];
    const pctSales = num(pctRaw);

    hours.push({ hour, timeLabel, transactions, items, avgCheck, sales, pctSales });

    totalTx += transactions;
    totalItems += items;
    totalSales += sales;
  }

  return {
    hours,
    totals: {
      transactions: totalTx,
      items: totalItems,
      avgCheck: totalTx > 0 ? Number((totalSales / totalTx).toFixed(2)) : null,
      sales: totalSales,
    },
  };
}

export function parseHourlySalesCsv(content: string): HourlySalesData {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('Hourly sales CSV is empty');

  const headers = lines[0].split(',').map(h => h.trim());
  const timeIdx = headers.indexOf('Time');
  const txIdx = headers.indexOf('# Transactions');
  const itemsIdx = headers.indexOf('# Items');
  const avgIdx = headers.indexOf('Avg. Sales/Check');
  const salesIdx = headers.indexOf('Sales');
  const pctIdx = headers.indexOf('% Sales');

  const hours: HourlySalesRow[] = [];
  let totalTx = 0, totalItems = 0, totalSales = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const timeLabel = cols[timeIdx] ?? '';
    if (timeLabel.toLowerCase().startsWith('total')) continue;

    const hour = parseHour(timeLabel);
    if (hour === null) continue;

    const transactions = num(cols[txIdx]);
    const items = num(cols[itemsIdx]);
    const avgCheck = cols[avgIdx] === '-' ? null : num(cols[avgIdx]);
    const sales = num(cols[salesIdx]);
    const pctSales = num(cols[pctIdx]);

    hours.push({ hour, timeLabel, transactions, items, avgCheck, sales, pctSales });

    totalTx += transactions;
    totalItems += items;
    totalSales += sales;
  }

  return {
    hours,
    totals: {
      transactions: totalTx,
      items: totalItems,
      avgCheck: totalTx > 0 ? Number((totalSales / totalTx).toFixed(2)) : null,
      sales: totalSales,
    },
  };
}
