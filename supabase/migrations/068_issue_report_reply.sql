-- ============================================================
-- issue_reports: tell the reporter when their report is resolved.
-- Run this in Supabase SQL Editor AFTER 067_venue_closures.sql
--
-- Khai, 13 Nov 2026: "send a update status about the error reported so they
-- know it has been corrected and can re-test it". Until now the reporter got a
-- thank-you and never heard again (061).
--
-- reporter_reply     what the admin writes FOR the reporter. Separate from
--                    admin_notes, which stay private (Khai's choice).
-- reporter_seen_at   when the reporter dismissed the notice. Cleared whenever
--                    the report is resolved again, so a second fix is told too.
--
-- The notice shows in Query and Plan for a report that is fixed or will not
-- be fixed, belongs to the person signed in, and is not yet seen.
-- Server only, as before: RLS on, no policies.
-- ============================================================

alter table public.issue_reports
  add column if not exists reporter_reply text check (reporter_reply is null or length(reporter_reply) <= 2000),
  add column if not exists reporter_seen_at timestamptz;

create index if not exists issue_reports_user_unseen_idx
  on public.issue_reports (user_id)
  where reporter_seen_at is null and status in ('fixed', 'wont_fix');
