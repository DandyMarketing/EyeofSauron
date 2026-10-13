import { test } from 'node:test';
import assert from 'node:assert';
import { PLAYBOOK, renderPlaybook, blockingRows } from './event-playbook.js';
import { EVENT_AGENT_PROMPT, eventDraftTool, eventPnlTool, openDecisions } from './event-agent.js';

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
  // An empty events store is not an empty history: last year's trade and last
  // year's competing programme are both reachable (Khai, 12 Oct 2026).
  assert.match(EVENT_AGENT_PROMPT, /SAME OCCASION LAST YEAR/);
  assert.match(EVENT_AGENT_PROMPT, /AN EMPTY EVENTS STORE IS NOT AN EMPTY HISTORY/);
  // Khai, 12 Oct 2026: "It keeps asking without sign of progress."
  assert.match(EVENT_AGENT_PROMPT, /EVERY EXCHANGE MUST MOVE THE PLAN/);
  assert.match(EVENT_AGENT_PROMPT, /RECOMMEND, THEN ASK FOR A YES/);
  assert.match(EVENT_AGENT_PROMPT, /SAY A CAVEAT ONCE/);
  // Khai, 12 Oct 2026: people do not know what makes it unique -- propose it,
  // rank what to push, and use plain words.
  assert.match(EVENT_AGENT_PROMPT, /PROPOSE THE CREATIVE ANSWERS/);
  assert.match(EVENT_AGENT_PROMPT, /Never ask one of these cold/);
  assert.match(EVENT_AGENT_PROMPT, /RANK WHAT TO PUSH/);
  assert.match(EVENT_AGENT_PROMPT, /PLAIN WORDS/);
  assert.match(JSON.stringify(eventDraftTool()), /What to push hardest/);
  // Package against package, ticket by ticket (Khai, 12 Oct 2026).
  assert.match(EVENT_AGENT_PROMPT, /COMPARE THE PACKAGE, NOT THE PARTS/);
  assert.match(EVENT_AGENT_PROMPT, /WE HAVE THE EDGE · LEVEL · THEY HAVE THE EDGE/);
  assert.match(EVENT_AGENT_PROMPT, /THE LAYERING IS INSUFFICIENT/);
  // A suggested number is labelled; a market claim needs a source (Khai, 12 Oct 2026).
  assert.match(EVENT_AGENT_PROMPT, /THREE KINDS OF NUMBER/);
  assert.match(EVENT_AGENT_PROMPT, /\(proposal\)/);
  assert.match(EVENT_AGENT_PROMPT, /NEVER CALL ANYTHING STANDARD, TYPICAL, NORMAL, THE GOING RATE/);
  assert.match(EVENT_AGENT_PROMPT, /Your training is not a source/);
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

/**
 * The 10 October failure. Asked to plan an event on race Saturday, the agent
 * said nothing about the Grand Prix or about Amber Lounge running that night
 * from $850 a head. These assert the three things that were wrong.
 */

test('the date is checked on first mention, not when the agenda reaches it', () => {
  /**
   * The original fault: competing_events sat in the `shape` stage, after
   * `point`, so a conversation opening with a date reached the clash check
   * several turns later if at all.
   *
   * THE FIRST FIX OVERSHOT and this test went with it. It asserted the prompt
   * said the check "interrupts the agenda", and it did — so the agent led with
   * the Grand Prix before knowing whether the event was a dinner or a late
   * party, which is the only thing that decides what the clash means. The
   * property worth guarding is that the CHECK is early, not that the
   * CONVERSATION is hijacked; the assertion that the old wording is gone lives
   * in the test above.
   */
  assert.match(EVENT_AGENT_PROMPT, /THE MOMENT A DATE IS NAMED/);
  assert.match(EVENT_AGENT_PROMPT, /on the first mention of a date/);
});

test('the table is checked before the search, and the search is bounded', () => {
  // Searching first is what produced fourteen pages and zero citations on the
  // 29 Sep run. The anchors are a query; the long tail is a narrow search.
  assert.match(EVENT_AGENT_PROMPT, /query_city_events/);
  assert.match(EVENT_AGENT_PROMPT, /CHECK IT FIRST, ALWAYS/);
  assert.match(EVENT_AGENT_PROMPT, /NARROW question about a\s+SPECIFIC window/);
  assert.match(EVENT_AGENT_PROMPT, /fourteen pages/);
});

test('a clash and an opportunity are told apart on five stated factors', () => {
  /**
   * Khai's point: a competing event "gives a different approach and target
   * market". Amber Lounge at $850 from 9pm is not competing for a $180 dinner
   * wallet — it is a pre-party seating. Without a framework the agent either
   * ignores the clash or panics about it, and both are wrong.
   */
  for (const factor of ['PROXIMITY', 'HOUR', 'PRICE, WHICH IS THE DEMOGRAPHIC', 'SCALE', 'DIRECTION']) {
    assert.ok(EVENT_AGENT_PROMPT.includes(factor), `the ${factor} factor is missing`);
  }
  assert.match(EVENT_AGENT_PROMPT, /CLASH, OPPORTUNITY or IRRELEVANT/);
  // Irrelevant said out loud, because silence reads as "nothing is on".
  assert.match(EVENT_AGENT_PROMPT, /Irrelevant is a real answer/);
});

test('the demographic read is marked as an inference, and its inputs are not', () => {
  // The reasoning is the product here. The numbers under it are the one thing
  // that must not be invented, and a confident invented audience sounds exactly
  // like the useful version.
  assert.match(EVENT_AGENT_PROMPT, /NEVER state a ticket price, a date or an attendance figure/);
  assert.match(EVENT_AGENT_PROMPT, /SAY WHEN YOU ARE INFERRING/);
});

test('a search that found nothing has to say so', () => {
  assert.match(EVENT_AGENT_PROMPT, /silence reads as "nothing is on"/);
});

test('what the search finds is offered back to the calendar, with a source', () => {
  /**
   * The answer to "we cannot possibly maintain that by hand": the table holds
   * the anchors and fills its long tail as a byproduct of somebody planning
   * around it. An unsourced row would be an assertion nobody can check sitting
   * in the table everything else trusts, so source_url is required.
   */
  const props: any = eventDraftTool().input_schema.properties;
  const found = props.city_events_found;
  assert.ok(found, 'the draft cannot carry what it discovered');
  assert.ok(found.items.required.includes('source_url'), 'a calendar row without a source');
  assert.match(found.description, /never something you remember/);
});

test('the agent names competitor programming as the thing it cannot see', () => {
  /**
   * Khai: are they looking at other venues — guest shifts, major festivals —
   * so we know who we are competing with. The festivals are now in
   * city_events. Competitor PROGRAMMING is not tracked at all, and an agent
   * that checks two calendars and goes quiet implies a clear diary when what
   * it means is that it could not look.
   */
  assert.match(EVENT_AGENT_PROMPT, /WHAT YOU CANNOT SEE, AND MUST SAY SO/);
  assert.match(EVENT_AGENT_PROMPT, /guest shift/i);
  assert.match(EVENT_AGENT_PROMPT, /a real gap rather than a clear\s+diary/);
});

/**
 * The opposite failure to the 10 October one, caused by fixing it. Told "I want
 * to do an event on 10 October 2026 at Neon Pigeon", the agent opened with the
 * Grand Prix and a demand for a measurable objective — before it knew whether
 * the event was a dinner or a late party, which is the only thing that decides
 * what the clash means.
 */

test('it hears the idea out before challenging any of it', () => {
  assert.match(EVENT_AGENT_PROMPT, /HEAR THE WHOLE IDEA BEFORE YOU ARGUE/);
  assert.match(EVENT_AGENT_PROMPT, /genuine\s+curiosity before a single challenge/);
});

test('THIN and WEAK are distinguished, because only one earns a challenge', () => {
  /**
   * "Mainly awareness" is weak: thought about, and badly. "An event on the 10th
   * at Neon Pigeon" is thin: not finished. Treating the second like the first
   * is badgering somebody for not yet having said what they were about to say.
   */
  assert.match(EVENT_AGENT_PROMPT, /THIN IS NOT WEAK/);
  assert.match(EVENT_AGENT_PROMPT, /earns a follow-up\s+question instead/);
  assert.match(EVENT_AGENT_PROMPT, /it is badgering/);
});

test('the date is CHECKED immediately but RAISED when the advice can be specific', () => {
  // Checking and raising are different acts. Running them together is what
  // made the fix for the 10 October miss into an interruption.
  assert.match(EVENT_AGENT_PROMPT, /CHECK IMMEDIATELY AND SILENTLY/);
  assert.match(EVENT_AGENT_PROMPT, /RAISE IT ONCE YOU KNOW ENOUGH/);
  assert.match(EVENT_AGENT_PROMPT, /ONE CLAUSE/);

  // And the old wording must not creep back.
  assert.doesNotMatch(EVENT_AGENT_PROMPT, /it interrupts the agenda/);
});

test('the clash still gets raised — holding it is not dropping it', () => {
  // The 10 October failure must not come back as the cure for this one.
  assert.match(EVENT_AGENT_PROMPT, /THEN RAISE IT PROPERLY/);
  assert.match(EVENT_AGENT_PROMPT, /stops you forgetting it/);
});

/**
 * The planner replaces the whole standing prompt, so it never inherited
 * Sauron's presentation rules — it was built with none at all. The 10 October
 * answer was correct, insightful and a wall of prose, which for somebody on a
 * phone between services is most of the way to useless.
 */

test('the planner has presentation rules, which it did not inherit', () => {
  // system-prompt.ts has these; EVENT_AGENT_PROMPT replaces it wholesale, so
  // they have to be stated again rather than assumed.
  assert.match(EVENT_AGENT_PROMPT, /SHOW IT, DO NOT NARRATE IT/);
  assert.match(EVENT_AGENT_PROMPT, /run restaurants/);
});

test('the verdict leads, the facts are a table, the prose is capped', () => {
  assert.match(EVENT_AGENT_PROMPT, /THE VERDICT GOES FIRST/);
  assert.match(EVENT_AGENT_PROMPT, /MORE THAN TWO FACTS PER ROW IS A TABLE/);
  assert.match(EVENT_AGENT_PROMPT, /THREE SENTENCES OF PROSE, AT MOST/);
  assert.match(EVENT_AGENT_PROMPT, /ONE QUESTION, at the end/);
});

test('the prompt SHOWS the shape rather than describing it', () => {
  /**
   * A worked example beats a rule here. The example is the real 10 October
   * answer rewritten: same facts, same judgement, a third of the reading — so
   * the model can see the target instead of inferring it from adjectives.
   */
  assert.match(EVENT_AGENT_PROMPT, /\| On, Sat 10 Oct \| Where \| When \| Price \|/);
  assert.match(EVENT_AGENT_PROMPT, /THAT IS THE SHAPE/);
});

test('brevity is not allowed to cost the insight', () => {
  // The Padang emptying at 11.45 is the product. The rule is "say it in one
  // sentence", never "leave it out" — a short answer with nothing in it is a
  // worse failure than a long one.
  assert.match(EVENT_AGENT_PROMPT, /Your REASONING is the product/);
  assert.match(EVENT_AGENT_PROMPT, /an insight is one\s+sentence, not five/);
});

test('the channels row walks every channel, Instagram plan and TikTok included', () => {
  // Khai, 13 Oct 2026: "one channel is mentioned, the promoters -- what is the IG plan", "tik tok etc".
  const row = PLAYBOOK.find(r => r.key === 'channels')!;
  for (const ch of ['Instagram', 'TikTok', 'email', 'WhatsApp', 'Google', 'ticket platform', 'promoters']) {
    assert.match(row.ask, new RegExp(ch), `channels ask is missing ${ch}`);
  }
  assert.match(row.challenge, /THE INSTAGRAM PLAN IS MORE THAN THE POST SCHEDULE/);
  assert.match(row.challenge, /ONE is named as the booking channel/);
  // Paid reach is a channel; borrowed trust is the other row.
  assert.match(row.challenge, /KOLs and promoters are CHANNELS|KOLs.*are CHANNELS/);
  const alt = PLAYBOOK.find(r => r.key === 'alternative_channels')!;
  assert.match(alt.decision, /lending their trust/);
});

test('the planner is shown the board and may not claim the plan is done past it', () => {
  assert.match(EVENT_AGENT_PROMPT, /THE BOARD IS THE RECORD, NOT YOUR MEMORY/);
  assert.match(EVENT_AGENT_PROMPT, /\[PROGRESS BOARD\] note/);
  assert.match(EVENT_AGENT_PROMPT, /never say CONFIRMED\s+at all/);
});

test('the planner writes plain words and short sentences', () => {
  // Khai, 13 Oct 2026: "you are going to need to simplify the language used".
  assert.match(EVENT_AGENT_PROMPT, /PLAIN WORDS, SHORT SENTENCES/);
  assert.match(EVENT_AGENT_PROMPT, /about fifteen words at most/);
  assert.match(EVENT_AGENT_PROMPT, /NO FIGURES OF SPEECH/);
  assert.match(EVENT_AGENT_PROMPT, /BEFORE:[\s\S]*AFTER:/);
  const brief = (eventDraftTool().input_schema.properties as any).brief.description;
  assert.match(brief, /PLAIN WORDS AND SHORT SENTENCES/);
});

test('a parked task stays parked, and a reply asks at most one question', () => {
  // Khai, 13 Oct 2026: asked for the DJ's name six times after "not yet".
  assert.match(EVENT_AGENT_PROMPT, /A PARKED TASK STAYS PARKED/);
  assert.match(EVENT_AGENT_PROMPT, /Do not ask for it again,\s+do not ask for a "provisional"\s+one/);
  assert.match(EVENT_AGENT_PROMPT, /If nothing is\s+open, ask nothing/);
  assert.doesNotMatch(EVENT_AGENT_PROMPT, /- ONE QUESTION, at the end/);
  assert.match(EVENT_AGENT_PROMPT, /Parked tasks with an owner and a date\s+do NOT stop it being ready/);
  assert.match(EVENT_AGENT_PROMPT, /"Prepare the\s+brief"[\s\S]*"Create this\s+event"/);
});

test('owners and deadlines is about who and when, not the name of what the task is about', () => {
  // Khai, 13 Oct 2026: "A name against every item" was read as the DJ's name.
  const row = PLAYBOOK.find(r => r.key === 'owners_and_deadlines')!;
  assert.doesNotMatch(row.decision, /^A name against every item/);
  assert.match(row.decision, /A person who owns every task, and a date/);
  assert.match(row.decision, /which DJ/);
});

test('the draft lists only our venues, and owners are people, not "Planner"', () => {
  // Khai, 13 Oct 2026: Create refused "barter" -- a rented rooftop -- and a
  // task owner came out as "Planner".
  const props = eventDraftTool().input_schema.properties as any;
  assert.match(props.venue_slugs.description, /never a space being rented or a partner's venue/);
  assert.match(props.tasks.items.properties.owner_name.description, /neither is "Planner" or "You"/);
});

test('our venues are a fixed choice, and other spaces have their own place', () => {
  // Khai, 13 Oct 2026: the Barter rooftop, rented, was written in as a venue.
  const fixed = (eventDraftTool(['neon-pigeon', 'fat-prince']).input_schema.properties as any).venue_slugs.items;
  assert.deepEqual(fixed.enum, ['neon-pigeon', 'fat-prince']);
  assert.equal((eventDraftTool().input_schema.properties as any).venue_slugs.items.enum, undefined);
  const spaces = (eventDraftTool().input_schema.properties as any).other_spaces;
  assert.deepEqual(spaces.items.properties.access.enum, ['rented', 'partner', 'public']);
  assert.match(EVENT_AGENT_PROMPT, /OUR VENUES, AND SPACES WE DO NOT CONTROL/);
  assert.match(EVENT_AGENT_PROMPT, /never as a venue/);
});

test('the P&L has its own pass, with the same shape as the brief\'s', () => {
  // Khai, 13 Oct 2026: "sometimes the P&L doesn't appear".
  const own = eventPnlTool().input_schema.properties.pnl;
  const inBrief = (eventDraftTool().input_schema.properties as any).pnl;
  assert.deepEqual(own, inBrief);
  assert.deepEqual(eventPnlTool().input_schema.required, ['pnl']);
});

test('running the night: staffing, photography and both menus are decisions, the rest are tasks', () => {
  // Khai, 13 Oct 2026, going through the board's Event Template.
  const running = PLAYBOOK.filter(r => r.stage === 'running').map(r => r.key);
  assert.deepEqual(running, ['staffing', 'photography', 'food_menu', 'drink_menu']);
  assert.match(PLAYBOOK.find(r => r.key === 'staffing')!.challenge, /SECURITY IS LABOUR/);
  assert.match(PLAYBOOK.find(r => r.key === 'staffing')!.challenge, /marked a proposal, never "the standard ratio"/);
  assert.equal(PLAYBOOK.find(r => r.key === 'food_menu')!.applies_when, 'the event sells food');
  assert.match(PLAYBOOK.find(r => r.key === 'photography')!.challenge, /"No" is a valid answer/);
  // Booking rules stay a task on the board's template, not a decision.
  assert.equal(PLAYBOOK.some(r => /booking_rules/.test(r.key)), false);
  assert.match(EVENT_AGENT_PROMPT, /RUNNING THE NIGHT/);
});
