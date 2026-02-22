-- Create configuration policy system tables.
-- These tables are the backbone of the hierarchical config policy engine.
-- Uses IF NOT EXISTS / DO $$ guards so it is safe to re-run.

-- ============================================
-- Step 1: Enums
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'config_policy_status') THEN
    CREATE TYPE config_policy_status AS ENUM ('active', 'inactive', 'archived');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'config_feature_type') THEN
    CREATE TYPE config_feature_type AS ENUM (
      'patch', 'alert_rule', 'backup', 'security',
      'monitoring', 'maintenance', 'compliance', 'automation'
    );
  END IF;
END $$;

-- Ensure 'event_log' and 'software_policy' values exist
-- (may already be added by 2026-02-21-event-log-policy-settings.sql)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'event_log'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'event_log';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'software_policy'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'config_feature_type')
  ) THEN
    ALTER TYPE config_feature_type ADD VALUE 'software_policy';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'config_assignment_level') THEN
    CREATE TYPE config_assignment_level AS ENUM (
      'partner', 'organization', 'site', 'device_group', 'device'
    );
  END IF;
END $$;

-- ============================================
-- Step 2: Core tables
-- ============================================

CREATE TABLE IF NOT EXISTS configuration_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  name        varchar(255) NOT NULL,
  description text,
  status      config_policy_status NOT NULL DEFAULT 'active',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS config_policy_feature_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_policy_id uuid NOT NULL REFERENCES configuration_policies(id) ON DELETE CASCADE,
  feature_type     config_feature_type NOT NULL,
  feature_policy_id uuid,
  inline_settings  jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS config_policy_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_policy_id uuid NOT NULL REFERENCES configuration_policies(id) ON DELETE CASCADE,
  level            config_assignment_level NOT NULL,
  target_id        uuid NOT NULL,
  priority         integer NOT NULL DEFAULT 0,
  assigned_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ============================================
-- Step 3: Feature-specific tables
-- ============================================

-- Alert rules (multi-item per feature link)
CREATE TABLE IF NOT EXISTS config_policy_alert_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id        uuid NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  name                   varchar(200) NOT NULL,
  severity               alert_severity NOT NULL,
  conditions             jsonb NOT NULL,
  cooldown_minutes       integer NOT NULL DEFAULT 5,
  auto_resolve           boolean NOT NULL DEFAULT false,
  auto_resolve_conditions jsonb,
  title_template         text NOT NULL DEFAULT '{{ruleName}} triggered on {{deviceName}}',
  message_template       text NOT NULL DEFAULT '{{ruleName}} condition met',
  sort_order             integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Automations (multi-item per feature link)
CREATE TABLE IF NOT EXISTS config_policy_automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  name            varchar(255) NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  trigger_type    varchar(50) NOT NULL,
  cron_expression varchar(100),
  timezone        varchar(100),
  event_type      varchar(200),
  actions         jsonb NOT NULL,
  on_failure      automation_on_failure NOT NULL DEFAULT 'stop',
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Compliance rules (multi-item per feature link)
CREATE TABLE IF NOT EXISTS config_policy_compliance_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id        uuid NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  name                   varchar(255) NOT NULL,
  rules                  jsonb NOT NULL,
  enforcement_level      policy_enforcement NOT NULL DEFAULT 'monitor',
  check_interval_minutes integer NOT NULL DEFAULT 60,
  remediation_script_id  uuid REFERENCES scripts(id),
  sort_order             integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Patch settings (single-item per feature link)
CREATE TABLE IF NOT EXISTS config_policy_patch_settings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id         uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  sources                 text[] NOT NULL DEFAULT ARRAY['os'],
  auto_approve            boolean NOT NULL DEFAULT false,
  auto_approve_severities text[] DEFAULT '{}',
  schedule_frequency      varchar(20) NOT NULL DEFAULT 'weekly',
  schedule_time           varchar(10) NOT NULL DEFAULT '02:00',
  schedule_day_of_week    varchar(10) DEFAULT 'sun',
  schedule_day_of_month   integer DEFAULT 1,
  reboot_policy           varchar(20) NOT NULL DEFAULT 'if_required',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Maintenance settings (single-item per feature link)
CREATE TABLE IF NOT EXISTS config_policy_maintenance_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id       uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  recurrence            varchar(20) NOT NULL DEFAULT 'weekly',
  duration_hours        integer NOT NULL DEFAULT 2,
  timezone              varchar(100) NOT NULL DEFAULT 'UTC',
  window_start          varchar(30),
  suppress_alerts       boolean NOT NULL DEFAULT true,
  suppress_patching     boolean NOT NULL DEFAULT false,
  suppress_automations  boolean NOT NULL DEFAULT false,
  suppress_scripts      boolean NOT NULL DEFAULT false,
  notify_before_minutes integer DEFAULT 15,
  notify_on_start       boolean NOT NULL DEFAULT true,
  notify_on_end         boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ============================================
-- Step 4: Indexes
-- ============================================

CREATE INDEX IF NOT EXISTS config_policies_org_id_idx
  ON configuration_policies(org_id);
CREATE INDEX IF NOT EXISTS config_policies_status_idx
  ON configuration_policies(status);

CREATE INDEX IF NOT EXISTS config_feature_links_policy_id_idx
  ON config_policy_feature_links(config_policy_id);
CREATE INDEX IF NOT EXISTS config_feature_links_feature_type_idx
  ON config_policy_feature_links(feature_type);
CREATE UNIQUE INDEX IF NOT EXISTS config_feature_links_unique
  ON config_policy_feature_links(config_policy_id, feature_type);

CREATE INDEX IF NOT EXISTS config_assignments_policy_id_idx
  ON config_policy_assignments(config_policy_id);
CREATE INDEX IF NOT EXISTS config_assignments_level_target_idx
  ON config_policy_assignments(level, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS config_assignments_unique
  ON config_policy_assignments(config_policy_id, level, target_id);

CREATE INDEX IF NOT EXISTS cpar_feature_link_id_idx
  ON config_policy_alert_rules(feature_link_id);
CREATE INDEX IF NOT EXISTS cpaut_feature_link_id_idx
  ON config_policy_automations(feature_link_id);
CREATE INDEX IF NOT EXISTS cpaut_trigger_type_enabled_idx
  ON config_policy_automations(trigger_type);
CREATE INDEX IF NOT EXISTS cpcr_feature_link_id_idx
  ON config_policy_compliance_rules(feature_link_id);

-- ============================================
-- Step 5: RLS policies
-- ============================================

ALTER TABLE configuration_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS configuration_policies_org_isolation ON configuration_policies;
CREATE POLICY configuration_policies_org_isolation
  ON configuration_policies
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE config_policy_feature_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_feature_links_org_isolation ON config_policy_feature_links;
CREATE POLICY config_policy_feature_links_org_isolation
  ON config_policy_feature_links
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = config_policy_feature_links.config_policy_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_assignments_org_isolation ON config_policy_assignments;
CREATE POLICY config_policy_assignments_org_isolation
  ON config_policy_assignments
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = config_policy_assignments.config_policy_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_alert_rules_org_isolation ON config_policy_alert_rules;
CREATE POLICY config_policy_alert_rules_org_isolation
  ON config_policy_alert_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_alert_rules.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_automations_org_isolation ON config_policy_automations;
CREATE POLICY config_policy_automations_org_isolation
  ON config_policy_automations
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_automations.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_compliance_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_compliance_rules_org_isolation ON config_policy_compliance_rules;
CREATE POLICY config_policy_compliance_rules_org_isolation
  ON config_policy_compliance_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_compliance_rules.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_patch_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_patch_settings_org_isolation ON config_policy_patch_settings;
CREATE POLICY config_policy_patch_settings_org_isolation
  ON config_policy_patch_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_patch_settings.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );

ALTER TABLE config_policy_maintenance_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS config_policy_maintenance_settings_org_isolation ON config_policy_maintenance_settings;
CREATE POLICY config_policy_maintenance_settings_org_isolation
  ON config_policy_maintenance_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM config_policy_feature_links fl
      JOIN configuration_policies cp ON cp.id = fl.config_policy_id
      WHERE fl.id = config_policy_maintenance_settings.feature_link_id
        AND public.breeze_has_org_access(cp.org_id)
    )
  );
