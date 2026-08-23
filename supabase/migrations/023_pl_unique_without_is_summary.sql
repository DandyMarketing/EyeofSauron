-- Key profit_and_loss on the LINE, not on how the parser happened to describe it.
--
-- Migration 013 keyed the table on
--   (venue_id, period_start, period_end, section, account_name, is_summary)
-- Two of those six columns are the parser's OPINION about a row rather than
-- part of its identity, and both were rewritten by a single bug fix.
--
-- WHAT HAPPENED, 23 Aug 2026. The parser was corrected so that Gross Profit,
-- Operating Profit and Net Profit are marked as computed totals rather than
-- detail lines, and so that an untitled section takes its name from its own
-- content instead of its position in the report. Every period was re-ingested.
-- Because both `is_summary` AND `section` had changed, the upsert matched
-- nothing and INSERTED: 213 duplicate rows across three venues and two years,
-- each line present once correctly flagged under its own name and once still
-- claiming to be a detail line under a positional label.
--
--   Gross Profit      stale: "Section 3"                  correct: "Gross Profit"
--   Net Profit        stale: "Section 9/11/12"            correct: "Net Profit"
--   Operating Profit  stale: "Section 9/10"               correct: "Operating Profit"
--
-- The positional names even drift month to month, because the report's shape
-- changes -- which is exactly why they were never identity in the first place.
--
-- Both copies were real, both carried the same amount, and nothing in an answer
-- would have hinted at it. query_profit_and_loss tells the model to trust
-- `is_summary` instead of adding everything up, so a "what were our total
-- costs" question would have swept three computed totals into the cost base.
--
-- THE RULE, worth stating because it will come up again: a column a bug fix
-- might CHANGE must never be part of a unique key. Otherwise the fix forks the
-- row instead of repairing it, and the wrong version survives alongside the
-- right one looking equally legitimate.
--
-- Verified before applying: no venue-period holds the same account_name twice,
-- so this key loses nothing.
--
-- RUN THE CLEANUP FIRST -- this constraint cannot be created while the
-- duplicates exist:
--
--   delete from public.profit_and_loss p
--   where p.is_summary = false
--     and p.section ~ '^Section [0-9]+$'
--     and exists (
--       select 1 from public.profit_and_loss q
--       where q.venue_id = p.venue_id
--         and q.period_start = p.period_start
--         and q.period_end = p.period_end
--         and q.account_name = p.account_name
--         and q.is_summary = true
--     );

-- The 013 constraint was unnamed, so Postgres generated one. Found by its
-- definition rather than by guessing at a truncated auto-generated name.
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

-- One row per account, per period, per venue. `section` and `is_summary` ride
-- along as attributes and can now be corrected in place.
alter table public.profit_and_loss
  add constraint profit_and_loss_period_account_key
  unique (venue_id, period_start, period_end, account_name);

comment on constraint profit_and_loss_period_account_key on public.profit_and_loss is
  'section and is_summary are deliberately NOT in this key. Both are the parser''s description of a row, not its identity, and a fix that changes either must update the row rather than fork it — see migration 023.';
