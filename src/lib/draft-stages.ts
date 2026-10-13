/**
 * What the brief-writer is doing right now, in plain words.
 *
 * Khai, 13 Oct 2026, of a "Putting the brief together..." that sat unchanged
 * for minutes: "it makes it feel like the process hanged". The brief is one
 * long model call, so the honest progress is what it has WRITTEN so far: the
 * tool's input arrives as streamed JSON, and the field it is on now -- the last
 * key in the partial object -- says which part of the brief is being written.
 * Nothing here is a timer pretending to be progress.
 */

const STAGES: Array<[RegExp, string]> = [
  [/^(name|start_date|end_date|venue_slugs)$/, 'Naming the event, its dates and venues'],
  [/^other_spaces$/, 'Recording the spaces that are not our venues'],
  [/^(occasion|concept_type|partner|format|demographic|concept|usp|venue_fit)$/, 'Writing the concept'],
  [/^(target_|baseline_)/, 'Setting the target against a normal night'],
  [/^price/, 'Setting the price'],
  [/^(cost_lines|cost_total|break_even_covers)$/, 'Adding up the costs'],
  [/^(ad_budget|ad_plan)$/, 'Writing the ad plan'],
  [/^tasks$/, 'Listing the tasks'],
  [/^city_events_found$/, 'Noting what else is on in the city'],
  [/^abort_condition$/, 'Setting the check date'],
  [/^pnl$/, 'Laying out the P&L'],
  [/^brief$/, 'Writing the brief itself'],
];

export interface DraftStage { key: string; label: string }

/** The stage for a partial draft, or null before anything has been written. */
export function draftStage(snapshot: unknown): DraftStage | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const keys = Object.keys(snapshot as Record<string, unknown>);
  const key = keys[keys.length - 1];
  if (!key) return null;
  const s = snapshot as Record<string, any>;
  const base = STAGES.find(([re]) => re.test(key))?.[1] ?? 'Putting the brief together';

  // A count where there is one to give, so a long section visibly moves.
  if (key === 'tasks' && Array.isArray(s.tasks)) {
    return { key, label: `${base} (${s.tasks.length} so far)` };
  }
  if (key === 'pnl' && s.pnl && typeof s.pnl === 'object') {
    const lines = (Array.isArray(s.pnl.programming) ? s.pnl.programming.length : 0) + (Array.isArray(s.pnl.costs) ? s.pnl.costs.length : 0);
    return { key, label: lines ? `${base} (${lines} lines so far)` : base };
  }
  if (key === 'brief' && typeof s.brief === 'string') {
    const words = s.brief.split(/\s+/).filter(Boolean).length;
    return { key, label: words ? `${base} (about ${Math.round(words / 50) * 50 || words} words)` : base };
  }
  return { key, label: base };
}
