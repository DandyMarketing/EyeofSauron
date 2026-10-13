-- 057: spaces an event uses that are not our venues.
--
-- Khai, 13 Oct 2026, on the New Year's Eve plan: the Barter rooftop is rented
-- for the night, so it is not one of our venues -- it has no sales, bookings,
-- costs, staff access or Monday board in Sauron, and event_venues cannot hold
-- it. Creating the event failed on it outright. It belongs to the event all the
-- same, so it is recorded here, as the person confirmed it in the brief:
--
--   [{ "name": "Barter rooftop", "access": "rented", "cost": 1800,
--      "capacity": 100, "use": "boiler room after midnight",
--      "owner_name": "...", "risks": "their licence, their door" }]
--
-- access is rented | partner | public. Kept so next year's planner finds
-- "Barter rooftop, rented, $1,800, held 100" instead of starting from nothing.
--
-- Additive only. Nullable: earlier events have none.

alter table public.events
  add column if not exists other_spaces jsonb;

-- Check after running:
--   select column_name, data_type from information_schema.columns
--   where table_name = 'events' and column_name = 'other_spaces';
-- Expect one row: other_spaces jsonb.
