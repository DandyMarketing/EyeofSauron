-- Overtime hours, so the rate we are charged can be CHECKED rather than trusted.
--
-- Two things prompted this on 7 Sep 2026, and they are the same fault.
--
-- FIRST, THE BUG. The first real ingest wrote 46,318.00 of labour cost against
-- 0.0 hours and reported success. `actualCosts` was known to be an object --
-- { basicCost, eventCost, weekendCost, overtimeCost } -- and `actualHours` was
-- assumed to be a plain number, because it is singular and hours are a number.
-- It is the same object shape. Every hours field failed to parse silently, and
-- a zero denominator is worse than a missing one: sales per labour hour would
-- have divided by it and reported nothing wrong.
--
-- SECOND, THE QUESTION IT ANSWERS. Overtime here is understood to be paid at a
-- flat part-time rate rather than a multiple of the person's own hourly, and
-- nothing in this system could confirm that. Storing overtime COST alone leaves
-- a number no query can verify. With the hours beside it, the implied rate is a
-- division, reported on every run as ONE blended figure across everybody --
-- never per person, because a person's rate is their pay, while an average over
-- dozens is a business parameter.
--
-- WHY THAT MATTERS BEYOND VALIDATION. If overtime really is a flat rate below a
-- full-timer's loaded hourly, then an overtime hour is CHEAPER than a basic
-- one, and the universal F&B instinct to cut overtime is backwards here. The
-- recommendation engine must be able to see the rate before it gives advice
-- that would replace cheap hours with expensive ones.

alter table public.labour_daily
  add column if not exists overtime_hours numeric(10,2) not null default 0;

comment on column public.labour_daily.overtime_hours is
  'Overtime hours, stored so overtime_cost / overtime_hours gives an implied '
  'rate that can be checked. A drift in it means the rate changed or the mix of '
  'who works overtime did, and both are worth a question that week.';
