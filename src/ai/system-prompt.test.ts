import { test } from 'node:test';
import assert from 'node:assert';
import { SYSTEM_PROMPT_BASE } from './system-prompt.js';

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
