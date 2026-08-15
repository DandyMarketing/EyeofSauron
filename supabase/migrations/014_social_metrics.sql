-- Social metrics, for marketing.
--
-- The point of this data in this warehouse is not a follower count. It is the
-- join: social activity next to covers and revenue on (venue_id,
-- business_date), so the question "did that campaign move the business" can be
-- answered from one place. Anything that does not carry a venue and a date
-- cannot answer it.

-- Which social account belongs to which venue.
--
-- Same shape and same reason as revel_venue_keys and xero_connections: an
-- account handle is not a venue name, and mapping it by eye is how BUILD_LOG
-- 2.2 happened. An unmapped account is flagged, never guessed.
create table if not exists public.social_accounts (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null check (platform in ('instagram', 'facebook', 'tiktok', 'google_business')),
  -- The platform's own stable id (IG user id, FB page id). Handles get
  -- renamed; ids do not.
  account_id    text not null,
  account_name  text,
  venue_id      uuid references public.venues(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (platform, account_id)
);

-- One row per account, per day, per metric.
--
-- Deliberately long-and-narrow rather than a column per metric. Meta renames
-- and retires metrics on its own schedule -- impressions became views -- and a
-- wide table needs a migration every time that happens, with old columns left
-- behind meaning something subtly different. A narrow table absorbs it, and
-- the metric name stays exactly what the platform called it so a figure can
-- always be traced back.
create table if not exists public.social_daily (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references public.venues(id) on delete cascade,
  platform      text not null,
  account_id    text not null,

  -- The day the metric DESCRIBES, in the venue's local terms -- not the
  -- timestamp the platform stamped on it. See normaliseInsights(): Meta
  -- reports a day's figure with an end_time at the START of the next day, and
  -- storing that verbatim shifts every metric forward by one day.
  business_date date not null,

  metric        text not null,
  value         numeric not null,

  fetched_at    timestamptz not null default now(),
  unique (platform, account_id, business_date, metric)
);

create index if not exists social_daily_venue_date_idx
  on public.social_daily (venue_id, business_date);

comment on table public.social_daily is
  'Daily social metrics keyed to the venue and the day they describe, so they '
  'join to daily_operations and reservations. Stories metrics expire from '
  'Meta after ~24 hours and cannot be backfilled -- a gap here is permanent.';

alter table public.social_accounts enable row level security;
alter table public.social_daily enable row level security;

-- Marketing needs sales across every venue, which the current owner/finance/
-- manager/staff role model cannot express -- see the role-model note in
-- CLAUDE.md. Until that is resolved, this policy is the same venue scoping as
-- every other table, and the real boundary remains enforceVenueScope() in
-- application code because the service-role key bypasses RLS entirely.
drop policy if exists "Users can view social data for their venues" on public.social_daily;
create policy "Users can view social data for their venues"
  on public.social_daily for select
  using (
    venue_id in (
      select venue_id from public.user_venue_roles where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );
