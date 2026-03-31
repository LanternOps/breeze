BEGIN;

CREATE TABLE IF NOT EXISTS "vault_snapshot_inventory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "vault_id" uuid NOT NULL,
  "snapshot_db_id" uuid NOT NULL,
  "external_snapshot_id" varchar(200) NOT NULL,
  "synced_at" timestamp DEFAULT now() NOT NULL,
  "size_bytes" bigint,
  "file_count" integer,
  "manifest_verified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "vault_snapshot_inventory" ADD CONSTRAINT "vault_snapshot_inventory_org_id_organizations_id_fk"
 FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "vault_snapshot_inventory" ADD CONSTRAINT "vault_snapshot_inventory_vault_id_local_vaults_id_fk"
 FOREIGN KEY ("vault_id") REFERENCES "public"."local_vaults"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "vault_snapshot_inventory" ADD CONSTRAINT "vault_snapshot_inventory_snapshot_db_id_backup_snapshots_id_fk"
 FOREIGN KEY ("snapshot_db_id") REFERENCES "public"."backup_snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "vault_snapshot_inventory_org_idx"
  ON "vault_snapshot_inventory" USING btree ("org_id");

CREATE INDEX IF NOT EXISTS "vault_snapshot_inventory_vault_idx"
  ON "vault_snapshot_inventory" USING btree ("vault_id");

CREATE INDEX IF NOT EXISTS "vault_snapshot_inventory_snapshot_idx"
  ON "vault_snapshot_inventory" USING btree ("snapshot_db_id");

CREATE INDEX IF NOT EXISTS "vault_snapshot_inventory_external_snapshot_idx"
  ON "vault_snapshot_inventory" USING btree ("external_snapshot_id");

CREATE UNIQUE INDEX IF NOT EXISTS "vault_snapshot_inventory_vault_snapshot_uniq"
  ON "vault_snapshot_inventory" USING btree ("vault_id", "snapshot_db_id");

COMMIT;
