import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseShift, coversVariance } from './covers.js';

describe('normaliseShift', () => {
  /**
   * BUILD_LOG 2.2. The code assumed every venue calls its services LUNCH and
   * DINNER. Fat Prince calls them DAY and LEGACY, which produced $20/head at
   * lunch and $212/head at dinner — numbers that looked like a business
   * problem rather than a mapping bug.
   */
  test('maps the standard names', () => {
    assert.equal(normaliseShift('BRUNCH', null), 'brunch');
    assert.equal(normaliseShift('LUNCH', null), 'lunch');
    assert.equal(normaliseShift('DINNER', null), 'dinner');
  });

  test('maps Fat Prince’s own vocabulary', () => {
    assert.equal(normaliseShift('DAY', null), 'lunch');
    assert.equal(normaliseShift('LEGACY', null), 'dinner');
  });

  test('is insensitive to case and surrounding whitespace', () => {
    assert.equal(normaliseShift('lunch', null), 'lunch');
    assert.equal(normaliseShift('  Legacy  ', null), 'dinner');
  });

  test('falls back to arrival hour for a name it has never seen', () => {
    // A new shift name in SevenRooms must degrade to a sensible bucket rather
    // than appear as a phantom meal period.
    assert.equal(normaliseShift('TWILIGHT', '12:30'), 'lunch');
    assert.equal(normaliseShift('TWILIGHT', '19:00'), 'dinner');
  });

  test('the lunch/dinner cutoff is 15:00', () => {
    assert.equal(normaliseShift(null, '14:59'), 'lunch');
    assert.equal(normaliseShift(null, '15:00'), 'dinner');
  });

  test('returns unknown when there is nothing to go on', () => {
    assert.equal(normaliseShift(null, null), 'unknown');
    assert.equal(normaliseShift(undefined, undefined), 'unknown');
    assert.equal(normaliseShift('TWILIGHT', 'not-a-time'), 'unknown');
  });

  test('a known name wins over the arrival hour', () => {
    // A late lunch booking is still lunch if the venue says so.
    assert.equal(normaliseShift('LUNCH', '20:00'), 'lunch');
  });
});

describe('coversVariance', () => {
  test('an exact match is ok', () => {
    const v = coversVariance(120, 120);
    assert.equal(v.variance, 0);
    assert.equal(v.status, 'ok');
  });

  test('a gap of up to two covers is minor', () => {
    assert.equal(coversVariance(120, 118).status, 'minor');
    assert.equal(coversVariance(118, 120).status, 'minor');
  });

  test('a gap of more than two covers needs review', () => {
    assert.equal(coversVariance(120, 117).status, 'review');
    assert.equal(coversVariance(117, 120).status, 'review');
  });

  test('the variance keeps its sign', () => {
    // Direction matters: SevenRooms above Revel is a different floor problem
    // from Revel above SevenRooms.
    assert.equal(coversVariance(120, 117).variance, 3);
    assert.equal(coversVariance(117, 120).variance, -3);
  });

  test('a missing side is missing, not zero', () => {
    // Reporting a gap as "0 covers" would read as a closed venue.
    assert.equal(coversVariance(null, 120).status, 'missing');
    assert.equal(coversVariance(120, null).status, 'missing');
    assert.equal(coversVariance(undefined, undefined).status, 'missing');
    assert.equal(coversVariance(null, 120).variance, null);
  });

  test('a genuine zero on both sides is ok, not missing', () => {
    // A closed day has real zeroes, and must not be reported as a data gap.
    const v = coversVariance(0, 0);
    assert.equal(v.status, 'ok');
    assert.equal(v.variance, 0);
  });
});
