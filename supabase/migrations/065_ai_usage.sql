-- ============================================================
-- ai_usage: who asked, what each call to the AI cost.
-- Run this in Supabase SQL Editor AFTER 064_returning_visit_depth.sql
--
-- Khai, 22 Oct 2026: "track the usage of each person and calculate the cost
-- based on the model and query they have asked and have that shown on the
-- admin page next to the user name".
--
-- ONE ROW PER CALL, written by the server where the call is made
-- (src/lib/ai-usage.ts): the engine's rounds, the planner's passes (brief,
-- P&L, progress board, Monday), conversation titles, and the scheduled jobs.
-- A call with nobody signed in -- the weekly recommendations, the post
-- classifier -- has no user and is reported as System, so people + System is
-- the whole Anthropic bill.
--
-- TOKENS ARE KEPT, NOT JUST THE COST. cost_usd is worked out at the time from
-- the list prices in src/lib/ai-pricing.ts; if a price changes, history can be
-- recalculated from the tokens. A model with no price there gets a NULL cost,
-- never zero, and the admin page counts those.
--
-- Read only by the server (service role). RLS is on with no policy, so no
-- browser can read anyone's usage directly.
-- ============================================================

create table if not exists public.ai_usage (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  -- ON DELETE SET NULL: a deleted user's spend is still spend, now System's.
  user_id       uuid references auth.users(id) on delete set null,
  feature       text not null check (feature in ('query', 'plan', 'system')),
  purpose       text not null,
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cache_read    integer not null default 0,
  cache_write   integer not null default 0,
  web_searches  integer not null default 0,
  cost_usd      numeric(12, 6),
  ms            integer,
  -- Groups the calls of ONE answer, so the page can count questions.
  run_id        uuid,
  -- Rows filled in from saved answers below, rather than recorded live.
  backfilled    boolean not null default false,
  source_message_id uuid unique
);

create index if not exists ai_usage_created_idx on public.ai_usage (created_at);
create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at);

alter table public.ai_usage enable row level security;

-- ------------------------------------------------------------
-- The month's totals, grouped. One row per person x feature x model -- a few
-- dozen at most -- so the admin page never pages through every call.
-- ------------------------------------------------------------
create or replace function public.ai_usage_summary(p_from timestamptz, p_to timestamptz)
returns table (
  user_id       uuid,
  feature       text,
  model         text,
  calls         bigint,
  answers       bigint,
  input_tokens  bigint,
  output_tokens bigint,
  cache_read    bigint,
  cache_write   bigint,
  web_searches  bigint,
  cost_usd      numeric,
  unpriced      bigint
)
language sql
stable
as $$
  select
    u.user_id, u.feature, u.model,
    count(*)                                   as calls,
    count(distinct u.run_id)                   as answers,
    sum(u.input_tokens)::bigint,
    sum(u.output_tokens)::bigint,
    sum(u.cache_read)::bigint,
    sum(u.cache_write)::bigint,
    sum(u.web_searches)::bigint,
    coalesce(sum(u.cost_usd), 0)               as cost_usd,
    count(*) filter (where u.cost_usd is null) as unpriced
  from public.ai_usage u
  where u.created_at >= p_from and u.created_at < p_to
  group by u.user_id, u.feature, u.model;
$$;

-- ------------------------------------------------------------
-- BACKFILL from answers already saved. Since 13 Oct 2026 every saved Query and
-- Plan answer carries, in tool_trace.run.calls, the model and tokens of each
-- call it made. That is costed here with the same list prices.
--
-- What it CANNOT recover, and the page says so: the planner's separate passes
-- (brief, P&L, progress board, Monday) and titles were never recorded before
-- today, and an answer that errored was never saved.
--
-- Only messages from BEFORE live recording began, so a row is never counted
-- twice whichever order the SQL and the deploy happen in. Safe to run again:
-- source_message_id is unique and conflicts are skipped.
-- ------------------------------------------------------------
insert into public.ai_usage
  (created_at, user_id, feature, purpose, model, input_tokens, output_tokens,
   cache_read, cache_write, web_searches, cost_usd, ms, run_id, backfilled, source_message_id)
select
  m.created_at,
  c.user_id,
  case when c.kind = 'plan' then 'plan' else 'query' end,
  case when coalesce((call->>'rescue')::boolean, false) then 'recovery' else coalesce(m.tool_trace->'run'->>'purpose', 'chat') end,
  call->>'model',
  coalesce((call->>'input_tokens')::int, 0),
  coalesce((call->>'output_tokens')::int, 0),
  coalesce((call->>'cache_read')::int, 0),
  coalesce((call->>'cache_write')::int, 0),
  -- Searches are recorded per ANSWER, so they go on its first call only.
  case when ord = 1 then coalesce((m.tool_trace->'run'->>'web_searches')::int, 0) else 0 end,
  -- The same list prices as src/lib/ai-pricing.ts ($ per million tokens:
  -- input, output, cache read; cache write is 1.25x input). A test keeps
  -- these equal. Longest prefix first, so opus-5-5 is not priced as opus-5.
  round((
    coalesce((call->>'input_tokens')::numeric, 0)  * p.inp +
    coalesce((call->>'output_tokens')::numeric, 0) * p.outp +
    coalesce((call->>'cache_read')::numeric, 0)    * p.cread +
    coalesce((call->>'cache_write')::numeric, 0)   * p.inp * 1.25
  ) / 1000000
  + case when ord = 1 then coalesce((m.tool_trace->'run'->>'web_searches')::numeric, 0) * 0.01 else 0 end, 6),
  (call->>'ms')::int,
  m.id,
  true,
  -- One row per CALL, but the unique key is per message: the first call
  -- carries the message id, the rest are keyed by message id + position.
  case when ord = 1 then m.id else md5(m.id::text || ':' || ord)::uuid end
from public.conversation_messages m
join public.conversations c on c.id = m.conversation_id
cross join lateral jsonb_array_elements(m.tool_trace->'run'->'calls') with ordinality as t(call, ord)
cross join lateral (
  select
    case
      when call->>'model' like 'claude-opus-5-5%'   then 4    when call->>'model' like 'claude-opus-5%'   then 5
      when call->>'model' like 'claude-sonnet-5-5%' then 2    when call->>'model' like 'claude-sonnet-5%' then 2
      when call->>'model' like 'claude-haiku-5-5%'  then 0.10
      when call->>'model' like 'claude-fable-5-1%'  then 10   when call->>'model' like 'claude-fable-5%'  then 10
    end as inp,
    case
      when call->>'model' like 'claude-opus-5-5%'   then 20   when call->>'model' like 'claude-opus-5%'   then 25
      when call->>'model' like 'claude-sonnet-5-5%' then 10   when call->>'model' like 'claude-sonnet-5%' then 10
      when call->>'model' like 'claude-haiku-5-5%'  then 0.50
      when call->>'model' like 'claude-fable-5-1%'  then 50   when call->>'model' like 'claude-fable-5%'  then 50
    end as outp,
    case
      when call->>'model' like 'claude-opus-5-5%'   then 0.20 when call->>'model' like 'claude-opus-5%'   then 0.50
      when call->>'model' like 'claude-sonnet-5-5%' then 0.20 when call->>'model' like 'claude-sonnet-5%' then 0.20
      when call->>'model' like 'claude-haiku-5-5%'  then 0.01
      when call->>'model' like 'claude-fable-5-1%'  then 0.25 when call->>'model' like 'claude-fable-5%'  then 1.00
    end as cread
) p
where m.role = 'assistant'
  and m.tool_trace ? 'run'
  and jsonb_typeof(m.tool_trace->'run'->'calls') = 'array'
  and call->>'model' is not null
  and m.created_at < coalesce((select min(created_at) from public.ai_usage where not backfilled), now())
on conflict (source_message_id) do nothing;

comment on table public.ai_usage is
  'One row per call to the AI: who (NULL = System), what for, model, tokens, '
  'web searches and list-price cost in USD. Written by src/lib/ai-usage.ts; '
  'rows with backfilled = true were costed from saved answers (065).';
