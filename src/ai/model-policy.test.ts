import { test } from 'node:test';
import assert from 'node:assert';
import {
  modelFor,
  isModelFeatureError,
  usageLine,
  OPUS,
  SONNET,
} from './model-policy.js';

/**
 * The brief said "Opus for deep reasoning/suggestions; a faster/cheaper model
 * for routine lookups & routing" and the code hardcoded claude-sonnet-5 in
 * three places with no tiering at all. A decision written down and never built
 * is worse than one nobody made, because everyone assumes it is in force.
 */

test('the analysis paths get Opus, and they think', () => {
  // CLAUDE.md: the analytics are table stakes, the recommendations are the
  // product. This is the path that cannot be bought elsewhere.
  assert.equal(modelFor('chat', {}).model, OPUS);
  assert.equal(modelFor('chat', {}).thinking, true);
  assert.equal(modelFor('recommendation', {}).model, OPUS);
  assert.equal(modelFor('recommendation', {}).thinking, true);
});

test('a lookup gets Sonnet and no thinking', () => {
  // "What were sales yesterday" is a date and a number. Latency matters more
  // than depth, and there is nothing for reasoning to improve.
  const lookup = modelFor('lookup', {});
  assert.equal(lookup.model, SONNET);
  assert.equal(lookup.thinking, false);
  assert.equal(lookup.effort, undefined);
});

test('recovery is cheap and shallow on purpose', () => {
  // It only runs when a turn already failed, and it restates data already in
  // the conversation. Deep thought cannot help.
  assert.equal(modelFor('recovery', {}).model, SONNET);
  assert.equal(modelFor('recovery', {}).thinking, false);
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
  // thinking and effort describe the JOB, not the engine, so an override that
  // silently turned reasoning off would be a trap.
  const overridden = modelFor('chat', { SAURON_MODEL_CHAT: 'claude-sonnet-5' });
  assert.equal(overridden.model, 'claude-sonnet-5');
  assert.equal(overridden.thinking, true);
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

test('a thinking purpose is never left on the pre-thinking ceiling', () => {
  // 8192 was set before any thinking existed in this codebase. Any purpose
  // that thinks must have moved off it.
  for (const purpose of ['chat', 'recommendation'] as const) {
    const choice = modelFor(purpose);
    assert.equal(choice.thinking, true);
    assert.ok(choice.maxTokens > 8192, `${purpose} still on the pre-thinking ceiling`);
  }
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
