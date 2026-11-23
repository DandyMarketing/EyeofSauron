-- 071: an event keeps its key visual brief.
--
-- Khai, 23 Nov 2026: the plan now writes a creative brief for the graphic
-- designer's key visual, beside the event brief and the P&L. Pressing "Create
-- this event" stores it with the event, as migration 056 does for the brief,
-- so it exists after a refresh. Markdown: the same text the page shows, the
-- Word file is made from and Monday carries.
--
-- Nullable: events created before this, or from a draft with no KV brief,
-- have none. Additive only. Until this runs, Create still works and logs
-- "KV brief not stored".

alter table public.events
  add column if not exists kv_brief text;

-- Check after running:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'events' and column_name = 'kv_brief';
