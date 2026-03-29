-- Phase 7: SLA monitoring + DR orchestration

CREATE TABLE IF NOT EXISTS "backup_sla_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(200) NOT NULL,
  "rpo_target_minutes" integer NOT NULL,
  "rto_target_minutes" integer NOT NULL,
  "target_devices" jsonb DEFAULT '[]',
  "target_groups" jsonb DEFAULT '[]',
  "alert_on_breach" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "sla_configs_org_idx" ON "backup_sla_configs"("org_id");

CREATE TABLE IF NOT EXISTS "backup_sla_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "sla_config_id" uuid NOT NULL REFERENCES "backup_sla_configs"("id"),
  "device_id" uuid REFERENCES "devices"("id"),
  "event_type" varchar(30) NOT NULL,
  "details" jsonb,
  "detected_at" timestamp DEFAULT now() NOT NULL,
  "resolved_at" timestamp
);
CREATE INDEX IF NOT EXISTS "sla_events_org_idx" ON "backup_sla_events"("org_id");
CREATE INDEX IF NOT EXISTS "sla_events_config_idx" ON "backup_sla_events"("sla_config_id");
CREATE INDEX IF NOT EXISTS "sla_events_device_idx" ON "backup_sla_events"("device_id");

CREATE TABLE IF NOT EXISTS "dr_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(200) NOT NULL,
  "description" text,
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "rpo_target_minutes" integer,
  "rto_target_minutes" integer,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "dr_plans_org_idx" ON "dr_plans"("org_id");

CREATE TABLE IF NOT EXISTS "dr_plan_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "dr_plans"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(200) NOT NULL,
  "sequence" integer NOT NULL DEFAULT 0,
  "depends_on_group_id" uuid REFERENCES "dr_plan_groups"("id"),
  "devices" jsonb DEFAULT '[]',
  "restore_config" jsonb DEFAULT '{}',
  "estimated_duration_minutes" integer
);
CREATE INDEX IF NOT EXISTS "dr_groups_plan_idx" ON "dr_plan_groups"("plan_id");

CREATE TABLE IF NOT EXISTS "dr_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "dr_plans"("id"),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "execution_type" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "started_at" timestamp,
  "completed_at" timestamp,
  "initiated_by" uuid REFERENCES "users"("id"),
  "results" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "dr_executions_plan_idx" ON "dr_executions"("plan_id");
CREATE INDEX IF NOT EXISTS "dr_executions_org_idx" ON "dr_executions"("org_id");
