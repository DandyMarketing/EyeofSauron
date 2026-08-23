import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveAccount,
  unmappedAccounts,
  rollUpByCanonical,
  DEFAULT_BUSINESS_LINE,
  type VenueAccountMap,
} from './account-map.js';

/**
 * The three ledgers name the same cost differently — Fat Prince is the outlier
 * on all nine variants — so a comparison built on raw account_name splits one
 * cost across two buckets that never add up, in an answer that looks complete.
 * These pin the behaviour that decides whether two venues are comparable.
 */

const mapOf = (rows: Array<[string, string, string?]>): VenueAccountMap =>
  new Map(rows.map(([account_name, canonical_account, business_line]) => [
    account_name,
    { account_name, canonical_account, business_line: business_line ?? DEFAULT_BUSINESS_LINE },
  ]));

const FAT_PRINCE = mapOf([
  ['Public Relations / Marketing costs', 'Public Relations / Marketing fees'],
  ['COGS - Alcohol', 'COGS - Beverages'],
  ['COGS - Beverages', 'COGS - Beverages'],
  ['Rent', 'Rent'],
]);

const NEON_PIGEON = mapOf([
  ['COGS - Food', 'COGS - Food'],
  ['COGS - Sushi', 'COGS - Food', 'sushi'],
  ['Sales - Sushi', 'Sales - Food', 'sushi'],
  ['Sales - Merchandise', 'Sales - Merchandise', 'merchandise'],
]);

test('the Fat Prince spelling resolves to the shared name', () => {
  const r = resolveAccount('Public Relations / Marketing costs', FAT_PRINCE);
  assert.equal(r.canonical_account, 'Public Relations / Marketing fees');
  assert.equal(r.business_line, 'main');
});

test('an unmapped account falls back to ITSELF, never to a bucket', () => {
  // Deliberately unlike the BOH/FOH role mapping, where defaulting is
  // forbidden. Falling into a bucket makes a category drift with no visible
  // cause; falling back to your own name merges nothing and moves no figure.
  const r = resolveAccount('Some New Account', FAT_PRINCE);
  assert.equal(r.canonical_account, 'Some New Account');
  assert.equal(r.business_line, 'main');
});

test('a null account name does not throw', () => {
  assert.equal(resolveAccount(null, FAT_PRINCE).canonical_account, '');
});

test('unmapped accounts are listed once, in order', () => {
  const missing = unmappedAccounts(
    ['Rent', 'Brand New', 'Rent', 'Also New', 'Brand New'],
    FAT_PRINCE,
  );
  assert.deepEqual(missing, ['Brand New', 'Also New']);
});

test('Fat Prince alcohol and beverages roll into ONE comparable figure', () => {
  // Fat Prince splits alcohol out and the other two venues do not. Rolled up,
  // its beverage cost is finally on the same basis as theirs.
  const rolled = rollUpByCanonical(
    [
      { account_name: 'COGS - Alcohol', amount: 6000 },
      { account_name: 'COGS - Beverages', amount: 4000 },
    ],
    FAT_PRINCE,
  );

  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].canonical_account, 'COGS - Beverages');
  assert.equal(rolled[0].amount, 10000);
  // What was merged must stay visible — a rolled figure whose inputs are
  // invisible is one nobody can check.
  assert.deepEqual(rolled[0].source_accounts.sort(), ['COGS - Alcohol', 'COGS - Beverages']);
});

test('sushi rolls into food cost but stays a SEPARATE line', () => {
  // Both requirements at once: it belongs in Potus Pte Ltd's P&L because
  // improving that P&L was the point of launching it, AND it has to be
  // reportable on its own.
  const rolled = rollUpByCanonical(
    [
      { account_name: 'COGS - Food', amount: 30000 },
      { account_name: 'COGS - Sushi', amount: 5000 },
    ],
    NEON_PIGEON,
  );

  assert.equal(rolled.length, 2);
  const main = rolled.find(r => r.business_line === 'main')!;
  const sushi = rolled.find(r => r.business_line === 'sushi')!;

  assert.equal(main.canonical_account, 'COGS - Food');
  assert.equal(sushi.canonical_account, 'COGS - Food');
  assert.equal(main.amount, 30000);
  assert.equal(sushi.amount, 5000);
  // Summing them gives the entity's true food cost.
  assert.equal(main.amount + sushi.amount, 35000);
});

test('merchandise is its own line and does not merge into food', () => {
  const rolled = rollUpByCanonical(
    [
      { account_name: 'Sales - Sushi', amount: 12000 },
      { account_name: 'Sales - Merchandise', amount: 900 },
    ],
    NEON_PIGEON,
  );
  assert.equal(rolled.length, 2);
  assert.ok(rolled.some(r => r.canonical_account === 'Sales - Merchandise' && r.business_line === 'merchandise'));
});

test('unmapped rows still roll up, under their own names', () => {
  // The fallback must not drop a figure. It just does not unify it.
  const rolled = rollUpByCanonical(
    [{ account_name: 'Brand New Account', amount: 250 }],
    FAT_PRINCE,
  );
  assert.equal(rolled[0].canonical_account, 'Brand New Account');
  assert.equal(rolled[0].amount, 250);
});

test('largest first, by magnitude — a big negative is not sorted last', () => {
  // Costs are positive in this ledger, but Net Profit can be negative and is
  // still the most significant line on the page.
  const rolled = rollUpByCanonical(
    [
      { account_name: 'Rent', amount: 5000 },
      { account_name: 'Brand New', amount: -90000 },
    ],
    FAT_PRINCE,
  );
  assert.equal(rolled[0].canonical_account, 'Brand New');
});
