import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const REVEL_CUTOFF = '2026-07-29';

const VENUES: Record<string, string> = {
  'neon-pigeon': '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5',
  'fat-prince': 'c0d03a78-7d28-4a4a-a908-d1719110e881',
  'super-firangi': 'a0838494-04a6-4f04-8c1f-a8a2e01a3c07',
};

interface BoardConfig {
  boardId: number;
  venue: string;
  yearStart: number;
  yearEnd: number;
  label: string;
}

const BOARDS: BoardConfig[] = [
  { boardId: 2015363786, venue: 'neon-pigeon', yearStart: 2022, yearEnd: 2023, label: 'NP 2022-23' },
  { boardId: 2015353457, venue: 'fat-prince', yearStart: 2022, yearEnd: 2023, label: 'FP 2022-23' },
  { boardId: 2015461582, venue: 'super-firangi', yearStart: 2022, yearEnd: 2023, label: 'FS 2022-23' },
  { boardId: 5430537941, venue: 'neon-pigeon', yearStart: 2024, yearEnd: 2024, label: 'NP 2024' },
  { boardId: 5380594625, venue: 'fat-prince', yearStart: 2024, yearEnd: 2024, label: 'FP 2024' },
  { boardId: 5430517504, venue: 'super-firangi', yearStart: 2024, yearEnd: 2024, label: 'FS 2024' },
  { boardId: 8133596119, venue: 'neon-pigeon', yearStart: 2025, yearEnd: 2025, label: 'NP 2025' },
  { boardId: 8132958581, venue: 'fat-prince', yearStart: 2025, yearEnd: 2025, label: 'FP 2025' },
  { boardId: 8133759522, venue: 'super-firangi', yearStart: 2025, yearEnd: 2025, label: 'FS 2025' },
  { boardId: 18394773435, venue: 'neon-pigeon', yearStart: 2026, yearEnd: 2026, label: 'NP 2026' },
  { boardId: 18394771274, venue: 'fat-prince', yearStart: 2026, yearEnd: 2026, label: 'FP 2026' },
  { boardId: 18394735035, venue: 'super-firangi', yearStart: 2026, yearEnd: 2026, label: 'FS 2026' },
];

const COLUMN_IDS = {
  brunch: {
    food_sales: 'dup__of_lunch_food_sales8',
    bev_sales: 'dup__of_lunch_bev_sales75',
    service_charge: 'numeric',
    covers: 'dup__of_lunch_covers0',
    discounts: 'dup__of_lunch_discounts',
    reservations: 'dup__of_lunch_res5',
    cancellations: 'dup__of_lunch_cxl___ns2',
    reductions: 'dup__of_lunch_reductions8',
    walk_ins: 'dup__of_lunch_walk_ins',
  },
  lunch: {
    food_sales: 'dup__of_lunch_bev_sales',
    bev_sales: 'numbers19',
    service_charge: 'numeric8',
    covers: 'numbers2',
    discounts: 'dup__of_dinner_discounts',
    reservations: 'numbers98',
    cancellations: 'numbers22',
    reductions: 'numbers46',
    walk_ins: 'numbers8',
  },
  dinner: {
    food_sales: 'dup__of_lunch_sales',
    bev_sales: 'numbers86',
    service_charge: 'numeric3',
    covers: 'numbers833',
    discounts: 'numbers32',
    reservations: 'dup__of_lunch_res',
    cancellations: 'dup__of_lunch_cxl___ns',
    reductions: 'dup__of_lunch_reductions',
    walk_ins: 'numbers83',
  },
  total_sc_manual: 'numbers768',
} as const;

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04',
  june: '06', july: '07', august: '08', september: '09',
  october: '10', november: '11', december: '12',
};

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function validOrNull(y: number, m: number, d: number): string | null {
  if (!isValidDate(y, m, d)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseDate(raw: string): string | null {
  const s = raw.trim()
    .replace(/[–—]/g, '-')
    .replace(/\s*\(.*\)$/, '')
    .replace(/[,]+/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+(mon|tue|wed|thu|fri|sat|sun)\w*\.?$/i, '')
    .replace(/\s+(mon|tue|wed|thu|fri|sat|sun|thr)\w*\.?$/i, '')
    .replace(/\.+$/, '')
    .trim();

  let m: RegExpMatchArray | null;

  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  // YY-MM-DD (e.g. "22-08-17")
  m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  // YY-MMDD (e.g. "23-1226")
  m = s.match(/^(\d{2})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  // YYYY-MMDD (e.g. "2023-0728")
  m = s.match(/^(\d{4})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  // YY MMDD with space (e.g. "23 0913")
  m = s.match(/^(\d{2})\s+(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  // DD/MM/YYYY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validOrNull(+m[3], +m[2], +m[1]);

  // DD/MM/YY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) return validOrNull(2000 + +m[3], +m[2], +m[1]);

  // DD-Mon-YY or DD Mon YYYY
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]+)[\s-](\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    let year = +m[3];
    if (year < 100) year = 2000 + year;
    return validOrNull(year, +month, +m[1]);
  }

  return null;
}

function parseNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  group?: { id: string; title: string };
  column_values: Record<string, string | null>;
}

interface MealPeriodData {
  food_sales: number;
  bev_sales: number;
  service_charge: number;
  covers: number;
  discounts: number;
  reservations: number;
  cancellations: number;
  reductions: number;
  walk_ins: number;
}

interface ParsedRecord {
  venue_id: string;
  business_date: string;
  board_label: string;
  is_primary: boolean;
  meal_periods: Record<string, MealPeriodData>;
  total_sc_manual: number;
}

const JUNK_NAMES = new Set(['bluesheets_21feb_lunch', 'test 2', 'new item']);

function parseDateFromCreatedAt(iso: string): string {
  return iso.substring(0, 10);
}

function getCol(item: MondayItem, colId: string): number {
  return parseNum(item.column_values[colId]);
}

function extractPeriod(item: MondayItem, period: 'brunch' | 'lunch' | 'dinner'): MealPeriodData {
  const cols = COLUMN_IDS[period];
  return {
    food_sales: getCol(item, cols.food_sales),
    bev_sales: getCol(item, cols.bev_sales),
    service_charge: getCol(item, cols.service_charge),
    covers: getCol(item, cols.covers),
    discounts: getCol(item, cols.discounts),
    reservations: getCol(item, cols.reservations),
    cancellations: getCol(item, cols.cancellations),
    reductions: getCol(item, cols.reductions),
    walk_ins: getCol(item, cols.walk_ins),
  };
}

function hasMealData(p: MealPeriodData): boolean {
  return p.food_sales !== 0 || p.bev_sales !== 0 || p.covers !== 0;
}

function processBoard(items: MondayItem[], board: BoardConfig): ParsedRecord[] {
  const venueId = VENUES[board.venue];
  const records: ParsedRecord[] = [];
  let unparsed = 0;

  for (const item of items) {
    if (JUNK_NAMES.has(item.name.toLowerCase().trim())) {
      console.warn(`  [JUNK] Skipping: "${item.name}"`);
      continue;
    }

    let date = parseDate(item.name);
    if (!date) {
      date = parseDateFromCreatedAt(item.created_at);
      console.warn(`  [FALLBACK] "${item.name}" -> created_at ${date}`);
    }

    const year = parseInt(date.substring(0, 4));
    if (year <= 2021) continue;
    if (date >= REVEL_CUTOFF) continue;

    const isPrimary = year >= board.yearStart && year <= board.yearEnd;

    const brunch = extractPeriod(item, 'brunch');
    const lunch = extractPeriod(item, 'lunch');
    const dinner = extractPeriod(item, 'dinner');

    const mealPeriods: Record<string, MealPeriodData> = {};
    if (hasMealData(brunch)) mealPeriods.brunch = brunch;
    if (hasMealData(lunch)) mealPeriods.lunch = lunch;
    if (hasMealData(dinner)) mealPeriods.dinner = dinner;

    if (Object.keys(mealPeriods).length === 0) continue;

    records.push({
      venue_id: venueId,
      business_date: date,
      board_label: board.label,
      is_primary: isPrimary,
      meal_periods: mealPeriods,
      total_sc_manual: getCol(item, COLUMN_IDS.total_sc_manual),
    });
  }

  if (unparsed > 0) console.warn(`  ${unparsed} items with unparseable dates`);
  return records;
}

function deriveRow(rec: ParsedRecord) {
  let totalFood = 0, totalBev = 0, totalSC = 0, totalCovers = 0, totalDiscounts = 0;

  for (const p of Object.values(rec.meal_periods)) {
    totalFood += p.food_sales;
    totalBev += p.bev_sales;
    totalSC += p.service_charge;
    totalCovers += p.covers;
    totalDiscounts += p.discounts;
  }

  const grossSales = Math.round((totalFood + totalBev) * 100) / 100;
  const effectiveSC = totalSC > 0 ? totalSC : rec.total_sc_manual;
  const netSales = Math.round((grossSales - totalDiscounts + effectiveSC) * 100) / 100;

  return {
    venue_id: rec.venue_id,
    business_date: rec.business_date,
    gross_sales: grossSales || null,
    net_sales: netSales || null,
    item_discounts: totalDiscounts,
    taxed_service_fee: effectiveSC,
    total_guests: totalCovers || null,
    meal_periods: rec.meal_periods,
    data_source: 'monday' as const,
  };
}

async function main() {
  const inputFile = process.argv[2] || 'data/monday-raw.json';

  if (!existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    console.error('Usage: npx tsx scripts/backfill-monday.ts [path-to-monday-raw.json]');
    process.exit(1);
  }

  console.log(`Reading ${inputFile}...`);
  const rawData: Record<string, MondayItem[]> = JSON.parse(readFileSync(inputFile, 'utf-8'));

  console.log('Monday.com backfill — two-pass chronological processing\n');

  const primaryDates = new Set<string>();
  const allRecords: ParsedRecord[] = [];
  const spillover: ParsedRecord[] = [];

  for (const board of BOARDS) {
    const key = String(board.boardId);
    const items = rawData[key];
    if (!items) {
      console.warn(`No data for ${board.label} (${board.boardId})`);
      continue;
    }

    console.log(`${board.label}: ${items.length} items`);
    const records = processBoard(items, board);

    let pCount = 0, sCount = 0;
    for (const rec of records) {
      if (rec.is_primary) {
        primaryDates.add(`${rec.venue_id}:${rec.business_date}`);
        allRecords.push(rec);
        pCount++;
      } else {
        spillover.push(rec);
        sCount++;
      }
    }
    console.log(`  -> ${pCount} primary, ${sCount} spillover`);
  }

  let kept = 0, dropped = 0;
  for (const rec of spillover) {
    const key = `${rec.venue_id}:${rec.business_date}`;
    if (!primaryDates.has(key)) {
      allRecords.push(rec);
      primaryDates.add(key);
      kept++;
    } else {
      dropped++;
    }
  }

  console.log(`\nSpillover: kept ${kept}, dropped ${dropped} duplicates`);
  console.log(`Total records: ${allRecords.length}`);

  const byVenue = new Map<string, ParsedRecord[]>();
  for (const rec of allRecords) {
    const arr = byVenue.get(rec.venue_id) ?? [];
    arr.push(rec);
    byVenue.set(rec.venue_id, arr);
  }

  for (const [venueId, recs] of byVenue) {
    const name = Object.entries(VENUES).find(([, id]) => id === venueId)?.[0] ?? venueId;
    const dates = recs.map(r => r.business_date).sort();
    console.log(`  ${name}: ${recs.length} days (${dates[0]} to ${dates[dates.length - 1]})`);
  }

  // Deduplicate: if multiple records exist for the same venue+date, keep the primary one
  const deduped = new Map<string, ParsedRecord>();
  for (const rec of allRecords) {
    const key = `${rec.venue_id}:${rec.business_date}`;
    const existing = deduped.get(key);
    if (!existing || (rec.is_primary && !existing.is_primary)) {
      deduped.set(key, rec);
    }
  }
  const finalRecords = [...deduped.values()].sort((a, b) => a.business_date.localeCompare(b.business_date));
  console.log(`After dedup: ${finalRecords.length} unique records`);

  console.log('\nUpserting to daily_operations...');

  let upserted = 0, errors = 0;
  const CHUNK = 50;

  for (let i = 0; i < finalRecords.length; i += CHUNK) {
    const chunk = finalRecords.slice(i, i + CHUNK);
    const rows = chunk.map(deriveRow);

    const { error } = await supabase
      .from('daily_operations')
      .upsert(rows, { onConflict: 'venue_id,business_date' });

    if (error) {
      console.error(`  Chunk ${Math.floor(i / CHUNK)}: ${error.message}`);
      errors++;
    } else {
      upserted += rows.length;
      if ((i + CHUNK) % 500 === 0 || i + CHUNK >= finalRecords.length) {
        console.log(`  ${Math.min(i + CHUNK, finalRecords.length)}/${finalRecords.length}`);
      }
    }
  }

  console.log(`\nDone. Upserted: ${upserted}, Errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
