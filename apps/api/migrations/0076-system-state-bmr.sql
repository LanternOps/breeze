-- Phase 3: System state backup + bare metal recovery
-- Idempotent: safe to re-run.

-- Add backup_type to backup_jobs
ALTER TABLE "backup_jobs" ADD COLUMN IF NOT EXISTS "backup_type" backup_type DEFAULT 'file';

-- Add system state columns to backup_snapshots
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "backup_type" backup_type DEFAULT 'file';
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "hardware_profile" jsonb;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "system_state_manifest" jsonb;

-- Add BMR columns to restore_jobs
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "restore_type_v2" restore_type DEFAULT 'selective';
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "target_config" jsonb;
ALTER TABLE "restore_jobs" ADD COLUMN IF NOT EXISTS "recovery_token_id" uuid;

-- Recovery tokens table
CREATE TABLE IF NOT EXISTS "recovery_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "snapshot_id" uuid NOT NULL REFERENCES "backup_snapshots"("id"),
  "token_hash" varchar(64) NOT NULL,
  "restore_type" varchar(30) NOT NULL,
  "target_config" jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp
);
CREATE INDEX IF NOT EXISTS "recovery_tokens_org_idx" ON "recovery_tokens"("org_id");
CREATE INDEX IF NOT EXISTS "recovery_tokens_hash_idx" ON "recovery_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "recovery_tokens_status_idx" ON "recovery_tokens"("status");

-- FK from restore_jobs to recovery_tokens
DO $$ BEGIN
  ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_recovery_token_fk"
    FOREIGN KEY ("recovery_token_id") REFERENCES "recovery_tokens"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
