import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPayrollAccount, payrollAccountIds } from './payroll-accounts.js';

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
