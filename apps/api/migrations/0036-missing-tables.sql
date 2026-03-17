-- Create tables and enums that were added via db:push but never had migrations.
-- All statements use IF NOT EXISTS so this is safe to run on existing databases.

-- ============================================
-- Enums
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_log_level') THEN
    CREATE TYPE agent_log_level AS ENUM ('debug', 'info', 'warn', 'error');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_approval_mode') THEN
    CREATE TYPE ai_approval_mode AS ENUM ('per_step', 'action_plan', 'auto_approve', 'hybrid_plan');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_plan_status') THEN
    CREATE TYPE ai_plan_status AS ENUM ('pending', 'approved', 'rejected', 'executing', 'completed', 'aborted');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brain_context_type') THEN
    CREATE TYPE brain_context_type AS ENUM ('issue', 'quirk', 'followup', 'preference');
  END IF;
END $$;

-- ============================================
-- Tables
-- ============================================

-- Agent diagnostic logs
CREATE TABLE IF NOT EXISTS agent_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  "timestamp"   timestamptz NOT NULL,
  level         agent_log_level NOT NULL,
  component     varchar(100) NOT NULL,
  message       text NOT NULL,
  fields        jsonb,
  agent_version varchar(50),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_logs_device_idx
  ON agent_logs(device_id);
CREATE INDEX IF NOT EXISTS agent_logs_org_ts_idx
  ON agent_logs(org_id, "timestamp");
CREATE INDEX IF NOT EXISTS agent_logs_level_component_idx
  ON agent_logs(level, component);
CREATE INDEX IF NOT EXISTS agent_logs_timestamp_idx
  ON agent_logs("timestamp");

-- AI action plans (multi-step approval)
CREATE TABLE IF NOT EXISTS ai_action_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES ai_sessions(id),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  status             ai_plan_status NOT NULL DEFAULT 'pending',
  steps              jsonb NOT NULL,
  current_step_index integer NOT NULL DEFAULT 0,
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_action_plans_session_id_idx
  ON ai_action_plans(session_id);
CREATE INDEX IF NOT EXISTS ai_action_plans_status_idx
  ON ai_action_plans(status);

-- AI screenshots (temporary storage for vision analysis)
CREATE TABLE IF NOT EXISTS ai_screenshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  session_id   uuid REFERENCES ai_sessions(id),
  storage_key  varchar(500) NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  size_bytes   integer NOT NULL,
  captured_by  varchar(50) NOT NULL DEFAULT 'agent',
  reason       varchar(200),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_screenshots_device_id_idx
  ON ai_screenshots(device_id);
CREATE INDEX IF NOT EXISTS ai_screenshots_org_id_idx
  ON ai_screenshots(org_id);
CREATE INDEX IF NOT EXISTS ai_screenshots_expires_at_idx
  ON ai_screenshots(expires_at);

-- Brain device context (AI memory per device)
CREATE TABLE IF NOT EXISTS brain_device_context (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  device_id    uuid NOT NULL REFERENCES devices(id),
  context_type brain_context_type NOT NULL,
  summary      varchar(255) NOT NULL,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS brain_device_context_device_id_idx
  ON brain_device_context(device_id);
CREATE INDEX IF NOT EXISTS brain_device_context_org_id_idx
  ON brain_device_context(org_id);
CREATE INDEX IF NOT EXISTS brain_device_context_device_type_idx
  ON brain_device_context(device_id, context_type);
CREATE INDEX IF NOT EXISTS brain_device_context_device_active_idx
  ON brain_device_context(device_id, resolved_at);

-- Device boot metrics
CREATE TABLE IF NOT EXISTS device_boot_metrics (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id             uuid NOT NULL REFERENCES devices(id),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  boot_timestamp        timestamptz NOT NULL,
  bios_seconds          real,
  os_loader_seconds     real,
  desktop_ready_seconds real,
  total_boot_seconds    real NOT NULL,
  startup_item_count    integer NOT NULL,
  startup_items         jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_boot_metrics_device_boot_idx
  ON device_boot_metrics(device_id, boot_timestamp);
CREATE INDEX IF NOT EXISTS device_boot_metrics_device_created_idx
  ON device_boot_metrics(device_id, created_at);
CREATE INDEX IF NOT EXISTS device_boot_metrics_org_device_idx
  ON device_boot_metrics(org_id, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_boot_metrics_device_boot_uniq
  ON device_boot_metrics(device_id, boot_timestamp);

-- ============================================
-- RLS policies
-- ============================================

ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_logs_org_isolation ON agent_logs;
CREATE POLICY agent_logs_org_isolation ON agent_logs
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE ai_action_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_action_plans_org_isolation ON ai_action_plans;
CREATE POLICY ai_action_plans_org_isolation ON ai_action_plans
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE ai_screenshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_screenshots_org_isolation ON ai_screenshots;
CREATE POLICY ai_screenshots_org_isolation ON ai_screenshots
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE brain_device_context ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brain_device_context_org_isolation ON brain_device_context;
CREATE POLICY brain_device_context_org_isolation ON brain_device_context
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );

ALTER TABLE device_boot_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_boot_metrics_org_isolation ON device_boot_metrics;
CREATE POLICY device_boot_metrics_org_isolation ON device_boot_metrics
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );
