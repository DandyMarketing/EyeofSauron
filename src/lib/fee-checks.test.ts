import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RATE_DRIFT_TOLERANCE, feeAnomalies, feeWarning, unexplained } from './fee-checks.js';

/**
 * Neon Pigeon's real 2026 fees. Two fees, identical to the cent every month,
 * each about 2.5% of income — except June, which came in at 1.99% and which
 * nothing reported.
 */
const NEON_PIGEON_2026 = [
  { period_start: '2026-01-01', amount: 3075.04, income: 119651 },
  { period_start: '2026-02-01', amount: 3607.09, income: 141454 },
  { period_start: '2026-03-01', amount: 4513.59, income: 175626 },
  { period_start: '2026-04-01', amount: 4378.13, income: 169039 },
  { period_start: '2026-05-01', amount: 4801.30, income: 197584 },
  { period_start: '2026-06-01', amount: 3474.59, income: 174603 },   // the odd one
  { period_start: '2026-07-01', amount: 3491.27, income: 140776 },
].flatMap(m => [
  { ...m, account_name: 'Management fee' },
  { ...m, account_name: 'Licensing Fees' },
]);

test('June 2026 is caught — the month nothing reported', () => {
  const found = feeAnomalies(NEON_PIGEON_2026);
  const june = found.filter(a => a.period_start === '2026-06-01');

  assert.ok(june.length > 0, 'June should be flagged');
  assert.equal(june[0].kind, 'rate_outlier');
  assert.match(june[0].detail, /1\.99% of income/);
});

test('the normal months are NOT flagged', () => {
  // May at 2.43% against a 2.55% median is ordinary variation. A monitor that
  // fires on that is one nobody reads by March.
  const found = feeAnomalies(NEON_PIGEON_2026);
  const periods = new Set(found.map(a => a.period_start));

  for (const normal of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-07-01']) {
    assert.ok(!periods.has(normal), `${normal} should not be flagged`);
  }
});

test('a paired mismatch is caught, and ranked above a rate drift', () => {
  // The strong check: two fees charged at the same rate on the same base
  // cannot legitimately differ, so this has no explanation but an error.
  const rows = NEON_PIGEON_2026.map(r =>
    r.period_start === '2026-03-01' && r.account_name === 'Licensing Fees'
      ? { ...r, amount: 4000.00 }
      : r,
  );

  const found = feeAnomalies(rows);
  const march = found.filter(a => a.period_start === '2026-03-01');

  assert.equal(march[0].kind, 'pair_mismatch');
  assert.match(march[0].detail, /coding error/);
});

test('a cent of rounding between paired fees is not an error', () => {
  const rows = NEON_PIGEON_2026.map(r =>
    r.period_start === '2026-01-01' && r.account_name === 'Licensing Fees'
      ? { ...r, amount: 3075.044 }
      : r,
  );

  assert.equal(
    feeAnomalies(rows).filter(a => a.kind === 'pair_mismatch').length,
    0,
  );
});

test('a venue with ONE fee is checked on drift and never on pairing', () => {
  // Fat Prince and Firangi pay a single management fee. There is nothing to
  // pair it against and that is not a finding.
  const fatPrince = [
    { period_start: '2026-01-01', account_name: 'Management Fees', amount: 6852.27, income: 152612 },
    { period_start: '2026-02-01', account_name: 'Management Fees', amount: 6325.81, income: 142153 },
    { period_start: '2026-03-01', account_name: 'Management Fees', amount: 7602.92, income: 174780 },
    { period_start: '2026-04-01', account_name: 'Management Fees', amount: 6841.72, income: 155141 },
    { period_start: '2026-05-01', account_name: 'Management Fees', amount: 8117.24, income: 184064 },
  ];

  assert.deepEqual(feeAnomalies(fatPrince), []);
});

test('rates are judged against the venue\'s OWN history, never another venue\'s', () => {
  // Neon Pigeon runs ~2.5% per fee and Fat Prince ~4.4%. Comparing them would
  // flag the commercial arrangement rather than an error.
  const fatPrinceRate = [
    { period_start: '2026-01-01', account_name: 'Management Fees', amount: 6852.27, income: 152612 },
    { period_start: '2026-02-01', account_name: 'Management Fees', amount: 6325.81, income: 142153 },
    { period_start: '2026-03-01', account_name: 'Management Fees', amount: 7602.92, income: 174780 },
    { period_start: '2026-04-01', account_name: 'Management Fees', amount: 6841.72, income: 155141 },
  ];

  assert.deepEqual(feeAnomalies(fatPrinceRate), []);
});

test('too little history means no rate verdict', () => {
  // Three months cannot establish what normal is, and guessing would fire on
  // a venue that has just opened.
  const thin = [
    { period_start: '2026-05-01', account_name: 'Management fee', amount: 100, income: 10000 },
    { period_start: '2026-06-01', account_name: 'Management fee', amount: 100, income: 10000 },
    { period_start: '2026-07-01', account_name: 'Management fee', amount: 500, income: 10000 },
  ];

  assert.deepEqual(feeAnomalies(thin).filter(a => a.kind === 'rate_outlier'), []);
});

test('a missing income figure is skipped, not treated as zero', () => {
  const noIncome = NEON_PIGEON_2026.map(r => ({ ...r, income: null }));
  assert.deepEqual(feeAnomalies(noIncome).filter(a => a.kind === 'rate_outlier'), []);
});

test('no fees at all is empty, not an error', () => {
  assert.deepEqual(feeAnomalies([]), []);
});

// --- the briefing line -----------------------------------------------------

test('a clean history produces no warning', () => {
  assert.equal(feeWarning([]), null);
});

test('the warning leads with the newest and says who controls it', () => {
  const warning = feeWarning(feeAnomalies(NEON_PIGEON_2026))!;

  assert.match(warning, /DOES NOT LOOK RIGHT/);
  assert.match(warning, /2026-06-01/);
  // The point a briefing must not get wrong: this is not the venue's decision.
  assert.match(warning, /nobody on the floor controls them/);
});

test('the tolerance is wide enough for honest variation', () => {
  // Normal months sit within ~5% of their median; June was 22% below.
  assert.ok(RATE_DRIFT_TOLERANCE > 0.05 && RATE_DRIFT_TOLERANCE < 0.22);
});

describe('acknowledged months', () => {
  const JUNE = { period_start: '2026-06-01', account_name: null, reason: 'Rate set lower by the founder for this month.' };

  test('an acknowledged month stops being a finding', () => {
    // Neon Pigeon's June 2026 fee is real and explained: a founder's decision,
    // not a coding error. Left unacknowledged it flags every Monday for the
    // rest of the year, and a monitor that cries wolf weekly has failed.
    const found = feeAnomalies(NEON_PIGEON_2026, [JUNE]);
    const june = found.filter(a => a.period_start === '2026-06-01');

    assert.ok(june.length > 0, 'the anomaly is still detected');
    assert.equal(june[0].acknowledged, JUNE.reason);
    assert.equal(unexplained(found).length, 0);
  });

  test('the anomaly is KEPT, not removed', () => {
    // Deleting it would make a check that went silent indistinguishable from
    // one that stopped working — the failure this codebase keeps finding.
    const withAck = feeAnomalies(NEON_PIGEON_2026, [JUNE]);
    const without = feeAnomalies(NEON_PIGEON_2026);
    assert.equal(withAck.length, without.length);
  });

  test('the briefing says it is known rather than going quiet', () => {
    const warning = feeWarning(feeAnomalies(NEON_PIGEON_2026, [JUNE]))!;

    assert.match(warning, /known and accounted for/);
    assert.match(warning, /founder/);
    assert.doesNotMatch(warning, /DOES NOT LOOK RIGHT/);
  });

  test('acknowledging one month does not silence the same month next year', () => {
    // Per-month, never per-venue. Acknowledging the venue would be the same
    // mistake with a longer fuse, and invisible when it bites.
    const nextYear = NEON_PIGEON_2026.map(r => ({
      ...r,
      period_start: r.period_start.replace('2026', '2027'),
    }));

    const found = feeAnomalies(nextYear, [JUNE]);
    // Two, because Neon Pigeon pays two fees and each drifts. The number is
    // not the point — the point is that none of them is explained.
    assert.equal(unexplained(found).filter(a => a.period_start === '2027-06-01').length, 2);
  });

  test('acknowledging one fee leaves the other half of a pair reporting', () => {
    const oneOnly = [{ period_start: '2026-06-01', account_name: 'Management fee', reason: 'agreed' }];
    const found = feeAnomalies(NEON_PIGEON_2026, oneOnly);
    const june = found.filter(a => a.period_start === '2026-06-01');

    assert.ok(june.some(a => a.acknowledged), 'the named fee is explained');
    assert.ok(june.some(a => !a.acknowledged), 'the other one still reports');
  });

  test('a pair mismatch needs a WHOLE-month acknowledgement', () => {
    // Naming one account cannot explain two accounts disagreeing.
    const rows = NEON_PIGEON_2026.map(r =>
      r.period_start === '2026-03-01' && r.account_name === 'Licensing Fees'
        ? { ...r, amount: 4000.00 }
        : r,
    );
    const named = [{ period_start: '2026-03-01', account_name: 'Licensing Fees', reason: 'x' }];
    const mismatch = feeAnomalies(rows, named).find(a => a.kind === 'pair_mismatch')!;

    assert.equal(mismatch.acknowledged, undefined);
  });

  test('no anomalies at all is still silence, not a reassurance', () => {
    // Only a month that WAS flagged and then explained earns a line.
    const clean = [
      { period_start: '2026-01-01', account_name: 'Management Fees', amount: 6852.27, income: 152612 },
      { period_start: '2026-02-01', account_name: 'Management Fees', amount: 6325.81, income: 142153 },
      { period_start: '2026-03-01', account_name: 'Management Fees', amount: 7602.92, income: 174780 },
      { period_start: '2026-04-01', account_name: 'Management Fees', amount: 6841.72, income: 155141 },
    ];
    assert.equal(feeWarning(feeAnomalies(clean, [JUNE])), null);
  });
});
