/**
 * "Send to Monday", the parts that decide what lands on somebody's board.
 * Board titles and people below are the real NP Activations Board (2026) as
 * read on 12 Oct 2026.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTitle, parseGroupDate, stepKey, historicalOffsets, matchPerson, findColumns,
  deadlineFlags, buildItems, columnValues, sanitiseItems, attachTargets, pnlUpdateHtml, splitNames, matchPeople,
  planChanges, sanitiseUpdates, updateValues, alreadyPosted, parentByKind, EXTRA_PARENTS, workstreamOf, workstreams, readWorkstreams, titlePrompt, TITLE_SYSTEM, briefItems, readTitles, cleanTitle, detailUpdateHtml, type MondayUser, type BoardItem, type PlannerTask,
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
    [{ name: 'A', deadline: null, owner_ids: [5], assigned_ids: [7], parent: null, detail: null, aliases: [], task_id: null }]);
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

test('each task goes under its own workstream, or by its kind until it has one -- never a template step', () => {
  // Khai, 22 Oct 2026: the brief alone decides what is on the board.
  const tasks: PlannerTask[] = [
    { ...task('Book the DJ', 'ops'), workstream: 'Entertainment' },
    { ...task('Post 4: dinner menu being cooked', 'content'), workstream: 'Marketing' },
    task('Press invites', 'outreach'),
    { ...task('Set up the rooftop bar', 'ops'), workstream: '  ' },
  ];
  assert.deepEqual(tasks.map(workstreamOf), ['Entertainment', 'Marketing', 'PR & outreach', 'Operations']);
  assert.deepEqual(workstreams(tasks), ['Entertainment', 'Marketing', 'PR & outreach', 'Operations'], 'in the order the plan uses them');
  assert.ok(EXTRA_PARENTS.includes(parentByKind('content') as any));
  void npSteps;
});

test('the naming pass reads workstreams, and is told the event and the ones in use', () => {
  const w = readWorkstreams(3, { tasks: [
    { task: 0, title: 'Book the DJ', workstream: 'Entertainment' },
    { task: 1, title: 'x', workstream: 'A workstream name far too long to be a heading on a board' },
    { task: 9, workstream: 'Nope' },
  ] });
  assert.deepEqual([...w], [[0, 'Entertainment']]);
  const p = titlePrompt([task('Book the DJ', 'ops')], { name: 'NYE Rooftop', concept: 'A rooftop countdown' }, ['Entertainment']);
  assert.match(p, /THE EVENT: NYE Rooftop -- A rooftop countdown/);
  assert.match(p, /WORKSTREAMS ALREADY IN USE.*Entertainment/);
  assert.match(TITLE_SYSTEM, /each event has|should not look the same/);
});

test('the brief and the P&L get their own items when the template is gone', () => {
  const me: MondayUser = { id: '9', name: 'Khai', email: 'k@x' };
  const items = briefItems(me, true);
  assert.deepEqual(items.map(i => i.name), ['Event brief', 'Financial forecast']);
  assert.deepEqual(items[0].owner_ids, [9]);
  assert.deepEqual(briefItems(null, false).map(i => i.name), ['Event brief'], 'no forecast item without a P&L');
  assert.deepEqual(attachTargets(['Event brief', 'Financial forecast', 'Entertainment']), { brief: 0, pnl: 1 });
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

// --- Short names, the full text as a note (Khai, 13 Oct 2026) ---

test('a short name is checked, and a task with none keeps its full name', () => {
  assert.equal(cleanTitle('  Cost the dinner menu. '), 'Cost the dinner menu');
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('x'.repeat(81)), null);
  assert.deepEqual([...readTitles(3, { tasks: [{ task: 0, title: 'Book the DJ' }, { task: 7, title: 'Nope' }, { task: 2, title: 42 }] })], [[0, 'Book the DJ']]);
});

test('a task with a short name goes on under it, with the full text as its note and its old name kept to recognise', () => {
  const long = 'Food menu written and costed to 25.59% COGS ($128 set menu, rooftop access included)';
  const [plain, titled] = buildItems({ // sorted by due date: the DJ (1 Nov) first
    steps: [], deadlines: [], users, sender: users[5],
    tasks: [
      { description: long, kind: 'ops', channel: null, due_date: '2026-11-17', owner_name: 'Lukasz', title: 'Cost the dinner menu', parent: 'Operations' },
      { description: 'Book the DJ', kind: 'ops', channel: null, due_date: '2026-11-01', owner_name: null, parent: 'Operations' },
    ],
    today: '2026-10-13', start: '2026-12-31', end: '2026-12-31',
  });
  assert.equal(titled.name, 'Cost the dinner menu');
  assert.equal(titled.detail, long);
  assert.deepEqual(titled.aliases, [long]);
  assert.equal(plain.name, 'Book the DJ');
  assert.equal(plain.detail, undefined);
});

test('a sub-item an earlier send made under its long name is matched, not made again', () => {
  const cols = { deadline: 'date', owner: 'people', assigned: 'people_1', status: 'status9', statusLabel: null, doneLabels: [] };
  const long = 'Food menu written and costed to 25.59% COGS';
  const out = planChanges(
    [{ name: 'Cost the dinner menu', aliases: [long], deadline: '2026-11-17', owner_ids: [1], assigned_ids: [], parent: 'Operations' }],
    [{ id: '1', name: 'Operations', deadline: null, owner_ids: [], assigned_ids: [], status: null,
       subitems: [{ id: '5', name: long, deadline: null, owner_ids: [1], assigned_ids: [], status: null }] }],
    cols, String, cols,
  );
  assert.equal(out[0].item_id, '5');
});

test('the note carries the full task, the date and who it is for -- escaped', () => {
  const html = detailUpdateHtml('Cost <menu> & sign off', '2026-11-17', ['Lukasz Kononowicz', 'salvin']);
  assert.match(html, /Cost &lt;menu&gt; &amp; sign off/);
  assert.match(html, /Due 2026-11-17/);
  assert.match(html, /For: Lukasz Kononowicz, salvin/);
});
