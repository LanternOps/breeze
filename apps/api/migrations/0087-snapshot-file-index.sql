BEGIN;

CREATE TABLE IF NOT EXISTS "backup_snapshot_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_db_id" uuid NOT NULL,
  "source_path" text NOT NULL,
  "backup_path" text NOT NULL,
  "size" bigint,
  "modified_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "backup_snapshot_files" ADD CONSTRAINT "backup_snapshot_files_snapshot_db_id_backup_snapshots_id_fk"
 FOREIGN KEY ("snapshot_db_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "backup_snapshot_files_snapshot_idx"
  ON "backup_snapshot_files" USING btree ("snapshot_db_id");

CREATE INDEX IF NOT EXISTS "backup_snapshot_files_snapshot_source_idx"
  ON "backup_snapshot_files" USING btree ("snapshot_db_id","source_path");

COMMIT;
