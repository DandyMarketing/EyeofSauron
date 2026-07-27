-- ============================================================
-- Ingestion log + watchdog support
-- Tracks every file processed and enables gap detection
-- ============================================================

create table public.ingestion_log (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid references public.venues(id),
  venue_key       text,
  business_date   date,
  report_type     text not null check (report_type in ('product_mix', 'operations')),
  filename        text not null,
  status          text not null check (status in ('success', 'parse_error', 'validation_error', 'reconciliation_failed', 'ingestion_error', 'unknown_venue')),
  row_count       integer,
  error_message   text,
  created_at      timestamptz not null default now()
);

create index idx_ingestion_log_venue_date on public.ingestion_log(venue_id, business_date);
create index idx_ingestion_log_status on public.ingestion_log(status);
create index idx_ingestion_log_created on public.ingestion_log(created_at desc);
