import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReportInput, reportMarkdown, KIND_LABELS, type StoredReport } from './issue-reports.js';

test('a report from the browser is checked: fixed kinds and pages, ids, ceilings', () => {
  const ok = cleanReportInput({
    kind: 'wrong', page: 'chat', comment: '  Brunch figure is the whole day ',
    conversation_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    question: 'How did brunch book?', answer: '41 bookings', context: { model: 'opus', evil: 'x' },
  });
  assert.equal(ok?.comment, 'Brunch figure is the whole day');
  assert.equal(ok?.conversation_id, '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  assert.deepEqual(ok?.context, { model: 'opus' });
  assert.equal(cleanReportInput({ kind: 'nonsense', page: 'chat' }), null);
  assert.equal(cleanReportInput({ kind: 'wrong', page: 'admin' }), null);
  assert.equal(cleanReportInput({ kind: 'error', page: 'plan', conversation_id: "x'; drop" })?.conversation_id, null);
  assert.equal(cleanReportInput({ kind: 'other', page: 'chat', comment: 'x'.repeat(5000) })?.comment?.length, 4000);
});

test('the copied report carries the conversation and every tool\'s input and result', () => {
  const r: StoredReport = {
    id: 'r1', created_at: '2026-10-13T10:00:00Z', reporter_name: 'Josh Wilson', reporter_email: 'josh@staydandy.com',
    kind: 'wrong', page: 'chat', comment: 'Brunch was 55', question: 'Brunch bookings 10 Oct?', answer: '41 bookings',
    error: null, status: 'new', admin_notes: null, context: { model: 'claude-opus-5' },
    transcript: [
      { role: 'user', content: 'Brunch bookings 10 Oct?' },
      { role: 'assistant', content: '41 bookings', tool_trace: [
        { name: 'query_booking_lead_time', input: { venue_slug: 'super-firangi', business_date: '2026-10-10' }, result: '{"bookings":41}', ms: 812 },
      ], run: { purpose: 'chat', rounds: 2, ms: 41200, out_of_time: false, rescued: null, calls: [
        { model: 'claude-opus-5', effort: 'high', stop_reason: 'tool_use', input_tokens: 12000, output_tokens: 800, cache_read: 9000, ms: 9100 },
      ] } },
    ],
  };
  const md = reportMarkdown(r);
  assert.match(md, /Reported by:\*\* Josh Wilson <josh@staydandy.com>/);
  assert.match(md, new RegExp(KIND_LABELS.wrong));
  assert.match(md, /Tool `query_booking_lead_time` \(812 ms\)/);
  assert.match(md, /"business_date":"2026-10-10"/);
  assert.match(md, /\{"bookings":41\}/);
  assert.match(md, /## What they said\n\nBrunch was 55/);
  assert.match(md, /How it ran: 2 tool round\(s\), 41\.2s, purpose chat/);
  assert.match(md, /call: claude-opus-5 \(high\), stop tool_use, in 12000 \/ out 800 tokens, cache read 9000, 9100 ms/);
});
