-- ============================================================
-- Phase 0, Step 2: daily_operations table + product_mix updates
-- Run this in Supabase SQL Editor AFTER 001_backbone_schema.sql
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. UPDATE PRODUCT_MIX TABLE
-- Real Revel CSVs have columns not in the original schema:
--   - Weight (for weight-priced items)
--   - Non-Taxable Sales / Taxable Sales (split; we keep combined `sales` too)
--   - Parent Product (present in some venues, e.g. Super Firangi)
--
-- Also: drop the unique constraint. Modifier rows can share names
-- across different parent products (e.g. "Hold", "Fire Now").
-- Ingestion uses delete-then-insert per (venue_id, business_date).
-- ────────────────────────────────────────────────────────────

alter table public.product_mix
  drop constraint if exists product_mix_venue_id_business_date_name_row_type_key;

alter table public.product_mix
  add column if not exists weight numeric not null default 0,
  add column if not exists non_taxable_sales numeric not null default 0,
  add column if not exists taxable_sales numeric not null default 0,
  add column if not exists parent_product text;


-- ────────────────────────────────────────────────────────────
-- 2. DAILY_OPERATIONS TABLE
-- One row per venue per business day from the Revel Operations Report.
-- Flat columns for key metrics the AI can query directly;
-- JSONB columns for variable-structure breakdowns.
-- ────────────────────────────────────────────────────────────

create table public.daily_operations (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references public.venues(id) on delete cascade,
  business_date         date not null,

  -- Sales summary (from SALES BY CLASS > Total row)
  raw_qty               numeric,
  raw_sales             numeric,
  voids_qty             numeric,
  voids_amount          numeric,
  comps_qty             numeric,
  comps_amount          numeric,
  gross_sales           numeric not null,
  item_discounts        numeric not null default 0,
  order_discounts       numeric not null default 0,
  net_sales             numeric not null,

  -- Gross product sales breakdown
  taxed_gross_sales     numeric,
  untaxed_gross_sales   numeric,
  taxed_service_fee     numeric,
  untaxed_service_fee   numeric,

  -- Tax (Singapore GST 9%)
  tax_on_sales          numeric,
  tax_on_service_fee    numeric,
  tax_total             numeric,

  -- Tips
  tips_total            numeric not null default 0,

  -- Net to account for (total cash + card collected)
  net_to_account_for    numeric,

  -- Service performance
  total_transactions    numeric,
  avg_check             numeric,
  total_guests          numeric,
  avg_sale_per_guest    numeric,

  -- Detailed breakdowns (JSONB for variable-structure data)
  sales_by_class        jsonb,      -- [{class, rawQty, rawSales, grossSales, ...}]
  payments              jsonb,      -- [{type, qty, sales, tips, total, isSubType, ...}]
  discount_reasons      jsonb,      -- [{reason, qty, total}]
  void_comp_reasons     jsonb,      -- [{reason, type, qty, total}]

  created_at            timestamptz not null default now(),
  unique(venue_id, business_date)
);

create index idx_daily_operations_venue_date
  on public.daily_operations(venue_id, business_date);


-- ────────────────────────────────────────────────────────────
-- 3. ROW-LEVEL SECURITY for daily_operations
-- Same pattern as product_mix: venue-scoped, owners see all.
-- ────────────────────────────────────────────────────────────

alter table public.daily_operations enable row level security;

create policy "Users can view daily operations for their venues"
  on public.daily_operations for select
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
