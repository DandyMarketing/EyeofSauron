import 'dotenv/config';
import { askSauron } from '../ai/engine.js';
import { EVENT_AGENT_PROMPT } from '../ai/event-agent.js';
import type { ChatMessage } from '../ai/engine.js';

/**
 * A scripted planning conversation, printed, so the CHALLENGES can be judged
 * before there is a screen around them.
 *
 * WHAT IT TESTS AND WHAT IT DOES NOT. It tests whether the agent pushes back on
 * a weak answer, whether it pulls figures rather than inventing them, whether
 * it asks about the right things in a sensible order, and whether it refuses to
 * finish while something blocking is open. It does NOT test the back-and-forth,
 * because both sides of this are written down -- the planner's replies below
 * are deliberately WEAK, which is the only way to see whether the challenge
 * fires at all. A real planner gives better answers and gets a shorter
 * conversation.
 *
 * Run it with a scenario:
 *   npm run plan:dry -- --scenario=collab
 *   npm run plan:dry -- --scenario=deepavali
 *   npm run plan:dry -- --scenario=tasting
 *
 * The transcript goes to stdout, which on Railway means the deploy log. That is
 * an unpleasant place to read a conversation and it is still far cheaper than
 * finding out the questions are wrong after building the tab.
 */

const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1];

/**
 * The planner's side, written badly ON PURPOSE.
 *
 * Every reply here is one of the weak answers the playbook names -- "awareness",
 * "three weeks", "Instagram", "the team will handle it". An agent that sails
 * through these has failed, and one that argues with all of them is doing its
 * job. Writing them well would produce a pleasant transcript that proves
 * nothing.
 */
const SCENARIOS: Record<string, { opening: string; replies: string[] }> = {
  collab: {
    opening:
      'We want to do a two-night guest chef collab at Firangi Superstar in the first week of November. ' +
      'The chef is coming from Mumbai. Help me plan it.',
    replies: [
      'Mainly awareness. And revenue obviously.',
      'A full room both nights. It should do well, the chef has a big following.',
      "Those are the nights he's free. It's a Thursday and Friday.",
      'Set menu, six courses, with a pairing. About $180.',
      'We priced it on what he charges elsewhere. Feels right for his name.',
      'Three weeks of campaign. Instagram mainly, and the mailing list.',
      "We'll post a few times. Probably a graphic announcing it, then a reminder.",
      "The team will handle the outreach.",
      'We have not thought about ad spend. Maybe a few hundred dollars.',
    ],
  },
  deepavali: {
    opening:
      'Firangi Superstar for Deepavali this year. I want to do something bigger than last time.',
    replies: [
      'More covers than last year, and more press.',
      'Last year was fine but nothing special. I do not have the numbers to hand.',
      'The week of Deepavali itself. It falls on a Sunday this year I think.',
      'A la carte with a special menu section. Walk-ins welcome.',
      'The Indian community mainly. And our regulars.',
      'Instagram, and we will tell the regulars.',
      'Two weeks of posts. Maybe four or five posts.',
    ],
  },
  tasting: {
    opening:
      'A small wine tasting at Fat Prince on a Tuesday. Maybe 20 people. Nothing fancy.',
    replies: [
      'Fill a dead night really. Tuesdays are quiet.',
      'Twenty covers would be good.',
      'No partner, we would just use our own list.',
      '$65 a head including four wines and some snacks.',
      'One Instagram post and a message to the wine list people.',
    ],
  },
};

const name = arg('scenario') ?? 'collab';
const scenario = SCENARIOS[name];

if (!scenario) {
  console.error(`No scenario "${name}". Available:`);
  for (const k of Object.keys(SCENARIOS)) console.error(`  --scenario=${k}`);
  process.exit(1);
}

console.log('='.repeat(78));
console.log(`EVENT PLANNER DRY RUN — scenario "${name}"`);
console.log('The planner\'s replies below are deliberately WEAK. Judge whether the');
console.log('agent argues with them, pulls real figures, and refuses to finish early.');
console.log('='.repeat(78));

const history: ChatMessage[] = [];
let turn = 0;
let totalQueries = 0;

const say = (who: string, text: string) => {
  console.log(`\n${'-'.repeat(78)}\n${who}\n${'-'.repeat(78)}\n${text}\n`);
};

for (const message of [scenario.opening, ...scenario.replies]) {
  turn += 1;
  say(`PLANNER (turn ${turn})`, message);

  const result = await askSauron(
    message, [...history], undefined, 'chat',
    // Owner-level: a dry run should see everything, so a thin answer is the
    // agent's doing rather than a permission it did not have.
    'owner', undefined, undefined, EVENT_AGENT_PROMPT,
  );

  totalQueries += result.toolCalls.length;

  say(
    `AGENT (turn ${turn}) — ${result.toolCalls.length} quer${result.toolCalls.length === 1 ? 'y' : 'ies'}` +
    (result.toolCalls.length ? `: ${result.toolCalls.map(t => t.name).join(', ')}` : ''),
    result.answer,
  );

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: result.answer });
}

console.log('='.repeat(78));
console.log(`${turn} turns, ${totalQueries} warehouse quer${totalQueries === 1 ? 'y' : 'ies'}.`);
console.log('');
console.log('WHAT TO LOOK FOR, in rough order of how much it matters:');
console.log('  1. Did it CHALLENGE the weak answers, or accept them? "Awareness",');
console.log('     "three weeks" and "the team will handle it" should each have been');
console.log('     argued with. Sailing through any of them is the failure.');
console.log('  2. Did it PULL figures rather than estimate? Every number in the');
console.log('     transcript should trace to one of the queries listed per turn.');
console.log('     A plausible spend per head with no query behind it is the worst');
console.log('     thing this surface can do.');
console.log('  3. Did it ask ONE thing at a time, or fire a form?');
console.log('  4. Did it refuse to finish while a blocking decision was open?');
console.log('  5. Did the tasting scenario get a SHORTER interrogation than the');
console.log('     collab? If a Tuesday tasting is asked about partner terms, the');
console.log('     applies_when gating is not working.');
console.log('='.repeat(78));
