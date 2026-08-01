-- ============================================================
-- Migration 008: Add reconciliation lock + audit to daily_operations
-- Once Revel + Monday meal period data reconciles (exact match),
-- the row is frozen. Subsequent Monday updates are rejected and
-- logged to the reconciliation_alerts table.
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Lock fields on daily_operations
ALTER TABLE public.daily_operations
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS meal_periods_hash text;

-- 2. Reconciliation alerts table — audit trail for post-lock changes
CREATE TABLE IF NOT EXISTS public.reconciliation_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid NOT NULL REFERENCES public.venues(id),
  business_date   date NOT NULL,
  alert_type      text NOT NULL CHECK (alert_type IN (
    'mismatch',
    'post_lock_change',
    'reconciliation_failed'
  )),
  monday_gross    numeric,
  revel_gross     numeric,
  difference      numeric,
  old_hash        text,
  new_hash        text,
  old_meal_periods jsonb,
  new_meal_periods jsonb,
  resolved        boolean NOT NULL DEFAULT false,
  resolved_by     uuid REFERENCES auth.users(id),
  resolved_at     timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recon_alerts_venue_date
  ON public.reconciliation_alerts(venue_id, business_date);
CREATE INDEX idx_recon_alerts_unresolved
  ON public.reconciliation_alerts(resolved) WHERE NOT resolved;

-- 3. Update ingestion_log to allow monday_meals report type
ALTER TABLE public.ingestion_log DROP CONSTRAINT ingestion_log_report_type_check;
ALTER TABLE public.ingestion_log ADD CONSTRAINT ingestion_log_report_type_check
  CHECK (report_type IN ('product_mix', 'operations', 'hourly_sales', 'monday_meals'));
