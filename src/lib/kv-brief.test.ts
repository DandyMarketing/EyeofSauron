import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanKvBrief, kvBriefMarkdown, kvBriefTool, KV_FORMATS } from './kv-brief.js';

const raw = {
  event_name: 'NYE 2026 on the rooftop',
  venues: 'Neon Pigeon, with the Barter rooftop (rented)',
  when: 'Thu 31 Dec 2026, 9pm to 2am',
  concept: 'A ticketed countdown on a rented rooftop with a headline DJ.',
  key_message: 'The best view of the fireworks, with a party under it.',
  usp_angle: 'The only rooftop countdown in Keong Saik.',
  audience: 'Regulars and their friends, 28 to 40.',
  mood: 'Neon at night, warm not cold',
  references: ['Our NYE 2025 reel', 'A late-night club flyer'],
  colours_and_finish: 'Pink and teal neon on black',
  avoid: 'Generic gold-and-glitter New Year stock art',
  must_include: ['Neon Pigeon logo', 'SevenRooms QR'],
  handles_hashtags: '@neonpigeonsg #NPNYE',
  copy_lines: [{ use: 'Headline', text: 'Count down | on the roof', basis: 'proposal' }],
  formats: [
    { format: 'IG Feed (1080 x 1080)', use: 'launch post', quantity: 2 },
    { format: 'Billboard 6x3m', use: 'nothing like this was on the form' },
  ],
  print: [{ item: 'Table cards', size: 'A6', quantity: null, notes: '' }],
  deadlines: [
    { what: 'Final artwork', date: '2026-12-05', basis: 'settled' },
    { what: 'First draft', date: '2026-12-01', basis: 'proposal' },
    { what: 'Print sent', date: 'next week', basis: 'proposal' },
  ],
  requested_by: 'Corbin',
  approver: 'Khai',
  open_points: ['Which partner logos, and their files'],
};

test('a format not on the team\'s list becomes Other, keeping what it was called', () => {
  const kv = cleanKvBrief(raw)!;
  assert.equal(kv.formats[1]!.format, 'Other');
  assert.equal(kv.formats[1]!.size, 'Billboard 6x3m');
  assert.equal(kv.formats[0]!.quantity, 2);
});

test('a date that is not a date is an open point, never shown as a deadline', () => {
  const kv = cleanKvBrief(raw)!;
  assert.deepEqual(kv.deadlines.map(d => d.date), ['2026-12-01', '2026-12-05'], 'sorted, the bad one gone');
  assert.ok(kv.open_points.some(p => /Print sent/.test(p) && /next week/.test(p)));
});

test('nothing to work from is no brief at all', () => {
  assert.equal(cleanKvBrief(null), null);
  assert.equal(cleanKvBrief({ event_name: 'x', formats: [], open_points: [] }), null);
});

test('the markdown marks what was proposed, not agreed, and keeps table cells intact', () => {
  const md = kvBriefMarkdown(cleanKvBrief(raw)!);
  assert.match(md, /^# Key visual brief: NYE 2026 on the rooftop/);
  assert.match(md, /Count down \/ on the roof \*\(proposal\)\*/, 'a pipe would have split the cell');
  assert.match(md, /\| Final artwork \| Sat, 5 Dec 2026 \|/);
  assert.match(md, /First draft \| Tue, 1 Dec 2026 \*\(proposal\)\*/);
  assert.match(md, /\| Table cards \| A6 \| to confirm \|/, 'a missing quantity is said, never zero');
  assert.match(md, /## Still to settle\n\n- Which partner logos/);
});

test('an empty section is left out, but "still to settle" always says something', () => {
  const md = kvBriefMarkdown(cleanKvBrief({ event_name: 'Quiet', concept: 'A small dinner.', key_message: 'Book now.', formats: [], open_points: [] })!);
  assert.doesNotMatch(md, /## Print|## Copy|## Look and feel/);
  assert.match(md, /- None: everything above was agreed/);
});

test('the tool offers exactly the team\'s formats and asks for open points', () => {
  const t = kvBriefTool();
  const fmt = (t.input_schema.properties.kv.properties.formats.items as any).properties.format.enum;
  assert.deepEqual(fmt, [...KV_FORMATS]);
  assert.ok(t.input_schema.properties.kv.required.includes('open_points'));
  assert.match(t.description, /Never invent/);
});
