-- Backup schema migration: align tables with API contract
-- Run: docker exec -i breeze-postgres-dev psql -U breeze -d breeze < apps/api/src/db/migrations/2026-02-25-backup-schema.sql

BEGIN;

-- ── backup_configs: add updatedAt ─────────────────────────────────────────────
ALTER TABLE backup_configs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ── backup_policies: rebuild as flat policy table ─────────────────────────────
-- Drop old junction-style columns, add policy-level columns
ALTER TABLE backup_policies
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS name varchar(200),
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS schedule jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS retention jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS targets jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Drop old columns (safe: nothing uses them in production yet)
ALTER TABLE backup_policies
  DROP COLUMN IF EXISTS target_type,
  DROP COLUMN IF EXISTS target_id,
  DROP COLUMN IF EXISTS includes,
  DROP COLUMN IF EXISTS excludes,
  DROP COLUMN IF EXISTS priority;

-- Drop old index that referenced dropped columns
DROP INDEX IF EXISTS backup_policies_target_idx;

-- Add new indexes
CREATE INDEX IF NOT EXISTS backup_policies_org_id_idx ON backup_policies(org_id);
CREATE INDEX IF NOT EXISTS backup_policies_enabled_idx ON backup_policies(enabled);

-- Make org_id NOT NULL (no existing rows in production)
ALTER TABLE backup_policies ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE backup_policies ALTER COLUMN name SET NOT NULL;

-- ── backup_jobs: add orgId, policyId, createdAt, updatedAt ────────────────────
ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS policy_id uuid REFERENCES backup_policies(id),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE backup_jobs ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS backup_jobs_org_id_idx ON backup_jobs(org_id);
CREATE INDEX IF NOT EXISTS backup_jobs_policy_id_idx ON backup_jobs(policy_id);
CREATE INDEX IF NOT EXISTS backup_jobs_created_at_idx ON backup_jobs(created_at);

-- ── backup_snapshots: add orgId, configId, label, location ────────────────────
ALTER TABLE backup_snapshots
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS config_id uuid REFERENCES backup_configs(id),
  ADD COLUMN IF NOT EXISTS label varchar(200),
  ADD COLUMN IF NOT EXISTS location text;

ALTER TABLE backup_snapshots ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS backup_snapshots_org_id_idx ON backup_snapshots(org_id);

-- ── restore_jobs: add orgId, createdAt, updatedAt ─────────────────────────────
ALTER TABLE restore_jobs
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE restore_jobs ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS restore_jobs_org_id_idx ON restore_jobs(org_id);

-- Change bigint mode from 'bigint' to 'number' (no SQL change needed, Drizzle-only)
-- Change totalSize/transferredSize/size/restoredSize — these are already bigint in PG

COMMIT;
