-- ============================================================
-- Phase 0, Step 1: Backbone schema + Row-Level Security
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. VENUES
-- Each physical restaurant/bar in The Dandy Collection.
-- `company_id` is nullable now — we'll backfill it when multi-tenant ships (Phase 4).
create table public.venues (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  slug        text not null unique,  -- url-friendly key, e.g. 'neon-pigeon'
  company_id  uuid,                  -- future: FK to companies table
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. PROFILES
-- One row per user, linked 1:1 to Supabase auth.users.
-- Supabase Auth creates auth.users automatically on signup;
-- this public.profiles table holds app-level data.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 3. USER_VENUE_ROLES
-- The access-control junction table. A user can have different roles
-- at different venues. This powers ALL access decisions.
--
-- Roles:
--   'owner'   — sees everything across all venues (HQ)
--   'finance' — sees financials + aggregate labour cost
--   'manager' — sees own venue's ops data, labour %, but NOT individual pay
--   'staff'   — future: limited view
create table public.user_venue_roles (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles(id) on delete cascade,
  venue_id  uuid not null references public.venues(id) on delete cascade,
  role      text not null check (role in ('owner', 'finance', 'manager', 'staff')),
  unique(user_id, venue_id)
);

-- 4. REVEL_VENUE_KEYS
-- Maps the opaque venue key in Revel filenames to our venue_id.
-- e.g. 'neonpigeon_neonpigeon' → venue_id for Neon Pigeon.
-- Unknown keys must be flagged, never guessed.
create table public.revel_venue_keys (
  id          uuid primary key default gen_random_uuid(),
  report_key  text not null unique,  -- the key from the filename
  venue_id    uuid not null references public.venues(id) on delete cascade
);

-- 5. PRODUCT_MIX
-- One row per product per venue per business day.
-- Source: Revel POS nightly reports.
create table public.product_mix (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references public.venues(id) on delete cascade,
  business_date  date not null,
  row_type       text not null check (row_type in ('Product', 'Modifier')),
  class          text,          -- 'Food', 'Beverage', etc.
  name           text not null,
  sku            text,
  barcode        text,
  category       text,
  subcategory    text,
  qty            numeric not null default 0,
  sales          numeric not null default 0,  -- taxable + non-taxable combined
  pct_total      numeric,                      -- % of total sales for the day
  cogs           numeric not null default 0,   -- arrives as 0 from Revel; Zeemart fills later
  created_at     timestamptz not null default now(),
  unique(venue_id, business_date, name, row_type)
);

-- Index for the most common query pattern: "show me venue X on date Y"
create index idx_product_mix_venue_date on public.product_mix(venue_id, business_date);


-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================

-- Enable RLS on every table
alter table public.venues enable row level security;
alter table public.profiles enable row level security;
alter table public.user_venue_roles enable row level security;
alter table public.revel_venue_keys enable row level security;
alter table public.product_mix enable row level security;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- PROFILES: users can read/update only their own profile
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
create policy "Users can view own profile"
  on public.profiles for select
  using (id = auth.uid());

create policy "Users can update own profile"
  on public.profiles for update
  using (id = auth.uid());

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- VENUES: users can see only venues they have a role at.
-- Owners (role = 'owner') can see ALL venues.
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
create policy "Users can view their venues"
  on public.venues for select
  using (
    id in (
      select venue_id from public.user_venue_roles
      where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- USER_VENUE_ROLES: users can see their own role assignments.
-- Owners can see all assignments (needed for admin views).
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
create policy "Users can view own roles"
  on public.user_venue_roles for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- REVEL_VENUE_KEYS: read-only, same venue-scoped access.
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
create policy "Users can view revel keys for their venues"
  on public.revel_venue_keys for select
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

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- PRODUCT_MIX: users see only their venue's product data.
-- Owners see all venues.
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
create policy "Users can view product mix for their venues"
  on public.product_mix for select
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

-- ============================================================
-- SERVICE ROLE BYPASS
-- The service_role key (used by backend/n8n for ingestion)
-- bypasses RLS by default in Supabase — no extra policy needed.
-- This is correct: the backend inserts data for any venue,
-- while end-user queries go through the anon/authenticated
-- key which enforces RLS.
-- ============================================================

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- When a user signs up via Supabase Auth, automatically
-- create a matching row in public.profiles.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
