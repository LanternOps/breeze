BEGIN;

CREATE TABLE IF NOT EXISTS "recovery_media_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "token_id" uuid NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "platform" varchar(20) NOT NULL,
  "architecture" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "storage_key" varchar(1024),
  "checksum_sha256" varchar(64),
  "metadata" jsonb,
  "created_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

DO $$ BEGIN
 ALTER TABLE "recovery_media_artifacts" ADD CONSTRAINT "recovery_media_artifacts_org_id_organizations_id_fk"
 FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_media_artifacts" ADD CONSTRAINT "recovery_media_artifacts_token_id_recovery_tokens_id_fk"
 FOREIGN KEY ("token_id") REFERENCES "public"."recovery_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_media_artifacts" ADD CONSTRAINT "recovery_media_artifacts_snapshot_id_backup_snapshots_id_fk"
 FOREIGN KEY ("snapshot_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_media_artifacts" ADD CONSTRAINT "recovery_media_artifacts_created_by_users_id_fk"
 FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "recovery_media_artifacts_org_idx"
  ON "recovery_media_artifacts" USING btree ("org_id");

CREATE INDEX IF NOT EXISTS "recovery_media_artifacts_token_idx"
  ON "recovery_media_artifacts" USING btree ("token_id");

CREATE INDEX IF NOT EXISTS "recovery_media_artifacts_snapshot_idx"
  ON "recovery_media_artifacts" USING btree ("snapshot_id");

CREATE INDEX IF NOT EXISTS "recovery_media_artifacts_status_idx"
  ON "recovery_media_artifacts" USING btree ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_media_artifacts_token_platform_arch_uniq"
  ON "recovery_media_artifacts" USING btree ("token_id", "platform", "architecture");

COMMIT;
