-- Persisted alert correlation groups (Phase 2).
-- Direct org_id RLS shape 1 for both tables.
-- Idempotent throughout. autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS alert_correlation_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  group_key VARCHAR(255) NOT NULL,
  root_alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'open',
  score NUMERIC(3, 2),
  noise_reduction_percent INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT alert_correlation_groups_status_check CHECK (
    status IN ('open', 'acknowledged', 'resolved', 'dismissed', 'split', 'merged')
  ),
  CONSTRAINT alert_correlation_groups_score_check CHECK (
    score IS NULL OR (score >= 0 AND score <= 1)
  ),
  CONSTRAINT alert_correlation_groups_noise_reduction_check CHECK (
    noise_reduction_percent >= 0 AND noise_reduction_percent <= 100
  ),
  CONSTRAINT alert_correlation_groups_member_count_check CHECK (member_count >= 0),
  CONSTRAINT alert_correlation_groups_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT alert_correlation_groups_metadata_size_check CHECK (octet_length(metadata::text) <= 8192)
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_correlation_groups_org_key_uq
  ON alert_correlation_groups (org_id, group_key);

CREATE INDEX IF NOT EXISTS alert_correlation_groups_org_status_seen_idx
  ON alert_correlation_groups (org_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS alert_correlation_groups_root_alert_idx
  ON alert_correlation_groups (root_alert_id);

CREATE TABLE IF NOT EXISTS alert_correlation_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  group_id UUID NOT NULL REFERENCES alert_correlation_groups(id) ON DELETE CASCADE,
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  role VARCHAR(40) NOT NULL DEFAULT 'related',
  confidence NUMERIC(3, 2),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT alert_correlation_members_role_check CHECK (role IN ('root', 'related')),
  CONSTRAINT alert_correlation_members_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT alert_correlation_members_evidence_object_check CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT alert_correlation_members_evidence_size_check CHECK (octet_length(evidence::text) <= 8192)
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_correlation_members_group_alert_uq
  ON alert_correlation_members (group_id, alert_id);

CREATE INDEX IF NOT EXISTS alert_correlation_members_org_alert_idx
  ON alert_correlation_members (org_id, alert_id);

CREATE INDEX IF NOT EXISTS alert_correlation_members_org_group_idx
  ON alert_correlation_members (org_id, group_id);

ALTER TABLE alert_correlation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_correlation_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_correlation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_correlation_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON alert_correlation_groups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON alert_correlation_groups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON alert_correlation_groups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON alert_correlation_groups;

CREATE POLICY breeze_org_isolation_select ON alert_correlation_groups
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON alert_correlation_groups
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON alert_correlation_groups
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON alert_correlation_groups
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select ON alert_correlation_members;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON alert_correlation_members;
DROP POLICY IF EXISTS breeze_org_isolation_update ON alert_correlation_members;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON alert_correlation_members;

CREATE POLICY breeze_org_isolation_select ON alert_correlation_members
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON alert_correlation_members
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON alert_correlation_members
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON alert_correlation_members
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE alert_correlation_groups TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE alert_correlation_members TO breeze_app;
