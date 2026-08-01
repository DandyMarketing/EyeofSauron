import { supabase } from '../lib/supabase.js';

const MONDAY_API = 'https://api.monday.com/v2';

interface MondayColumnValues {
  [columnId: string]: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  column_values: MondayColumnValues;
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

export interface ReconciliationResult {
  passed: boolean;
  mondayGross: number;
  revelGross: number;
  difference: number;
  tolerance: number;
}

export interface IngestionResult {
  venue: string;
  date: string;
  action: 'inserted' | 'updated' | 'merged' | 'skipped';
  reconciliation?: ReconciliationResult;
  error?: string;
}

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

const VENUE_BOARDS: Record<string, { venueId: string; boards: number[] }> = {
  'neon-pigeon': {
    venueId: '30f4ec07-afc6-4bb4-ba7c-10375b4f68c5',
    boards: [18394773435],
  },
  'fat-prince': {
    venueId: 'c0d03a78-7d28-4a4a-a908-d1719110e881',
    boards: [18394771274],
  },
  'super-firangi': {
    venueId: 'a0838494-04a6-4f04-8c1f-a8a2e01a3c07',
    boards: [18394735035],
  },
};

const JUNK_NAMES = new Set(['bluesheets_21feb_lunch', 'test 2', 'new item']);

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

export function parseDate(raw: string): string | null {
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

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{4})-(\d{2})(\d{2})$/);
  if (m) return validOrNull(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{2})\s+(\d{2})(\d{2})$/);
  if (m) return validOrNull(2000 + +m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validOrNull(+m[3], +m[2], +m[1]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) return validOrNull(2000 + +m[3], +m[2], +m[1]);

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

function deriveTotals(mealPeriods: Record<string, MealPeriodData>, totalScManual: number) {
  let totalFood = 0, totalBev = 0, totalSC = 0, totalCovers = 0, totalDiscounts = 0;
  for (const p of Object.values(mealPeriods)) {
    totalFood += p.food_sales;
    totalBev += p.bev_sales;
    totalSC += p.service_charge;
    totalCovers += p.covers;
    totalDiscounts += p.discounts;
  }
  const grossSales = Math.round((totalFood + totalBev) * 100) / 100;
  const effectiveSC = totalSC > 0 ? totalSC : totalScManual;
  const netSales = Math.round((grossSales - totalDiscounts + effectiveSC) * 100) / 100;
  return { grossSales, netSales, totalCovers, totalDiscounts, effectiveSC };
}

const RECONCILIATION_TOLERANCE = 5.0; // $5 tolerance

export function reconcileMondayVsRevel(
  mondayGross: number,
  revelGross: number,
): ReconciliationResult {
  const difference = Math.abs(mondayGross - revelGross);
  return {
    passed: difference <= RECONCILIATION_TOLERANCE,
    mondayGross,
    revelGross,
    difference,
    tolerance: RECONCILIATION_TOLERANCE,
  };
}

export async function fetchBoardItems(
  boardId: number,
  apiToken: string,
  lookbackDays: number,
): Promise<MondayItem[]> {
  const allItems: MondayItem[] = [];
  let cursor: string | null = null;

  const query = cursor === null
    ? `query ($boardId: [ID!]!, $limit: Int!) {
        boards(ids: $boardId) {
          items_page(limit: $limit) {
            cursor
            items {
              id
              name
              created_at
              column_values { id text }
            }
          }
        }
      }`
    : `query ($boardId: [ID!]!, $limit: Int!, $cursor: String!) {
        boards(ids: $boardId) {
          items_page(limit: $limit, cursor: $cursor) {
            cursor
            items {
              id
              name
              created_at
              column_values { id text }
            }
          }
        }
      }`;

  const LIMIT = 500;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
  const cutoff = cutoffDate.toISOString().split('T')[0];

  while (true) {
    const variables: Record<string, unknown> = {
      boardId: [String(boardId)],
      limit: LIMIT,
    };
    if (cursor) variables.cursor = cursor;

    const gqlQuery = cursor
      ? `query ($boardId: [ID!]!, $limit: Int!, $cursor: String!) {
          boards(ids: $boardId) {
            items_page(limit: $limit, cursor: $cursor) {
              cursor
              items { id name created_at column_values { id text } }
            }
          }
        }`
      : `query ($boardId: [ID!]!, $limit: Int!) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              cursor
              items { id name created_at column_values { id text } }
            }
          }
        }`;

    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiToken,
        'API-Version': '2024-10',
      },
      body: JSON.stringify({ query: gqlQuery, variables }),
    });

    if (!res.ok) {
      throw new Error(`Monday.com API error: ${res.status} ${await res.text()}`);
    }

    const json = await res.json() as {
      data?: { boards: Array<{ items_page: { cursor: string | null; items: Array<{
        id: string; name: string; created_at: string;
        column_values: Array<{ id: string; text: string | null }>;
      }> } }> };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Monday.com GraphQL error: ${json.errors[0].message}`);
    }

    const page = json.data!.boards[0].items_page;
    for (const item of page.items) {
      const colMap: MondayColumnValues = {};
      for (const cv of item.column_values) {
        colMap[cv.id] = cv.text;
      }
      allItems.push({
        id: item.id,
        name: item.name,
        created_at: item.created_at,
        column_values: colMap,
      });
    }

    cursor = page.cursor;
    if (!cursor || page.items.length < LIMIT) break;
  }

  return allItems;
}

export async function ingestMondayItems(
  venueSlug: string,
  items: MondayItem[],
  options: { dryRun?: boolean } = {},
): Promise<IngestionResult[]> {
  const config = VENUE_BOARDS[venueSlug];
  if (!config) throw new Error(`Unknown venue: ${venueSlug}`);
  const { venueId } = config;
  const results: IngestionResult[] = [];

  for (const item of items) {
    if (JUNK_NAMES.has(item.name.toLowerCase().trim())) continue;

    let date = parseDate(item.name);
    if (!date) {
      date = item.created_at.substring(0, 10);
    }

    const year = parseInt(date.substring(0, 4));
    if (year <= 2021) continue;

    const brunch = extractPeriod(item, 'brunch');
    const lunch = extractPeriod(item, 'lunch');
    const dinner = extractPeriod(item, 'dinner');

    const mealPeriods: Record<string, MealPeriodData> = {};
    if (hasMealData(brunch)) mealPeriods.brunch = brunch;
    if (hasMealData(lunch)) mealPeriods.lunch = lunch;
    if (hasMealData(dinner)) mealPeriods.dinner = dinner;

    if (Object.keys(mealPeriods).length === 0) continue;

    const totalScManual = getCol(item, COLUMN_IDS.total_sc_manual);
    const totals = deriveTotals(mealPeriods, totalScManual);

    const { data: existing } = await supabase
      .from('daily_operations')
      .select('id, data_source, gross_sales')
      .eq('venue_id', venueId)
      .eq('business_date', date)
      .maybeSingle();

    let action: IngestionResult['action'];
    let reconciliation: ReconciliationResult | undefined;

    if (existing && existing.data_source === 'revel') {
      // Revel row exists — merge in meal periods, reconcile first
      if (existing.gross_sales && totals.grossSales > 0) {
        reconciliation = reconcileMondayVsRevel(totals.grossSales, existing.gross_sales);
      }

      if (!options.dryRun) {
        const { error } = await supabase
          .from('daily_operations')
          .update({
            meal_periods: mealPeriods,
            data_source: 'both',
          })
          .eq('id', existing.id);

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', reconciliation, error: error.message });
          continue;
        }
      }
      action = 'merged';

    } else if (existing && (existing.data_source === 'monday' || existing.data_source === 'both')) {
      // Monday or merged row — update meal periods
      if (!options.dryRun) {
        const updateData: Record<string, unknown> = { meal_periods: mealPeriods };
        if (existing.data_source === 'monday') {
          updateData.gross_sales = totals.grossSales || null;
          updateData.net_sales = totals.netSales || null;
          updateData.item_discounts = totals.totalDiscounts;
          updateData.taxed_service_fee = totals.effectiveSC;
          updateData.total_guests = totals.totalCovers || null;
        }
        const { error } = await supabase
          .from('daily_operations')
          .update(updateData)
          .eq('id', existing.id);

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', error: error.message });
          continue;
        }
      }
      action = 'updated';

    } else {
      // No existing row — insert as monday source
      if (!options.dryRun) {
        const { error } = await supabase
          .from('daily_operations')
          .insert({
            venue_id: venueId,
            business_date: date,
            gross_sales: totals.grossSales || null,
            net_sales: totals.netSales || null,
            item_discounts: totals.totalDiscounts,
            taxed_service_fee: totals.effectiveSC,
            total_guests: totals.totalCovers || null,
            meal_periods: mealPeriods,
            data_source: 'monday',
          });

        if (error) {
          results.push({ venue: venueSlug, date, action: 'skipped', error: error.message });
          continue;
        }
      }
      action = 'inserted';
    }

    results.push({ venue: venueSlug, date, action, reconciliation });
  }

  return results;
}

export function getVenueBoards(): typeof VENUE_BOARDS {
  return VENUE_BOARDS;
}

export function updateVenueBoards(slug: string, boardIds: number[]): void {
  if (!VENUE_BOARDS[slug]) throw new Error(`Unknown venue: ${slug}`);
  VENUE_BOARDS[slug].boards = boardIds;
}
