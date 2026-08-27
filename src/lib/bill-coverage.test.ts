import { test } from 'node:test';
import assert from 'node:assert';
import { coverageByAccount, caveatFor, COVERAGE_TRUSTWORTHY_PCT } from './bill-coverage.js';

/**
 * These pin the one thing that decides whether a supplier breakdown is honest.
 * A list of four marketing suppliers is true; presented as the breakdown of an
 * account it covers a quarter of, it is a wrong answer, and nothing else in the
 * response tells the reader which they are looking at.
 */

const MARKETING = 'acct-marketing';
const RENT = 'acct-rent';

const line = (accountId: string | null, account: string | null, amount: number) =>
  ({ account_id: accountId, account, amount });

test('the measured marketing case: 26% of the account, flagged', () => {
  // Neon Pigeon, June 2026. $26,034 in the ledger, bills explaining a quarter.
  const [cov] = coverageByAccount(
    [line(MARKETING, 'Public Relations / Marketing', 6768.96)],
    new Map([[MARKETING, 26034.46]]),
  );

  assert.equal(cov.coverage_pct, 26);
  assert.equal(cov.ledger_total, 26034.46);
  assert.match(cov.caveat!, /only 26% of the ledger account/);
  assert.match(cov.caveat!, /Never present this as the full breakdown/);
});

test('an account bills explain in full carries no caveat', () => {
  // Rent measured at ~100%. A warning here would be noise, and noise is how a
  // caveat stops being read on the account that needs it.
  const [cov] = coverageByAccount([line(RENT, 'Rent', 12000)], new Map([[RENT, 12000]]));
  assert.equal(cov.coverage_pct, 100);
  assert.equal(cov.caveat, null);
});

test('above 100% is reported as a failure to reconcile, not as thoroughness', () => {
  // COGS Food measured 109%. Whatever the cause, the bill side claims more was
  // spent than the ledger recorded, which is impossible — and left unflagged it
  // reads as excellent coverage, the opposite of the marketing problem.
  const [cov] = coverageByAccount([line('acct-food', 'COGS Food', 10900)], new Map([['acct-food', 10000]]));
  assert.equal(cov.coverage_pct, 109);
  assert.match(cov.caveat!, /ABOVE 100%/);
  assert.match(cov.caveat!, /does not reconcile/);
});

test('above 100% no longer blames credit notes, because they are ingested', () => {
  // The caveat named ACCPAYCREDIT as the cause from the day coverage was built,
  // which was true then and is a wild goose chase now: migration 031 ingests
  // credit notes negative, so they are already netted off. A caveat that sends
  // somebody to fix what is fixed is worse than no caveat.
  const caveat = caveatFor(109)!;
  assert.doesNotMatch(caveat, /ACCPAYCREDIT/);
  assert.match(caveat, /Credit notes ARE included/);
  // And it still points at the P&L as the authority rather than the bills.
  assert.match(caveat, /P&L account total as the authority/);
});

test('no P&L line means unmeasurable, never 100%', () => {
  // The dangerous default. Treating a missing denominator as full coverage
  // would mark exactly the accounts we know least about as the most reliable.
  const [cov] = coverageByAccount([line('acct-x', 'Something', 500)], new Map());
  assert.equal(cov.coverage_pct, null);
  assert.equal(cov.ledger_total, null);
  assert.match(cov.caveat!, /cannot be measured/);
});

test('a zero ledger total is unmeasurable, not a division by zero', () => {
  const [cov] = coverageByAccount([line('acct-x', 'Something', 500)], new Map([['acct-x', 0]]));
  assert.equal(cov.coverage_pct, null);
  assert.match(cov.caveat!, /cannot be measured/);
});

test('lines with no account still count toward the total', () => {
  // Dropping them would shrink the numerator and flatter every percentage.
  const cov = coverageByAccount([line(null, null, 300)], new Map());
  assert.equal(cov.length, 1);
  assert.equal(cov[0].account, 'Unmapped account');
  assert.equal(cov[0].bills_total, 300);
});

test('lines are grouped by account and summed', () => {
  const [cov] = coverageByAccount(
    [line(MARKETING, 'Marketing', 100), line(MARKETING, 'Marketing', 250.5)],
    new Map([[MARKETING, 1000]]),
  );
  assert.equal(cov.bills_total, 350.5);
  assert.equal(cov.bill_lines, 2);
  assert.equal(cov.coverage_pct, 35.1);
});

test('accounts come back largest first', () => {
  // The account with the most money in it is the one somebody is asking about.
  const cov = coverageByAccount(
    [line(RENT, 'Rent', 12000), line(MARKETING, 'Marketing', 500)],
    new Map([[RENT, 12000], [MARKETING, 26034]]),
  );
  assert.deepEqual(cov.map(c => c.account), ['Rent', 'Marketing']);
});

test('the trust threshold is where the caveat turns on', () => {
  assert.equal(caveatFor(COVERAGE_TRUSTWORTHY_PCT), null);
  assert.notEqual(caveatFor(COVERAGE_TRUSTWORTHY_PCT - 0.1), null);
  assert.equal(caveatFor(100), null);
  assert.notEqual(caveatFor(100.1), null);
});
