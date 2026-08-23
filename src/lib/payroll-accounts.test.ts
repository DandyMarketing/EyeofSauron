import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPayrollAccount, payrollAccountIds, looksLikePersonalPay } from './payroll-accounts.js';

/**
 * Neon Pigeon's June 2026 came back with 168 bill lines across four payroll
 * accounts -- roughly forty people times four accounts. Payroll is posted as
 * supplier bills in this chart of accounts, so pulling bills pulled individual
 * pay, which the security model says never to hold.
 */
describe('isPayrollAccount', () => {
  test('catches the accounts that actually appeared', () => {
    for (const name of [
      'Wages and Salaries',
      'CPF',
      'SDL',
      'Foreign Workers Levy (FWL)',
    ]) {
      assert.equal(isPayrollAccount(name), true, name);
    }
  });

  test('catches the ones that have not appeared yet but would carry pay', () => {
    for (const name of ['Payroll clearing', 'Staff bonus', "Directors' fees", 'Staff advance']) {
      assert.equal(isPayrollAccount(name), true, name);
    }
  });

  test('leaves ordinary costs alone', () => {
    for (const name of [
      'COGS - Food',
      'Rent',
      'Public Relations / Marketing fees',
      'Staff welfare',
      'Staff costs - Uniform',
      'Recruitment / Visa expenses',
    ]) {
      assert.equal(isPayrollAccount(name), false, name);
    }
  });

  test('is case insensitive and safe on nulls', () => {
    assert.equal(isPayrollAccount('WAGES AND SALARIES'), true);
    assert.equal(isPayrollAccount(null), false);
    assert.equal(isPayrollAccount(undefined), false);
    assert.equal(isPayrollAccount(''), false);
  });
});

describe('payrollAccountIds', () => {
  test('collects the ids of payroll accounts and no others', () => {
    const ids = payrollAccountIds([
      { account_id: 'wages-uuid', account_name: 'Wages and Salaries' },
      { account_id: 'food-uuid', account_name: 'COGS - Food' },
      { account_id: 'cpf-uuid', account_name: 'CPF' },
    ]);

    assert.ok(ids.has('wages-uuid'));
    assert.ok(ids.has('cpf-uuid'));
    assert.ok(!ids.has('food-uuid'));
    assert.equal(ids.size, 2);
  });

  test('ignores rows with no account id', () => {
    // Section totals carry no account id and cannot identify anything.
    const ids = payrollAccountIds([{ account_id: null, account_name: 'Total Staff Costs' }]);
    assert.equal(ids.size, 0);
  });
});

// ---------------------------------------------------------------------------
// The second guard: reading the LINE, not its account
// ---------------------------------------------------------------------------

/**
 * payrollAccountIds() learns payroll accounts from P&L account NAMES, so it is
 * blind to an account the P&L never reports. On 23 Aug 2026 an audit found bill
 * lines carrying named individuals' net salaries and SDL under exactly such
 * accounts — 46 lines across three venues, including dividends and a director
 * loan repayment. None of them could have been caught by name.
 */

test('a net-salary line is personal pay whatever account it was coded to', () => {
  assert.equal(looksLikePersonalPay('Leon K Net Salaries', 'Printmate (S) Pte Ltd'), true);
  assert.equal(looksLikePersonalPay('Varshni N SDL', 'Ministry of Manpower'), true);
});

test('Ministry of Manpower is payroll on the supplier alone', () => {
  // The description on these lines is sometimes just a person's name, which no
  // pattern can safely match. The supplier is the reliable signal.
  assert.equal(looksLikePersonalPay('Some Person', 'Ministry of Manpower'), true);
});

test('dividends and director loan repayments are personal too', () => {
  // Not payroll, but named individuals' financial affairs — same wall.
  assert.equal(looksLikePersonalPay('A Shareholder', 'Dividends'), true);
  assert.equal(looksLikePersonalPay('A Director', 'Loan Repayment'), true);
});

test('ordinary supplier lines pass through', () => {
  assert.equal(looksLikePersonalPay('FRUIT HOKKAIDO APPLE WINE 500ml / 12bot', 'Angra Wine & Spirit Importers'), false);
  assert.equal(looksLikePersonalPay('Chemical Wash - Ceiling Cassette', 'Air-Tech Conditioning'), false);
  assert.equal(looksLikePersonalPay(null, null), false);
});

test('the levy pattern catches FWL lines however they are worded', () => {
  assert.equal(looksLikePersonalPay('Foreign Worker Levy - Aug', 'Ministry of Manpower'), true);
  assert.equal(looksLikePersonalPay('LEVY', null), true);
});

test('matching is case-insensitive', () => {
  assert.equal(looksLikePersonalPay('NET SALARIES', null), true);
  assert.equal(looksLikePersonalPay('Payroll run', null), true);
});
