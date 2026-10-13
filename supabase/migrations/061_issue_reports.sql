-- "Report this issue": a button under every answer that sends the whole
-- conversation to the admins.
--
-- WHY. 13 Oct 2026, Khai, with Sauron now in daily use by the team: "make a
-- button report this issue, then it sends it to the admins -- an error, or
-- something it cannot answer, or it answers incorrectly. It will make a report
-- log including the entire chat, and allow me to review it with you to find
-- the problem and see if it is something we can fix."
--
-- Decided with Khai: admins hear about it through a badge on the admin
-- console; the person who reported it gets a thank-you and nothing more.
--
-- TWO PARTS.
--
-- 1. conversation_messages.tool_trace -- what each data tool was asked and
--    what it RETURNED (an excerpt), with how long it took, saved with every
--    answer from now on. A saved chat already kept the words and the charts,
--    but not this, and this is where a wrong answer usually comes from (the
--    10 Oct brunch read the whole day's bookings: visible only in the tool's
--    input). Owner-only to read, like the rest of the report.
--
-- 2. issue_reports -- one row per report, holding a SNAPSHOT of the
--    conversation as it stood when reported: the chat can be renamed,
--    continued or deleted afterwards and the report still shows what was seen.
--    The reporter's name and email are copied in for the same reason.
--
-- Row-level security is ON with no policies: only the server (service role)
-- reads or writes, and the endpoints are owner-only for reading. A report
-- carries figures from the reporter's own venues; nobody else's.

alter table public.conversation_messages add column if not exists tool_trace jsonb;

comment on column public.conversation_messages.tool_trace is
  'Per answer: each data tool called, its input, an excerpt of what it returned, '
  'and how long it took. For issue reports. Never sent to the browser.';

create table if not exists public.issue_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Who reported it. ON DELETE SET NULL: the report outlives the account,
  -- and the copied name and email still say who it was.
  user_id uuid references auth.users(id) on delete set null,
  reporter_email text,
  reporter_name text,

  -- What kind of problem, in the reporter's choice of words.
  kind text not null check (kind in ('wrong', 'cannot_answer', 'error', 'other')),
  comment text,

  -- Where: the chat or the event planner, and which conversation.
  page text not null check (page in ('chat', 'plan')),
  conversation_id uuid references public.conversations(id) on delete set null,

  -- The exchange reported, and the error text if the page showed one.
  question text,
  answer text,
  error text,

  -- The whole conversation as it stood, with each answer's tool trace.
  transcript jsonb not null default '[]'::jsonb,
  -- Browser, model chosen, app version: what helps reproduce it.
  context jsonb,

  -- The review, for admins only.
  status text not null default 'new' check (status in ('new', 'looking', 'fixed', 'wont_fix')),
  admin_notes text,
  resolved_at timestamptz
);

create index if not exists issue_reports_status_idx on public.issue_reports (status, created_at desc);

alter table public.issue_reports enable row level security;

comment on table public.issue_reports is
  'Reports from the "Report this issue" button: a snapshot of the conversation '
  'with its tool traces, the reporter''s note, and the admins'' review. Server '
  'only (RLS on, no policies); read through owner-only endpoints.';
