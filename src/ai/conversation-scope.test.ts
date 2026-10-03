import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeOfTurn, mayStillRead, filterConversation } from './conversation-scope.js';

test('a turn records the venues and domains it read', () => {
  const scope = scopeOfTurn([
    { name: 'query_daily_operations', input: { venue_slug: 'neon_pigeon', days: 7 } },
    { name: 'query_profit_and_loss', input: { venue_slug: 'fat_prince' } },
    { name: 'create_chart', input: {} },
  ]);
  assert.deepEqual(scope.venue_slugs, ['fat_prince', 'neon_pigeon']);
  assert.ok(scope.domains.includes('financial'), 'the P&L is financial data');
  assert.ok(scope.domains.includes('operations'));
});

test('every shape of venue argument is picked up', () => {
  // Missing one would let a message through a scope check it should fail.
  const shapes = [
    { venue: 'neon_pigeon' },
    { venue_slug: 'neon_pigeon' },
    { venue_name: 'neon_pigeon' },
    { venue_slugs: ['neon_pigeon'] },
    { venues: ['neon_pigeon'] },
  ];
  for (const input of shapes) {
    assert.deepEqual(
      scopeOfTurn([{ name: 'query_daily_operations', input }]).venue_slugs,
      ['neon_pigeon'],
      `missed the venue in ${JSON.stringify(input)}`,
    );
  }
});

test('a turn with no tool calls reads nothing', () => {
  assert.deepEqual(scopeOfTurn([]), { venue_slugs: [], domains: [] });
  assert.deepEqual(scopeOfTurn([{ name: '', input: null } as any]).venue_slugs, []);
});

test('A ROLE CHANGE HIDES WHAT THE ROLE NO LONGER COVERS', () => {
  /**
   * The case this file exists for. Finance asks about labour cost, the chat is
   * saved, their role becomes manager. Without the re-check the stored chat
   * goes on serving payroll figures that the live path would refuse.
   */
  const turn = { venue_slugs: ['neon_pigeon'], domains: ['payroll' as const] };

  const asFinance = mayStillRead(turn, { role: 'finance', venues: ['neon_pigeon'] });
  assert.equal(asFinance.visible, true);

  const asManager = mayStillRead(turn, { role: 'manager', venues: ['neon_pigeon'] });
  assert.equal(asManager.visible, false);
  assert.match(asManager.reason!, /payroll/);
  assert.match(asManager.reason!, /current role/);
});

test('A VENUE CHANGE HIDES THE OTHER VENUE', () => {
  const turn = { venue_slugs: ['fat_prince'], domains: ['financial' as const] };

  assert.equal(mayStillRead(turn, { role: 'finance', venues: ['fat_prince'] }).visible, true);

  const moved = mayStillRead(turn, { role: 'finance', venues: ['neon_pigeon'] });
  assert.equal(moved.visible, false);
  // Named, because the person had access when they asked and it is their own
  // conversation — an unexplained gap in your own history is worse.
  assert.match(moved.reason!, /fat_prince/);
});

test('an owner sees everything they ever asked', () => {
  const turn = { venue_slugs: ['fat_prince', 'neon_pigeon'], domains: ['payroll' as const] };
  assert.equal(mayStillRead(turn, { role: 'owner', venues: null }).visible, true);
});

test("a person's OWN QUESTIONS are never withheld", () => {
  /**
   * They wrote it, they have read it before, and it carries no figures — the
   * answer is where the data is. Hiding somebody's own words makes the
   * conversation unreadable without protecting anything.
   */
  const { messages, withheld } = filterConversation([
    { role: 'user', content: 'What is labour at Fat Prince?', venue_slugs: ['fat_prince'], domains: ['payroll'] },
    { role: 'assistant', content: 'Labour was $63,118.', venue_slugs: ['fat_prince'], domains: ['payroll'] },
  ], { role: 'manager', venues: ['neon_pigeon'] });

  assert.equal(messages[0].content, 'What is labour at Fat Prince?');
  assert.equal(messages[1].content.startsWith('Hidden'), true);
  assert.equal(withheld, 1);
});

test('a withheld message loses its charts too', () => {
  // A chart is drawn from the same figures as the prose. Leaving it behind
  // would withhold the sentence and publish the picture of it.
  const { messages } = filterConversation([
    { role: 'assistant', content: 'Here it is.', charts: [{ title: 'P&L', svg: '<svg/>' }],
      venue_slugs: ['fat_prince'], domains: ['financial'] },
  ], { role: 'manager', venues: ['neon_pigeon'] });
  assert.equal(messages[0].charts, null);
});

test('THE COUNT IS REPORTED, so a filter that stopped working is visible', () => {
  const msgs = [
    { role: 'assistant', content: 'a', venue_slugs: ['fat_prince'], domains: ['financial'] },
    { role: 'assistant', content: 'b', venue_slugs: ['neon_pigeon'], domains: ['operations'] },
    { role: 'assistant', content: 'c', venue_slugs: ['firangi_superstar'], domains: ['operations'] },
  ];
  const { withheld } = filterConversation(msgs, { role: 'manager', venues: ['neon_pigeon'] });
  assert.equal(withheld, 2);
});

test('a turn recorded before scopes existed is not hidden by accident', () => {
  // Null/absent columns mean "nothing recorded", not "everything". Treating an
  // old row as out of scope would blank every conversation that predates this.
  const { messages, withheld } = filterConversation(
    [{ role: 'assistant', content: 'old answer' }],
    { role: 'staff', venues: ['neon_pigeon'] },
  );
  assert.equal(withheld, 0);
  assert.equal(messages[0].content, 'old answer');
});
