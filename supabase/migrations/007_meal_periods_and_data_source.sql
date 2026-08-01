-- ============================================================
-- Migration 007: Add meal_periods JSONB + data_source to daily_operations
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add meal_periods column
-- Stores per-period breakdown from Monday.com manual entry:
-- {
--   "brunch": { food_sales, bev_sales, service_charge, covers, discounts,
--               reservations, cancellations, reductions, walk_ins },
--   "lunch":  { ... },
--   "dinner": { ... }
-- }
-- Only periods with actual data are present.

ALTER TABLE public.daily_operations
  ADD COLUMN IF NOT EXISTS meal_periods jsonb;

-- 2. Add data_source column
-- Tracks origin of the top-level financial fields for reconciliation:
--   'revel'  = automated Revel CSV (authoritative for daily totals)
--   'monday' = derived from Monday.com meal periods (historical)
--   'both'   = Revel totals + Monday meal periods (overlap window)

ALTER TABLE public.daily_operations
  ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'revel';

ALTER TABLE public.daily_operations
  ADD CONSTRAINT daily_operations_data_source_check
  CHECK (data_source IN ('revel', 'monday', 'both'));

-- 3. Relax NOT NULL on gross_sales/net_sales for Monday-sourced rows
-- Monday data may have days where only some periods have data,
-- and the derived totals are best-effort. Allow nulls so partial
-- data can still be stored.

ALTER TABLE public.daily_operations
  ALTER COLUMN gross_sales DROP NOT NULL;

ALTER TABLE public.daily_operations
  ALTER COLUMN net_sales DROP NOT NULL;
