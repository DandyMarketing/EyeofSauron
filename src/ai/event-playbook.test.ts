import { test } from 'node:test';
import assert from 'node:assert';
import { PLAYBOOK, renderPlaybook, blockingRows } from './event-playbook.js';
import { EVENT_AGENT_PROMPT, eventDraftTool, openDecisions } from './event-agent.js';

/**
 * These assert the rules that make the conversation worth having, rather than
 * the presence of rows. A playbook can be complete and still be a form.
 */

test('every row carries a challenge, because the challenge is the product', () => {
  for (const r of PLAYBOOK) {
    assert.ok(r.ask.length > 10, `${r.key} has no question`);
    assert.ok(r.weak.length > 10, `${r.key} does not say what a weak answer sounds like`);
    assert.ok(r.challenge.length > 40, `${r.key} has no challenge — it is just a question`);
  }
});

test('keys are unique and match the columns migration 046 stores', () => {
  const keys = PLAYBOOK.map(r => r.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key');

  // The rows that become columns must be spelled as the columns are, or a
  // settled decision writes to nothing.
  for (const k of ['objective', 'price_and_basis', 'ad_spend', 'content_plan', 'partner_terms']) {
    assert.ok(keys.includes(k), `${k} is missing from the playbook`);
  }
});

test('the creative rows do NOT demand a number', () => {
  /**
   * The rule binds targets and commitments, never the idea. An agent that
   * demanded a KPI for a creative direction would be worse than no agent, and
   * this is the flag that stops it.
   */
  for (const k of ['usp_and_differentiation', 'venue_fit', 'audience_motivation', 'alternative_channels']) {
    const row = PLAYBOOK.find(r => r.key === k)!;
    assert.equal(row.measurable, false, `${k} is marked measurable and should not be`);
  }
});

test('the money and target rows DO demand a number', () => {
  for (const k of ['objective', 'price_and_basis', 'cost_build_and_breakeven', 'ad_spend']) {
    const row = PLAYBOOK.find(r => r.key === k)!;
    assert.equal(row.measurable, true, `${k} should require a number`);
  }
});

test('"revenue" is rejected by name in the objective challenge', () => {
  // The specific weak answer Khai called out: one word that cannot be checked.
  const row = PLAYBOOK.find(r => r.key === 'objective')!;
  assert.match(row.challenge, /REVENUE IS NOT AN ANSWER/);
  assert.match(row.weak, /Revenue/);
});

test('price is challenged on per-type averages, never a blend', () => {
  const row = PLAYBOOK.find(r => r.key === 'price_and_basis')!;
  assert.match(row.challenge, /NEVER PRICE OFF A BLENDED AVERAGE/);
  assert.match(row.challenge, /\$62 food and \$33 drink/);
});

test('the alternative-channels row names the standard to aim at', () => {
  /**
   * Without the worked example this row reads as "think of other channels",
   * which produces "LinkedIn". The Sindhi Society and the High Commission are
   * what the answer is supposed to look like.
   */
  const row = PLAYBOOK.find(r => r.key === 'alternative_channels')!;
  assert.match(row.challenge, /Sindhi Society/);
  assert.match(row.challenge, /High Commission of India/);
  assert.match(row.challenge, /KOL/);
});

test('scope only applies when more than one venue is in play', () => {
  const row = PLAYBOOK.find(r => r.key === 'scope')!;
  assert.ok(row.applies_when, 'scope would otherwise be asked of every single-venue event');
  assert.match(row.challenge, /SHARED OCCASION IS NOT A SHARED EVENT/);
});

test('partner terms are conditional, so a wine tasting is not asked about a partner', () => {
  const row = PLAYBOOK.find(r => r.key === 'partner_terms')!;
  assert.ok(row.applies_when);
  assert.ok(row.blocking_when);
});

test('rendering marks blocking, measurability and the conditional rows', () => {
  const text = renderPlaybook();
  assert.match(text, /BLOCKING/);
  assert.match(text, /answer must carry a NUMBER/);
  assert.match(text, /creative or descriptive — do NOT demand a number/);
  assert.match(text, /Only raise this when:/);
});

test('open decisions are the blocking ones not yet settled', () => {
  const all = blockingRows().map(r => r.key);
  assert.ok(all.length > 0);
  assert.deepEqual(openDecisions(all), []);
  assert.ok(openDecisions([]).includes('objective'));
});

test('the prompt forbids writing, and forbids claiming a write', () => {
  /**
   * The model cannot reach the database and must not imply that it has. "The
   * user confirmed" is the claim a language model is worst at, which is why the
   * confirmation is a click in the app rather than a sentence here.
   */
  assert.match(EVENT_AGENT_PROMPT, /you\s+do not write anything to the database/);
  assert.match(EVENT_AGENT_PROMPT, /must never say that you have/);
});

test('the prompt carries the rules that make it not a form', () => {
  assert.match(EVENT_AGENT_PROMPT, /YOU ARE NOT A FORM/);
  assert.match(EVENT_AGENT_PROMPT, /ONE thing at a time/);
  assert.match(EVENT_AGENT_PROMPT, /PUSH BACK ON WEAK ANSWERS/);
  assert.match(EVENT_AGENT_PROMPT, /ALLOWED TO SAY THE PLAN IS NOT READY/);
  assert.match(EVENT_AGENT_PROMPT, /EVERY FIGURE COMES FROM A QUERY TOOL/);
  assert.match(EVENT_AGENT_PROMPT, /NEVER BLENDED/);
});

test('the prompt keeps the empty events store from becoming a verdict', () => {
  // "No record" is a fact about the data. "Never tried here" is a claim about
  // the business, and for the next year it would be made from an absence.
  assert.match(EVENT_AGENT_PROMPT, /not backfilled/);
  assert.match(EVENT_AGENT_PROMPT, /Never say "this has not been\s+tried here"/);
});

test('the draft tool requires a date and an owner on every task', () => {
  const schema: any = eventDraftTool().input_schema;
  const task = schema.properties.tasks.items;
  assert.ok(task.required.includes('t_minus_days'), 'a post without a date is an intention');
  assert.ok(task.required.includes('owner_name'), 'a plan with no owner is a wish');
});

test('the draft tool keeps the two price bases separate', () => {
  const props: any = eventDraftTool().input_schema.properties;
  assert.ok(props.price_basis_food_avg);
  assert.ok(props.price_basis_bev_avg);
  assert.match(props.price_basis_bev_avg.description, /SEPARATELY/);
});

test('the draft tool warns against inventing a figure to fill a field', () => {
  // The failure this surface invites: judgement is the product here, so a
  // missing baseline is the easiest thing in the system to quietly make up.
  assert.match(eventDraftTool().description, /Do not invent a baseline/);
  assert.match(eventDraftTool().description, /does NOT save anything/);
});

test('multi-venue is discouraged in the tool, not only in the conversation', () => {
  const props: any = eventDraftTool().input_schema.properties;
  assert.match(props.venue_slugs.description, /MORE THAN ONE ONLY IF THE MECHANIC BREAKS/);
});
