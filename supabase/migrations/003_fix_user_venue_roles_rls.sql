-- Fix: user_venue_roles RLS policy was self-referencing (owner check
-- queried user_venue_roles inside its own policy), causing infinite
-- recursion when any other table's policy looked up user_venue_roles.
-- Fix: users simply see their own rows; other tables query this table
-- for the owner role check, which works since users can read their own rows.

DROP POLICY IF EXISTS "Users can view own roles" ON public.user_venue_roles;

CREATE POLICY "Users can view own roles"
  ON public.user_venue_roles FOR SELECT
  USING (user_id = auth.uid());
