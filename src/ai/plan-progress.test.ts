import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseProgress, planTranscript, DECISION_LABELS, DECISION_HINTS, progressTool, decisionGuide, boardNote, cleanPrevious, withPrevious, parseStored, applyManual, toggleManual } from './plan-progress.js';
import { PLAYBOOK } from './event-playbook.js';

test('every playbook decision has a short label, and the tool offers exactly the playbook keys', () => {
  for (const r of PLAYBOOK) assert.ok(DECISION_LABELS[r.key], r.key);
  const keys = (progressTool().input_schema.properties.settled.items.properties.key as any).enum;
  assert.deepEqual(keys, PLAYBOOK.map(r => r.key));
});

test('counts settled against what applies, ignoring keys the model made up', () => {
  const p = summariseProgress({
    settled: [
      { key: 'date_and_why', summary: 'NYE 31 Dec, a strong night' },
      { key: 'product_shape', summary: 'Ticketed at all four rooms' },
      { key: 'date_and_why', summary: 'duplicate' },
      { key: 'vibes', summary: 'not a playbook key' },
    ],
    not_applicable: ['ad_spend', 'date_and_why'],
    waiting_on: [{ item: 'Barter rooftop contract', who: 'Barter' }, { item: '' }],
    next: 'scope',
  });
  assert.equal(p.counts.settled, 2);
  // 20 decisions, one not applicable; date_and_why was settled so it still counts.
  assert.equal(p.counts.applicable, PLAYBOOK.length - 1);
  assert.deepEqual(p.not_applicable, ['ad_spend']);
  assert.equal(p.settled.find(s => s.key === 'date_and_why')?.summary, 'NYE 31 Dec, a strong night');
  assert.deepEqual(p.waiting_on, [{ item: 'Barter rooftop contract', who: 'Barter' }]);
  assert.deepEqual(p.next, { key: 'scope', label: 'One event or several' });
  assert.equal(p.stages.reduce((n, s) => n + s.applicable, 0), p.counts.applicable);
});

test('nothing usable is an empty board, not a crash', () => {
  const p = summariseProgress(null);
  assert.equal(p.counts.settled, 0);
  assert.equal(p.counts.applicable, PLAYBOOK.length);
  assert.equal(p.next?.key, 'objective');
});

test('the transcript never calls the person the planner', () => {
  const t = planTranscript([{ role: 'user', content: 'i still need a fourth' }, { role: 'assistant', content: 'Noted.' }]);
  assert.match(t, /^THE PERSON PLANNING: i still need a fourth/);
  assert.doesNotMatch(t, /^PLANNER:/m);
});

test('the reader is told what every decision means, not just its key', () => {
  const g = decisionGuide();
  for (const r of PLAYBOOK) assert.ok(g.includes(`- ${r.key} (`) && g.includes(r.decision), r.key);
  assert.match(g, /scope \(One event or several\): Whether this is one event across venues or several events sharing a date\./);
});

test('every open item carries a one-line hint of what it means', () => {
  for (const r of PLAYBOOK) {
    const h = DECISION_HINTS[r.key];
    assert.ok(h, `${r.key} has no hint`);
    assert.ok(h.length <= 60, `${r.key}: "${h}" is ${h.length} characters -- keep it to one line`);
    assert.doesNotMatch(h, /\d/, `${r.key}: a hint carries no figures`);
  }
  const p = summariseProgress(null);
  assert.equal(p.open.find(o => o.key === 'scope')?.hint, DECISION_HINTS.scope);
});

test('a decision touched but not settled says what is agreed and what is missing', () => {
  const p = summariseProgress({
    settled: [{ key: 'objective', summary: '$30,000 at 20% net' }],
    partial: [
      { key: 'channels', agreed: 'promoters, Meta ads', missing: 'the Instagram plan, and which channel books' },
      // Settled wins over partial, and an unknown key is dropped.
      { key: 'objective', agreed: 'x', missing: 'y' },
      { key: 'nonsense', agreed: 'x', missing: 'y' },
    ],
    not_applicable: [], waiting_on: [],
  });
  const ch = p.open.find(o => o.key === 'channels')!;
  assert.deepEqual(ch.partial, { agreed: 'promoters, Meta ads', missing: 'the Instagram plan, and which channel books' });
  assert.equal(p.open.some(o => o.key === 'objective'), false);
  assert.equal(p.open.filter(o => o.partial).length, 1);
});

test('the board note tells the planner what is open, and is empty when nothing blocking is', () => {
  // Khai, 13 Oct 2026: the planner said "CONFIRMED" while the board showed
  // Channels and Other channels open.
  const note = boardNote(['channels', 'alternative_channels', 'channels', 'made_up']);
  assert.match(note, /\[PROGRESS BOARD/);
  assert.match(note, /Channels: Every channel/);
  assert.match(note, /Other channels:/);
  assert.equal(note.match(/- Channels:/g)!.length, 1, 'a repeated key is listed once');
  assert.doesNotMatch(note, /made_up/);
  assert.match(note, /do not call the plan ready, complete, locked or confirmed/);
  assert.equal(boardNote([]), '');
  assert.equal(boardNote('channels'), '');
});

test('a pending fee does not hold a made choice open', () => {
  const settled = progressTool().input_schema.properties.settled as any;
  assert.match(settled.description, /CHOICE THAT IS MADE IS SETTLED even if its fee, quote or signature is still pending/);
});

test('a settled decision stays settled unless the conversation reopens it, with a reason', () => {
  // Khai, 13 Oct 2026: "progress kept fluctuating 20/20 then ... went to this".
  const previous = cleanPrevious({
    settled: [{ key: 'owners_and_deadlines', summary: 'Fairuz, Corbin/Josh, you' }, { key: 'price_and_basis', summary: '$80 late door' }, { key: 'bogus', summary: 'x' }],
    not_applicable: ['scope'],
  })!;
  assert.equal(previous.settled.length, 2, 'an unknown key is dropped');

  // This read missed both settled decisions and forgot scope -- nothing moves.
  const kept = summariseProgress(withPrevious({ settled: [], not_applicable: [], waiting_on: [] }, previous));
  assert.ok(kept.settled.some(d => d.key === 'owners_and_deadlines'));
  assert.ok(kept.settled.some(d => d.key === 'price_and_basis'));
  assert.ok(kept.not_applicable.includes('scope'));
  assert.deepEqual(kept.reopened, []);

  // A genuine change reopens one, and the board says why.
  const moved = summariseProgress(withPrevious({
    settled: [], not_applicable: [], waiting_on: [],
    reopened: [{ key: 'price_and_basis', why: 'late door changed from $80 to $60' }, { key: 'owners_and_deadlines', why: '' }],
  }, previous));
  assert.equal(moved.settled.some(d => d.key === 'price_and_basis'), false);
  assert.deepEqual(moved.reopened, [{ key: 'price_and_basis', label: 'Price', why: 'late door changed from $80 to $60' }]);
  assert.ok(moved.settled.some(d => d.key === 'owners_and_deadlines'), 'a reopen with no reason is ignored');

  assert.equal(cleanPrevious(null), null);
  assert.equal(cleanPrevious({ settled: 'x' }), null);
});

test('the board note carries what is missing, so the planner asks for exactly that', () => {
  const note = boardNote([{ key: 'owners_and_deadlines', missing: 'owners for the nine posts' }]);
  assert.match(note, /Owners & deadlines: .* MISSING: owners for the nine posts/);
});

test('a parked task settles its decision rather than holding it open', () => {
  const settled = progressTool().input_schema.properties.settled as any;
  assert.match(settled.description, /PARKED as a task with an owner and a date[\s\S]*is SETTLED/);
});

test('a decision the person marks as decided is decided, and only they can undo it', () => {
  // Khai, 13 Oct 2026: the board kept listing the DJ's name after he had parked it.
  const reading = {
    settled: [{ key: 'objective', summary: '$30,000 at 20% net' }],
    partial: [{ key: 'owners_and_deadlines', agreed: 'all tasks', missing: "the rooftop act's name" }],
    reopened: [{ key: 'owners_and_deadlines', why: 'model thinks so' }],
    not_applicable: [], waiting_on: [], next: 'owners_and_deadlines',
  };
  const manual = toggleManual([], 'owners_and_deadlines', true);
  const p = summariseProgress(applyManual(reading, manual));
  const own = p.settled.find(d => d.key === 'owners_and_deadlines')!;
  assert.equal(own.by_you, true);
  assert.equal(p.open.some(o => o.key === 'owners_and_deadlines'), false);
  assert.deepEqual(p.reopened, [], 'a later reading cannot reopen a hand mark');
  assert.notEqual(p.next?.key, 'owners_and_deadlines');
  assert.equal(p.settled.find(d => d.key === 'objective')!.by_you, undefined);

  // Undo puts it back to whatever the reading says.
  const undone = summariseProgress(applyManual(reading, toggleManual(manual, 'owners_and_deadlines', false)));
  assert.ok(undone.open.some(o => o.key === 'owners_and_deadlines'));

  assert.deepEqual(toggleManual(['objective'], 'not_a_decision', true), ['objective']);
});

test('the saved board comes back in one piece, and junk saved reads as nothing', () => {
  const stored = parseStored({ reading: { settled: [{ key: 'objective', summary: 'x' }] }, manual: ['channels', 'bogus', 'channels'] });
  assert.deepEqual(stored!.manual, ['channels']);
  assert.ok(stored!.reading);
  assert.equal(parseStored(null), null);
  assert.equal(parseStored('text'), null);
});
