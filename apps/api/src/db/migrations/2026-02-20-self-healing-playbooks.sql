DO $$
BEGIN
  CREATE TYPE playbook_execution_status AS ENUM (
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'rolled_back',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE playbook_step_type AS ENUM (
    'diagnose',
    'act',
    'wait',
    'verify',
    'rollback'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS playbook_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  steps JSONB NOT NULL,
  trigger_conditions JSONB,
  is_built_in BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  category VARCHAR(50),
  required_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playbook_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  playbook_id UUID NOT NULL REFERENCES playbook_definitions(id),
  status playbook_execution_status NOT NULL DEFAULT 'pending',
  current_step_index INTEGER NOT NULL DEFAULT 0,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  context JSONB,
  error_message TEXT,
  rollback_executed BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  triggered_by VARCHAR(50) NOT NULL,
  triggered_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS playbook_definitions_org_id_idx
  ON playbook_definitions (org_id);

CREATE INDEX IF NOT EXISTS playbook_definitions_active_idx
  ON playbook_definitions (is_active);

CREATE INDEX IF NOT EXISTS playbook_definitions_category_idx
  ON playbook_definitions (category);

CREATE INDEX IF NOT EXISTS playbook_executions_org_id_idx
  ON playbook_executions (org_id);

CREATE INDEX IF NOT EXISTS playbook_executions_device_id_idx
  ON playbook_executions (device_id);

CREATE INDEX IF NOT EXISTS playbook_executions_playbook_id_idx
  ON playbook_executions (playbook_id);

CREATE INDEX IF NOT EXISTS playbook_executions_status_idx
  ON playbook_executions (status);

CREATE INDEX IF NOT EXISTS playbook_executions_created_at_idx
  ON playbook_executions (created_at);
