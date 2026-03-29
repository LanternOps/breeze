-- 0082-local-vault.sql: Local vault (SMB share / USB drive) table
-- Tracks per-device vault configurations and sync status.

CREATE TABLE IF NOT EXISTS "local_vaults" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "vault_path" text NOT NULL,
  "vault_type" varchar(20) NOT NULL DEFAULT 'local',
  "is_active" boolean NOT NULL DEFAULT true,
  "retention_count" integer NOT NULL DEFAULT 3,
  "last_sync_at" timestamp,
  "last_sync_status" varchar(30),
  "last_sync_snapshot_id" varchar(200),
  "sync_size_bytes" bigint,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "local_vaults_org_idx" ON "local_vaults"("org_id");
CREATE INDEX IF NOT EXISTS "local_vaults_device_idx" ON "local_vaults"("device_id");

ALTER TABLE "local_vaults" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "org_isolation" ON "local_vaults"
    USING (org_id = current_setting('app.current_org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
