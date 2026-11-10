/**
 * Reading one-off closures (migration 067). Fail-soft: before the migration is
 * applied, or if the read fails, every caller carries on with the regular
 * closed weekdays alone, and the failure is logged once rather than costing a
 * dashboard, a report or an ingest.
 */
import { supabase } from './supabase.js';
import { selectAll } from './paged.js';
import { indexClosures, type ClosureIndex, type OneOffClosure } from './venue-closures.js';

let warned = false;

export async function readClosures(venueIds: string[], from: string, to: string): Promise<ClosureIndex> {
  if (venueIds.length === 0) return new Map();
  const { data, error } = await selectAll(() => supabase
    .from('venue_closures')
    .select('venue_id, closed_on, reason')
    .in('venue_id', venueIds)
    .gte('closed_on', from)
    .lte('closed_on', to)
    .order('closed_on', { ascending: true }));
  if (error) {
    if (!warned) {
      warned = true;
      console.warn(`[closures] one-off closures unavailable (is migration 067 applied?): ${error.message}`);
    }
    return new Map();
  }
  return indexClosures((data ?? []) as OneOffClosure[]);
}

/** One venue's closures in a range, as a set of dates. */
export async function closedDatesFor(venueId: string, from: string, to: string): Promise<Map<string, string>> {
  return (await readClosures([venueId], from, to)).get(venueId) ?? new Map();
}
