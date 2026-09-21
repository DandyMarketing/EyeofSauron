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
  describeRole,
  describeAllRoles,
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

// --- what the admin console tells you before you grant it -------------------

/**
 * The console offered four bare words — Manager, Staff, Finance, Owner — with
 * nothing saying what any of them could see, so an access decision was made
 * from a label. The fix is only safe if the description is COMPUTED from the
 * rules that enforce it: a hand-written one sits in an HTML file nobody edits
 * when ROLE_DOMAINS changes, and then the console states the opposite of the
 * truth with total confidence. These tests pin the derivation, not the wording.
 */

const TOOLS = ['query_daily_operations', 'query_profit_and_loss', 'query_top_posts', 'query_labour'];

test('what a role is told it can read matches what mayRead allows', () => {
  // The whole point. If these ever disagree, the console is lying.
  for (const role of ['owner', 'finance', 'manager', 'staff'] as const) {
    const described = describeRole(role, TOOLS);
    for (const domain of described.domains) {
      assert.equal(mayRead(role, domain), true, `${role} is told it reads ${domain} and cannot`);
    }
    for (const domain of described.withheld_domains) {
      assert.equal(mayRead(role, domain), false, `${role} is told it cannot read ${domain} and can`);
    }
  }
});

test('the tool split matches what the tool layer would actually refuse', () => {
  for (const role of ['owner', 'finance', 'manager', 'staff'] as const) {
    const described = describeRole(role, TOOLS);
    for (const tool of described.tools) {
      assert.equal(enforceDomainScope(tool, role), null, `${role} is offered ${tool} and would be refused`);
    }
    for (const tool of described.blocked_tools) {
      assert.ok(enforceDomainScope(tool, role), `${role} is told ${tool} is refused and it is not`);
    }
  }
});

test('every tool is accounted for, in one list or the other', () => {
  // A tool that appeared in neither would be invisible on the page — and an
  // access surface nobody can see is the thing this whole panel exists against.
  for (const role of ['owner', 'finance', 'manager', 'staff'] as const) {
    const d = describeRole(role, TOOLS);
    assert.equal(d.tools.length + d.blocked_tools.length, TOOLS.length);
  }
});

test('a new tool appears by itself, with no page to update', () => {
  const before = describeRole('manager', TOOLS);
  const after = describeRole('manager', [...TOOLS, 'query_something_new']);
  assert.equal(after.tools.length + after.blocked_tools.length, before.tools.length + before.blocked_tools.length + 1);
});

test('only an owner is described as seeing every venue', () => {
  assert.match(describeRole('owner').venues, /every venue/);
  for (const role of ['finance', 'manager', 'staff'] as const) {
    assert.match(describeRole(role).venues, /only the venues assigned/);
  }
});

test('the payroll wall is described the way the handlers implement it', () => {
  // Managers see labour as a percentage and never an amount. That is the line
  // the security model draws, and the sentence a person reads before granting
  // the role has to draw the same one.
  const manager = describeRole('manager');
  assert.ok(manager.cannot.some(s => /wage or labour AMOUNT/i.test(s)));
  assert.ok(manager.can.some(s => /PERCENTAGE/i.test(s)));

  const finance = describeRole('finance');
  assert.ok(finance.can.some(s => /AMOUNTS/i.test(s)));
  assert.ok(!finance.cannot.some(s => /wage or labour AMOUNT/i.test(s)));
});

test('only an owner is told it can open the admin console', () => {
  // Owner is the one choice the venue dropdown beside it cannot contain.
  for (const role of ['finance', 'manager', 'staff'] as const) {
    assert.ok(describeRole(role).cannot.some(s => /admin console/i.test(s)), `${role} should be told`);
  }
  assert.ok(!describeRole('owner').cannot.some(s => /admin console/i.test(s)));
});

test('every role produces something to read', () => {
  // An empty panel is indistinguishable from a panel that failed to load, and
  // the failure mode of both is granting blind.
  for (const r of describeAllRoles(TOOLS)) {
    assert.ok(r.can.length > 0, `${r.role} has nothing under "can"`);
    assert.ok(r.venues.length > 0);
  }
});

test('staff is the narrowest and owner the widest', () => {
  const staff = describeRole('staff', TOOLS);
  const owner = describeRole('owner', TOOLS);
  assert.ok(staff.domains.length < owner.domains.length);
  assert.equal(owner.blocked_tools.length, 0, 'an owner is refused nothing');
});
