-- device_oem_policy_side (#11242, follow-up to #11065 W09): what a device's
-- vendor updates policy contributes to its display state, materialised per
-- device by the policy-side refresh (services/oemUpdates/policySideStore.ts: the
-- worker tick, a targeted job after a policy write, and the fleet request for a
-- bounded number of pending devices) so the fleet view can count and page in SQL.
--
-- The time-stable half only: the lane the hardware offers, the winning link,
-- its reboot mode, the current occurrence's last night and rollover instant,
-- and when the device came under the schedule. The time-dependent half (is the
-- last night over, has a reboot been held 72 h) is evaluated against `now` in
-- the query (services/oemUpdates/displayStateSql.ts), so a stored row stays
-- right between ticks until `refresh_after`.
--
-- Derived per-device state, not config, so `org_id NOT NULL` is the DEVICE's
-- org and the partner-wide-first shape does not apply. RLS shape 1.
--
-- Every row is a device the refresh has computed: `offered_lane` NULL means "no
-- lane", and a missing row means "not computed yet", which the route treats as
-- pending. `link_id` is a bare uuid: a derived pointer, recomputed on every
-- refresh, not a reference to keep alive.
--
-- No json/jsonb/bytea column: every column is included in
-- CORE_TENANT_EXPORT_POLICY (refresh_after as reviewed, for the name heuristic).
-- No rows are written here, so no system-scope
-- election is needed.

CREATE TABLE IF NOT EXISTS device_oem_policy_side (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  offered_lane varchar(16)
    CONSTRAINT device_oem_policy_side_lane_chk
    CHECK (offered_lane IS NULL OR offered_lane IN ('dell', 'surface', 'hp', 'lenovo')),
  -- oemGatesFingerprint() when the row was computed: a row whose fingerprint
  -- differs from the process's is pending (a kill switch flipped at deploy).
  gates_fingerprint varchar(64) NOT NULL,
  link_id uuid,
  link_enabled boolean NOT NULL DEFAULT false,
  reboot_mode varchar(16)
    CONSTRAINT device_oem_policy_side_reboot_mode_chk
    CHECK (reboot_mode IS NULL OR reboot_mode IN ('overnight', 'never')),
  occurrence_key varchar(64),
  -- Window of the occurrence's last night: its start, and its end, after which
  -- the occurrence is past its last night.
  last_night_start timestamptz,
  past_last_night_at timestamptz,
  -- The next occurrence's first window start: the row is stale from then on.
  refresh_after timestamptz,
  managed_since timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Composite (device_id, org_id) FK: a row can only name a device of the org it
-- claims. ON UPDATE CASCADE restamps org_id when the device moves orgs
-- (DEVICE_ORG_FK_CASCADE_TABLES in routes/devices/core.ts); ON DELETE CASCADE
-- removes the row with the device. DEFERRABLE INITIALLY IMMEDIATE is mandatory
-- for composite FKs on org_id (org merge runs SET CONSTRAINTS ALL DEFERRED).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_oem_policy_side_device_org_fk'
  ) THEN
    ALTER TABLE device_oem_policy_side
      ADD CONSTRAINT device_oem_policy_side_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS device_oem_policy_side_org_idx
  ON device_oem_policy_side (org_id);
-- The worker's due pass: rows whose occurrence has rolled over.
CREATE INDEX IF NOT EXISTS device_oem_policy_side_refresh_idx
  ON device_oem_policy_side (refresh_after)
  WHERE refresh_after IS NOT NULL;

-- RLS shape 1 (direct NOT NULL org_id). breeze_has_org_access already grants
-- system scope, so there is no separate system branch.
ALTER TABLE device_oem_policy_side ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_oem_policy_side FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_oem_policy_side;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_oem_policy_side;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_oem_policy_side;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_oem_policy_side;

CREATE POLICY breeze_org_isolation_select ON device_oem_policy_side
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_oem_policy_side
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_oem_policy_side
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_oem_policy_side
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON device_oem_policy_side TO breeze_app;
