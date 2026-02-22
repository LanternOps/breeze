BEGIN;

-- ============================================================
-- RLS for device_ip_history (has org_id)
-- ============================================================
ALTER TABLE device_ip_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_ip_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_ip_history;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_ip_history;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_ip_history;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_ip_history;

CREATE POLICY breeze_org_isolation_select ON device_ip_history
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_ip_history
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_ip_history
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_ip_history
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS for network_known_guests (partner-scoped, uses partner_id)
-- ============================================================
ALTER TABLE network_known_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_known_guests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON network_known_guests;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON network_known_guests;

CREATE POLICY breeze_partner_isolation_select ON network_known_guests
  FOR SELECT USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.partner_id = network_known_guests.partner_id
               AND public.breeze_has_org_access(o.id))
  );
CREATE POLICY breeze_partner_isolation_insert ON network_known_guests
  FOR INSERT WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.partner_id = network_known_guests.partner_id
               AND public.breeze_has_org_access(o.id))
  );
CREATE POLICY breeze_partner_isolation_update ON network_known_guests
  FOR UPDATE USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.partner_id = network_known_guests.partner_id
               AND public.breeze_has_org_access(o.id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.partner_id = network_known_guests.partner_id
               AND public.breeze_has_org_access(o.id))
  );
CREATE POLICY breeze_partner_isolation_delete ON network_known_guests
  FOR DELETE USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (SELECT 1 FROM organizations o
               WHERE o.partner_id = network_known_guests.partner_id
               AND public.breeze_has_org_access(o.id))
  );

COMMIT;
