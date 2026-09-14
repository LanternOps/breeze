-- Monitoring & Automation unification, W04 (#5287 / #5291).
-- Coverage: handler-only kinds, the script monitor, and partner-wide network checks.
--
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file in one
-- transaction). Every DML statement elects system scope first — breeze_app is
-- not the owner and 425 of 442 tables FORCE ROW LEVEL SECURITY, so an
-- unelevated UPDATE matches zero rows silently.

-- 1. Five new monitor kinds. ADD VALUE is transaction-safe here ONLY because
--    nothing below writes a row using one of these labels.
DO $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['antivirus','software_presence','backup_continuity','script','network_check'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumlabel = k AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'monitor_kind')
    ) THEN
      EXECUTE format('ALTER TYPE monitor_kind ADD VALUE %L', k);
    END IF;
  END LOOP;
END $$;

-- 2. A diagnostic run dispatched BY a monitor is its own trigger type. Reusing
--    'policy' would make the script handler unable to tell a monitor's own probe
--    from any other policy-driven run on the same script.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'monitor' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'trigger_type')
  ) THEN
    ALTER TYPE trigger_type ADD VALUE 'monitor';
  END IF;
END $$;

-- 3. Which monitor's probe this execution is. NULL for every other execution.
--    ON DELETE SET NULL: deleting a monitor must not delete run history.
ALTER TABLE script_executions
  ADD COLUMN IF NOT EXISTS monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS script_executions_monitor_device_idx
  ON script_executions (monitor_id, device_id, completed_at DESC)
  WHERE monitor_id IS NOT NULL;

-- 4. network_monitors becomes a config table: org_id XOR partner_id.
--    A partner authors ONE "is the gateway up" check and it runs for every org.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid
  REFERENCES monitor_definitions(id) ON DELETE CASCADE;
ALTER TABLE network_monitors ALTER COLUMN org_id DROP NOT NULL;

-- Every existing row is org-owned; the CHECK below would abort on a stray NULL.
-- Report the count either way — a 0 here is the forensic record that there was
-- nothing to clean, not an absence of evidence.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*) INTO n FROM network_monitors WHERE org_id IS NULL AND partner_id IS NULL;
  IF n > 0 THEN RAISE WARNING 'network_monitors: % ownerless rows before one_owner_chk', n; END IF;
END $$;

ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_one_owner_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_one_owner_chk
  CHECK ((org_id IS NULL) <> (partner_id IS NULL));

CREATE INDEX IF NOT EXISTS network_monitors_partner_id_idx ON network_monitors (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS network_monitors_managed_by_monitor_uniq
  ON network_monitors (managed_by_monitor_id) WHERE managed_by_monitor_id IS NOT NULL;

ALTER TABLE network_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_monitors FORCE ROW LEVEL SECURITY;

-- Sweep the four per-command org-only policies the baseline shipped. Leaving
-- any of them in place is harmless for reads (policies OR together) but the
-- INSERT/UPDATE ones would make a partner-wide row impossible to write.
DROP POLICY IF EXISTS breeze_org_isolation_select ON network_monitors;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_monitors;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_monitors;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_monitors;
DROP POLICY IF EXISTS network_monitors_isolation ON network_monitors;
CREATE POLICY network_monitors_isolation ON network_monitors
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- Additive, SELECT-only. LOAD-BEARING on the agent path: agentAuth sets
-- breeze.current_partner_id, and without this branch a partner-wide network
-- check is invisible to the poller's own context with no error at all.
DROP POLICY IF EXISTS network_monitors_partner_wide_select ON network_monitors;
CREATE POLICY network_monitors_partner_wide_select ON network_monitors
  FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- 5. Results carry the org the check ran FOR and the device it ran FROM.
--    A partner-wide parent has no org_id, so the old EXISTS-join policy is
--    blind for it; this converts the child to Shape 1 (direct org_id).
ALTER TABLE network_monitor_results ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
ALTER TABLE network_monitor_results ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE network_monitor_results r
     SET org_id = m.org_id
    FROM network_monitors m
   WHERE r.monitor_id = m.id AND r.org_id IS NULL AND m.org_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'network_monitor_results: backfilled org_id on % rows', n; END IF;
END $$;

CREATE INDEX IF NOT EXISTS network_monitor_results_org_id_idx ON network_monitor_results (org_id);
CREATE INDEX IF NOT EXISTS network_monitor_results_device_id_idx ON network_monitor_results (device_id);

-- org_id stays NULLABLE here on purpose: this is append-only telemetry that can
-- exceed 1M rows, and SET NOT NULL needs the batched ctid backfill loop first.
-- Filed as a follow-up; every writer added in W04 sets org_id unconditionally.
DROP POLICY IF EXISTS breeze_org_isolation_select ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_update ON network_monitor_results;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON network_monitor_results;
DROP POLICY IF EXISTS network_monitor_results_isolation ON network_monitor_results;
CREATE POLICY network_monitor_results_isolation ON network_monitor_results
  USING (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)))
  WITH CHECK (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)));
