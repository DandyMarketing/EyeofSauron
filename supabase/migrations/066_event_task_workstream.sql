-- ============================================================
-- event_tasks.workstream: the parent a task goes under on Monday.
-- Run this in Supabase SQL Editor AFTER 065_ai_usage.sql
--
-- Khai, 22 Oct 2026: Send to Monday "starts from nothing and the brief
-- completion dictates what is to be done, so each event has a different look".
-- The board's Event Template no longer goes; each event's items are its own
-- WORKSTREAMS -- "Venue & build", "Ticketing", "Entertainment" -- with the
-- tasks as sub-items beneath them.
--
-- SAVED, like the short name in `title` (060), for the same reason: Sauron
-- recognises a sub-item already on the board by its name AND its parent, so a
-- workstream written afresh on every preview would make each re-send add the
-- tasks again under a slightly different heading. Written once by the naming
-- pass, changed only when a person moves the task on the preview.
--
-- Nullable: a task with none goes under a parent chosen by its kind.
-- ============================================================

alter table public.event_tasks add column if not exists workstream text;

comment on column public.event_tasks.workstream is
  'The workstream this task goes under on Monday, named for this event (066). '
  'Saved once so re-sends find the same parent; NULL falls back to the task kind.';
