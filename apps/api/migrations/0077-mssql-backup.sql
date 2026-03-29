-- Phase 4: MSSQL backup & restore — SQL instances + backup chains
-- Idempotent: safe to re-run.

-- sql_instances: discovered SQL Server instances per device
CREATE TABLE IF NOT EXISTS "sql_instances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "instance_name" varchar(256) NOT NULL,
  "version" varchar(50),
  "edition" varchar(100),
  "port" integer,
  "auth_type" varchar(20) NOT NULL DEFAULT 'windows',
  "databases" jsonb DEFAULT '[]',
  "status" varchar(20) NOT NULL DEFAULT 'unknown',
  "last_discovered_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Unique constraint on device + instance name
DO $$ BEGIN
  ALTER TABLE "sql_instances"
    ADD CONSTRAINT "sql_instances_device_instance_uniq"
    UNIQUE ("device_id", "instance_name");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "sql_instances_org_device_idx"
  ON "sql_instances"("org_id", "device_id");

-- backup_chains: tracks LSN chain continuity for differential / log chains
CREATE TABLE IF NOT EXISTS "backup_chains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "device_id" uuid NOT NULL REFERENCES "devices"("id"),
  "config_id" uuid NOT NULL REFERENCES "backup_configs"("id"),
  "chain_type" varchar(20) NOT NULL,
  "target_name" varchar(256) NOT NULL,
  "target_id" varchar(256),
  "is_active" boolean NOT NULL DEFAULT true,
  "full_snapshot_id" uuid REFERENCES "backup_snapshots"("id"),
  "chain_metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "backup_chains_org_config_idx"
  ON "backup_chains"("org_id", "config_id");

CREATE INDEX IF NOT EXISTS "backup_chains_target_idx"
  ON "backup_chains"("device_id", "target_name");

-- RLS policies for multi-tenant isolation
DO $$ BEGIN
  ALTER TABLE "sql_instances" ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY sql_instances_org_isolation ON "sql_instances"
    USING ("org_id" = current_setting('app.current_org_id', true)::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "backup_chains" ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY backup_chains_org_isolation ON "backup_chains"
    USING ("org_id" = current_setting('app.current_org_id', true)::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
