DO $$
BEGIN
  CREATE TYPE incident_severity AS ENUM ('p1', 'p2', 'p3', 'p4');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE incident_status AS ENUM ('detected', 'analyzing', 'contained', 'recovering', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE incident_evidence_type AS ENUM ('file', 'log', 'screenshot', 'memory', 'network');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE incident_collected_by AS ENUM ('user', 'brain', 'system');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE incident_action_actor AS ENUM ('user', 'brain', 'system');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  classification VARCHAR(40) NOT NULL,
  severity incident_severity NOT NULL,
  status incident_status NOT NULL DEFAULT 'detected',
  summary TEXT,
  related_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_devices JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_to UUID REFERENCES users(id),
  detected_at TIMESTAMP NOT NULL,
  contained_at TIMESTAMP,
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incident_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  evidence_type incident_evidence_type NOT NULL,
  description TEXT,
  collected_at TIMESTAMP NOT NULL,
  collected_by incident_collected_by NOT NULL DEFAULT 'user',
  hash VARCHAR(128),
  storage_path TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incident_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES incidents(id),
  org_id UUID NOT NULL REFERENCES organizations(id),
  action_type VARCHAR(40) NOT NULL,
  description TEXT NOT NULL,
  executed_by incident_action_actor NOT NULL DEFAULT 'user',
  status VARCHAR(20) NOT NULL,
  result JSONB,
  reversible BOOLEAN NOT NULL DEFAULT FALSE,
  reversed BOOLEAN NOT NULL DEFAULT FALSE,
  approval_ref VARCHAR(128),
  executed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS incidents_org_status_idx ON incidents(org_id, status);
CREATE INDEX IF NOT EXISTS incidents_severity_idx ON incidents(severity);
CREATE INDEX IF NOT EXISTS incidents_assigned_to_idx ON incidents(assigned_to);
CREATE INDEX IF NOT EXISTS incidents_detected_at_idx ON incidents(detected_at);

CREATE INDEX IF NOT EXISTS incident_evidence_incident_idx ON incident_evidence(incident_id);
CREATE INDEX IF NOT EXISTS incident_evidence_org_idx ON incident_evidence(org_id);
CREATE INDEX IF NOT EXISTS incident_evidence_collected_at_idx ON incident_evidence(collected_at);

CREATE INDEX IF NOT EXISTS incident_actions_incident_idx ON incident_actions(incident_id);
CREATE INDEX IF NOT EXISTS incident_actions_org_idx ON incident_actions(org_id);
CREATE INDEX IF NOT EXISTS incident_actions_executed_at_idx ON incident_actions(executed_at);
CREATE INDEX IF NOT EXISTS incident_actions_status_idx ON incident_actions(status);
CREATE INDEX IF NOT EXISTS incident_actions_action_type_idx ON incident_actions(action_type);
CREATE INDEX IF NOT EXISTS incident_actions_org_status_idx ON incident_actions(org_id, status);
CREATE INDEX IF NOT EXISTS incident_actions_incident_executed_at_idx ON incident_actions(incident_id, executed_at);
