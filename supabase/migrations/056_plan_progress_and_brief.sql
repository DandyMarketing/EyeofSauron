-- 056: the progress board is saved with its plan, and an event keeps its brief.
--
-- Khai, 13 Oct 2026, after a refresh brought back an item he had already dealt
-- with: "it's not storing". The board's reading lived only in the open page, so
-- every refresh re-read the whole plan from nothing and could decide something
-- differently. It is now saved on the conversation, and a reopened plan --
-- on any device -- starts from its last reading.
--
-- conversations.progress holds the board's last reading of that plan, plus the
-- decisions the PERSON marked as decided by hand ("manual"). A hand mark beats
-- the model's reading and only the person can undo it. Null until the first
-- reading; nothing else reads it.
--
-- events.brief and events.pnl: pressing "Create this event" stored the event's
-- fields and tasks, but not the brief's text or the P&L lines, so after a
-- refresh the brief existed nowhere. Stored as the person confirmed them.
-- Nullable: events created before this have neither.
--
-- Additive only. Nothing is dropped, renamed or rewritten.

alter table public.conversations
  add column if not exists progress jsonb;

alter table public.events
  add column if not exists brief text;

alter table public.events
  add column if not exists pnl jsonb;

-- Check after running:
--   select column_name, data_type from information_schema.columns
--   where (table_name = 'conversations' and column_name = 'progress')
--      or (table_name = 'events' and column_name in ('brief', 'pnl'));
-- Expect three rows: progress jsonb, brief text, pnl jsonb.
