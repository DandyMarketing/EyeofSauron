import { test } from 'node:test';
import assert from 'node:assert';
import {
  modelFor,
  isModelFeatureError,
  usageLine,
  rescueChoice,
  OPUS,
  SONNET,
} from './model-policy.js';

/**
 * The brief said "Opus for deep reasoning/suggestions; a faster/cheaper model
 * for routine lookups & routing" and the code hardcoded claude-sonnet-5 in
 * three places with no tiering at all. A decision written down and never built
 * is worse than one nobody made, because everyone assumes it is in force.
 */

test('the analysis paths get Opus, and they think hardest', () => {
  // CLAUDE.md: the analytics are table stakes, the recommendations are the
  // product. This is the path that cannot be bought elsewhere.
  assert.equal(modelFor('chat', {}).model, OPUS);
  assert.equal(modelFor('recommendation', {}).model, OPUS);
});

/**
 * REWRITTEN 16 Sep 2026. These three tests used to assert `thinking === false`
 * on the cheap tiers, and that field has been removed because it never did
 * anything: omitting `thinking` runs ADAPTIVE on both Opus 5 and Sonnet 5, so
 * the two purposes documented as "no thinking" were thinking every time they
 * ran. The tests passed throughout, which is the part worth keeping in mind --
 * they asserted our intention rather than the API's behaviour.
 *
 * Depth is now `effort`, which is a real control, and the assertions are on
 * that.
 */
test('a lookup is shallow, and shallow now means low effort', () => {
  // "What were sales yesterday" is a date and a number. Latency matters more
  // than depth, and there is nothing for reasoning to improve.
  const lookup = modelFor('lookup', {});
  assert.equal(lookup.model, SONNET);
  assert.equal(lookup.effort, 'low');
});

test('recovery is cheap and shallow on purpose', () => {
  // It only runs when a turn already failed, and it restates data already in
  // the conversation. Deep thought cannot help.
  assert.equal(modelFor('recovery', {}).model, SONNET);
  assert.equal(modelFor('recovery', {}).effort, 'low');
});

test('no purpose can express "do not think" any more', () => {
  // Deliberate. Anthropic's guidance is to prefer low effort over disabled
  // thinking on Opus 5: with thinking off the model occasionally writes a tool
  // call into its visible TEXT, which succeeds, never runs, raises nothing, and
  // then pollutes every later round of the loop.
  for (const purpose of ['chat', 'recommendation', 'lookup', 'recovery'] as const) {
    assert.ok(modelFor(purpose).effort, `${purpose} has no effort`);
    assert.equal((modelFor(purpose) as any).thinking, undefined);
  }
});

test('the proactive path thinks harder than the interactive one', () => {
  // Nobody is waiting on a scheduled suggestion, and a weak one is worse than
  // none — it teaches people to ignore the feature.
  const chat = modelFor('chat', {});
  const proactive = modelFor('recommendation', {});
  assert.equal(chat.effort, 'high');
  assert.equal(proactive.effort, 'xhigh');
});

test('an env override changes the model and nothing else', () => {
  // Effort describes the JOB, not the engine, so an operator override that
  // silently made every answer shallower would be a trap. The CALLER's choice
  // is different and deliberately does move effort -- see below.
  const overridden = modelFor('chat', { SAURON_MODEL_CHAT: 'claude-sonnet-5' });
  assert.equal(overridden.model, 'claude-sonnet-5');
  assert.equal(overridden.effort, 'high');
});

test('overrides are per purpose, so one path can move alone', () => {
  const env = { SAURON_MODEL_LOOKUP: 'claude-haiku-4-5' };
  assert.equal(modelFor('lookup', env).model, 'claude-haiku-4-5');
  assert.equal(modelFor('chat', env).model, OPUS);
});

test('an empty override is ignored rather than blanking the model', () => {
  assert.equal(modelFor('chat', { SAURON_MODEL_CHAT: '   ' }).model, OPUS);
});

test('a 400 about thinking or effort is a feature error', () => {
  // These ship on every request. If a model refuses one, answers should get
  // shallower — not stop, the way the web search country code stopped
  // everything.
  for (const message of [
    'thinking.budget_tokens: not supported on this model',
    'output_config.effort: unsupported value',
    'Unexpected parameter: thinking',
  ]) {
    const err: any = new Error(message);
    err.status = 400;
    assert.equal(isModelFeatureError(err), true, message);
  }
});

test('a 400 about our own messages is NOT swallowed', () => {
  const err: any = new Error('messages.3: tool_use ids were found without tool_result blocks');
  err.status = 400;
  assert.equal(isModelFeatureError(err), false);
});

test('transient failures are not feature errors', () => {
  // Retrying without thinking would turn a blip into a permanently shallower
  // answer for that request.
  const rate: any = new Error('429 rate_limit_error thinking');
  rate.status = 429;
  assert.equal(isModelFeatureError(rate), false);

  const overloaded: any = new Error('529 overloaded_error');
  overloaded.status = 529;
  assert.equal(isModelFeatureError(overloaded), false);
});

test('the usage line reports the cache hit rate', () => {
  // A cache that silently stopped working otherwise shows up as a bill months
  // later and nothing else.
  const line = usageLine(OPUS, {
    input_tokens: 200,
    cache_read_input_tokens: 1800,
    cache_creation_input_tokens: 0,
    output_tokens: 500,
  });
  assert.match(line, /cache_read=1800/);
  assert.match(line, /cache_hit=90%/);
});

test('a first request with nothing cached reports 0%', () => {
  const line = usageLine(OPUS, { input_tokens: 5000, output_tokens: 100 });
  assert.match(line, /cache_hit=0%/);
});

test('a missing usage object does not throw', () => {
  assert.match(usageLine(OPUS, undefined), /cache_hit=0%/);
});

// --- output ceilings -------------------------------------------------------

/**
 * Thinking tokens count towards output_tokens, so a purpose with deeper
 * thinking needs a HIGHER ceiling, not the same one. The first recommendation
 * run came back at exactly 8192 output tokens with a 3,449-character answer:
 * xhigh thinking had taken the budget and the analysis was truncated.
 */
test('every purpose has an output ceiling', () => {
  for (const purpose of ['chat', 'recommendation', 'lookup', 'recovery'] as const) {
    const choice = modelFor(purpose);
    assert.ok(choice.maxTokens > 0, `${purpose} has no maxTokens`);
  }
});

test('the deepest-thinking purpose gets the most room', () => {
  assert.ok(
    modelFor('recommendation').maxTokens > modelFor('chat').maxTokens,
    'recommendation thinks harder AND writes longer than chat',
  );
  assert.ok(
    modelFor('chat').maxTokens > modelFor('lookup').maxTokens,
    'chat thinks; a lookup does not',
  );
});

test('a deep-thinking purpose is never left on the pre-thinking ceiling', () => {
  // 8192 was set before any thinking existed in this codebase. Thinking tokens
  // count towards output, so any purpose that thinks hard must have moved off
  // it or its answer is what gets truncated.
  for (const purpose of ['chat', 'recommendation'] as const) {
    const choice = modelFor(purpose);
    assert.ok(choice.maxTokens > 8192, `${purpose} still on the pre-thinking ceiling`);
  }
});

// --- the interactive clock -------------------------------------------------

/**
 * MAX_TOOL_ROUNDS caps how many rounds may run and cannot cap how long they
 * take. On 14 Sep 2026 a question about data the warehouse deliberately does
 * not hold sent the model hunting until the request outlived Railway's edge
 * timeout: connection cut, HTML error page, "Error: Request failed" in the
 * browser, every token billed, nothing delivered.
 */
test('the interactive path has a clock and the scheduled one does not', () => {
  const chat = modelFor('chat');
  assert.ok(chat.toolBudgetMs && chat.toolBudgetMs > 0, 'chat has no budget');

  // Nobody is waiting on a briefing and there is no proxy in front of a cron
  // job. Cutting one off would truncate an analysis that had all the time in
  // the world.
  assert.equal(modelFor('recommendation').toolBudgetMs, null);
});

test('the budget leaves room for the rescue reply, not just for the edge', () => {
  // It is the point at which new ROUNDS stop starting; the rescue happens
  // after it. A budget set just under the edge timeout would produce a rescue
  // that itself times out, which is the original failure with more steps.
  const chat = modelFor('chat');
  assert.ok(chat.toolBudgetMs! <= 180_000, 'budget is too close to any plausible edge timeout');
});

test('the rescue keeps the model and drops the depth', () => {
  // Same model because caches are model-scoped and the conversation may carry
  // encrypted web-search content; low effort because latency is the entire
  // thing being bought.
  const chat = modelFor('chat');
  const rescue = rescueChoice(chat);

  assert.equal(rescue.model, chat.model);
  assert.equal(rescue.effort, 'low');
  assert.ok(rescue.maxTokens <= chat.maxTokens);
  assert.equal(rescue.toolBudgetMs, null, 'the rescue must never be cut off by the clock that caused it');
});

test('a model override does not change the ceiling', () => {
  // Env overrides pick the engine; thinking and ceilings describe the JOB.
  const before = modelFor('lookup').maxTokens;
  process.env.SAURON_MODEL_LOOKUP = 'claude-haiku-4-5';
  try {
    assert.equal(modelFor('lookup').model, 'claude-haiku-4-5');
    assert.equal(modelFor('lookup').maxTokens, before);
  } finally {
    delete process.env.SAURON_MODEL_LOOKUP;
  }
});

/**
 * REWRITTEN 16 Sep 2026, and this one is a reversal rather than a tidy-up.
 *
 * It used to assert that choosing Sonnet changed the model and NOTHING else,
 * on the reasoning that effort describes the job. The dropdown that selects it
 * says "Sonnet — quicker and cheaper", and on 14 Sep a question that chose it
 * ran with adaptive thinking at high effort, a 16,384-token ceiling and twelve
 * tool rounds, then outlived the edge timeout and returned nothing at all. The
 * old test was locking in a promise the product was not keeping.
 */
test('the cheap choice is actually cheaper — it moves effort, not just the model', () => {
  const base = modelFor('chat', {});
  const cheap = modelFor('chat', {}, 'sonnet');

  assert.equal(cheap.model, SONNET);
  assert.equal(base.effort, 'high');
  assert.equal(cheap.effort, 'medium');
  // The ceiling is a backstop, not a tuning knob: lowering it would truncate
  // answers mid-thought rather than making them cheaper.
  assert.equal(cheap.maxTokens, base.maxTokens);
});

test('choosing Opus explicitly leaves the job untouched', () => {
  const base = modelFor('chat', {});
  const chosen = modelFor('chat', {}, 'opus');
  assert.deepEqual(chosen, base);
});

test('the caller wins over the environment', () => {
  const choice = modelFor('chat', { SAURON_MODEL_CHAT: 'some-other-model' }, 'sonnet');
  assert.equal(choice.model, SONNET);
});

test('an unknown model is ignored, never passed through', () => {
  // This value arrives from a browser and every request against it is billed.
  // A passthrough would let anyone with a session point our key at whatever is
  // most expensive, or at a model nothing here has been tested against.
  const choice = modelFor('chat', {}, 'claude-something-enormous');
  assert.equal(choice.model, OPUS);

  // And it degrades rather than failing: an unknown value must not cost
  // somebody their question.
  assert.equal(choice.maxTokens, modelFor('chat', {}).maxTokens);
});

test('an unknown choice still lets the environment override stand', () => {
  const choice = modelFor('chat', { SAURON_MODEL_CHAT: 'operator-chosen' }, 'nonsense');
  assert.equal(choice.model, 'operator-chosen');
});
