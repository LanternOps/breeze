-- Incident Response: enums, tables, indexes, constraints, and RLS policies.
-- Fully idempotent — safe to re-run.

-- ============================================================
-- Enums
-- ============================================================
DO $$ BEGIN
  CREATE TYPE incident_severity AS ENUM ('p1', 'p2', 'p3', 'p4');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_status AS ENUM ('detected', 'analyzing', 'contained', 'recovering', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_evidence_type AS ENUM ('file', 'log', 'screenshot', 'memory', 'network');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_collected_by AS ENUM ('user', 'brain', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_action_actor AS ENUM ('user', 'brain', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_action_status AS ENUM ('pending', 'in_progress', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE incident_hash_algorithm AS ENUM ('sha256');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Tables
-- ============================================================
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
  hash VARCHAR(64),
  hash_algorithm incident_hash_algorithm NOT NULL DEFAULT 'sha256',
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
  status incident_action_status NOT NULL DEFAULT 'completed',
  result JSONB,
  reversible BOOLEAN NOT NULL DEFAULT FALSE,
  reversed BOOLEAN NOT NULL DEFAULT FALSE,
  approval_ref VARCHAR(128),
  executed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
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

-- ============================================================
-- Constraints (hardening)
-- ============================================================
ALTER TABLE incident_evidence
  DROP CONSTRAINT IF EXISTS incident_evidence_hash_sha256_chk;
ALTER TABLE incident_evidence
  ADD CONSTRAINT incident_evidence_hash_sha256_chk
  CHECK (hash IS NULL OR hash ~ '^[0-9a-f]{64}$');

ALTER TABLE incident_evidence
  DROP CONSTRAINT IF EXISTS incident_evidence_storage_path_scheme_chk;
ALTER TABLE incident_evidence
  ADD CONSTRAINT incident_evidence_storage_path_scheme_chk
  CHECK (storage_path ~ '^[a-z][a-z0-9+.-]*://.+');

-- ============================================================
-- RLS — incidents
-- ============================================================
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incidents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incidents;

CREATE POLICY breeze_org_isolation_select ON incidents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incidents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incidents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incidents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS — incident_evidence
-- ============================================================
ALTER TABLE incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incident_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incident_evidence;

CREATE POLICY breeze_org_isolation_select ON incident_evidence
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incident_evidence
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incident_evidence
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incident_evidence
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS — incident_actions
-- ============================================================
ALTER TABLE incident_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON incident_actions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON incident_actions;

CREATE POLICY breeze_org_isolation_select ON incident_actions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON incident_actions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON incident_actions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON incident_actions
  FOR DELETE USING (public.breeze_has_org_access(org_id));
