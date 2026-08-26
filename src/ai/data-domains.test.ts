import { test } from 'node:test';
import assert from 'node:assert';
import {
  domainOf,
  mayRead,
  effectiveRole,
  enforceDomainScope,
  mentionsPayrollAmounts,
  sensitivityOf,
  TOOL_DOMAINS,
} from './data-domains.js';

// --- the wall --------------------------------------------------------------

test('payroll is owner and finance only', () => {
  assert.equal(mayRead('owner', 'payroll'), true);
  assert.equal(mayRead('finance', 'payroll'), true);
  assert.equal(mayRead('manager', 'payroll'), false);
  assert.equal(mayRead('staff', 'payroll'), false);
});

test('a manager CAN see financial data — the wall is around payroll, not finance', () => {
  // A restaurant manager who cannot see cost of sales cannot run a kitchen.
  // Drawing the line wider than the security model states would be a different
  // decision than the one that was made.
  assert.equal(mayRead('manager', 'financial'), true);
  assert.equal(mayRead('manager', 'operations'), true);
  assert.equal(mayRead('manager', 'marketing'), true);
});

test('staff see operations only', () => {
  assert.equal(mayRead('staff', 'operations'), true);
  assert.equal(mayRead('staff', 'financial'), false);
  assert.equal(mayRead('staff', 'marketing'), false);
});

// --- tool mapping ----------------------------------------------------------

test('an UNKNOWN tool defaults to operations, the least guarded domain', () => {
  // Deliberate: a new tool that quietly gained payroll access by being
  // forgotten is the worst failure available. One that is over-restricted
  // merely does not work, and somebody says so.
  assert.equal(domainOf('some_tool_added_next_march'), 'operations');
  assert.equal(TOOL_DOMAINS.some_tool_added_next_march, undefined);
});

test('the financial tools are mapped', () => {
  assert.equal(domainOf('query_profit_and_loss'), 'financial');
  assert.equal(domainOf('query_supplier_bills'), 'financial');
});

// --- enforcement -----------------------------------------------------------

test('a staff member is refused the P&L, and told why', () => {
  const denied = enforceDomainScope('query_profit_and_loss', 'staff');
  assert.match(denied!, /financial/);
  assert.match(denied!, /staff/);
});

test('an owner is refused nothing', () => {
  for (const tool of Object.keys(TOOL_DOMAINS)) {
    assert.equal(enforceDomainScope(tool, 'owner'), null);
  }
});

test('no role means an internal caller and is NOT blocked', () => {
  // The recommendation engine runs as the system: it must see the P&L to say
  // anything useful about margin, and is filtered on its OUTPUT instead.
  assert.equal(enforceDomainScope('query_profit_and_loss', undefined), null);
});

// --- effective role --------------------------------------------------------

test('an owner is an owner everywhere', () => {
  assert.equal(effectiveRole({ isOwner: true, venues: [] }), 'owner');
  assert.equal(effectiveRole({ isOwner: true, venues: [{ role: 'staff' }] }), 'owner');
});

test('the STRONGEST role held wins', () => {
  // Someone who is finance at one venue and a manager at another is trusted
  // with finance data. The venue filter is what stops them reading the wrong
  // venue's — conflating the two dimensions makes neither work.
  assert.equal(
    effectiveRole({ isOwner: false, venues: [{ role: 'manager' }, { role: 'finance' }] }),
    'finance',
  );
  assert.equal(
    effectiveRole({ isOwner: false, venues: [{ role: 'staff' }, { role: 'manager' }] }),
    'manager',
  );
});

test('no venues at all is staff, the weakest, never owner', () => {
  assert.equal(effectiveRole({ isOwner: false, venues: [] }), 'staff');
});

// --- the output guard ------------------------------------------------------

test('the real leak from the first run is caught', () => {
  // "Staff costs $68,840 / 44.8% of income" — the percentage is fine for a
  // manager under the stated rule, the dollar figure is not.
  assert.equal(mentionsPayrollAmounts('| Staff costs | $68,840 | $72,930 | $63,118 |'), true);
  assert.equal(
    mentionsPayrollAmounts('Income fell 28.8% from May to July while staff costs fell to $63,118.'),
    true,
  );
});

test('labour expressed as a PERCENTAGE passes — that is what managers may see', () => {
  assert.equal(mentionsPayrollAmounts('Your labour ratio is 44.8% of income, up from 34.8%.'), false);
  assert.equal(mentionsPayrollAmounts('| — % of income | 34.8% | 41.9% | 44.8% |'), false);
});

test('a currency amount with nothing to do with pay passes', () => {
  assert.equal(mentionsPayrollAmounts('Net sales were $28,318 against covers of 340.'), false);
  assert.equal(mentionsPayrollAmounts('Marketing spend rose to $26,034 in June.'), false);
});

test('the two must be NEAR each other, not merely both present', () => {
  // A briefing that discusses labour % in one paragraph and food cost in
  // dollars in another is not a leak, and a whole-document window would
  // withhold most of what the engine writes.
  const text = 'Your labour ratio is 44.8% of income.\n\nFood cost of sales was $36,562 in July.';
  assert.equal(mentionsPayrollAmounts(text), false);
});

test('variants of the payroll vocabulary are caught', () => {
  for (const line of [
    'Payroll came to $63,118.',
    'Wages of S$12,000 were booked.',
    'CPF was SGD 4,200 for the month.',
    'The bonus pool is $15k.',
    'Manpower cost $9,000.',
  ]) {
    assert.equal(mentionsPayrollAmounts(line), true, line);
  }
});

test('empty input is not a leak', () => {
  assert.equal(mentionsPayrollAmounts(''), false);
  assert.equal(mentionsPayrollAmounts(null as any), false);
});

// --- recommendation sensitivity --------------------------------------------

test('a payroll amount anywhere makes the whole recommendation payroll', () => {
  assert.equal(
    sensitivityOf({
      domain: 'sales',
      headline: 'Cut the Monday roster',
      body: 'Staff costs ran $63,118 against income of $140,872.',
    }),
    'payroll',
  );
});

test('a labour recommendation is payroll even with no figure', () => {
  // Arguably showable, but it is not what the rule says, and the safe
  // direction to be wrong in is the one that can be loosened later.
  assert.equal(
    sensitivityOf({ domain: 'labour', headline: 'Trim Tuesday cover', body: 'Labour is 44.8% of income.' }),
    'payroll',
  );
});

test('cost is financial, and everything else is operations', () => {
  assert.equal(
    sensitivityOf({ domain: 'cost', headline: 'Beverage cost drifted', body: 'Up 2 points.' }),
    'financial',
  );
  assert.equal(
    sensitivityOf({ domain: 'covers', headline: 'Move the Tuesday set menu', body: '41 against 78 covers.' }),
    'operations',
  );
  assert.equal(
    sensitivityOf({ domain: 'marketing', headline: 'Post more dish content', body: 'Dish out-reaches lifestyle.' }),
    'operations',
  );
});
