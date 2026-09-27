-- AI Suggested Fixes W1 (Foundation): fix_outcomes + fix_memory.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-26-ai-suggested-fixes-fix-memory-design.md
--
-- fix_outcomes — tenancy shape 1 (direct org_id). One row per attempt; the only
--   place private detail (source ids, facets) lives. partner_id is denormalised
--   for partner-scoped rebuilds and pinned by a composite FK to
--   organizations(id, partner_id), DEFERRABLE INITIALLY IMMEDIATE per CLAUDE.md
--   (org merge runs SET CONSTRAINTS ALL DEFERRED). device_id carries NO FK:
--   outcome history is not re-stamped on a device move (same owner decision as
--   ai_agent_fix_watches) and is removed by the device cascade list on delete.
--   Excluded from breeze_device_child_orgid_tables() (section 4) so the
--   devices-UPDATE trigger never re-stamps it — a cross-partner device move
--   would otherwise violate fix_outcomes_org_partner_fk.
--
-- fix_memory — derived aggregate, org_id XOR partner_id (Partner-Wide First).
--   One FOR ALL dual-axis policy plus a SEPARATE FOR SELECT partner-wide branch
--   (template 2026-10-05-110000-config-policy-partner-wide-select.sql) so org
--   tokens and headless agent runs read their partner's shareable memory
--   without widening UPDATE/DELETE targeting.
--
-- Idempotent throughout. DDL only (no row writes, so no breeze.scope elevation).
-- No inner BEGIN/COMMIT — autoMigrate wraps this file in one transaction.

-- ---------------------------------------------------------------------------
-- 1. fix_outcomes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fix_outcomes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  partner_id            uuid NOT NULL,
  device_id             uuid NOT NULL,
  suggestion_id         uuid REFERENCES remediation_suggestions(id) ON DELETE SET NULL,
  source_type           varchar(20) NOT NULL,
  source_id             varchar(255) NOT NULL,
  alert_id              uuid REFERENCES alerts(id) ON DELETE SET NULL,
  anomaly_episode_id    uuid REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL,
  signature_version     smallint,
  signature_key         char(64),
  broad_key             char(64),
  signature_facets      jsonb,
  os_type               varchar(20),
  fix_kind              varchar(30) NOT NULL,
  fix_identity          varchar(200),
  script_id             uuid REFERENCES scripts(id) ON DELETE SET NULL,
  script_version_id     uuid REFERENCES script_versions(id) ON DELETE SET NULL,
  builtin_action        varchar(60),
  playbook_id           uuid REFERENCES playbook_definitions(id) ON DELETE SET NULL,
  instructions_ref      varchar(120),
  script_execution_id   uuid REFERENCES script_executions(id) ON DELETE SET NULL,
  state                 varchar(30) NOT NULL DEFAULT 'pending',
  state_reason          varchar(80),
  human_vote            varchar(10),
  voted_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  voted_at              timestamptz,
  recovered_at          timestamptz,
  deadline_at           timestamptz NOT NULL,
  holding_until         timestamptz,
  terminal_at           timestamptz,
  counted_at            timestamptz,
  recount_requested_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fix_outcomes_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fix_outcomes_state_chk CHECK (state IN ('pending', 'awaiting_recovery', 'holding', 'verified', 'failed', 'recurred', 'inconclusive', 'cancelled')),
  CONSTRAINT fix_outcomes_fix_kind_chk CHECK (fix_kind IN ('system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps')),
  CONSTRAINT fix_outcomes_source_type_chk CHECK (source_type IN ('alert', 'anomaly', 'correlation', 'rca')),
  CONSTRAINT fix_outcomes_human_vote_chk CHECK (human_vote IN ('up', 'down')),
  CONSTRAINT fix_outcomes_terminal_shape_chk
    CHECK ((terminal_at IS NULL) = (state IN ('pending', 'awaiting_recovery', 'holding'))),
  CONSTRAINT fix_outcomes_counted_shape_chk CHECK (counted_at IS NULL OR terminal_at IS NOT NULL),
  CONSTRAINT fix_outcomes_signature_shape_chk
    CHECK ((signature_key IS NULL) = (signature_version IS NULL) AND (signature_key IS NULL) = (broad_key IS NULL))
);

-- One suggestion is one attempt (spec). Partial: suggestion_id is SET NULL by
-- ML output retention and must not collide then.
CREATE UNIQUE INDEX IF NOT EXISTS fix_outcomes_suggestion_uq
  ON fix_outcomes (suggestion_id) WHERE suggestion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_active_idx
  ON fix_outcomes (state, deadline_at) WHERE state IN ('pending', 'awaiting_recovery', 'holding');
CREATE INDEX IF NOT EXISTS fix_outcomes_org_created_idx ON fix_outcomes (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fix_outcomes_device_state_idx ON fix_outcomes (device_id, state);
CREATE INDEX IF NOT EXISTS fix_outcomes_execution_idx ON fix_outcomes (script_execution_id) WHERE script_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_alert_idx ON fix_outcomes (alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_identity_idx
  ON fix_outcomes (partner_id, signature_key, os_type, fix_identity) WHERE counted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_recount_idx
  ON fix_outcomes (recount_requested_at) WHERE recount_requested_at IS NOT NULL;

ALTER TABLE fix_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fix_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fix_outcomes_isolation ON fix_outcomes;
CREATE POLICY fix_outcomes_isolation ON fix_outcomes
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON fix_outcomes TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. fix_memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fix_memory (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id            uuid REFERENCES partners(id) ON DELETE CASCADE,
  signature_version     smallint NOT NULL,
  signature_key         char(64) NOT NULL,
  broad_key             char(64) NOT NULL,
  os_type               varchar(20) NOT NULL,
  fix_kind              varchar(30) NOT NULL,
  fix_identity          varchar(200) NOT NULL,
  script_id             uuid REFERENCES scripts(id) ON DELETE CASCADE,
  script_version_id     uuid REFERENCES script_versions(id) ON DELETE CASCADE,
  builtin_action        varchar(60),
  playbook_id           uuid REFERENCES playbook_definitions(id) ON DELETE CASCADE,
  instructions_ref      varchar(120),
  attempts              integer NOT NULL DEFAULT 0,
  verified_count        integer NOT NULL DEFAULT 0,
  failed_count          integer NOT NULL DEFAULT 0,
  recurred_count        integer NOT NULL DEFAULT 0,
  up_votes              integer NOT NULL DEFAULT 0,
  down_votes            integer NOT NULL DEFAULT 0,
  rolling_success_rate  double precision NOT NULL DEFAULT 0,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  consecutive_verified  integer NOT NULL DEFAULT 0,
  recent_outcomes       text[] NOT NULL DEFAULT '{}'::text[],
  status                varchar(20) NOT NULL DEFAULT 'active',
  retired_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  retired_at            timestamptz,
  last_verified_at      timestamptz,
  stale_since           timestamptz,
  -- Durable org-erasure rebuild requests (Task 12 markFixMemoryStaleForOrgErasure).
  -- Each id is an org whose counted outcomes fed this partner row when its erasure
  -- started. A rebuild removes an id only once that org's organizations row is
  -- gone (the cascade deletes it LAST), checked BEFORE the rebuild reads
  -- contributions. stale_since is cleared only when this is empty, so a rebuild
  -- that races the cascade, or a failed post-cascade rebuild, can never
  -- un-stale a row that still counts erased contributions. No FK: the id must
  -- outlive the org. Partner rows only (org rows die in the org cascade).
  rebuild_pending_org_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fix_memory_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT fix_memory_status_chk CHECK (status IN ('active', 'demoted', 'retired')),
  CONSTRAINT fix_memory_fix_kind_chk CHECK (fix_kind IN ('system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps')),
  CONSTRAINT fix_memory_rate_chk CHECK (rolling_success_rate >= 0 AND rolling_success_rate <= 1)
);

-- Owner identity. Two partials because org rows carry partner_id NULL (XOR).
CREATE UNIQUE INDEX IF NOT EXISTS fix_memory_org_identity_uq
  ON fix_memory (org_id, signature_version, signature_key, os_type, fix_identity) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fix_memory_partner_identity_uq
  ON fix_memory (partner_id, signature_version, signature_key, os_type, fix_identity) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_partner_id_idx ON fix_memory (partner_id);
CREATE INDEX IF NOT EXISTS fix_memory_lookup_idx ON fix_memory (signature_version, os_type, signature_key);
CREATE INDEX IF NOT EXISTS fix_memory_broad_idx ON fix_memory (signature_version, os_type, broad_key);
CREATE INDEX IF NOT EXISTS fix_memory_script_idx ON fix_memory (script_id) WHERE script_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_stale_idx ON fix_memory (stale_since) WHERE stale_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_rebuild_pending_idx
  ON fix_memory (partner_id) WHERE cardinality(rebuild_pending_org_ids) > 0;

ALTER TABLE fix_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE fix_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fix_memory_isolation ON fix_memory;
CREATE POLICY fix_memory_isolation ON fix_memory
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- SELECT-only, never appended to the FOR ALL policy above (that would widen
-- UPDATE/DELETE targeting to partner rows for org tokens). `=` not
-- IS NOT DISTINCT FROM: a NULL current partner must match nothing.
DROP POLICY IF EXISTS fix_memory_partner_wide_select ON fix_memory;
CREATE POLICY fix_memory_partner_wide_select
  ON fix_memory
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON fix_memory TO breeze_app;

-- ---------------------------------------------------------------------------
-- 3. (no data backfill — both tables start empty)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. breeze_device_child_orgid_tables(): exclude fix_outcomes
-- ---------------------------------------------------------------------------
-- The helper is DYNAMIC (every public table with uuid device_id + uuid org_id,
-- minus this list), so section 1 silently enrolled fix_outcomes in the
-- device-move re-stamp loop. Outcome history stays with the org the attempt ran
-- in, and re-stamping org_id alone would violate fix_outcomes_org_partner_fk on
-- a cross-partner device move. Body copied VERBATIM from the newest definition,
-- 2026-10-26-160000-ai-operator-task-graph.sql section 8 (verified: no later
-- migration redefines it — re-run
-- `grep -l breeze_device_child_orgid_tables apps/api/migrations/*` before
-- committing and re-copy from the newest hit if that changed), with
-- 'fix_outcomes' added to the NOT IN list.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    -- fix_outcomes (AI Suggested Fixes W1): attempt history stays with the org
    -- the attempt ran in; (org_id, partner_id) composite FK would 23503 on a
    -- cross-partner move. The outcome sweeper cancels in-flight rows whose
    -- device left the org.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects',
      'fix_outcomes'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
