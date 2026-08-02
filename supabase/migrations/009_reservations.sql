-- ============================================================
-- SevenRooms reservations
-- Run this in Supabase SQL Editor AFTER 008_locked_at.sql
--
-- SCOPE DECISION: this table holds NO personal data.
-- SevenRooms returns first_name, last_name, email, phone_number,
-- notes, tags and reference codes on every reservation. None of
-- those are ingested here. Guest CRM lands later in its own
-- separately-secured table, once the privacy-notice and retention
-- questions are settled.
--
-- The one identity column we DO keep is sevenrooms_client_id: an
-- opaque SevenRooms key. It carries no personal detail on its own
-- but lets us count repeat guests, and lets a future guests table
-- join on without a backfill.
-- ============================================================

create table if not exists public.reservations (
  id                     uuid primary key default gen_random_uuid(),
  venue_id               uuid not null references public.venues(id) on delete cascade,
  business_date          date not null,

  -- SevenRooms identifiers
  sevenrooms_id          text not null unique,
  sevenrooms_client_id   text,            -- opaque guest key, not personal data

  -- Meal period. SevenRooms' own label: BRUNCH / LUNCH / DINNER.
  -- This is the authoritative meal split -- Revel cannot provide it,
  -- and it is what Monday.com is transcribed from by hand.
  shift_category         text,

  -- Booking lifecycle
  status                 text,            -- COMPLETE / CANCELED / NO_SHOW / ...
  status_simple          text,            -- Complete / Canceled / No Show
  booked_by              text,            -- 'Walk In', 'Google Reserve Integration', staff name
  is_walk_in             boolean not null default false,
  is_vip                 boolean not null default false,

  party_size             integer not null default 0,

  -- TIMEZONE WARNING: SevenRooms mixes zones within one record.
  --   arrival_time / slot_local  -> venue-local (SGT), stored naive
  --   seated_at / left_at        -> UTC, stored as timestamptz
  -- Getting this wrong puts every table-turn metric 8 hours out.
  arrival_time           text,            -- local 'HH:MM' as given
  slot_local             timestamp,        -- local slot datetime, no tz
  seated_at              timestamptz,      -- UTC
  left_at                timestamptz,      -- UTC
  duration_min           integer,

  table_numbers          text[],

  -- Join key back to Revel: this is the POS check number.
  pos_ticket_id          text,

  payment_net            numeric,
  payment_gross          numeric,
  payment_tax            numeric,

  source_created_at      timestamptz,
  source_updated_at      timestamptz,
  ingested_at            timestamptz not null default now()
);

create index if not exists idx_reservations_venue_date
  on public.reservations(venue_id, business_date);

create index if not exists idx_reservations_shift
  on public.reservations(venue_id, business_date, shift_category);

-- Supports the future SevenRooms -> Revel ticket join
create index if not exists idx_reservations_pos_ticket
  on public.reservations(pos_ticket_id) where pos_ticket_id is not null;

create index if not exists idx_reservations_client
  on public.reservations(sevenrooms_client_id) where sevenrooms_client_id is not null;


-- ────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY
-- Same venue-scoped pattern as daily_operations and product_mix:
-- users see their own venues, owners see everything.
-- ────────────────────────────────────────────────────────────

alter table public.reservations enable row level security;

create policy "Users can view reservations for their venues"
  on public.reservations for select
  using (
    venue_id in (
      select venue_id from public.user_venue_roles
      where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );


-- ────────────────────────────────────────────────────────────
-- Allow ingestion runs to be logged against this source
-- ────────────────────────────────────────────────────────────

alter table public.ingestion_log drop constraint if exists ingestion_log_report_type_check;
alter table public.ingestion_log add constraint ingestion_log_report_type_check
  check (report_type in (
    'product_mix', 'operations', 'hourly_sales', 'monday_meals', 'sevenrooms'
  ));
