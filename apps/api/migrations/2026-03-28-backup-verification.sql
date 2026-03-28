CREATE TABLE IF NOT EXISTS "backup_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "device_id" uuid NOT NULL,
  "backup_job_id" uuid NOT NULL,
  "snapshot_id" uuid,
  "verification_type" varchar(30) NOT NULL,
  "status" varchar(20) NOT NULL,
  "started_at" timestamp NOT NULL,
  "completed_at" timestamp,
  "restore_time_seconds" integer,
  "files_verified" integer DEFAULT 0,
  "files_failed" integer DEFAULT 0,
  "size_bytes" bigint,
  "details" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "recovery_readiness" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "device_id" uuid NOT NULL,
  "readiness_score" integer NOT NULL,
  "estimated_rto_minutes" integer,
  "estimated_rpo_minutes" integer,
  "risk_factors" jsonb,
  "calculated_at" timestamp NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_org_id_organizations_id_fk"
 FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_device_id_devices_id_fk"
 FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_backup_job_id_backup_jobs_id_fk"
 FOREIGN KEY ("backup_job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "backup_verifications" ADD CONSTRAINT "backup_verifications_snapshot_id_backup_snapshots_id_fk"
 FOREIGN KEY ("snapshot_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_readiness" ADD CONSTRAINT "recovery_readiness_org_id_organizations_id_fk"
 FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recovery_readiness" ADD CONSTRAINT "recovery_readiness_device_id_devices_id_fk"
 FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "backup_verify_org_device_idx" ON "backup_verifications" USING btree ("org_id","device_id");
CREATE INDEX IF NOT EXISTS "backup_verify_status_idx" ON "backup_verifications" USING btree ("status");
CREATE INDEX IF NOT EXISTS "recovery_readiness_org_score_idx" ON "recovery_readiness" USING btree ("org_id","readiness_score");
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_readiness_org_device_unique" ON "recovery_readiness" USING btree ("org_id","device_id");
