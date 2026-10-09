-- Reliability baseline markers (#5876). A tech (or a completed bare-metal
-- recovery) marks a point in time; reliability scoring ignores everything
-- before the latest active marker. Direct org_id tenancy (shape 1) with a
-- DEFERRABLE INITIALLY IMMEDIATE composite (device_id, org_id) FK so org
-- merge/move can re-point both sides. source_ref is a soft reference to
-- bare_metal_recoveries.id (no FK: see spec "Data model"). Idempotent; writes no rows.
CREATE TABLE IF NOT EXISTS device_reliability_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  baseline_at timestamptz NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_ref uuid,
  note text,
  before_snapshot jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_reason_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_reason_check
  CHECK (reason IN ('reimaged', 'remediated', 'hardware_replaced'));
ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_source_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_source_check
  CHECK (source IN ('manual', 'bare_metal_recovery'));
ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_note_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_note_check
  CHECK (NOT (reason = 'remediated' AND source = 'manual') OR (note IS NOT NULL AND length(btrim(note)) > 0));

ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_device_org_fkey;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_device_org_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS device_reliability_baselines_active_idx
  ON device_reliability_baselines (device_id, baseline_at DESC, created_at DESC) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS device_reliability_baselines_org_idx ON device_reliability_baselines (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_reliability_baselines_source_ref_uq
  ON device_reliability_baselines (device_id, source_ref) WHERE source_ref IS NOT NULL;

ALTER TABLE device_reliability_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_reliability_baselines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_reliability_baselines;
CREATE POLICY breeze_org_isolation_select ON device_reliability_baselines FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_reliability_baselines FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_reliability_baselines FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_reliability_baselines FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_reliability_baselines TO breeze_app;
