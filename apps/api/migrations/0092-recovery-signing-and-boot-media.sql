BEGIN;

ALTER TABLE "recovery_media_artifacts"
  ADD COLUMN IF NOT EXISTS "checksum_storage_key" varchar(1024),
  ADD COLUMN IF NOT EXISTS "signature_format" varchar(32),
  ADD COLUMN IF NOT EXISTS "signature_storage_key" varchar(1024),
  ADD COLUMN IF NOT EXISTS "signing_key_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "signed_at" timestamp;

UPDATE "recovery_media_artifacts"
SET "status" = 'legacy_unsigned'
WHERE "status" = 'ready'
  AND "signature_storage_key" IS NULL;

CREATE TABLE IF NOT EXISTS "recovery_boot_media_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "token_id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "bundle_artifact_id" uuid NOT NULL,
  "platform" varchar(20) NOT NULL,
  "architecture" varchar(20) NOT NULL,
  "media_type" varchar(20) NOT NULL DEFAULT 'iso',
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "storage_key" varchar(1024),
  "checksum_sha256" varchar(64),
  "checksum_storage_key" varchar(1024),
  "signature_format" varchar(32),
  "signature_storage_key" varchar(1024),
  "signing_key_id" varchar(128),
  "metadata" jsonb,
  "created_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "signed_at" timestamp,
  "completed_at" timestamp
);

DO $$ BEGIN
 ALTER TABLE "recovery_boot_media_artifacts" ADD CONSTRAINT "recovery_boot_media_artifacts_org_id_organizations_id_fk"
 FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_boot_media_artifacts" ADD CONSTRAINT "recovery_boot_media_artifacts_token_id_recovery_tokens_id_fk"
 FOREIGN KEY ("token_id") REFERENCES "public"."recovery_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_boot_media_artifacts" ADD CONSTRAINT "recovery_boot_media_artifacts_snapshot_id_backup_snapshots_id_fk"
 FOREIGN KEY ("snapshot_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_boot_media_artifacts" ADD CONSTRAINT "recovery_boot_media_artifacts_bundle_artifact_id_recovery_media_artifacts_id_fk"
 FOREIGN KEY ("bundle_artifact_id") REFERENCES "public"."recovery_media_artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_boot_media_artifacts" ADD CONSTRAINT "recovery_boot_media_artifacts_created_by_users_id_fk"
 FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_org_idx"
  ON "recovery_boot_media_artifacts" USING btree ("org_id");

CREATE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_token_idx"
  ON "recovery_boot_media_artifacts" USING btree ("token_id");

CREATE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_snapshot_idx"
  ON "recovery_boot_media_artifacts" USING btree ("snapshot_id");

CREATE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_bundle_idx"
  ON "recovery_boot_media_artifacts" USING btree ("bundle_artifact_id");

CREATE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_status_idx"
  ON "recovery_boot_media_artifacts" USING btree ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_boot_media_artifacts_token_media_type_uniq"
  ON "recovery_boot_media_artifacts" USING btree ("token_id", "platform", "architecture", "media_type");

COMMIT;
