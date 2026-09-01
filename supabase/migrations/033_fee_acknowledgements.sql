-- "We looked at this month and it is not an error."
--
-- feeAnomalies() found Neon Pigeon's June 2026 fee at 1.99% of income against a
-- 2.55% median and put it on the face of the briefing. That was the check
-- working: nobody had noticed, somebody asked, and Finance came back with an
-- answer -- the lower rate was a decision by the founder, not a coding error.
--
-- And then the check has no way to be told. It would flag June 2026 again every
-- Monday for the rest of the year, which is worse than not having it: by the
-- time it catches a real mis-charge in November that line will have appeared
-- fourteen times and nobody will read the fifteenth. A monitor that cries wolf
-- weekly has already failed.
--
-- PER MONTH, NEVER PER VENUE. Acknowledging the venue would silence June 2027
-- as well -- the same mistake with a longer fuse, and invisible when it bites.
-- A decision about one month is recorded against that month.
--
-- THE REASON IS REQUIRED, and it is not paperwork. The briefing says WHY the
-- month is outside its range rather than going quiet, because a check that
-- falls silent is indistinguishable from one that stopped working -- the
-- failure this codebase keeps finding. An explained anomaly stays visible and
-- carries its explanation; only its status as a finding changes.
--
-- account_name NULL acknowledges every fee that month, which is what a decision
-- affecting the whole charge looks like. Naming one acknowledges only that fee,
-- so the other half of a matched pair still reports -- and a pair MISMATCH can
-- only ever be explained by a whole-month acknowledgement, since naming one
-- account cannot account for the two disagreeing.

create table if not exists public.fee_acknowledgements (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references public.venues(id) on delete cascade,
  period_start   date not null,
  -- NULL means every fee in that month.
  account_name   text,
  reason         text not null check (length(trim(reason)) > 0),
  acknowledged_by uuid references auth.users(id),
  created_at     timestamptz not null default now(),

  -- One acknowledgement per venue-month-account. Re-recording a decision
  -- updates the reason rather than stacking a second explanation nobody reads.
  unique (venue_id, period_start, account_name)
);

comment on table public.fee_acknowledgements is
  'Months where a group fee is outside its usual range for a known reason. Scoped to ONE month deliberately — acknowledging a venue would silence the same month next year. The briefing still shows the month and states the reason; it just stops calling it a finding.';

create index if not exists fee_ack_venue_period_idx
  on public.fee_acknowledgements (venue_id, period_start);

alter table public.fee_acknowledgements enable row level security;

-- Read follows the same rule as everything else: your venues, or all of them
-- if you are an owner. Writing is owner-only — this silences a control, and
-- who silenced it and why is the whole point of the row.
create policy fee_ack_read on public.fee_acknowledgements
  for select using (
    exists (
      select 1 from public.user_venue_roles r
      where r.user_id = auth.uid()
        and (r.venue_id = fee_acknowledgements.venue_id or r.role = 'owner')
    )
  );

create policy fee_ack_write on public.fee_acknowledgements
  for all using (
    exists (
      select 1 from public.user_venue_roles r
      where r.user_id = auth.uid() and r.role = 'owner'
    )
  );
