/**
 * The stream reader, tested where it could never be tested inside an HTML file.
 *
 * The bug being guarded against is the one that cannot be found by using the
 * app on a fast connection: a network read ends wherever the packet ended, so
 * frames arrive split in the middle of a word, in the middle of the JSON, and
 * between the two newlines that terminate a frame. Code that assumes one read
 * is one event works flawlessly in development and loses progress lines — or
 * the ANSWER, which travels in the last frame — on a phone on mobile data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — a browser module, deliberately plain JS and untyped.
import { createEventParser, progressLines } from '../../public/sse-parse.js';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test('whole frames in one read', () => {
  const p = createEventParser();
  const events = p.push(frame({ kind: 'thinking' }) + frame({ kind: 'writing' }));
  assert.deepEqual(events.map((e: any) => e.kind), ['thinking', 'writing']);
});

test('a frame split anywhere still arrives exactly once', () => {
  // Every split point of a two-frame stream, including inside the JSON and
  // between the two newlines of the separator.
  const whole = frame({ kind: 'working', round: 1, labels: ['Pulling the P&L'] }) +
                frame({ kind: 'done', result: { answer: 'ok' } });

  for (let cut = 0; cut <= whole.length; cut++) {
    const p = createEventParser();
    const got = [...p.push(whole.slice(0, cut)), ...p.push(whole.slice(cut))];
    assert.deepEqual(
      got.map((e: any) => e.kind),
      ['working', 'done'],
      `split at ${cut} produced ${JSON.stringify(got.map((e: any) => e.kind))}`,
    );
    assert.deepEqual((got[1] as any).result, { answer: 'ok' }, `split at ${cut} damaged the answer`);
  }
});

test('one byte at a time', () => {
  // The pathological case, and the one that proves nothing is retained twice.
  const whole = frame({ kind: 'thinking' }) + frame({ kind: 'done', result: { answer: 'x' } });
  const p = createEventParser();
  const got: any[] = [];
  for (const ch of whole) got.push(...p.push(ch));
  assert.deepEqual(got.map(e => e.kind), ['thinking', 'done']);
});

test('keep-alive comments are ignored, not parsed', () => {
  const p = createEventParser();
  const events = p.push(': ping\n\n' + frame({ kind: 'thinking' }) + ': ping\n\n');
  assert.deepEqual(events.map((e: any) => e.kind), ['thinking']);
});

test('one unreadable frame never costs the answer', () => {
  /**
   * The `done` event carrying the reply may be the very next frame, so a throw
   * here would lose a question that had already been asked, answered and paid
   * for.
   */
  const p = createEventParser();
  const events = p.push('data: {not json\n\n' + frame({ kind: 'done', result: { answer: 'survived' } }));
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).result.answer, 'survived');
});

test('an incomplete trailing frame is retained, not emitted', () => {
  const p = createEventParser();
  assert.deepEqual(p.push('data: {"kind":"thin'), []);
  assert.deepEqual(p.push('king"}\n\n').map((e: any) => e.kind), ['thinking']);
});

test('progress lines are plain language, and unknown kinds render nothing', () => {
  assert.deepEqual(progressLines({ kind: 'thinking' }), ['Thinking']);
  assert.deepEqual(progressLines({ kind: 'writing' }), ['Writing the answer']);
  assert.deepEqual(progressLines({ kind: 'working', labels: ['Pulling the P&L'] }), ['Pulling the P&L']);

  // A kind this client has never heard of must not reach the screen.
  assert.deepEqual(progressLines({ kind: 'some_future_event', detail: 'raw' } as any), []);
  assert.deepEqual(progressLines(null as any), []);
  assert.deepEqual(progressLines({ kind: 'working' } as any), []);
  assert.deepEqual(progressLines({ kind: 'working', labels: [null, '', 'Real'] } as any), ['Real']);
  assert.deepEqual(progressLines({ kind: 'note', text: '' } as any), []);
});
