SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS subject_key text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'alerts'::regclass AND conname = 'alerts_subject_key_nonempty_chk'
  ) THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_subject_key_nonempty_chk CHECK (subject_key <> '');
  END IF;
END $$;
DO $$
DECLARE n integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY rule_id, device_id ORDER BY triggered_at DESC, id DESC
    ) AS position
    FROM alerts
    WHERE rule_id IS NOT NULL AND subject_key IS NULL
      AND status IN ('active', 'acknowledged', 'suppressed')
  )
  UPDATE alerts a
  SET status = 'resolved', resolved_at = now(), resolution_note = 'deduplicated by migration'
  FROM ranked r WHERE a.id = r.id AND r.position > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'resolved % duplicate open alerts', n;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_rule_device_subject_uidx
  ON alerts (rule_id, device_id, COALESCE(subject_key, ''))
  WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed');

-- W03 Task 10 — durable response admission for the subject response outbox.
-- `responses_admitted_at` is never reset (see subjectResponseOutbox.ts); its
-- CAS predicate is the single-response-owner guarantee. `response_dispatch`
-- stages a committed automation run for post-commit delivery, mirroring
-- `alerts.context._subjectDispatch`.
ALTER TABLE monitor_episodes ADD COLUMN IF NOT EXISTS responses_admitted_at timestamptz;
ALTER TABLE monitor_episodes ADD COLUMN IF NOT EXISTS response_dispatch jsonb;

-- W03 Task 12 — durable retirement recovery outbox. Org-scoped (no
-- device_id/alert_id FK) so it survives device-delete cascades and org
-- lifecycle deletes it through CORE_ORG_CASCADE_DELETE_ORDER.
CREATE TABLE IF NOT EXISTS hardware_alert_retirement_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hardware_alert_retirement_outbox_org_idx
  ON hardware_alert_retirement_outbox(org_id);
ALTER TABLE hardware_alert_retirement_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_alert_retirement_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_update ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON hardware_alert_retirement_outbox;
CREATE POLICY breeze_org_isolation_select ON hardware_alert_retirement_outbox
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON hardware_alert_retirement_outbox
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON hardware_alert_retirement_outbox
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON hardware_alert_retirement_outbox
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON hardware_alert_retirement_outbox TO breeze_app;
