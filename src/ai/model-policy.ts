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
   * How hard it thinks, and the ONLY control over that. There is deliberately
   * no `thinking` flag any more.
   *
   * There used to be one, `thinking: boolean`, and on 16 Sep 2026 it was found
   * to do nothing on either model we run. It gated whether
   * `thinking: {type:'adaptive'}` was sent -- and OMITTING the parameter runs
   * adaptive anyway on Opus 5 and Sonnet 5. So `lookup` and `recovery`, both
   * documented here as "no thinking", have been thinking at the model's own
   * default every time they ran. A flag that reads as off while the thing it
   * names is on is worse than no flag: it is a decision everyone believes is in
   * force.
   *
   * The fix is NOT to send `{type:'disabled'}`. Anthropic's own guidance is to
   * prefer low effort over disabled thinking on Opus 5, because with thinking
   * off the model occasionally writes a tool call into its VISIBLE TEXT -- the
   * turn succeeds, the call never runs, nothing errors, and in a tool loop that
   * text pollutes every later round. That is this codebase's favourite kind of
   * bug and there is no reason to invite it. Depth is `effort`, always.
   */
  effort: Effort;
  /**
   * Wall-clock budget for STARTING new tool rounds, or null for no limit.
   *
   * WHY A CLOCK AND NOT JUST A ROUND COUNT. MAX_TOOL_ROUNDS caps how many
   * rounds may run; it cannot cap how long they take, and those are different
   * failures. On 14 Sep 2026 a question about staff joining dates -- data this
   * warehouse deliberately does not hold -- sent the model hunting through
   * tools that could not answer it until the request outlived Railway's edge
   * timeout. The connection was cut, an HTML error page came back, and the
   * browser showed "Error: Request failed". Every token spent on that hunt was
   * billed and nothing reached the person who asked. Third occurrence of this
   * shape.
   *
   * So the budget is the point at which the loop stops starting new work and
   * answers with what it has. It is NOT the total turn time: the rescue reply
   * happens after it, which is why the number is well under any edge timeout
   * rather than just under it.
   *
   * null for the scheduled paths. Nobody is waiting on those and there is no
   * edge proxy in front of a cron job -- capping them would cut off an analysis
   * that had all the time in the world.
   */
  toolBudgetMs: number | null;
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

/**
 * The interactive budget, in milliseconds.
 *
 * 150 seconds, and the number is a floor-of-ignorance rather than a
 * measurement: Railway's edge timeout has never been established, only bounded
 * -- a six-minute answer died and a two-minute one lived. So this sits far
 * enough below any plausible edge that the rescue reply also fits inside it,
 * and it is overridable without a deploy because the right value is something
 * the logs will eventually tell us.
 */
const CHAT_TOOL_BUDGET_MS = Number(process.env.SAURON_TOOL_BUDGET_MS) || 150_000;

const DEFAULTS: Record<Purpose, ModelChoice> = {
  // The surface where the product's actual value is delivered.
  //
  // 8192 was chosen before thinking existed here, and it is now shared with
  // `high` effort. Raised, but not to the recommendation ceiling: somebody is
  // waiting for this one, and a very long answer on a phone is its own failure.
  chat: { model: OPUS, effort: 'high', maxTokens: 16384, toolBudgetMs: CHAT_TOOL_BUDGET_MS },
  // Nobody is waiting, and a weak proactive suggestion is worse than none --
  // it teaches people to ignore the feature.
  //
  // The largest ceiling of the four because it has the deepest thinking AND the
  // longest output: a week's briefing with tables for three findings. This is
  // a ceiling, not a target -- an analysis that needs less costs less.
  //
  // No clock. It runs as a cron job with no proxy in front of it, and the one
  // thing worse than a slow briefing is a truncated one.
  recommendation: { model: OPUS, effort: 'xhigh', maxTokens: 32768, toolBudgetMs: null },
  // A date and a number. Latency matters more than depth, especially on a
  // phone, and there is nothing here for reasoning to improve.
  lookup: { model: SONNET, effort: 'low', maxTokens: 4096, toolBudgetMs: 60_000 },
  // Restating data already in the conversation. Deep thought cannot help, and
  // this path only runs when something has already gone wrong.
  recovery: { model: SONNET, effort: 'low', maxTokens: 4096, toolBudgetMs: null },
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

/**
 * Models a CALLER may ask for, as opposed to ones an operator may configure.
 *
 * An allowlist rather than a passthrough, because this value arrives from a
 * browser and every request against it is billed. A free-text model field would
 * let anyone with a session point our API key at whatever is most expensive, or
 * at a model whose behaviour nothing here has been tested against. The
 * ENVIRONMENT override stays free-text: it is set by whoever deploys the
 * service, who can already do worse.
 */
export interface SelectableProfile {
  model: string;
  /** Omitted means "whatever the job asks for". */
  effort?: Effort;
}

export const SELECTABLE_MODELS: Record<string, SelectableProfile> = {
  // The job's own depth, on the model the job was tiered to.
  opus: { model: OPUS },
  /**
   * The cheap option, and it now has to EARN that label.
   *
   * It used to change the model and nothing else, because effort was held to
   * describe the job rather than the engine. That reasoning was sound and the
   * result was not: on 14 Sep 2026 a question picked "Sonnet — quicker and
   * cheaper" from the dropdown and ran with adaptive thinking at HIGH effort, a
   * 16,384-token ceiling and twelve available tool rounds -- the same work as
   * Opus on a cheaper engine. It then outlived the edge timeout and returned
   * nothing. The label promised a speed the code did not implement.
   *
   * MEDIUM RATHER THAN LOW, and that is a deliberately conservative first step.
   * Anthropic's published runs put `medium` at the default's accuracy for 70-85%
   * of its cost on knowledge work, where `low` gives up one to three points for
   * a third to a half off. `low` may well be right here -- this is warehouse
   * lookup and comparison, not long-horizon coding -- but there is no eval on
   * this path yet, so there is no way to tell a saving from a regression. One
   * word changes it the moment there is.
   */
  sonnet: { model: SONNET, effort: 'medium' },
};

export function modelFor(
  purpose: Purpose,
  env: Record<string, string | undefined> = process.env,
  /**
   * A model the caller explicitly chose, taking precedence over the
   * environment. Must be a key of SELECTABLE_MODELS; anything else is IGNORED
   * rather than rejected, so an unknown value degrades to the configured
   * default instead of failing the question.
   */
  chosen?: string,
): ModelChoice {
  const base = DEFAULTS[purpose] ?? DEFAULTS.chat;

  /**
   * The caller's choice wins over the environment, and both change only the
   * MODEL. Thinking, effort and the output ceiling stay with the purpose,
   * because they describe the JOB rather than the engine -- so picking Sonnet
   * buys a cheaper answer to the same question, not a shallower one.
   */
  const picked = chosen ? SELECTABLE_MODELS[chosen] : undefined;
  if (picked) {
    // A profile may carry an effort; if it does not, the job's own stands.
    return { ...base, model: picked.model, effort: picked.effort ?? base.effort };
  }

  const override = env[ENV_KEY[purpose]]?.trim();
  if (!override) return base;
  return { ...base, model: override };
}

/**
 * The same job, answered fast, for rescuing a turn that has run out of time or
 * rounds.
 *
 * SAME MODEL, DELIBERATELY, and it is the one decision here worth explaining.
 * Dropping to Sonnet would be cheaper per token and is wrong twice over: prompt
 * caches are model-scoped, so a switch re-bills the whole accumulated
 * conversation at full price on the one request whose job is to salvage a turn
 * that has already cost too much -- and by this point `messages` may hold web
 * search results carrying `encrypted_content` that the API decrypts on the way
 * in. Handing those to a different model is untested, and the rescue is exactly
 * where an untested failure must not happen.
 *
 * What changes is DEPTH. Low effort is most of the latency, and latency is the
 * entire thing being bought: a rescue that misses the edge timeout is worth
 * nothing at all. It costs a cache miss on the message tail -- changing effort
 * invalidates the messages cache, though not tools and system -- and that is a
 * price worth paying once, at the end, to turn "Request failed" into an answer.
 */
export function rescueChoice(choice: ModelChoice): ModelChoice {
  return {
    ...choice,
    effort: 'low',
    // A rescue restates what is already gathered. It does not need room to
    // write a second full analysis, and a smaller ceiling is a second brake on
    // how long this can take.
    maxTokens: Math.min(choice.maxTokens, 4096),
    toolBudgetMs: null,
  };
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
