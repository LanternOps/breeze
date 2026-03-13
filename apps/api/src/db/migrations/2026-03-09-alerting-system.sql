-- Phase 2: Add category, targets, updatedAt to alert_templates
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "category" varchar(100);
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "targets" jsonb;
ALTER TABLE "alert_templates" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;

-- Phase 2: Seed 5 built-in templates with fixed UUIDs
INSERT INTO "alert_templates" ("id", "name", "description", "category", "conditions", "severity", "title_template", "message_template", "targets", "auto_resolve", "cooldown_minutes", "is_built_in")
VALUES
  ('00000000-0000-4000-8000-000000000001', 'CPU High', 'CPU usage over 90% for 5 minutes', 'Performance',
   '{"type":"threshold","metric":"cpuPercent","operator":"gt","value":90,"durationMinutes":5}'::jsonb,
   'high',
   '{{deviceName}}: CPU High ({{actualValue}}%)',
   'CPU usage on {{deviceName}} ({{hostname}}) has exceeded {{threshold}}% for {{durationMinutes}} minutes. Current: {{actualValue}}%.',
   '{"scope":"organization"}'::jsonb,
   false, 15, true),
  ('00000000-0000-4000-8000-000000000002', 'Disk Space Low', 'Disk usage over 90% for 10 minutes', 'Capacity',
   '{"type":"threshold","metric":"diskPercent","operator":"gt","value":90,"durationMinutes":10}'::jsonb,
   'high',
   '{{deviceName}}: Disk Space Low',
   'Disk usage on {{deviceName}} ({{hostname}}) has exceeded 90% for {{durationMinutes}} minutes. Current: {{actualValue}}%.',
   '{"scope":"organization"}'::jsonb,
   false, 30, true),
  ('00000000-0000-4000-8000-000000000003', 'Service Stopped', 'Critical service is stopped or not responding', 'Availability',
   '{"type":"service_stopped","serviceName":"","consecutiveFailures":2}'::jsonb,
   'critical',
   '{{deviceName}}: Service Stopped',
   'A monitored service on {{deviceName}} ({{hostname}}) has stopped responding after consecutive failures.',
   '{"scope":"organization"}'::jsonb,
   false, 5, true),
  ('00000000-0000-4000-8000-000000000004', 'Memory Pressure', 'Memory usage above 85% for 5 minutes', 'Performance',
   '{"type":"threshold","metric":"ramPercent","operator":"gt","value":85,"durationMinutes":5}'::jsonb,
   'medium',
   '{{deviceName}}: Memory Pressure',
   'Memory usage on {{deviceName}} ({{hostname}}) has exceeded 85% for {{durationMinutes}} minutes. Current: {{actualValue}}%.',
   '{"scope":"organization"}'::jsonb,
   false, 15, true),
  ('00000000-0000-4000-8000-000000000005', 'Device Offline', 'Device offline for 5 minutes', 'Availability',
   '{"type":"offline","durationMinutes":5}'::jsonb,
   'medium',
   '{{deviceName}}: Offline',
   'Device {{deviceName}} ({{hostname}}) has been offline for more than 5 minutes.',
   '{"scope":"organization"}'::jsonb,
   false, 10, true)
ON CONFLICT (id) DO NOTHING;

-- Phase 4c: Add templates column to notification_channels
ALTER TABLE "notification_channels" ADD COLUMN IF NOT EXISTS "templates" jsonb DEFAULT '{}';

-- Phase 5: Create notification_routing_rules table
CREATE TABLE IF NOT EXISTS "notification_routing_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(255) NOT NULL,
  "priority" integer NOT NULL,
  "conditions" jsonb NOT NULL,
  "channel_ids" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "notification_routing_rules_org_id_idx" ON "notification_routing_rules" ("org_id");
CREATE INDEX IF NOT EXISTS "notification_routing_rules_priority_idx" ON "notification_routing_rules" ("org_id", "priority");
