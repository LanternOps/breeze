-- Phase 6: Cloud-to-Cloud backup tables

CREATE TABLE IF NOT EXISTS "c2c_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "provider" varchar(30) NOT NULL,
  "display_name" varchar(200) NOT NULL,
  "tenant_id" varchar(100),
  "client_id" varchar(200),
  "client_secret" text,
  "refresh_token" text,
  "access_token" text,
  "token_expires_at" timestamp,
  "scopes" text,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "last_sync_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "c2c_connections_org_idx" ON "c2c_connections"("org_id");
CREATE INDEX IF NOT EXISTS "c2c_connections_status_idx" ON "c2c_connections"("org_id", "status");

CREATE TABLE IF NOT EXISTS "c2c_backup_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "connection_id" uuid NOT NULL REFERENCES "c2c_connections"("id"),
  "name" varchar(200) NOT NULL,
  "backup_scope" varchar(30) NOT NULL,
  "target_users" jsonb DEFAULT '[]',
  "storage_config_id" uuid REFERENCES "backup_configs"("id"),
  "schedule" jsonb,
  "retention" jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "c2c_configs_org_idx" ON "c2c_backup_configs"("org_id");
CREATE INDEX IF NOT EXISTS "c2c_configs_connection_idx" ON "c2c_backup_configs"("connection_id");

CREATE TABLE IF NOT EXISTS "c2c_backup_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "config_id" uuid NOT NULL REFERENCES "c2c_backup_configs"("id"),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "started_at" timestamp,
  "completed_at" timestamp,
  "items_processed" integer DEFAULT 0,
  "items_new" integer DEFAULT 0,
  "items_updated" integer DEFAULT 0,
  "items_deleted" integer DEFAULT 0,
  "bytes_transferred" bigint DEFAULT 0,
  "delta_token" text,
  "error_log" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "c2c_jobs_org_idx" ON "c2c_backup_jobs"("org_id");
CREATE INDEX IF NOT EXISTS "c2c_jobs_config_idx" ON "c2c_backup_jobs"("config_id");
CREATE INDEX IF NOT EXISTS "c2c_jobs_status_idx" ON "c2c_backup_jobs"("status");

CREATE TABLE IF NOT EXISTS "c2c_backup_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "config_id" uuid NOT NULL REFERENCES "c2c_backup_configs"("id"),
  "job_id" uuid REFERENCES "c2c_backup_jobs"("id"),
  "item_type" varchar(30) NOT NULL,
  "external_id" varchar(500) NOT NULL,
  "user_email" varchar(320),
  "subject_or_name" text,
  "parent_path" text,
  "storage_path" text,
  "size_bytes" bigint,
  "item_date" timestamp,
  "is_deleted" boolean DEFAULT false,
  "deleted_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "c2c_items_org_config_idx" ON "c2c_backup_items"("org_id", "config_id");
CREATE INDEX IF NOT EXISTS "c2c_items_user_idx" ON "c2c_backup_items"("org_id", "user_email");
CREATE INDEX IF NOT EXISTS "c2c_items_external_idx" ON "c2c_backup_items"("external_id");
CREATE INDEX IF NOT EXISTS "c2c_items_type_date_idx" ON "c2c_backup_items"("item_type", "item_date");
