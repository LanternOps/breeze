-- Fleet hygiene findings (aggregate remediation, epic: fleet-hygiene-findings).
--
-- Four tables:
--   fleet_findings              - one row per detected fleet-wide problem
--                                  "episode" (metric anomaly pattern, log
--                                  correlation, reliability offenders, ...).
--   fleet_finding_devices        - live membership: which devices currently
--                                  belong to a finding.
--   fleet_remediation_runs       - a remediation attempt (script/command)
--                                  launched against a finding's members.
--   fleet_remediation_run_targets - per-device fan-out of a remediation run.
--
-- Tenancy: Shape 1 (direct org_id) on all four tables, auto-discovered by the
-- RLS coverage contract test — no allowlist entry needed. RLS is enabled AND
-- forced with all four breeze_has_org_access(org_id) policies in this same
-- migration (never deferred).
--
-- FK directions (deliberate):
--   fleet_findings.org_id -> organizations(id) ON DELETE CASCADE.
--   fleet_findings.acknowledged_by / dismissed_by -> users(id) ON DELETE SET
--     NULL: a deleted user must not strand a finding behind an FK error.
--   fleet_finding_devices.finding_id -> fleet_findings(id) ON DELETE CASCADE,
--     SINGLE-COLUMN only (no composite (finding_id, org_id) FK). This table's
--     org_id is rewritten in place by the device-move trigger when a member
--     device changes orgs, which would transiently desync it from the
--     finding's org_id; a composite FK would reject that write mid-move. The
--     next reconcile pass prunes any resulting mismatch. org_id still has its
--     own direct FK to organizations for cascade/erasure safety.
--   fleet_remediation_runs uses a COMPOSITE FK (finding_id, org_id) ->
--     fleet_findings(id, org_id) ON DELETE CASCADE, backed by the
--     fleet_findings_id_org_uq unique index below — runs are never
--     re-tenanted independently of their finding, so the composite FK is safe
--     here (unlike fleet_finding_devices above).
--   fleet_remediation_runs.created_by -> users(id) ON DELETE SET NULL.
--   fleet_remediation_run_targets.run_id -> fleet_remediation_runs(id) ON
--     DELETE CASCADE. target_device_uuid is a point-in-time SNAPSHOT of the
--     device being remediated and intentionally has NO foreign key (of any
--     kind) — it must survive the target device being deleted or moved, and
--     is deliberately not named device_id so it's never mistaken for a column
--     the device-move trigger should rewrite.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO blocks for constraints,
-- CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE
-- POLICY. gen_random_uuid() only (no gen_random_bytes -- pgcrypto is absent).

CREATE TABLE IF NOT EXISTS fleet_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind varchar(40) NOT NULL,
  semantic_key text NOT NULL,
  algorithm_version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'open',
  severity varchar(20) NOT NULL DEFAULT 'warning',
  title varchar(300) NOT NULL,
  summary text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_count integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_reconciled_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  dismiss_notes text,
  resolved_at timestamptz,
  resolution_reason varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_findings_kind_chk') THEN
    ALTER TABLE fleet_findings
      ADD CONSTRAINT fleet_findings_kind_chk
      CHECK (kind IN ('metric_anomaly_pattern', 'log_correlation', 'reliability_offenders'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_findings_status_chk') THEN
    ALTER TABLE fleet_findings
      ADD CONSTRAINT fleet_findings_status_chk
      CHECK (status IN ('open', 'acknowledged', 'dismissed', 'resolved'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_findings_severity_chk') THEN
    ALTER TABLE fleet_findings
      ADD CONSTRAINT fleet_findings_severity_chk
      CHECK (severity IN ('info', 'warning', 'error', 'critical'));
  END IF;
END $$;

-- Backs the composite FK from fleet_remediation_runs(finding_id, org_id).
CREATE UNIQUE INDEX IF NOT EXISTS fleet_findings_id_org_uq
  ON fleet_findings(id, org_id);

-- One live (unresolved) episode per (org, kind, semantic_key, algorithm
-- version) -- a new episode can only open once the prior one resolves.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_findings_live_episode_uq
  ON fleet_findings(org_id, kind, semantic_key, algorithm_version)
  WHERE resolved_at IS NULL;

-- Findings feed: list/filter by org, status, severity, ordered by recency.
CREATE INDEX IF NOT EXISTS fleet_findings_feed_idx
  ON fleet_findings(org_id, status, severity, last_seen_at);

-- RLS: direct org_id (Shape 1) -- standard org isolation, enabled AND forced.
ALTER TABLE fleet_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_findings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_findings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_findings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_findings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_findings;

CREATE POLICY breeze_org_isolation_select ON fleet_findings FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON fleet_findings FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON fleet_findings FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON fleet_findings FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_findings TO breeze_app;

-- fleet_finding_devices: live membership -- which devices currently belong
-- to a finding. device_id is NOT the primary key alone; a device can only
-- belong once per finding.
CREATE TABLE IF NOT EXISTS fleet_finding_devices (
  finding_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  source_kind varchar(40) NOT NULL,
  source_row_id uuid,
  member_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (finding_id, device_id)
);

DO $$
BEGIN
  -- Single-column FK on finding_id ONLY (see header note): the device-move
  -- trigger rewrites this table's org_id independently of fleet_findings, so
  -- a composite (finding_id, org_id) FK would break mid-move.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_finding_devices_finding_fk') THEN
    ALTER TABLE fleet_finding_devices
      ADD CONSTRAINT fleet_finding_devices_finding_fk
      FOREIGN KEY (finding_id) REFERENCES fleet_findings(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fleet_finding_devices_org_idx
  ON fleet_finding_devices(org_id);
CREATE INDEX IF NOT EXISTS fleet_finding_devices_device_idx
  ON fleet_finding_devices(device_id);

-- RLS: direct org_id (Shape 1) -- standard org isolation, enabled AND forced.
ALTER TABLE fleet_finding_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_finding_devices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_finding_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_finding_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_finding_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_finding_devices;

CREATE POLICY breeze_org_isolation_select ON fleet_finding_devices FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON fleet_finding_devices FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON fleet_finding_devices FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON fleet_finding_devices FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_finding_devices TO breeze_app;

-- fleet_remediation_runs: a remediation attempt (script/command) launched
-- against a finding's current membership.
CREATE TABLE IF NOT EXISTS fleet_remediation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL,
  finding_revision bigint NOT NULL,
  action_kind varchar(20) NOT NULL,
  script_id uuid,
  command_type varchar(60),
  parameter_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'queued',
  target_count integer NOT NULL DEFAULT 0,
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

DO $$
BEGIN
  -- Composite FK (finding_id, org_id) -- safe here because runs are never
  -- independently re-tenanted (unlike fleet_finding_devices). Backed by
  -- fleet_findings_id_org_uq.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_remediation_runs_finding_org_fk') THEN
    ALTER TABLE fleet_remediation_runs
      ADD CONSTRAINT fleet_remediation_runs_finding_org_fk
      FOREIGN KEY (finding_id, org_id) REFERENCES fleet_findings(id, org_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_remediation_runs_action_kind_chk') THEN
    ALTER TABLE fleet_remediation_runs
      ADD CONSTRAINT fleet_remediation_runs_action_kind_chk
      CHECK (action_kind IN ('script', 'command'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_remediation_runs_status_chk') THEN
    ALTER TABLE fleet_remediation_runs
      ADD CONSTRAINT fleet_remediation_runs_status_chk
      CHECK (status IN ('queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fleet_remediation_runs_org_status_idx
  ON fleet_remediation_runs(org_id, status, created_at);
CREATE INDEX IF NOT EXISTS fleet_remediation_runs_finding_idx
  ON fleet_remediation_runs(finding_id);

-- RLS: direct org_id (Shape 1) -- standard org isolation, enabled AND forced.
ALTER TABLE fleet_remediation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_remediation_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_remediation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_remediation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_remediation_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_remediation_runs;

CREATE POLICY breeze_org_isolation_select ON fleet_remediation_runs FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON fleet_remediation_runs FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON fleet_remediation_runs FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON fleet_remediation_runs FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_remediation_runs TO breeze_app;

-- fleet_remediation_run_targets: per-device fan-out of a remediation run.
CREATE TABLE IF NOT EXISTS fleet_remediation_run_targets (
  run_id uuid NOT NULL REFERENCES fleet_remediation_runs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_device_uuid uuid NOT NULL,
  hostname_snapshot varchar(255),
  site_id_snapshot uuid,
  status varchar(20) NOT NULL DEFAULT 'pending',
  device_command_id uuid,
  result_summary text,
  skip_reason varchar(80),
  queued_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, target_device_uuid)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fleet_remediation_run_targets_status_chk') THEN
    ALTER TABLE fleet_remediation_run_targets
      ADD CONSTRAINT fleet_remediation_run_targets_status_chk
      CHECK (status IN ('pending', 'queued', 'succeeded', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fleet_remediation_run_targets_org_idx
  ON fleet_remediation_run_targets(org_id);
CREATE INDEX IF NOT EXISTS fleet_remediation_run_targets_status_idx
  ON fleet_remediation_run_targets(run_id, status);

-- RLS: direct org_id (Shape 1) -- standard org isolation, enabled AND forced.
ALTER TABLE fleet_remediation_run_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_remediation_run_targets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON fleet_remediation_run_targets;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON fleet_remediation_run_targets;
DROP POLICY IF EXISTS breeze_org_isolation_update ON fleet_remediation_run_targets;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON fleet_remediation_run_targets;

CREATE POLICY breeze_org_isolation_select ON fleet_remediation_run_targets FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON fleet_remediation_run_targets FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON fleet_remediation_run_targets FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON fleet_remediation_run_targets FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_remediation_run_targets TO breeze_app;
