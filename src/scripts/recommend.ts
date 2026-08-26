import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { requireSchema } from '../lib/schema-check.js';
import { askSauron } from '../ai/engine.js';
import { modelFor } from '../ai/model-policy.js';
import { fatalApiReason, fatalRunSummary } from '../lib/api-fatal.js';
import { latestClosedMonth } from '../lib/accounting-period.js';
import {
  analysisBrief,
  recommendationTool,
  parseRecommendations,
  suppressRepeats,
  namesOtherVenues,
  fingerprint,
  lastCompleteWeek,
  unsettledWeekNote,
  SUPPRESSION_DAYS,
} from '../ai/recommendation.js';

/**
 * The weekly briefing: what each venue most needs to know, unasked.
 *
 * TWO PASSES, ON PURPOSE. The first is the analysis -- Opus, the full tool set,
 * charts, thinking -- writing naturally, which is where the quality is. The
 * second is a cheap forced tool call that splits that prose into rows. Asking
 * the analyst to "end with JSON" was the alternative and it is the pattern the
 * post classifier deliberately rejected: a forced tool means the API enforces
 * the schema instead of us hoping, and there is no prose to strip.
 *
 * WHY IT RUNS WITH FULL VENUE ACCESS. Benchmarking is the product's edge and it
 * cannot happen inside a single-venue scope -- the tool layer would refuse
 * every comparison. So the analysis sees everything and namesOtherVenues() is
 * the control on what comes back out: comparative figures yes, another venue's
 * identity no. That is a narrower guarantee than RLS and it is stated as such
 * in the flag it raises.
 */

const client = new Anthropic();

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const onlySlug = arg('venue');
const dryRun = process.argv.includes('--dry-run');

/** Overridable so a bad week can be re-examined without waiting for Monday. */
const weekOf = arg('week-of') ?? new Date().toISOString().split('T')[0];

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('ANTHROPIC_API_KEY is not set on this service.');
  console.error('');
  console.error('The recommendation engine is entirely model work — without a key there is');
  console.error('nothing for it to do. Add ANTHROPIC_API_KEY to this service\'s variables and');
  console.error('run it again.');
  process.exit(1);
}

const { start: periodStart, end: periodEnd } = lastCompleteWeek(weekOf);

/**
 * Which P&L months the engine may treat as fact. Finance closes a month on the
 * 15th of the following one; the first real run quoted July's operating profit
 * as settled and was right only because it happened to fall after 15 August.
 */
const closedMonth = latestClosedMonth();
const runId = randomUUID();

/**
 * Sonnet for the structuring pass. It is restating an analysis that has already
 * been done -- the same job as `recovery` in the model policy, and the same
 * reasoning: latency and cost beat depth when the thinking is already finished.
 */
const STRUCTURING_MODEL = modelFor('recovery').model;
const ANALYSIS_MODEL = modelFor('recommendation').model;

console.log(`Weekly recommendations — ${periodStart} to ${periodEnd}`);
console.log(`Analysis: ${ANALYSIS_MODEL}. Structuring: ${STRUCTURING_MODEL}. Run ${runId}`);
console.log(`Latest settled P&L month: ${closedMonth}. Anything later is provisional.\n`);

await requireSchema();

const { data: allVenues, error: venueError } = await supabase
  .from('venues')
  .select('id, name, slug')
  .order('name');

if (venueError) {
  console.error(`Could not read venues: ${venueError.message}`);
  process.exit(1);
}
if (!allVenues || allVenues.length === 0) {
  console.error('No venues in the warehouse.');
  process.exit(1);
}

const venues = onlySlug
  ? (allVenues as any[]).filter(v => v.slug === onlySlug)
  : (allVenues as any[]);

/**
 * Say what the valid answers ARE, not just that this one was wrong.
 *
 * A slug is an internal identifier nobody memorises, and "no venue with slug
 * X" leaves someone opening the admin console or guessing -- which is what
 * happened: `neonpigeon` was guessed when the real form is hyphenated. The
 * list is one query we have already made.
 */
if (venues.length === 0) {
  console.error(`No venue with slug "${onlySlug}". The venues in this warehouse are:`);
  for (const v of allVenues as any[]) console.error(`  --venue=${v.slug}    (${v.name})`);
  process.exit(1);
}

/**
 * Every name that must not appear in another venue's briefing.
 *
 * Legal entity names are included because two of the three -- "Potus" and
 * "20 Craig Road" -- tell a reader nothing about the venue, so a leak through
 * one of them would not be caught by eye.
 */
const { data: entities } = await supabase.from('xero_connections').select('venue_id, tenant_name');
const forbiddenFor = (venueId: string) => [
  ...(venues as any[]).filter(v => v.id !== venueId).map(v => v.name),
  ...((entities ?? []) as any[]).filter(e => e.venue_id !== venueId && e.tenant_name).map(e => e.tenant_name),
];

let written = 0;
let suppressedTotal = 0;
let withheldTotal = 0;
let quietVenues = 0;
/** Venues whose week had unresolved reconciliation alerts in it. */
let unsettledVenues = 0;
/** Venues fully dealt with, so an abort can say how many were never looked at. */
let processed = 0;
const problems: string[] = [];
let fatal: string | null = null;

for (const venue of venues as any[]) {
  console.log(`--- ${venue.name}`);

  // What we have already told them. The brief asks the model not to repeat
  // these; suppressRepeats() is what actually enforces it.
  const since = new Date(Date.now() - SUPPRESSION_DAYS * 86400000).toISOString();
  const { data: recent } = await supabase
    .from('recommendations')
    .select('headline, fingerprint')
    .eq('venue_id', venue.id)
    .gte('generated_at', since)
    .order('generated_at', { ascending: false });

  const recentRows = (recent ?? []) as any[];

  /**
   * Did Finance actually close this week?
   *
   * The Tuesday schedule assumes they did on Monday. The detection for a week
   * still moving has existed since the Monday reconciliation was built and
   * nothing consumed it -- so a briefing could be written on figures that
   * changed the next day, frozen, and never revisited.
   */
  const { data: openAlerts } = await supabase
    .from('reconciliation_alerts')
    .select('alert_type, business_date')
    .eq('venue_id', venue.id)
    .eq('resolved', false)
    .gte('business_date', periodStart)
    .lte('business_date', periodEnd);

  const unsettled = unsettledWeekNote((openAlerts ?? []) as any[]);
  if (unsettled) {
    unsettledVenues++;
    console.log(`  week NOT settled — ${(openAlerts ?? []).length} unresolved alert(s); briefing will say so`);
  }

  try {
    const brief = analysisBrief(
      venue.name,
      periodStart,
      periodEnd,
      recentRows.map(r => r.headline),
      { latestClosedMonth: closedMonth, warnings: unsettled ? [unsettled] : [] },
    );

    // Pass one: the real work. Unscoped so it can benchmark.
    const analysis = await askSauron(brief, [], undefined, 'recommendation');

    /**
     * Say the analysis finished, the moment it finishes.
     *
     * The first real run printed nothing at all between one venue's header and
     * the next: five minutes of Opus, eleven tool rounds, and no evidence in
     * the log that any of it produced anything. A long job that goes quiet is
     * indistinguishable from a hung one, and if the process dies later the
     * completed work leaves no trace.
     */
    console.log(`  analysed: ${analysis.toolCalls.length} quer${analysis.toolCalls.length === 1 ? 'y' : 'ies'}, ${analysis.charts.length} chart(s), ${analysis.answer.length} chars`);

    /**
     * In a dry run the PROSE is the deliverable.
     *
     * The structured headlines are what gets stored, but they are a summary of
     * this -- and the question a dry run exists to answer is whether the advice
     * is any good, which cannot be judged from a headline. Printed before the
     * structuring call so it survives a failure in it.
     */
    if (dryRun) {
      console.log(`\n${analysis.answer}\n`);
    }

    // Pass two: rows, not prose.
    const structured = await client.messages.create({
      model: STRUCTURING_MODEL,
      max_tokens: 4096,
      system: [{
        type: 'text',
        text: `You are splitting a finished analysis into records. Do not add findings, do not soften them, and do not invent figures — everything must already be in the text you are given. If the analysis concluded there was nothing worth raising, return an empty list.`,
        cache_control: { type: 'ephemeral' },
      }],
      tools: [recommendationTool() as any],
      tool_choice: { type: 'tool', name: 'record_recommendations' },
      messages: [{ role: 'user', content: `The briefing for ${venue.name}, ${periodStart} to ${periodEnd}:\n\n${analysis.answer}` }],
    });

    const call = structured.content.find(b => b.type === 'tool_use') as any;
    const parsed = parseRecommendations(call?.input);

    if (!parsed.ok) {
      problems.push(`${venue.name}: could not structure the analysis — ${parsed.reason}`);
      continue;
    }

    if (parsed.value.length === 0) {
      // Not a failure. An engine that always has something to say is one
      // nobody believes.
      quietVenues++;
      console.log('  nothing worth raising this week.');
      continue;
    }

    // The control, applied before anything is stored.
    const forbidden = forbiddenFor(venue.id);
    const clean = [];
    for (const candidate of parsed.value) {
      const leaked = namesOtherVenues(`${candidate.headline}\n${candidate.body}`, forbidden);
      if (leaked.length > 0) {
        withheldTotal++;
        problems.push(`${venue.name}: WITHHELD "${candidate.headline}" — names ${leaked.join(', ')}, which this venue is not cleared to see`);
        continue;
      }
      clean.push(candidate);
    }

    const { kept, suppressed } = suppressRepeats(clean, recentRows.map(r => r.fingerprint));
    suppressedTotal += suppressed.length;

    for (const s of suppressed) {
      console.log(`  repeat, not sent: ${s.headline}`);
    }

    if (kept.length === 0) {
      console.log('  nothing new after suppression.');
      continue;
    }

    if (dryRun) {
      for (const k of kept) console.log(`  [dry run] ${k.domain} (${k.confidence}) — ${k.headline}`);
      continue;
    }

    const { error: writeError } = await supabase.from('recommendations').insert(
      kept.map(k => ({
        venue_id: venue.id,
        run_id: runId,
        period_start: periodStart,
        period_end: periodEnd,
        headline: k.headline,
        body: k.body,
        domain: k.domain,
        confidence: k.confidence,
        /**
         * The QUERIES, not the rows they returned.
         *
         * askSauron reports which tools it called with which arguments, and
         * that is re-runnable: anyone doubting a figure can execute the same
         * query and see. Storing the returned rows as well would be stronger
         * provenance and would put a product mix of several hundred rows in
         * this column for every recommendation. Re-runnable is the honest
         * middle, and it is worth knowing which of the two this is.
         */
        evidence: analysis.toolCalls,
        charts: analysis.charts,
        model: ANALYSIS_MODEL,
        fingerprint: fingerprint(k.headline),
      })),
    );

    if (writeError) {
      problems.push(`${venue.name}: write failed — ${writeError.message}`);
      continue;
    }

    written += kept.length;
    for (const k of kept) console.log(`  ${k.domain} (${k.confidence}) — ${k.headline}`);
  } catch (e: any) {
    fatal = fatalApiReason(e);
    if (fatal) break;
    problems.push(`${venue.name}: ${String(e?.message ?? e).slice(0, 200)}`);
  } finally {
    // In `finally` because the body leaves by `continue` in four places — a
    // quiet venue, a suppressed set, a dry run, a structuring failure — and
    // each of those is a venue fully dealt with. Not counted when aborting:
    // the venue that hit the failure was attempted, not completed.
    if (!fatal) processed++;
  }
}

console.log(`\n${written} recommendation(s) written across ${venues.length} venue(s).`);

if (quietVenues > 0) {
  console.log(`${quietVenues} venue(s) had nothing worth raising. That is a valid outcome, not a failure.`);
}

/**
 * Both counts are reported every run, because each measures something the
 * other cannot. Suppression climbing means the engine keeps rediscovering the
 * same thing and the advice has gone stale. Withholding above zero means the
 * brief's comparative-only rule is being ignored and only the code caught it.
 */
if (unsettledVenues > 0) {
  console.log(`${unsettledVenues} venue(s) had an unsettled week — their briefings say so on the face of them.`);
}
if (suppressedTotal > 0) {
  console.log(`${suppressedTotal} suppressed as a repeat of something said in the last ${SUPPRESSION_DAYS} days.`);
}
if (withheldTotal > 0) {
  console.log(`${withheldTotal} WITHHELD for naming another venue. The prompt asked for anonymous comparison and did not get it — worth reading the brief again if this keeps happening.`);
}

if (problems.length > 0) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`  - ${p}`);
}

if (fatal) {
  console.log(fatalRunSummary(
    fatal,
    processed,
    venues.length - processed,
    `npm run recommend --${onlySlug ? ` --venue=${onlySlug}` : ''}`,
  ));
  process.exit(1);
}

// Every venue failing is a failure however politely it was reported. A quiet
// week is not: nothing written because nothing was worth writing is success.
process.exit(problems.length === venues.length ? 1 : 0);
