-- Correct network_known_guests to the flat partner tenancy axis.
--
-- The legacy policies inferred partner access by traversing organizations.
-- Besides being the wrong tenancy shape, that made access depend on whatever
-- organization rows were visible to the caller. Partner-owned state must use
-- the authoritative flat partner predicate directly.

ALTER TABLE network_known_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_known_guests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON network_known_guests;

CREATE POLICY breeze_partner_isolation_select ON network_known_guests
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));

CREATE POLICY breeze_partner_isolation_insert ON network_known_guests
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));

CREATE POLICY breeze_partner_isolation_update ON network_known_guests
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));

CREATE POLICY breeze_partner_isolation_delete ON network_known_guests
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
