-- Phase 2: Encryption keys, GFS retention, immutable storage, storage tiering

-- New table: storage encryption keys for BYOK
CREATE TABLE IF NOT EXISTS "storage_encryption_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(200) NOT NULL,
  "key_type" varchar(20) NOT NULL DEFAULT 'aes_256',
  "public_key_pem" text,
  "encrypted_private_key" text,
  "key_hash" varchar(128) NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "rotated_at" timestamp,
  "expires_at" timestamp
);
CREATE INDEX IF NOT EXISTS "encryption_keys_org_idx" ON "storage_encryption_keys"("org_id");
CREATE INDEX IF NOT EXISTS "encryption_keys_active_idx" ON "storage_encryption_keys"("org_id", "is_active");

-- Extend backup_policies with GFS, legal hold, bandwidth, priority
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "gfs_config" jsonb;
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "legal_hold" boolean DEFAULT false;
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "legal_hold_reason" text;
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "bandwidth_limit_mbps" integer;
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "backup_window_start" varchar(5);
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "backup_window_end" varchar(5);
ALTER TABLE "backup_policies" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 50;

-- Extend backup_snapshots with immutability, legal hold, encryption, tiering
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "storage_tier" varchar(30);
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "is_immutable" boolean DEFAULT false;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "immutable_until" timestamp;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "legal_hold" boolean DEFAULT false;
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "encryption_key_id" uuid REFERENCES "storage_encryption_keys"("id");
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "checksum_sha256" varchar(64);
ALTER TABLE "backup_snapshots" ADD COLUMN IF NOT EXISTS "gfs_tags" jsonb;

COMMENT ON COLUMN "backup_policies"."gfs_config" IS 'GFS retention: {daily: N, weekly: N, monthly: N, yearly: N}';
COMMENT ON COLUMN "backup_policies"."backup_window_start" IS 'Backup window start time HH:MM';
COMMENT ON COLUMN "backup_policies"."backup_window_end" IS 'Backup window end time HH:MM';
COMMENT ON COLUMN "backup_policies"."priority" IS 'Scheduling priority: 1=highest, 50=default';
COMMENT ON COLUMN "backup_snapshots"."gfs_tags" IS 'GFS tags: {daily: bool, weekly: bool, monthly: bool, yearly: bool}';
