-- Canonical ML feedback events foundation (Phase 0 / C1).
-- Append-only label capture table with direct org_id RLS shape 1.
-- Idempotent throughout. autoMigrate wraps this file in a transaction.

CREATE TABLE IF NOT EXISTS ml_feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  source_type VARCHAR(40) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  outcome VARCHAR(60) NOT NULL,
  confidence REAL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT ml_feedback_events_source_type_check CHECK (
    source_type IN ('alert', 'ticket', 'device', 'anomaly', 'correlation', 'rca', 'remediation', 'user_risk')
  ),
  CONSTRAINT ml_feedback_events_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT ml_feedback_events_metadata_object_check CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  CONSTRAINT ml_feedback_events_metadata_size_check CHECK (
    octet_length(metadata::text) <= 8192
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ml_feedback_events_dedupe_uq
  ON ml_feedback_events (source_type, source_id, event_type, occurred_at);

CREATE INDEX IF NOT EXISTS ml_feedback_events_org_occurred_idx
  ON ml_feedback_events (org_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ml_feedback_events_org_event_idx
  ON ml_feedback_events (org_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ml_feedback_events_source_idx
  ON ml_feedback_events (source_type, source_id, occurred_at DESC);

ALTER TABLE ml_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_feedback_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ml_feedback_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ml_feedback_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ml_feedback_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ml_feedback_events;

CREATE POLICY breeze_org_isolation_select ON ml_feedback_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ml_feedback_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ml_feedback_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ml_feedback_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- App role may read and append only. Tenant erasure deletes through the
-- audit-admin path used by audit_logs/audit_log_chain.
GRANT SELECT, INSERT ON TABLE ml_feedback_events TO breeze_app;
REVOKE UPDATE, DELETE ON TABLE ml_feedback_events FROM breeze_app;
GRANT SELECT, DELETE ON TABLE ml_feedback_events TO breeze_audit_admin;
REVOKE UPDATE ON TABLE ml_feedback_events FROM breeze_audit_admin;

CREATE OR REPLACE FUNCTION ml_feedback_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' AND allow_retention = '1' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'ml_feedback_events is append-only',
    HINT = 'ML feedback labels cannot be modified or deleted. Tenant erasure uses breeze_audit_admin plus the breeze.allow_audit_retention GUC (DELETE only).';
END;
$$;

DROP TRIGGER IF EXISTS ml_feedback_events_block_update ON ml_feedback_events;
CREATE TRIGGER ml_feedback_events_block_update BEFORE UPDATE ON ml_feedback_events
  FOR EACH ROW EXECUTE FUNCTION ml_feedback_events_append_only();

DROP TRIGGER IF EXISTS ml_feedback_events_block_delete ON ml_feedback_events;
CREATE TRIGGER ml_feedback_events_block_delete BEFORE DELETE ON ml_feedback_events
  FOR EACH ROW EXECUTE FUNCTION ml_feedback_events_append_only();
