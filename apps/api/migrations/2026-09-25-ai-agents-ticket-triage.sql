-- Phase 2 wave P2-4 (#4187 / #4191): AI ticket triage.
--   1. tickets: composite-FK target (id, org_id) + field_provenance
--      (per-field authorship map — 'user' | 'ai_agent' | 'system').
--   2. action_intents: composite-FK target (id, org_id), needed as the FK
--      target for ticket_drafts.intent_id below (action_intents had no such
--      unique index before this migration — ai_agent_runs already got one in
--      2026-09-05-a-agent-originated-intents.sql).
--   3. ticket_drafts (Shape 1, forced RLS): the reply/resolution-note an
--      agent proposes for a ticket, consumed by a human approval before it
--      becomes a real ticket_comments row.
--   4. action_intents: typed ticket scope (scope_kind admits 'ticket'
--      alongside P2-2's 'device'; scope_ticket_id composite-FK'd to
--      tickets(id, org_id) so a forged cross-tenant pointer is 23503 even
--      under system context — deliberately stronger than scope_device_id's
--      plain single-column FK, a Task-2 design choice per the P2-4 plan).
--   5. ai_agent_runs.profile CHECK admits 'triage'.
--   6. ticket_comments: one-AI-note-per-run partial unique index (the FK
--      from agent_run_id to ai_agent_runs already exists, added inline by
--      2026-09-19-ai-agents-ticket-shadow.sql's `ADD COLUMN ...
--      REFERENCES ...` — verified via \d ticket_comments below; no need to
--      re-declare it here).
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. tickets --------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS tickets_id_org_uq ON tickets (id, org_id);
-- Per-field authorship map for AI-assisted edits (subject/description/
-- category/priority/etc — keys are ticket column names, values are the
-- principal kind that last set that field). NOT NULL DEFAULT '{}' so every
-- pre-existing row backfills to "nobody has attributed this field yet"
-- rather than NULL, matching action_intents.arguments' jsonb-default
-- convention. Classified excludedOpen in the export policy (jsonb —
-- CLAUDE.md: any json/jsonb/bytea column is excludedOpen regardless of
-- contents) since a provenance map is itself information about who wrote
-- what, not raw customer content.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS field_provenance jsonb NOT NULL DEFAULT '{}';

-- 2. action_intents composite-FK target ------------------------------------
-- Composite-FK target: unique on (id, org_id) so ticket_drafts.intent_id can
-- reference it the same way action_intents.requesting_agent_run_id already
-- references ai_agent_runs(id, org_id) (2026-09-05-a). Redundant with the
-- existing PRIMARY KEY(id) for lookups; exists solely because a composite FK
-- needs a UNIQUE constraint/index over exactly its referenced column list.
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_id_org_uq ON action_intents (id, org_id);

-- 3. ticket_drafts (Shape 1, forced RLS) -----------------------------------
CREATE TABLE IF NOT EXISTS ticket_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  run_id uuid,
  intent_id uuid,
  kind text NOT NULL CONSTRAINT ticket_drafts_kind_chk CHECK (kind IN ('reply', 'resolution_note')),
  content text NOT NULL,
  state text NOT NULL DEFAULT 'active' CONSTRAINT ticket_drafts_state_chk CHECK (state IN ('active', 'consumed', 'discarded', 'superseded')),
  superseded_by uuid REFERENCES ticket_drafts(id) ON DELETE SET NULL,
  consumed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_drafts_ticket_org_fk FOREIGN KEY (ticket_id, org_id) REFERENCES tickets (id, org_id) ON DELETE CASCADE,
  CONSTRAINT ticket_drafts_consumed_chk CHECK (state <> 'consumed' OR (consumed_by IS NOT NULL AND consumed_at IS NOT NULL))
);

-- run/intent composite FKs mirror action_intents.requestingAgentRunOrgFk
-- (actionIntents.ts:325-345 / 2026-09-05-a-agent-originated-intents.sql)
-- EXACTLY, including ON DELETE RESTRICT: runs and intents are never
-- hard-deleted (ai-agents spec §2), so this is a safety net, not an active
-- cascade path. MATCH SIMPLE (the default) means a NULL run_id/intent_id
-- trivially satisfies the constraint — both columns are optional (a draft
-- need not originate from a run/intent).
DO $$ BEGIN
  ALTER TABLE ticket_drafts ADD CONSTRAINT ticket_drafts_run_org_fk
    FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE ticket_drafts ADD CONSTRAINT ticket_drafts_intent_org_fk
    FOREIGN KEY (intent_id, org_id) REFERENCES action_intents (id, org_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One active draft per (ticket, kind) — a fresh proposal supersedes the
-- prior one (state -> 'superseded') rather than coexisting with it.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_drafts_active_uq ON ticket_drafts (ticket_id, kind) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS ticket_drafts_org_idx ON ticket_drafts (org_id);
CREATE INDEX IF NOT EXISTS ticket_drafts_ticket_idx ON ticket_drafts (ticket_id);

ALTER TABLE ticket_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_drafts FORCE ROW LEVEL SECURITY;

-- RLS: direct NOT NULL org_id (Shape 1) — the canonical idiom is the plain
-- breeze_has_org_access(org_id) check with NO separate system branch:
-- breeze_has_org_access() already returns TRUE for system scope internally
-- (public.breeze_has_org_access, 0001-baseline.sql), so an explicit
-- `breeze_current_scope() = 'system' OR ...` clause is redundant here (it IS
-- needed on ai_agent_schedules only because that table's org_id is
-- NULLABLE — a dual-axis org_id XOR partner_id table, not Shape 1). Verified
-- against action_intents' own policy comment
-- (2026-07-18-action-intents.sql: "breeze_has_org_access already grants
-- system scope, so no separate system-only branch is needed") and
-- ticket_outbox's identical single-clause policy
-- (2026-09-19-ai-agents-ticket-shadow.sql).
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_drafts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_drafts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_drafts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_drafts;

CREATE POLICY breeze_org_isolation_select ON ticket_drafts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_drafts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_drafts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_drafts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_drafts TO breeze_app;

-- 4. action_intents ticket scope --------------------------------------------
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS scope_ticket_id uuid;

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_kind_chk
  CHECK (scope_kind IS NULL OR scope_kind IN ('device', 'ticket'));
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_scope_device_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_device_chk
  CHECK (scope_device_id IS NULL OR scope_kind = 'device');
DO $$ BEGIN
  ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_ticket_chk
    CHECK (scope_ticket_id IS NULL OR scope_kind = 'ticket');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite FK so a forged cross-tenant ticket pointer is 23503 even under
-- system context (deliberately stronger than scope_device_id's plain
-- single-column FK — a Task-2 design choice per the P2-4 plan). ON DELETE
-- SET NULL matches scope_device_id's tombstone treatment: the ticket's
-- eventual delete (or a moveOrg detach step in Task A3) resolves to the
-- same non-null -> NULL transition the immutability trigger below permits.
DO $$ BEGIN
  ALTER TABLE action_intents ADD CONSTRAINT action_intents_scope_ticket_org_fk
    FOREIGN KEY (scope_ticket_id, org_id) REFERENCES tickets (id, org_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS action_intents_scope_ticket_idx ON action_intents (scope_ticket_id) WHERE scope_ticket_id IS NOT NULL;

-- Extend the ONE immutable-content function (2026-09-05-a, last extended by
-- 2026-09-23-ai-agents-scheduled-sweeps.sql for scope_kind/scope_device_id).
-- Body copied verbatim from the 2026-09-23 definition plus: scope_ticket_id
-- is immutable EXCEPT for the same non-null -> NULL tombstone transition
-- scope_device_id already permits.
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 5. ai_agent_runs profile CHECK gains 'triage' ------------------------------
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk
  CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative', 'triage'));

-- 6. ticket_comments: one-AI-note-per-run ------------------------------------
-- ticket_comments.agent_run_id already carries a FK to ai_agent_runs(id) ON
-- DELETE SET NULL, added inline by
-- 2026-09-19-ai-agents-ticket-shadow.sql's `ADD COLUMN IF NOT EXISTS
-- agent_run_id UUID REFERENCES ai_agent_runs(id) ON DELETE SET NULL` — that
-- REFERENCES clause fired the first (and only) time the column was created,
-- so the FK persists under an auto-generated name
-- (ticket_comments_agent_run_id_fkey) even though ADD COLUMN IF NOT EXISTS
-- itself is a no-op on every later re-run. Re-declaring it here under a new
-- name would create a second, functionally-redundant FK constraint rather
-- than being idempotent — so this migration adds ONLY the new partial
-- unique index enforcing "at most one AI-authored comment per run".
CREATE UNIQUE INDEX IF NOT EXISTS ticket_comments_one_ai_note_per_run_uq
  ON ticket_comments (agent_run_id) WHERE agent_run_id IS NOT NULL AND origin_principal_kind = 'ai_agent';
