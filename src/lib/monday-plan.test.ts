/**
 * "Send to Monday", the parts that decide what lands on somebody's board.
 * Board titles and people below are the real NP Activations Board (2026) as
 * read on 12 Oct 2026.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTitle, parseGroupDate, stepKey, historicalOffsets, matchPerson, findColumns,
  deadlineFlags, buildItems, columnValues, sanitiseItems, deadlinePrompt, attachTargets, pnlUpdateHtml, splitNames, matchPeople,
  planChanges, sanitiseUpdates, updateValues, alreadyPosted, assignParents, parentByKind, EXTRA_PARENTS, type MondayUser, type BoardItem, type PlannerTask,
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
  assert.deepEqual(cols, { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment', doneLabels: [] });
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
  assert.equal(sanitiseItems(Array.from({ length: 121 }, () => ({ name: 'x' }))), null);
  assert.deepEqual(sanitiseItems([{ name: ' A ', deadline: 'soon', owner_ids: ['5', -1, 'x'], assigned_ids: [2.5, 7] }]),
    [{ name: 'A', deadline: null, owner_ids: [5], assigned_ids: [7], parent: null }]);
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

test('a person no longer active on Monday is left off a template step and said', () => {
  // 13 Oct 2026: "unable to assign person with id: 48376983" stopped a send at 7 of 39.
  const salvin = { id: '99680353', name: 'salvin', email: null };
  const items = buildItems({
    steps: [{ name: '7. Submit GR Event Booking Rules Form', owner_ids: [48376983, 99680353], assigned_ids: [] }],
    deadlines: [{ index: 0, due: '2026-11-01', phase: 'before', reason: 'r' }],
    tasks: [], users: [salvin], sender: null,
    today: '2026-10-13', start: '2026-12-31', end: '2026-12-31',
  });
  assert.deepEqual(items[0].owner_ids, [99680353]);
  assert.equal(items[0].owner_label, 'salvin');
  assert.match(items[0].flags.join(), /a person is no longer active on Monday but still on this step in the board's Event Template/);
  // Named when Monday says who, so the team knows whom to replace on the template.
  const named = buildItems({
    steps: [{ name: '7. Submit GR Event Booking Rules Form', owner_ids: [48376983, 99680353], assigned_ids: [] }],
    deadlines: [{ index: 0, due: '2026-11-01', phase: 'before', reason: 'r' }],
    tasks: [], users: [salvin], sender: null,
    today: '2026-10-13', start: '2026-12-31', end: '2026-12-31',
    inactive: new Map([[48376983, 'Sanaya Soonawalla']]),
  });
  assert.match(named[0].flags.join(), /^Sanaya Soonawalla is no longer active on Monday .* Replace them on that step in Monday/);
});

// --- A re-send updates what is already there (Khai, 13 Oct 2026) ---

test('the finished labels are the board\'s own is_done flags, as on the NP board', () => {
  const cols = findColumns([{ id: 'status9', title: 'Status', type: 'status', settings: { labels: [
    { label: 'Working on it', is_done: false }, { label: 'Done', is_done: true }, { label: 'Stuck', is_done: false },
    { label: 'Waiting for Review', is_done: true }, { label: 'New Assignment', is_done: false }, { label: 'Share', is_done: true },
  ] } }]);
  assert.deepEqual(cols.doneLabels, ['Done', 'Waiting for Review', 'Share']);
  // A board with no flags falls back to "Done" itself.
  assert.deepEqual(findColumns([{ id: 's', title: 'Status', type: 'status', settings: { labels: { 0: 'Working on it', 1: 'Done' } } }]).doneLabels, ['Done']);
});

test('a re-send shows what changed: empty cells ticked, filled ones not, finished items left alone', () => {
  const cols = { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment', doneLabels: ['Done', 'Waiting for Review'] };
  const name = (id: number) => users.find(u => Number(u.id) === id)?.name ?? `#${id}`;
  const board: BoardItem[] = [
    { id: '11', name: '5. Photography', deadline: null, owner_ids: [69158983], assigned_ids: [], status: 'New Assignment' },
    { id: '12', name: '7. Booking Rules', deadline: '2026-11-20', owner_ids: [69158983], assigned_ids: [37868628], status: 'Working on it' },
    { id: '13', name: '2. Concept & Mechanics', deadline: '2026-10-20', owner_ids: [69158983], assigned_ids: [], status: 'Done' },
    { id: '14', name: 'Post the teaser reel (Instagram)', deadline: '2026-12-01', owner_ids: [69158983], assigned_ids: [99680353], status: null },
  ];
  const plan = [
    { name: '5. Photography', deadline: '2026-12-10', owner_ids: [69158983], assigned_ids: [106554939] },
    { name: '7. booking rules', deadline: '2026-11-15', owner_ids: [69158983], assigned_ids: [56148909] },
    { name: '2. Concept & Mechanics', deadline: '2026-10-25', owner_ids: [69158983], assigned_ids: [] },
    // Nothing changed, and the plan naming nobody does not clear the board.
    { name: 'Post the teaser reel (Instagram)', deadline: '2026-12-01', owner_ids: [69158983], assigned_ids: [] },
    // Not on the board yet: added by the send, not a change.
    { name: 'Book the DJ', deadline: '2026-11-01', owner_ids: [69158983], assigned_ids: [] },
  ];
  const out = planChanges(plan, board, cols, name);
  assert.equal(out.length, 3);
  const photo = out.find(c => c.item_id === '11')!;
  assert.deepEqual(photo.changes.map(c => [c.field, c.on]), [['deadline', true], ['assigned', true]]);
  const rules = out.find(c => c.item_id === '12')!;
  // The team already set these on the board: shown, but not ticked.
  assert.deepEqual(rules.changes.map(c => [c.field, c.board, c.plan, c.on]), [
    ['deadline', '2026-11-20', '2026-11-15', false],
    ['assigned', 'Corbin Tay Neon', 'Lukasz Kononowicz', false],
  ]);
  assert.deepEqual(out.find(c => c.item_id === '13'), { item_id: '13', name: '2. Concept & Mechanics', done: 'Done', changes: [] });
});

test('ticked changes come back checked, and an update never touches the status', () => {
  assert.deepEqual(sanitiseUpdates([
    { item_id: '11', deadline: '2026-12-10', assigned_ids: [106554939] },
    { item_id: 'x; drop', deadline: '2026-12-10' },
    { item_id: '12', deadline: 'next week' },
    { item_id: '13', owner_ids: ['abc', -1] },
  ]), [{ item_id: '11', deadline: '2026-12-10', assigned_ids: [106554939] }]);
  assert.deepEqual(sanitiseUpdates('nonsense'), []);
  const cols = { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment' };
  assert.deepEqual(updateValues({ deadline: '2026-12-10', assigned_ids: [7] }, cols), {
    date: { date: '2026-12-10' }, people_1: { personsAndTeams: [{ id: 7, kind: 'person' }] },
  });
});

test('a brief already on the item is not posted twice; a changed one is', () => {
  const html = '<h2>NYE</h2><p>Three floors &amp; one countdown.</p>';
  const onMonday = ['Revised 2026-10-13 -- this replaces the earlier version below. NYE Three floors & one countdown.'];
  assert.equal(alreadyPosted(html, onMonday), true);
  assert.equal(alreadyPosted('<p>Four floors now.</p>', onMonday), false);
  assert.equal(alreadyPosted(html, []), false);
});

// --- The planner's tasks as sub-items (Khai, 13 Oct 2026) ---

const npSteps = [
  { name: '4. Submit & Review Food Menu', owner_ids: [], assigned_ids: [] },
  { name: '5. Determine if Photography is needed', owner_ids: [], assigned_ids: [] },
  { name: '8. Source entertainment/partners/sponsors', owner_ids: [], assigned_ids: [] },
];
const task = (description: string, kind: string): PlannerTask =>
  ({ description, kind, channel: null, due_date: '2026-12-01', owner_name: null });

test('each task goes under the step the AI chose, or an extra parent -- never a step that does not exist', () => {
  const tasks = [task('Book the DJ', 'ops'), task('Post 4: dinner menu being cooked', 'content'), task('Press invites', 'outreach'), task('Something odd', 'other')];
  const out = assignParents(tasks, npSteps, { tasks: [
    { task: 0, step: 2 },
    { task: 1, step: -1, extra: 'Marketing plan' },
    { task: 2, step: 9 },              // no such step: falls back to its kind
    // task 3 not answered at all: by kind
  ] });
  assert.deepEqual(out.map(t => t.parent), ['8. Source entertainment/partners/sponsors', 'Marketing plan', 'PR & outreach', 'Other tasks']);
  // Nothing usable from the pass: every task still has a parent.
  assert.deepEqual(assignParents(tasks, npSteps, null).map(t => t.parent), ['Operations', 'Marketing plan', 'PR & outreach', 'Other tasks']);
  assert.ok(EXTRA_PARENTS.includes(parentByKind('content') as any));
});

test('a sub-item must hang off a top-level item sent with it', () => {
  const ok = sanitiseItems([
    { name: '8. Source entertainment/partners/sponsors', deadline: null, owner_ids: [], assigned_ids: [] },
    { name: 'Book the DJ', deadline: '2026-11-01', owner_ids: [1], assigned_ids: [], parent: '8. Source entertainment/partners/sponsors' },
  ]);
  assert.equal(ok?.[1].parent, '8. Source entertainment/partners/sponsors');
  assert.equal(ok?.[0].parent, null);
  assert.equal(sanitiseItems([{ name: 'Book the DJ', deadline: null, owner_ids: [], assigned_ids: [], parent: 'Nowhere' }]), null);
});

test('a re-send compares a task with the sub-items of its parent, on the sub-item board\'s labels', () => {
  const cols = { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: 'New Assignment', doneLabels: ['Done'] };
  const sub = { deadline: 'dup__of_start_date', owner: 'person', assigned: 'dup__of_owner', status: 'status', statusLabel: null, doneLabels: ['Done', 'Stuck', 'Waiting for Review'] };
  const board: BoardItem[] = [{
    id: '1', name: 'Marketing plan', deadline: null, owner_ids: [69158983], assigned_ids: [], status: null,
    subitems: [
      { id: '21', name: 'Post 4: dinner menu being cooked', deadline: null, owner_ids: [69158983], assigned_ids: [], status: null },
      { id: '22', name: 'Post 5: boiler room teaser', deadline: '2026-12-15', owner_ids: [69158983], assigned_ids: [], status: 'Stuck' },
    ],
  }, { id: '9', name: 'Post 4: dinner menu being cooked', deadline: '2026-12-08', owner_ids: [], assigned_ids: [], status: null }];
  const out = planChanges([
    { name: 'Post 4: dinner menu being cooked', deadline: '2026-12-09', owner_ids: [69158983], assigned_ids: [], parent: 'Marketing plan' },
    { name: 'Post 5: boiler room teaser', deadline: '2026-12-16', owner_ids: [69158983], assigned_ids: [], parent: 'Marketing plan' },
  ], board, cols, String, sub);
  // The sub-item, not the flat item of the same name from the earlier send.
  assert.deepEqual(out[0], { item_id: '21', name: 'Post 4: dinner menu being cooked', sub: true, changes: [{ field: 'deadline', board: '', plan: '2026-12-09', value: '2026-12-09', on: true }] });
  // "Stuck" is finished on the sub-item board's own definition.
  assert.deepEqual(out[1], { item_id: '22', name: 'Post 5: boiler room teaser', sub: true, done: 'Stuck', changes: [] });
  assert.deepEqual(sanitiseUpdates([{ item_id: '21', sub: true, deadline: '2026-12-09' }]), [{ item_id: '21', sub: true, deadline: '2026-12-09' }]);
});
