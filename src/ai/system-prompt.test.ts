import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT_BASE } from './system-prompt.js';
import { FIGURE_DEFINITIONS } from '../lib/sales.js';

/**
 * Standing rules in the prompt, asserted rather than hoped for.
 *
 * A prompt is a hint and not a control, which is exactly why the ones that
 * matter should at least be prevented from silently disappearing in an edit.
 * The same reasoning as the test on chart_indexes over in recommendation.test.
 */

test('the prompt tells the reader which retention measure is being quoted', () => {
  /**
   * There are two retention numbers, they answer different questions, and they
   * move in OPPOSITE directions -- repeat share falls when a venue attracts
   * more new guests, cohort retention does not. Quoting either as "retention
   * was 12%" to somebody who runs a restaurant is a figure they cannot act on,
   * and quoting both without the distinction reads as a contradiction.
   */
  assert.match(SYSTEM_PROMPT_BASE, /REPEAT SHARE/);
  assert.match(SYSTEM_PROMPT_BASE, /COHORT RETENTION/);
  assert.match(SYSTEM_PROMPT_BASE, /in_plain_words/);

  // The counter-intuitive half, which is the part a reader must be told.
  assert.match(SYSTEM_PROMPT_BASE, /FALLS when you attract lots of new/);

  // And the instruction to say it, rather than merely to know it.
  assert.match(SYSTEM_PROMPT_BASE, /never "retention was 12%" alone/);
});

test('the prompt says who is reading, because that is what forces the visual', () => {
  assert.match(SYSTEM_PROMPT_BASE, /SHOW THE DATA, DO NOT NARRATE IT/);
  assert.match(SYSTEM_PROMPT_BASE, /they are not\s+analysts/);
});

test('both chart tools are offered, not just the time-series one', () => {
  // The briefing of 23 Sep 2026 carried no visual at all, partly because the
  // only chart tool named could not draw what the findings were about.
  assert.match(SYSTEM_PROMPT_BASE, /create_chart/);
  assert.match(SYSTEM_PROMPT_BASE, /create_composition_chart/);
});

test('the prompt carries exactly ONE definition of gross sales', () => {
  /**
   * It carried two, and they contradicted each other. An old "Key context" line
   * said gross sales was "product sales before discounts/tax" while the
   * sales-definitions block said food + beverage + the 10% service charge.
   *
   * The first turned out to be the RIGHT one and the second was wrong — gross
   * is food + beverage and the 10% is levied afterwards — but that is not the
   * point. Two definitions of one term in one prompt is an answer nobody can
   * predict or reproduce, whichever happens to be correct.
   */
  assert.ok(
    !/product sales before discounts/i.test(SYSTEM_PROMPT_BASE),
    'a second definition of gross sales is back in the prompt',
  );
  assert.match(
    SYSTEM_PROMPT_BASE,
    /GROSS SALES = food \+ beverage, service charge\s+EXCLUDED/,
    'the business definition of gross sales is missing',
  );
  assert.ok(
    !/GROSS SALES = food \+ beverage \+ the 10% service charge/.test(SYSTEM_PROMPT_BASE),
    'the service-charge-inclusive definition of gross is back — it overstates gross by 9%',
  );
  // And the consequence must be stated, or it reads as an error and gets fixed.
  assert.match(SYSTEM_PROMPT_BASE, /NET SALES IS LARGER THAN GROSS SALES/);

  // "gross - discounts + service fee + tax" described Net To Account For using
  // "gross" in the OTHER sense, which is how the contradiction read as coherent.
  assert.ok(
    !/gross - discounts \+ service fee/.test(SYSTEM_PROMPT_BASE),
    'Net To Account For is defined using "gross" in the food-and-beverage sense again',
  );
});

test('the prompt tells the model to DEFINE a figure for the reader, not just to know it', () => {
  /**
   * The definitions were all there and all correct, and every one of them was
   * addressed to the model. Nothing said to pass them on. An operator reading
   * "gross sales $3,980" assumes the textbook meaning — service charge OUTSIDE
   * — and is about 10% wrong with nothing in the answer to tell them.
   */
  assert.match(SYSTEM_PROMPT_BASE, /SAY WHAT EACH FIGURE MEANS, EVERY TIME YOU REPORT ONE/);

  // The form matters as much as the rule: a glossary at the end of every answer
  // would be ignored by the third one.
  assert.match(SYSTEM_PROMPT_BASE, /Define each figure ONCE per answer/);
  assert.match(SYSTEM_PROMPT_BASE, /It is a definition, not a lesson/);

  // And it must use the wording the tools return, or the same metric gets
  // described two different ways on two different days.
  assert.match(SYSTEM_PROMPT_BASE, /figure_definitions/);
});

test('every figure the prompt says to define has a definition to use', () => {
  /**
   * The prompt names the figures that must never appear bare. If one of them
   * has no entry in FIGURE_DEFINITIONS, the model is told to use wording that
   * does not exist and will invent it — which is the drift this is meant to
   * stop.
   */
  for (const field of [
    'gross_sales', 'net_sales', 'food_bev_sales',
    'avg_spend_per_head', 'avg_check', 'net_to_account_for',
  ] as const) {
    assert.ok(
      FIGURE_DEFINITIONS[field] && FIGURE_DEFINITIONS[field].length > 10,
      `${field} is named in the prompt but has no definition in FIGURE_DEFINITIONS`,
    );
  }
});

test('the definitions are returned beside the figures, not only in the prompt', () => {
  // A definition written far from the number can disagree with the number —
  // which is exactly what happened. Every sales response carries them.
  const src = readFileSync('src/ai/tool-handlers.ts', 'utf8');
  const occurrences = (src.match(/figure_definitions: FIGURE_DEFINITIONS/g) ?? []).length;
  assert.equal(
    occurrences, 3,
    `expected query_sales (both paths) and compare_venues to return the definitions, found ${occurrences}`,
  );
});

test('a trading summary must carry gross and the food/beverage split', () => {
  /**
   * Asked "how did Neon Pigeon do yesterday" on 4 Oct 2026, the answer gave net
   * sales, food & beverage sales, covers, transactions, average check, spend per
   * head and net to account for — and neither GROSS SALES nor the split between
   * food and drink. Both were available.
   *
   * The split is not a detail. Food and drink have different margins, different
   * prep and different staff behind them, so "beverage was 48%" changes what you
   * do about a quiet week where a bare sales total does not.
   */
  assert.match(SYSTEM_PROMPT_BASE, /WHAT A "HOW DID WE DO" ANSWER MUST CONTAIN/);
  assert.match(SYSTEM_PROMPT_BASE, /The food\/beverage split, in dollars AND per cent/);
  assert.match(SYSTEM_PROMPT_BASE, /Gross sales, and net sales/);
  // And it must come from the tool, because a percentage is a number too.
  assert.match(SYSTEM_PROMPT_BASE, /Never work a percentage out yourself/);
});

test('the prompt forbids two unlabelled spend-per-head figures in one answer', () => {
  /**
   * The same answer put $89.86 in its table (food & beverage ÷ covers, from
   * query_sales) and $98.32 in the paragraph beneath it (net sales ÷ covers,
   * from explain_revenue_change). Both correct, both unlabelled, one metric.
   * To a reader that is a contradiction, and nothing in the reply says it is not.
   */
  assert.match(SYSTEM_PROMPT_BASE, /NEVER PUT TWO SPEND-PER-HEAD FIGURES IN ONE ANSWER/);
  // The direction matters: the tool description had it backwards, claiming the
  // food & beverage basis read HIGHER. It is about 9% lower.
  assert.match(SYSTEM_PROMPT_BASE, /about 9% ABOVE the food &\s+beverage basis/);
});

test('the explain_revenue_change description has the direction right', () => {
  const tools = readFileSync('src/ai/tools.ts', 'utf8');
  assert.ok(
    !/food \+ beverage ÷ covers, which is what query_sales reports and reads a few percent higher/.test(tools),
    'the backwards claim is back: net ÷ covers is the LARGER of the two, by about 9%',
  );
  assert.match(tools, /THE DRIVER ONE IS THE LARGER/);
});

test('a trading summary must show discounts and the service charge too', () => {
  /**
   * Khai, 4 Oct 2026: "you should plant also the discount on display in the
   * table as well as the service charge."
   *
   * Both were already returned and neither was being shown. Discounting is the
   * one cost the floor controls hour by hour, and the service charge is the
   * bridge between gross and net — without it on the page, a reader who has
   * just been told net exceeds gross has no way to see why.
   */
  assert.match(SYSTEM_PROMPT_BASE, /Discounts, in dollars AND as a per cent of gross/);
  assert.match(SYSTEM_PROMPT_BASE, /- Service charge/);
  assert.match(SYSTEM_PROMPT_BASE, /discount_rate_pct/);
  assert.match(SYSTEM_PROMPT_BASE, /Never work a percentage out yourself/);
});

test('every figure the summary demands is one the tools actually return', () => {
  // A prompt that names a field the response does not carry invites the model
  // to work it out, which is the one thing it must not do with a number.
  for (const field of [
    'gross_sales', 'net_sales', 'food_sales', 'beverage_sales', 'food_pct',
    'total_discounts', 'discount_rate_pct', 'service_charge',
  ] as const) {
    assert.ok(
      FIGURE_DEFINITIONS[field as keyof typeof FIGURE_DEFINITIONS],
      `the prompt asks for ${field} but there is no definition for it`,
    );
  }
});
