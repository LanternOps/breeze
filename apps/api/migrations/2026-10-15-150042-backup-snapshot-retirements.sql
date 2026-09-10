-- apps/api/migrations/2026-10-15-150042-backup-snapshot-retirements.sql
-- D18 W01 (#5429/§3.3): backup_snapshot_retirements — durable tombstone
-- written by retention the instant it deletes an expired/pruned
-- backup_snapshots row (see backupRetention.ts's cleanupExpiredSnapshots).
--
-- Shape 1 tenancy (plain org_id column), same RLS pattern as
-- 2026-04-11-bucket-a-rls-policies.sql:12-32. config_id cascades (a config's
-- deletion should not orphan its retirement ledger); device_id is SET NULL
-- (retirement history must survive the device being deleted).
--
-- Idempotent: IF NOT EXISTS throughout; DROP POLICY IF EXISTS before create.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'backup_snapshot_retirement_reason') THEN
    CREATE TYPE backup_snapshot_retirement_reason AS ENUM ('expired', 'max_versions', 'manual');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS backup_snapshot_retirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  config_id uuid REFERENCES backup_configs(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  snapshot_id varchar(200) NOT NULL,
  storage_identity text NOT NULL,
  backup_type backup_type,
  reason backup_snapshot_retirement_reason NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  swept_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_snapshot_retirements_identity_snapshot_uq
  ON backup_snapshot_retirements (storage_identity, snapshot_id);

CREATE INDEX IF NOT EXISTS backup_snapshot_retirements_identity_swept_idx
  ON backup_snapshot_retirements (storage_identity, swept_at);

CREATE INDEX IF NOT EXISTS backup_snapshot_retirements_org_id_idx
  ON backup_snapshot_retirements (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_snapshot_retirements;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_snapshot_retirements;

ALTER TABLE backup_snapshot_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_snapshot_retirements FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON backup_snapshot_retirements
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_snapshot_retirements
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_snapshot_retirements
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_snapshot_retirements
  FOR DELETE USING (public.breeze_has_org_access(org_id));
