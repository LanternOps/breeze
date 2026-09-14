-- 2026-10-16-170700-device-function-assessments.sql   (Fleet Designer W02, #5652)
--
-- Device FUNCTION assessments (spec §4.5, §4.11): "what is this device for", a
-- second axis beside the coarse, billable device_role. The Fleet Designer
-- infers it (source = 'ai', with a confidence and bounded evidence strings); a
-- technician may state it by hand (source = 'manual', confidence NULL). A
-- manual row always wins and is never superseded by an ai row.
--
-- TENANCY: RLS shape 5 (device-id scoped, DENORMALIZED org_id) — a direct
-- breeze_has_org_access(org_id) policy, structurally pinned to the device by
-- the composite FK. Copies device_custom_field_values (2026-10-11-160000):
-- ON UPDATE CASCADE + DEFERRABLE INITIALLY DEFERRED, the device-axis deferral
-- moveOrg.coverage.test.ts pins (an org move flips the devices row first and
-- re-stamps children in the same after-row queue).
--
-- DDL only: no rows written, no breeze.scope election. Idempotent.

CREATE TABLE IF NOT EXISTS device_function_assessments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations (id),
  device_id          uuid NOT NULL,
  function_key       text NOT NULL,
  label              text NULL,
  -- NULL for a manual row (a technician states a fact, not a probability).
  confidence         numeric(3,2) NULL,
  -- Bounded display strings written by the designer; export excludedOpen.
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  source             text NOT NULL,
  run_id             uuid NULL,
  report_run_id      uuid NULL REFERENCES report_runs (id) ON DELETE SET NULL,
  active             boolean NOT NULL DEFAULT true,
  superseded_at      timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_function_assessments_source_chk
    CHECK (source IN ('ai', 'manual')),
  CONSTRAINT device_function_assessments_confidence_chk
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT device_function_assessments_manual_confidence_chk
    CHECK (source <> 'manual' OR confidence IS NULL),
  -- Mirrors DEVICE_FUNCTION_KEYS' shape and the custom:<slug> escape in
  -- packages/shared/src/validators/deviceFunctions.ts (the SSOT for the list).
  CONSTRAINT device_function_assessments_key_chk
    CHECK (function_key ~ '^[a-z][a-z0-9_]{1,47}$' OR function_key ~ '^custom:[a-z0-9][a-z0-9-]{1,39}$'),
  CONSTRAINT device_function_assessments_superseded_chk
    CHECK ((active AND superseded_at IS NULL) OR (NOT active AND superseded_at IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_function_assessments_device_org_fk'
  ) THEN
    ALTER TABLE device_function_assessments
      ADD CONSTRAINT device_function_assessments_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- Provenance pinned to the SAME org as the run (ai_agent_runs_id_org_uq).
  -- SET NULL (run_id) keeps the assessment when a run is erased; DEFERRABLE
  -- INITIALLY IMMEDIATE like every other composite FK on an org_id column
  -- (org-merge contract, orgLifecycleFoundations.integration.test.ts).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_function_assessments_run_org_fk'
  ) THEN
    ALTER TABLE device_function_assessments
      ADD CONSTRAINT device_function_assessments_run_org_fk
      FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
      ON DELETE SET NULL (run_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One ACTIVE assessment per device; history rows keep active = false.
CREATE UNIQUE INDEX IF NOT EXISTS device_function_assessments_active_device_uq
  ON device_function_assessments (device_id) WHERE active;
CREATE INDEX IF NOT EXISTS device_function_assessments_org_key_idx
  ON device_function_assessments (org_id, function_key) WHERE active;
CREATE INDEX IF NOT EXISTS device_function_assessments_device_idx
  ON device_function_assessments (device_id);
CREATE INDEX IF NOT EXISTS device_function_assessments_run_idx
  ON device_function_assessments (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_function_assessments_report_run_idx
  ON device_function_assessments (report_run_id) WHERE report_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_function_assessments_created_by_idx
  ON device_function_assessments (created_by_user_id) WHERE created_by_user_id IS NOT NULL;

ALTER TABLE device_function_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_function_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_function_assessments;
CREATE POLICY breeze_org_isolation_select ON device_function_assessments FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_function_assessments FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_function_assessments FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_function_assessments FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_function_assessments TO breeze_app;

-- Projection columns on devices, maintained by services/deviceFunction.ts in
-- the same transaction as every assessment write (never a trigger), so policy
-- targeting and list filters can read the active function cheaply.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_function text NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_function_source text NULL;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_function_source_chk;
ALTER TABLE devices ADD CONSTRAINT devices_device_function_source_chk
  CHECK ((device_function IS NULL AND device_function_source IS NULL)
      OR (device_function IS NOT NULL AND device_function_source IN ('ai', 'manual')));
CREATE INDEX IF NOT EXISTS devices_org_device_function_idx
  ON devices (org_id, device_function) WHERE device_function IS NOT NULL;
