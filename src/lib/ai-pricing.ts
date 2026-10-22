/**
 * What one call to the AI cost, from the tokens it used (Khai, 22 Oct 2026:
 * "track the usage of each person and calculate the cost based on the model
 * and query they have asked").
 *
 * LIST PRICES in US dollars per million tokens, as Anthropic publishes them --
 * the currency it bills in. Checked against Anthropic's own reference on
 * 22 Oct 2026. A negotiated discount would make these an upper bound.
 *
 * Every row also keeps its TOKENS, so if a price here changes, history can be
 * recalculated rather than being stuck with whatever this file said that day.
 * Migration 065's backfill carries the same numbers; a test keeps them equal.
 */

export interface ModelPrice {
  /** $ per million input tokens not served from the cache. */
  input: number;
  /** $ per million output tokens (thinking counts as output). */
  output: number;
  /** $ per million cached input tokens read. Usually a tenth of input. */
  cacheRead: number;
  /** $ per million input tokens written to the 5-minute cache: 1.25x input. */
  cacheWrite: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const price = (input: number, output: number, cacheRead = r6(input * 0.1)): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: r6(input * 1.25) });

/**
 * By model id PREFIX, longest first wins: the API may return an id with a
 * suffix, and "claude-opus-5-5" must not be priced as "claude-opus-5".
 * Sauron runs Opus 5 and Sonnet 5 (src/ai/model-policy.ts); the rest are here
 * because SAURON_MODEL_* can switch to them without a deploy.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5':   price(4, 20, 0.20),
  'claude-opus-5':     price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.20),
  'claude-sonnet-5':   price(2, 10),
  'claude-haiku-5-5':  price(0.10, 0.50),
  'claude-fable-5-1':  price(10, 50, 0.25),
  'claude-fable-5':    price(10, 50),
};

/** Anthropic's server-side web search: $10 per 1,000 searches. */
export const WEB_SEARCH_PRICE = 0.01;

export function priceFor(model: string): ModelPrice | null {
  const key = Object.keys(MODEL_PRICES)
    .filter(k => model === k || model.startsWith(k + '-') || model.startsWith(k + '@'))
    .sort((a, b) => b.length - a.length)[0];
  return key ? MODEL_PRICES[key] : null;
}

export interface CallUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  web_searches?: number | null;
}

/**
 * Dollars for one call, or NULL for a model with no price here. Null, never
 * zero: a call priced at nothing would quietly understate the bill, where a
 * blank says "not priced" and the admin page counts how many.
 */
export function callCost(model: string, u: CallUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const dollars =
    (n(u.input_tokens) * p.input +
     n(u.output_tokens) * p.output +
     n(u.cache_read) * p.cacheRead +
     n(u.cache_write) * p.cacheWrite) / 1_000_000 +
    n(u.web_searches) * WEB_SEARCH_PRICE;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/**
 * What a call was FOR, as the admin page groups it. A person's Query answers,
 * their Plan conversation, and the planner's own passes (brief, P&L, progress
 * board, Monday) are theirs; anything with nobody signed in is System.
 */
export type Feature = 'query' | 'plan' | 'system';

/** The forced tool a pass calls names the pass; the planner's are all Plan. */
const PASS_BY_TOOL: Record<string, string> = {
  record_event_draft: 'plan_brief',
  record_event_pnl: 'plan_pnl',
  record_plan_progress: 'plan_progress',
  record_task_titles: 'plan_task_names',
  record_checklist_deadlines: 'plan_monday_deadlines',
  record_task_parents: 'plan_monday_grouping',
  record_recommendations: 'recommendation_split',
};

/** A label for a request that is not the engine's own: from its forced tool. */
export function passOf(params: { tool_choice?: any; tools?: any[] }, fallback: string): string {
  const forced = params.tool_choice?.type === 'tool' ? params.tool_choice.name : null;
  const name = forced ?? (params.tools?.length === 1 ? params.tools[0]?.name : null);
  return (name && PASS_BY_TOOL[name]) ?? fallback;
}

/** Which bucket a call falls in, from who made it and what it was. */
export function featureOf(userId: string | null, purpose: string, routeFeature: Feature | null): Feature {
  if (!userId) return 'system';
  if (purpose.startsWith('plan_')) return 'plan';
  return routeFeature ?? 'query';
}
