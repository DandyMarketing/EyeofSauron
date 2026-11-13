-- ============================================================
-- conversation_files: documents uploaded to Query or Plan, as TEXT, for 30 days.
-- Run this in Supabase SQL Editor AFTER 068_issue_report_reply.sql
--
-- Khai, 13 Nov 2026: "give sauron the ability to upload excels, pdf, docx ...
-- because they sometimes may have a file they want to upload to compare".
-- Decided with Khai:
--   * the TEXT read from the file is kept with the conversation, so follow-up
--     questions and a reopened chat still see it; the file itself is never
--     stored -- it is read and discarded;
--   * kept 30 days, then deleted (expires_at); the person can remove it sooner;
--   * PDF, Excel/CSV and Word, in Query and Plan.
--
-- Uploaded files can hold personal data (staff lists, guest lists, pay), which
-- the warehouse otherwise never stores. So: one person's files are only ever
-- read for that person (user_id is the control on every read), nothing here is
-- sent over WhatsApp or Telegram, and the expiry is enforced on READ as well as
-- by deletion -- an expired row is never used even if the purge has not run.
--
-- conversation_id is empty between upload and the first question it is asked
-- with; the server attaches it once that conversation is saved.
--
-- Server only: RLS on, no policies.
-- ============================================================

create table if not exists public.conversation_files (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete cascade,
  filename         text not null check (length(filename) between 1 and 200),
  kind             text not null check (kind in ('pdf', 'spreadsheet', 'docx')),
  size_bytes       integer not null check (size_bytes >= 0),
  summary          text not null,
  content          text not null,
  truncated        boolean not null default false,
  notes            jsonb not null default '[]'::jsonb,
  read_by          text not null default 'text' check (read_by in ('text', 'vision')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '30 days')
);

create index if not exists conversation_files_conversation_idx on public.conversation_files (conversation_id);
create index if not exists conversation_files_user_idx on public.conversation_files (user_id, created_at desc);
create index if not exists conversation_files_expiry_idx on public.conversation_files (expires_at);

alter table public.conversation_files enable row level security;

comment on table public.conversation_files is
  'Text extracted from documents uploaded to Query/Plan (never the file). '
  'Owner-only, deleted after 30 days and ignored once expired. 069.';
