-- Allow hourly_sales as a report_type in ingestion_log
alter table public.ingestion_log drop constraint ingestion_log_report_type_check;
alter table public.ingestion_log add constraint ingestion_log_report_type_check
  check (report_type in ('product_mix', 'operations', 'hourly_sales'));
