/**
 * "Send to Monday", the parts that decide what lands on somebody's board.
 * Board titles and people below are the real NP Activations Board (2026) as
 * read on 12 Oct 2026.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTitle, parseGroupDate, stepKey, historicalOffsets, matchPerson, findColumns,
  deadlineFlags, buildItems, columnValues, sanitiseItems, deadlinePrompt, attachTargets, pnlUpdateHtml, splitNames, matchPeople, type MondayUser,
} from './monday-plan.js';

const users: MondayUser[] = [
  { id: '99680353', name: 'salvin', email: 'salvin@staydandy.com' },
  { id: '56148909', name: 'Lukasz Kononowicz', email: null },
  { id: '37868628', name: 'Corbin Tay Neon', email: null },
  { id: '106554939', name: 'Josh Wilson', email: null },
  { id: '1', name: 'Josh Tan', email: null },
  { id: '69158983', name: 'Khai Git Leong', email: 'khai@staydandy.com' },
];

test('the group is named the way the team names them', () => {
  assert.equal(groupTitle('NYE', '2026-12-31', '2026-12-31'), '26-1231 NYE');
  assert.equal(groupTitle('Hyrox', '2026-11-26', '2026-11-29'), '26-1126-1129 Hyrox');
});

test('event dates are read out of hand-written group titles, and a vague one is not guessed', () => {
  assert.equal(parseGroupDate('26-1231 NYE'), '2026-12-31');
  assert.equal(parseGroupDate('26- 1009 F1'), '2026-10-09');
  assert.equal(parseGroupDate('26 1002- 1031 Dining City'), '2026-10-02');
  assert.equal(parseGroupDate('26-1126-1129 Hyrox'), '2026-11-26');
  assert.equal(parseGroupDate('26-11XX Festive'), null);
  assert.equal(parseGroupDate('NP Active Tasks'), null);
  assert.equal(parseGroupDate('26-1340 Nonsense'), null);
});

test('a renumbered step is still the same step', () => {
  assert.equal(stepKey('13. Send Menus to Printers'), stepKey('11. send menus to printers'));
  assert.equal(stepKey('1.2 Confirm Electric'), 'confirm electric');
});

test('history is a median per step, and a group filled in bulk says nothing about timing', () => {
  const h = historicalOffsets([
    { group_title: '26-1231 NYE', name: '13. Send Menus to Printers', deadline: '2026-12-04' },
    { group_title: '26-1231 NYE', name: '0. Review last year performance', deadline: '2026-10-14' },
    { group_title: '26-1031 Halloween', name: '11. Send menus to printers', deadline: '2026-10-21' },
    { group_title: '26-1031 Halloween', name: '0. Review last year performance', deadline: '2026-09-01' },
    // Every deadline the same day: left out.
    { group_title: '26-1112 TikTok vs Instagram Shift', name: '13. Send Menus to Printers', deadline: '2026-10-07' },
    { group_title: '26-1112 TikTok vs Instagram Shift', name: '1. Strategy', deadline: '2026-10-07' },
    { group_title: '26-1112 TikTok vs Instagram Shift', name: '2. Concept', deadline: '2026-10-07' },
    // The template itself is not an event.
    { group_title: 'Event Template', name: '13. Send Menus to Printers', deadline: '2026-01-01' },
  ]);
  assert.deepEqual(h.get('send menus to printers'), { days_before: 19, n: 2 }); // 27 and 10, 18.5 rounded
  assert.deepEqual(h.get('review last year performance'), { days_before: 69, n: 2 }); // 78 and 60
});

test('people are matched by full name, then by a first name only one person has -- never guessed', () => {
  const m = matchPerson('Salvin', users);
  assert.equal(m.status, 'matched');
  assert.equal(m.status === 'matched' && m.user.id, '99680353');
  assert.equal(matchPerson('Corbin', users).status, 'matched');
  assert.equal(matchPerson('Josh', users).status, 'ambiguous');
  assert.equal(matchPerson('Josh Wilson', users).status, 'matched');
  assert.equal(matchPerson('The team', users).status, 'none');
  assert.equal(matchPerson('', users).status, 'none');
});

test('columns are found by their titles, and the starting status label read from the board', () => {
  const cols = findColumns([
    { id: 'status6', title: 'Event/Campaign Name', type: 'status' },
    { id: 'people', title: 'Owner', type: 'people' },
    { id: 'people_1', title: 'Assigned To', type: 'people' },
    { id: 'date', title: 'Deadline', type: 'date' },
    { id: 'date3', title: 'Original Deadline', type: 'date' },
    { id: 'status9', title: 'Status', type: 'status', settings: { labels: { 0: 'Working on it', 4: 'New Assignment' } } },
  ]);
  assert.deepEqual(cols, { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment' });
});

test('a deadline is flagged, never moved', () => {
  assert.deepEqual(deadlineFlags('2026-10-01', 'before', '2026-10-12', '2026-12-31', '2026-12-31'), ['Already past']);
  assert.deepEqual(deadlineFlags('2027-01-02', 'before', '2026-10-12', '2026-12-31', '2026-12-31'), ['Due after the event starts']);
  assert.deepEqual(deadlineFlags('2027-01-05', 'after', '2026-10-12', '2026-12-31', '2026-12-31'), []);
  assert.deepEqual(deadlineFlags(null, 'before', '2026-10-12', '2026-12-31', '2026-12-31'), ['No deadline']);
});

test('template steps keep the board\'s own people; planner tasks go to the person the plan named', () => {
  const items = buildItems({
    steps: [
      { name: '0. Review last year performance', owner_ids: [56148909, 99680353], assigned_ids: [37868628] },
      { name: '17. Conduct Debrief', owner_ids: [56148909], assigned_ids: [37868628] },
    ],
    deadlines: [
      { index: 0, due: '2026-10-20', phase: 'before', reason: 'first step' },
      { index: 1, due: '2027-01-08', phase: 'after', reason: 'a week after' },
    ],
    tasks: [
      { description: 'Reel: the room on the night', channel: 'reel', kind: 'content', due_date: '2026-12-31', owner_name: 'Corbin' },
      { description: 'Call last year\'s tables', channel: 'phone', kind: 'outreach', due_date: '2026-12-10', owner_name: 'Josh' },
    ],
    users,
    sender: users[5],
    today: '2026-10-12', start: '2026-12-31', end: '2026-12-31',
  });
  assert.equal(items.length, 4);
  assert.deepEqual(items[0].owner_ids, [56148909, 99680353]);
  assert.equal(items[0].owner_label, 'Lukasz Kononowicz, salvin');
  assert.deepEqual(items[1].flags, []);
  // Planner tasks in date order; the reel on the night itself is not "after the event".
  assert.equal(items[2].name, 'Call last year\'s tables (phone)');
  assert.deepEqual(items[2].assigned_ids, []);
  assert.match(items[2].flags.join(), /matches Josh Wilson and Josh Tan/);
  assert.deepEqual(items[3].assigned_ids, [37868628]);
  assert.deepEqual(items[3].flags, []);
  assert.deepEqual(items[3].owner_ids, [69158983]);
});

test('column values are what create_item expects, and nothing is sent for an empty field', () => {
  const cols = { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment' };
  assert.deepEqual(columnValues({ deadline: '2026-12-01', owner_ids: [1], assigned_ids: [] }, cols), {
    date: { date: '2026-12-01' },
    people: { personsAndTeams: [{ id: 1, kind: 'person' }] },
    status9: { label: 'New Assignment' },
  });
});

test('what comes back from the browser is checked before it is written', () => {
  assert.equal(sanitiseItems([]), null);
  assert.equal(sanitiseItems([{ name: '' }]), null);
  assert.equal(sanitiseItems(Array.from({ length: 81 }, () => ({ name: 'x' }))), null);
  assert.deepEqual(sanitiseItems([{ name: ' A ', deadline: 'soon', owner_ids: ['5', -1, 'x'], assigned_ids: [2.5, 7] }]),
    [{ name: 'A', deadline: null, owner_ids: [5], assigned_ids: [7] }]);
});

test('the deadline pass is given the plan first and the board\'s history as a labelled reference', () => {
  const p = deadlinePrompt({
    event: { name: 'NYE', start_date: '2026-12-31', end_date: '2026-12-31' },
    tasks: [{ description: 'Launch post', channel: 'carousel', kind: 'content', due_date: '2026-12-10', owner_name: 'Corbin' }],
    steps: [{ name: '13. Send Menus to Printers', owner_ids: [], assigned_ids: [] }, { name: '99. New step', owner_ids: [], assigned_ids: [] }],
    history: new Map([['send menus to printers', { days_before: 18, n: 2 }]]),
    today: '2026-10-12',
  });
  assert.ok(p.indexOf('THE PLAN') < p.indexOf('CHECKLIST'));
  assert.match(p, /2026-12-10: Launch post \(carousel\) -- Corbin/);
  assert.match(p, /0\. 13\. Send Menus to Printers \[on past events on this board: due 18 days before, median of 2\]/);
  assert.match(p, /1\. 99\. New step \[no history on this board\]/);
});

test('the brief and the P&L find their steps by words, whatever the number', () => {
  assert.deepEqual(attachTargets(['0. Review last year performance', '2. Concept & Mechanics', '7. Submit & Review Financial Forecast']), { brief: 1, pnl: 2 });
  assert.deepEqual(attachTargets(['1.1 Ask Booth choice']), { brief: null, pnl: null });
  const html = pnlUpdateHtml('NYE', { gross: 53624, nett: 53624, product_cost: 9000, group_fees: 2713, profit: 20000.4, scenarios: [{ pct: 0.6, profit: -1500 }, { pct: 0.8, profit: 9000 }, { pct: 1, profit: 20000 }] },
    { food: { value: 0.25, label: 'Food cost, Jul-Sep 2026', basis: 'our data' }, card: { value: null, label: 'Card rate: enter the quote', basis: 'to fill' } });
  assert.match(html, /Profit: \$20,000<\/strong> \(37\.3% of nett\)/);
  assert.match(html, /60%: -\$1,500; 80%: \$9,000/);
  assert.match(html, /Still to fill: Card rate: enter the quote/);
});

test('a shared owner is two people, matched one by one', () => {
  assert.deepEqual(splitNames('Corbin / Josh Wilson'), ['Corbin', 'Josh Wilson']);
  assert.deepEqual(splitNames('Khai + Josh & Fairuz, salvin and Raj'), ['Khai', 'Josh', 'Fairuz', 'salvin', 'Raj']);
  assert.deepEqual(splitNames(''), []);
});

test('the board\'s own people are matched first, guests included, then the account, then a pick', () => {
  // 13 Oct 2026: Corbin is a GUEST on Monday and the lookup searched members only.
  const corbin = { id: '37868628', name: 'Corbin Tay Neon', email: null };
  const josh = { id: '106554939', name: 'Josh Wilson', email: null };
  const joshua = { id: '116390364', name: 'Joshua Hariharan Ashokan', email: null };
  const victor = { id: '100467333', name: 'Victor', email: null };
  const victorFoo = { id: '73479978', name: 'Victor Foo', email: null };
  const all = [corbin, josh, joshua, victor, victorFoo];

  const m = matchPeople('Corbin / Josh Wilson', [corbin, josh], all);
  assert.deepEqual(m.ids, [37868628, 106554939]);
  assert.deepEqual(m.unresolved, []);

  // Not on the board, found on the account.
  assert.deepEqual(matchPeople('Joshua Hariharan Ashokan', [corbin], all).ids, [116390364]);

  // Nobody by that name: unresolved, never guessed.
  const none = matchPeople('Mel', [corbin], all);
  assert.deepEqual(none.ids, []);
  assert.equal(none.unresolved[0].name, 'Mel');

  // An earlier pick wins, and says so.
  const pick = matchPeople('Mel', [corbin], all, { mel: '37868628' });
  assert.deepEqual(pick.ids, [37868628]);
  assert.match(pick.labels[0], /your earlier pick/);
});

test('an unmatched name on a planner task comes with the board\'s people to choose from', () => {
  const corbin = { id: '37868628', name: 'Corbin Tay Neon', email: null };
  const salvin = { id: '99680353', name: 'salvin', email: null };
  const items = buildItems({
    steps: [], deadlines: [],
    tasks: [{ description: 'Shoot the roof at night', channel: null, kind: 'content', due_date: '2026-11-10', owner_name: 'Salvin / Mel' }],
    users: [corbin, salvin], boardUsers: [corbin, salvin], sender: null,
    today: '2026-10-13', start: '2026-12-31', end: '2026-12-31',
  });
  assert.deepEqual(items[0].assigned_ids, [99680353]);
  assert.equal(items[0].unresolved![0].name, 'Mel');
  assert.deepEqual(items[0].unresolved![0].options.map(o => o.name), ['Corbin Tay Neon', 'salvin']);
  assert.match(items[0].flags.join(), /No Monday user called "Mel" -- choose one/);
});
