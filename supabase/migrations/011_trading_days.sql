-- Trading days per venue.
--
-- Revel delivers a report for a day a venue was shut. Sometimes every figure
-- is zero (handled by isClosedDay() in the analysis layer, BUILD_LOG 3.2);
-- sometimes the file has no rows at all, which the parsers reject as a failed
-- extraction. That rejection is correct in general -- an empty file and a
-- truncated download look identical -- but Firangi Superstar is shut on
-- Sundays, so it fires every week and the watchdog has been red ever since.
--
-- Knowing which days a venue trades is the missing input. It is per-customer
-- onboarding data and must never be hardcoded: every operator's opening hours
-- differ and change over time.
--
-- 0 = Monday ... 6 = Sunday, matching DOW_LABELS in src/ai/charts.ts.
alter table public.venues
  add column if not exists closed_weekdays smallint[] not null default '{}';

comment on column public.venues.closed_weekdays is
  'Weekdays this venue is normally shut (0=Mon..6=Sun). An empty report on one '
  'of these days is logged as a closure, not an error. A day listed here that '
  'does trade still ingests normally -- this only changes how an EMPTY file is '
  'read, never how data is handled.';

-- Deliberately not seeded. BUILD_LOG 2.2: a mapping is confirmed against the
-- customer's own data and a human, never inferred. Set it per venue, e.g.
--   update public.venues set closed_weekdays = '{6}' where slug = 'super-firangi';
