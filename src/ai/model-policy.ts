/**
 * Which model answers which kind of question, and how hard it thinks.
 *
 * WHY THIS EXISTS AS A FILE. Until now `claude-sonnet-5` was hardcoded in three
 * places in engine.ts and there was no tiering at all -- despite the brief
 * saying "Opus for deep reasoning/suggestions; a faster/cheaper model for
 * routine lookups & routing". A decision written down and never built is worse
 * than one nobody made, because everyone assumes it is in force.
 *
 * CHOSEN ONCE PER REQUEST, NOT PER TURN, and that is forced rather than tidy:
 * prompt caches are model-scoped, so switching model mid-conversation throws
 * away the entire cached prefix. It is also the honest shape -- the tool loop's
 * first round is routing and its last is analysis, both through the same call
 * site, so there is no per-turn boundary to split on.
 *
 * THE DEFAULT IS OPUS, deliberately. CLAUDE.md says the analytics are table
 * stakes and the recommendations are the product; the recommendation path is
 * the one thing that cannot be bought elsewhere. Opus 5 is 1.67x Sonnet 5 per
 * token ($5/$25 against $3/$15), which at this volume is a rounding error
 * beside prompt caching cutting the repeated prefix to a tenth.
 */

export type Purpose =
  /** Someone asked a question in the web app. The main path. */
  | 'chat'
  /** Scheduled per-venue suggestions nobody is waiting on. */
  | 'recommendation'
  /** "What were sales yesterday" — a lookup, not analysis. */
  | 'lookup'
  /** Re-stating data already gathered after a turn produced no text. */
  | 'recovery';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelChoice {
  model: string;
  /**
   * Extended reasoning. There was NONE anywhere in this codebase before now --
   * every answer was written straight through, including the analytical ones.
   * That was a larger gap than the choice of model.
   */
  thinking: boolean;
  effort?: Effort;
  /**
   * Output ceiling for this purpose, THINKING INCLUDED -- which is the part
   * that is easy to get wrong.
   *
   * Thinking tokens count towards output_tokens, so raising effort without
   * raising this silently takes the budget away from the answer. The first real
   * recommendation run proved it: the final call came back at exactly 8192
   * output tokens -- the ceiling, to the token -- and the analysis behind it was
   * 3,449 characters. Roughly 900 tokens of answer after xhigh thinking had
   * taken the rest, on a briefing that had announced "three things".
   *
   * A truncated analysis is worse here than in chat, because nobody is watching
   * it happen and the structuring pass will faithfully record whatever survived.
   */
  maxTokens: number;
}

export const OPUS = 'claude-opus-5';
export const SONNET = 'claude-sonnet-5';

const DEFAULTS: Record<Purpose, ModelChoice> = {
  // The surface where the product's actual value is delivered.
  //
  // 8192 was chosen before thinking existed here, and it is now shared with
  // `high` effort. Raised, but not to the recommendation ceiling: somebody is
  // waiting for this one, and a very long answer on a phone is its own failure.
  chat: { model: OPUS, thinking: true, effort: 'high', maxTokens: 16384 },
  // Nobody is waiting, and a weak proactive suggestion is worse than none --
  // it teaches people to ignore the feature.
  //
  // The largest ceiling of the four because it has the deepest thinking AND the
  // longest output: a week's briefing with tables for three findings. This is
  // a ceiling, not a target -- an analysis that needs less costs less.
  recommendation: { model: OPUS, thinking: true, effort: 'xhigh', maxTokens: 32768 },
  // A date and a number. Latency matters more than depth, especially on a
  // phone, and there is nothing here for reasoning to improve.
  lookup: { model: SONNET, thinking: false, maxTokens: 4096 },
  // Restating data already in the conversation. Deep thought cannot help, and
  // this path only runs when something has already gone wrong.
  recovery: { model: SONNET, thinking: false, maxTokens: 4096 },
};

/**
 * Environment overrides, one per purpose.
 *
 * Per-purpose rather than one global switch, so a bad night on one path can be
 * moved without flattening the tiering everywhere. Same reasoning as
 * XERO_SCOPES: a setting that can only be tested by deploying is a setting
 * nobody tests.
 */
const ENV_KEY: Record<Purpose, string> = {
  chat: 'SAURON_MODEL_CHAT',
  recommendation: 'SAURON_MODEL_RECOMMENDATION',
  lookup: 'SAURON_MODEL_LOOKUP',
  recovery: 'SAURON_MODEL_RECOVERY',
};

export function modelFor(
  purpose: Purpose,
  env: Record<string, string | undefined> = process.env,
): ModelChoice {
  const base = DEFAULTS[purpose] ?? DEFAULTS.chat;
  const override = env[ENV_KEY[purpose]]?.trim();
  if (!override) return base;
  // Only the model is overridable. Thinking and effort stay with the purpose,
  // because they describe the JOB rather than the engine.
  return { ...base, model: override };
}

/**
 * Is this a 400 about a request feature the model does not accept?
 *
 * WHY. `country: 'SG'` was a valid ISO code the API refused, and because the
 * web search tool ships on every request it took down every question --
 * including ones that never touch the web. The lesson generalises: an optional
 * enrichment must cost the feature, never the product.
 *
 * `thinking` and `output_config` are exactly that shape. Both are documented
 * for these models, neither can be verified without calling the API, and both
 * are sent on every request. If a future model rejects one, answers should get
 * shallower, not stop.
 *
 * Narrow on purpose: a 400 about the messages array is our bug and must
 * surface, and a 429 or 529 is transient.
 */
export function isModelFeatureError(e: any): boolean {
  const status = e?.status ?? e?.response?.status;
  if (status !== 400) return false;
  let detail = '';
  try {
    detail = `${e?.message ?? ''} ${JSON.stringify(e?.error ?? {})}`;
  } catch {
    detail = String(e?.message ?? '');
  }
  return /thinking|output_config|effort|budget_tokens/i.test(detail);
}

/** What to log so a cache that silently stopped working is visible. */
export function usageLine(model: string, usage: any): string {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const uncached = usage?.input_tokens ?? 0;
  const total = cacheRead + cacheWrite + uncached;
  const hitRate = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
  return (
    `[model] ${model} in=${uncached} cache_read=${cacheRead} cache_write=${cacheWrite} ` +
    `out=${usage?.output_tokens ?? 0} cache_hit=${hitRate}%`
  );
}
