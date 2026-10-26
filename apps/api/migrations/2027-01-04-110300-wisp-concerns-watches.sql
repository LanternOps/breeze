-- Wisp W05a (#9911, feature #9906): the triage engine's facts (Wisp design
-- §7.1–7.4, §9; w00 "Triage engine (W05)" + A12, A30, A32, A34, A35).
--
--  * wisp_concerns           — one shared fact per (partner, org, subject) while
--                              live (open/snoozed); org_id NULL = a partner-level
--                              concern (cross-customer incident, w00 A30).
--  * wisp_concern_recipients — per-grant delivery state (nudge backoff, snooze,
--                              dismiss, answer, feedback) for a concern.
--  * wisp_watches            — standing checks a user asked for; org_id NULL =
--                              every org in a partner-wide grant's ceiling.
--  * wisp_grants.last_floor_tick_at — the wake scheduler's floor-tick cursor
--                              (W05b reads/advances it; the column ships here).
--  * ai_agent_runs_grant_org_profile_queued_idx — serves the per-grant UTC-day
--                              budget sum and the assessment watermark.
--
-- Tenancy — all three tables are partner-anchored / org-optional, exactly the
-- connection_health_incidents shape (2026-12-29-100100): partner_id NOT NULL,
-- org_id NULL only for a partner-level row, ONE FOR ALL policy
--   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
--          OR (org_id IS NULL AND breeze_has_partner_access(partner_id))
-- so every DML command is covered by both helpers (strict rls-coverage), and
-- NO breeze_current_partner_id() read branch: an org token must never see a
-- partner-level concern or a partner-wide watch. All three are in
-- DUAL_AXIS_TENANT_TABLES. They STAY in CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry.ts and CORE_TENANT_EXPORT_POLICY: org rows carry org_id,
-- and the cascade's `WHERE org_id = $1` never touches partner-level rows
-- (those leave with the partner via partner_id ON DELETE CASCADE).
--
-- Subject ids are SOFT references (no FK, w00 A12): subjects span tables with
-- conflicting erasure dispositions (devices are purged, ai_agent_runs are
-- leave-for-erasure, tickets move orgs); an FK would either cascade-delete a
-- concern's history or block the purge. The column is named subject_id so the
-- device/ticket cascade-list coverage tests do not match it — those lists are
-- deliberately untouched. The retention reaper (W05b) resolves a concern whose
-- subject is gone with outcome 'subject_gone'.
--
-- wisp_concern_recipients copies org_id from its concern for RLS only (the
-- concern is the source of truth, w00 A30); its concern FK is
-- (concern_id, partner_id) -> wisp_concerns(id, partner_id) so a recipient
-- can never point across partners. Every grant reference is the composite
-- (grant_id, partner_id) -> wisp_grants(id, partner_id) for the same reason.
--
-- ai_agent_runs_profile_chk is NOT widened here: the 'assessment' profile is
-- W05b's (#9917), and aiAgentSchedulesPartnerRls.integration.test.ts asserts
-- the CHECK equals AI_AGENT_RUN_PROFILES exactly, so the CHECK moves in the
-- same change as the enum.
--
-- Composite FKs whose target includes an org_id column are DEFERRABLE
-- INITIALLY IMMEDIATE (org merge defers constraints). Status/kind columns are
-- text + CHECK. The live-subject index is NULLS NOT DISTINCT (PG 15+; the
-- stack runs pgvector/pgvector:pg16).
--
-- DDL only — writes no rows, so no breeze.scope election (set_config) is
-- needed. Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- ---------------------------------------------------------------------------
-- 1. wisp_concerns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_concerns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id           uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id               uuid NULL,
  subject_kind         text NOT NULL,
  subject_id           uuid NOT NULL,
  summary              text NOT NULL,
  severity             text NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature            text NULL,
  child_concern_ids    uuid[] NOT NULL DEFAULT '{}'::uuid[],
  raised_by_grant_id   uuid NULL,
  last_assessed_run_id uuid NULL,
  outcome              text NULL,
  resolved_at          timestamptz NULL,
  resolved_by_user_id  uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_concerns_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT wisp_concerns_subject_kind_chk CHECK (subject_kind IN (
    'ticket','device','alert','org','integration','run','task','incident','quote','invoice','contract','site'
  )),
  CONSTRAINT wisp_concerns_severity_chk CHECK (severity IN ('info','low','medium','high')),
  CONSTRAINT wisp_concerns_status_chk CHECK (status IN ('open','snoozed','resolved','dismissed')),
  CONSTRAINT wisp_concerns_summary_len_chk CHECK (char_length(summary) BETWEEN 1 AND 2000),
  CONSTRAINT wisp_concerns_outcome_len_chk CHECK (outcome IS NULL OR char_length(outcome) <= 1000),
  CONSTRAINT wisp_concerns_evidence_size_chk CHECK (pg_column_size(evidence) <= 32768),
  CONSTRAINT wisp_concerns_signature_len_chk CHECK (signature IS NULL OR char_length(signature) <= 200)
);

DO $$ BEGIN
  ALTER TABLE wisp_concerns
    ADD CONSTRAINT wisp_concerns_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A revoked-and-erased grant leaves its concerns (shared facts) behind; the
-- column-list form keeps partner_id (a plain SET NULL would null it too).
DO $$ BEGIN
  ALTER TABLE wisp_concerns
    ADD CONSTRAINT wisp_concerns_raised_by_grant_fk
    FOREIGN KEY (raised_by_grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
    ON DELETE SET NULL (raised_by_grant_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- At most one live concern per subject; NULLS NOT DISTINCT so two live
-- partner-level (org_id NULL) concerns on one subject collide too.
CREATE UNIQUE INDEX IF NOT EXISTS wisp_concerns_live_subject_uq
  ON wisp_concerns (partner_id, org_id, subject_kind, subject_id) NULLS NOT DISTINCT
  WHERE status IN ('open','snoozed');
-- The correlator's idempotency key (w00 A30).
CREATE UNIQUE INDEX IF NOT EXISTS wisp_concerns_live_signature_uq
  ON wisp_concerns (partner_id, signature)
  WHERE status IN ('open','snoozed') AND signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS wisp_concerns_partner_status_idx ON wisp_concerns (partner_id, status);
CREATE INDEX IF NOT EXISTS wisp_concerns_org_status_severity_idx ON wisp_concerns (org_id, status, severity);
-- The retention reaper's scan.
CREATE INDEX IF NOT EXISTS wisp_concerns_closed_updated_idx
  ON wisp_concerns (status, updated_at) WHERE status IN ('resolved','dismissed');
-- The raised-by-grant FK's SET NULL scan on grant erasure.
CREATE INDEX IF NOT EXISTS wisp_concerns_raised_by_grant_idx
  ON wisp_concerns (raised_by_grant_id) WHERE raised_by_grant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. wisp_concern_recipients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_concern_recipients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id             uuid NOT NULL,
  partner_id             uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Copied from the concern for RLS only (w00 A30).
  org_id                 uuid NULL,
  grant_id               uuid NOT NULL,
  nudge_count            integer NOT NULL DEFAULT 0,
  last_nudged_at         timestamptz NULL,
  next_eligible_nudge_at timestamptz NULL,
  snoozed_until          timestamptz NULL,
  dismissed_at           timestamptz NULL,
  -- Set by any user action on the concern (snooze/dismiss/resolve/reply/feedback).
  answered_at            timestamptz NULL,
  feedback               text NULL,
  feedback_at            timestamptz NULL,
  feedback_note          text NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_concern_recipients_concern_grant_uq UNIQUE (concern_id, grant_id),
  CONSTRAINT wisp_concern_recipients_nudge_count_chk CHECK (nudge_count >= 0),
  CONSTRAINT wisp_concern_recipients_feedback_chk CHECK (feedback IS NULL OR feedback IN ('useful','not_useful')),
  CONSTRAINT wisp_concern_recipients_feedback_note_len_chk CHECK (feedback_note IS NULL OR char_length(feedback_note) <= 200)
);

DO $$ BEGIN
  ALTER TABLE wisp_concern_recipients
    ADD CONSTRAINT wisp_concern_recipients_concern_fk
    FOREIGN KEY (concern_id, partner_id) REFERENCES wisp_concerns (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_concern_recipients
    ADD CONSTRAINT wisp_concern_recipients_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_concern_recipients
    ADD CONSTRAINT wisp_concern_recipients_grant_fk
    FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS wisp_concern_recipients_grant_idx ON wisp_concern_recipients (grant_id);
CREATE INDEX IF NOT EXISTS wisp_concern_recipients_org_idx ON wisp_concern_recipients (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wisp_concern_recipients_partner_idx ON wisp_concern_recipients (partner_id);

-- ---------------------------------------------------------------------------
-- 3. wisp_watches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_watches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id          uuid NULL,
  grant_id        uuid NOT NULL,
  owner_user_id   uuid NOT NULL,
  kind            text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cadence_minutes integer NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  -- The grant status that stopped it; 'paused' is read by W02's userResumeGrant (A29).
  stopped_reason  text NULL,
  last_ran_at     timestamptz NULL,
  next_due_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_watches_kind_chk CHECK (kind IN (
    'ticket_waiting','alert_pattern','backup_health','patch_compliance','security_findings','custom_query','ticket_cluster'
  )),
  CONSTRAINT wisp_watches_cadence_chk CHECK (cadence_minutes BETWEEN 15 AND 10080),
  CONSTRAINT wisp_watches_status_chk CHECK (status IN ('active','stopped')),
  CONSTRAINT wisp_watches_params_size_chk CHECK (pg_column_size(params) <= 8192),
  CONSTRAINT wisp_watches_stopped_reason_len_chk CHECK (stopped_reason IS NULL OR char_length(stopped_reason) <= 64)
);

DO $$ BEGIN
  ALTER TABLE wisp_watches
    ADD CONSTRAINT wisp_watches_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_watches
    ADD CONSTRAINT wisp_watches_grant_fk
    FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The owner is the grantor (a partner user); users_id_partner_id_key ships
-- from 2027-01-04-100100-wisp-grants.sql.
DO $$ BEGIN
  ALTER TABLE wisp_watches
    ADD CONSTRAINT wisp_watches_owner_fk
    FOREIGN KEY (owner_user_id, partner_id) REFERENCES users (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS wisp_watches_active_due_idx ON wisp_watches (status, next_due_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS wisp_watches_grant_idx ON wisp_watches (grant_id);
CREATE INDEX IF NOT EXISTS wisp_watches_org_idx ON wisp_watches (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wisp_watches_partner_idx ON wisp_watches (partner_id);
CREATE INDEX IF NOT EXISTS wisp_watches_owner_idx ON wisp_watches (owner_user_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — ENABLE + FORCE in the creating file; one FOR ALL policy per table
-- ---------------------------------------------------------------------------
ALTER TABLE wisp_concerns ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_concerns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_concerns_isolation ON wisp_concerns;
CREATE POLICY wisp_concerns_isolation ON wisp_concerns
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE wisp_concern_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_concern_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_concern_recipients_isolation ON wisp_concern_recipients;
CREATE POLICY wisp_concern_recipients_isolation ON wisp_concern_recipients
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE wisp_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_watches_isolation ON wisp_watches;
CREATE POLICY wisp_watches_isolation ON wisp_watches
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

-- The API connects as the unprivileged app role; DELETE is needed by the org
-- cascade, partner erasure and the reaper; UPDATE by org merge.
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_concerns TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_concern_recipients TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_watches TO breeze_app;

-- ---------------------------------------------------------------------------
-- 5. wisp_grants.last_floor_tick_at (W05's column on W02's table)
-- ---------------------------------------------------------------------------
ALTER TABLE wisp_grants ADD COLUMN IF NOT EXISTS last_floor_tick_at timestamptz NULL;

-- ---------------------------------------------------------------------------
-- 6. ai_agent_runs: the per-grant budget sum / assessment watermark
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ai_agent_runs_grant_org_profile_queued_idx
  ON ai_agent_runs (grant_id, org_id, profile, queued_at DESC)
  WHERE grant_id IS NOT NULL;
