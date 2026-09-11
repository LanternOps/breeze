-- Bare-metal recovery W04a: one row per recovery attempt started from Breeze
-- boot media. Spec Sec8.1. Shape-1 RLS (org_id); policies mirror recovery_tokens
-- so the public, token-authenticated recover/* routes can read and update rows.
CREATE TABLE IF NOT EXISTS bare_metal_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES backup_snapshots(id) ON DELETE SET NULL,
  recovery_token_id uuid REFERENCES recovery_tokens(id) ON DELETE SET NULL,
  identity varchar(10) NOT NULL CHECK (identity IN ('original', 'new')),
  code_hash varchar(64) NOT NULL,
  code_expires_at timestamptz NOT NULL,
  code_used_at timestamptz,
  nonce_hash varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','media_booted','planned','restoring','validated','rebooted','checked_in','completed','failed','refused')),
  target jsonb,
  plan jsonb,
  result jsonb,
  failure_reason text,
  warnings jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  media_booted_at timestamptz,
  planned_at timestamptz,
  restoring_at timestamptz,
  validated_at timestamptz,
  rebooted_at timestamptz,
  checked_in_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS bare_metal_recoveries_code_hash_idx ON bare_metal_recoveries(code_hash);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_org_idx ON bare_metal_recoveries(org_id);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_device_idx ON bare_metal_recoveries(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_token_idx ON bare_metal_recoveries(recovery_token_id);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_status_idx ON bare_metal_recoveries(status) WHERE status NOT IN ('checked_in','completed','failed','refused');

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "recovered_at" timestamptz;
-- No REFERENCES here on purpose: backup_snapshots.device_id already points
-- devices -> ... -> backup_snapshots is not an edge, but backup_snapshots ->
-- devices IS (device_id FK). Adding devices -> backup_snapshots here would
-- create a 2-node FK cycle that topologicalCascadeOrder() (tenantCascade.ts)
-- cannot resolve (it throws loudly on any non-self-referential cycle rather
-- than silently guessing an order). This mirrors devices.possible_replacement_of_device_id's
-- self-reference exception, but a self-reference is exempted by table-name
-- equality in that function; a cross-table 2-cycle is not. Kept as a soft
-- (application-validated) reference, like other cross-schema device columns.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "recovered_from_snapshot_id" uuid;

ALTER TABLE bare_metal_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE bare_metal_recoveries FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bare_metal_recoveries' AND policyname = 'breeze_org_isolation_select') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_select ON bare_metal_recoveries FOR SELECT USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bare_metal_recoveries' AND policyname = 'breeze_org_isolation_insert') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_insert ON bare_metal_recoveries FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bare_metal_recoveries' AND policyname = 'breeze_org_isolation_update') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_update ON bare_metal_recoveries FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bare_metal_recoveries' AND policyname = 'breeze_org_isolation_delete') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_delete ON bare_metal_recoveries FOR DELETE USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bare_metal_recoveries TO breeze_app;
