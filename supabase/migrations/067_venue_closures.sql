-- ============================================================
-- venue_closures: days a venue was (or will be) shut that are NOT its regular
-- closed weekday. Run this in Supabase SQL Editor AFTER 066_event_task_workstream.sql
--
-- Khai, 10 Nov 2026. A Diwali-week comparison called Fat Prince "not
-- comparable": it had no sales and no completed bookings on Deepavali itself,
-- Mon 20 Oct 2025. Monday is not one of its closed weekdays, so nothing could
-- tell a holiday closure from a missing Revel file, and Sauron could only say
-- "not comparable" where it should have said "closed for Deepavali".
--
-- venues.closed_weekdays still holds the REGULAR pattern (Firangi's Sundays).
-- This holds the exceptions: a public holiday, a private event, a renovation.
-- One row per venue per date, with the reason a person gave, so the reason can
-- be said wherever the day appears: the tools, the dashboard, the daily report
-- and the ingest watchdog.
--
-- WHAT IT NEVER DOES: suppress data. A day listed here that turns out to have
-- traded ingests exactly as normal -- the listing only changes how an EMPTY
-- day is read, the same rule as closed_weekdays.
--
-- Written and read only by the server (service role). RLS on, no policy.
-- ============================================================

create table if not exists public.venue_closures (
  id          bigint generated always as identity primary key,
  venue_id    uuid not null references public.venues(id) on delete cascade,
  closed_on   date not null,
  reason      text not null check (length(trim(reason)) between 1 and 200),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (venue_id, closed_on)
);

create index if not exists venue_closures_date_idx on public.venue_closures (closed_on);

alter table public.venue_closures enable row level security;

comment on table public.venue_closures is
  'One-off closures beyond venues.closed_weekdays: date and the reason given. '
  'Changes how an EMPTY day reads (closure, not a gap); never suppresses data. 067.';
