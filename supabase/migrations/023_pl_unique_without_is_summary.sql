-- Take is_summary out of the profit_and_loss unique key.
--
-- WHY. Migration 013 keyed the table on
--   (venue_id, period_start, period_end, section, account_name, is_summary)
-- which makes the FLAG part of a row's identity. It is not: whether a line is
-- a section total is a property OF the line, not a different line.
--
-- The consequence was found on 23 Aug 2026. The parser was corrected to mark
-- Gross Profit, Operating Profit and Net Profit as totals rather than detail
-- lines, every period was re-ingested, and the upsert -- seeing a different
-- is_summary -- INSERTED rather than updated. Every one of those lines then
-- existed twice: 213 duplicate rows across three venues and two years, one
-- copy correctly flagged and one still claiming to be a detail line.
--
-- That is worse than the original bug it was fixing. query_profit_and_loss
-- tells the model to use is_summary instead of adding everything up, so a
-- "what were our total costs" question would sweep three computed totals into
-- the cost base -- and the duplicate is invisible, because both rows are real
-- and carry the same amount.
--
-- The general lesson, worth stating because it will come up again: a column
-- that a bug fix might CHANGE must never be part of the key. Otherwise
-- correcting it silently forks the row instead of repairing it.
--
-- RUN THE DELETE FIRST. This constraint cannot be created while duplicates
-- exist:
--
--   delete from public.profit_and_loss p
--   where p.is_summary = false
--     and exists (
--       select 1 from public.profit_and_loss q
--       where q.venue_id = p.venue_id
--         and q.period_start = p.period_start
--         and q.period_end = p.period_end
--         and q.section = p.section
--         and q.account_name = p.account_name
--         and q.is_summary = true
--     );

-- The 013 constraint was unnamed, so Postgres generated one. Find it by its
-- definition rather than guessing at a truncated auto-generated name.
do $$
declare
  target text;
begin
  select conname into target
  from pg_constraint
  where conrelid = 'public.profit_and_loss'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) like '%is_summary%';

  if target is not null then
    execute format('alter table public.profit_and_loss drop constraint %I', target);
  end if;
end $$;

-- One row per account, per section, per period, per venue. The flag rides
-- along and can now be corrected in place.
alter table public.profit_and_loss
  add constraint profit_and_loss_period_account_key
  unique (venue_id, period_start, period_end, section, account_name);

comment on constraint profit_and_loss_period_account_key on public.profit_and_loss is
  'is_summary is deliberately NOT in this key. It is a property of the row, and a parser fix that changes it must update the row rather than fork it — see 023.';
