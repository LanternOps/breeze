-- Wisp W04 (#9910, feature #9906): the durable conversation thread (Wisp
-- design §6; w00 A10 / A24).
--
-- One `wisp_threads` row per grant (UNIQUE grant_id): the running summary a
-- later session is seeded with, plus the org the thread is focused on.
-- `wisp_thread_sessions` links each ai_sessions row created under the grant to
-- its thread; `wisp_thread_attachments` holds the text files a user dropped on
-- the thread (the bytes live in ai_run_artifacts; the row is the handle).
-- ai_sessions gains the grant + revision the session was created under.
--
-- Tenancy:
--  * wisp_threads, wisp_thread_sessions — shape 3 (partner-axis):
--    ONE FOR ALL policy each, `system OR breeze_has_partner_access(partner_id)`,
--    so all four DML commands are covered by breeze_has_partner_access (strict
--    rls-coverage). Both are in PARTNER_TENANT_TABLES. wisp_thread_sessions
--    also carries the session's org_id, which is NOT its tenancy axis, so it is
--    in ORG_AXIS_POLICY_EXCLUDED_TABLES too (dual-list trap) and registered in
--    CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts (repoint-dedupe on its
--    PK; session_id is unique, so a merge never collides) and
--    CORE_TENANT_EXPORT_POLICY. Precedent: migration_window_orgs
--    (2026-12-25-120000-migration-windows.sql).
--  * wisp_thread_attachments — shape 1 (org-axis, `breeze_has_org_access(org_id)`,
--    auto-discovered by rls-coverage) with partner_id denormalised for the
--    thread FK. Registered in all three org registries.
--
-- wisp_threads.focus_org_id is a nullable org pointer on a partner-axis table:
-- composite FK (focus_org_id, partner_id) -> organizations(id, partner_id)
-- ON DELETE SET NULL (focus_org_id) — the PG 15+ column-list form; a plain
-- SET NULL would null partner_id too and fail NOT NULL. The stack runs
-- pgvector/pgvector:pg16. Org merge: wisp_threads has no org_id column, so it
-- is not a merge participant. A thread focused on a merged-away (loser) org
-- keeps pointing at the loser shell until the shell is erased, when the FK
-- clears it; the focus is re-checked against the grant ceiling at every
-- session create (w00 A24), which the loser shell no longer passes, and the
-- user re-focuses.
--
-- ai_sessions.wisp_grant_id / wisp_grant_revision_id: both-or-none CHECK, and
-- ONE composite FK (wisp_grant_revision_id, wisp_grant_id) ->
-- wisp_grant_revisions(id, grant_id) ON DELETE SET NULL (both columns). The
-- revision's own FK proves the grant exists, so no separate grant FK is
-- declared: two single-column SET NULL FKs would each null one column in its
-- own RI action and trip the pair CHECK when a grant is erased (the revisions
-- cascade with the grant, which then nulls both session columns at once — the
-- same shape as ai_agent_runs_grant_revision_fk in the W02 migration). FKs
-- are SQL-only in Drizzle (same rule as ai_sessions.agent_id).
--
-- Composite FKs whose target includes an org_id column are DEFERRABLE
-- INITIALLY IMMEDIATE (org merge defers constraints). Status-like columns:
-- none. wisp_grants_id_partner_uq already ships from the W02 migration
-- (2027-01-04-100100-wisp-grants.sql); ai_run_artifacts has no (id, org_id)
-- unique, so it is added here for the attachment FK.
--
-- DDL only — writes no rows, so no breeze.scope election (set_config) is
-- needed. Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- ---------------------------------------------------------------------------
-- 1. wisp_threads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id           uuid NOT NULL,
  partner_id         uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  summary            text NOT NULL DEFAULT '',
  summary_updated_at timestamptz,
  -- Typed reference, no FK: a closed session may be erased before its thread.
  last_session_id    uuid,
  -- w00 A24 / spec §6.1 (1): the customer this thread is "working on"; NULL = unfocused.
  focus_org_id       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One thread per grant (spec §6).
  CONSTRAINT wisp_threads_grant_uq UNIQUE (grant_id),
  -- Target of the two child tables' composite thread FKs.
  CONSTRAINT wisp_threads_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT wisp_threads_summary_len_chk CHECK (char_length(summary) <= 4000)
);

-- A thread always carries its grant's partner; it dies with the grant.
DO $$ BEGIN
  ALTER TABLE wisp_threads
    ADD CONSTRAINT wisp_threads_grant_fk
    FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_threads
    ADD CONSTRAINT wisp_threads_focus_org_fk
    FOREIGN KEY (focus_org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE SET NULL (focus_org_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS wisp_threads_partner_idx ON wisp_threads (partner_id);
-- The focus FK's SET NULL scan on org erasure.
CREATE INDEX IF NOT EXISTS wisp_threads_focus_org_idx ON wisp_threads (focus_org_id) WHERE focus_org_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. wisp_thread_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_thread_sessions (
  thread_id   uuid NOT NULL,
  session_id  uuid NOT NULL,
  partner_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_thread_sessions_pkey PRIMARY KEY (thread_id, session_id),
  -- A session belongs to one thread.
  CONSTRAINT wisp_thread_sessions_session_uq UNIQUE (session_id)
);

DO $$ BEGIN
  ALTER TABLE wisp_thread_sessions
    ADD CONSTRAINT wisp_thread_sessions_thread_fk
    FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- org_id is the session's own org (ai_sessions_id_org_uidx ships from
-- 2026-10-15-160102-ai-budget-reservation-session-org-fk.sql).
DO $$ BEGIN
  ALTER TABLE wisp_thread_sessions
    ADD CONSTRAINT wisp_thread_sessions_session_fk
    FOREIGN KEY (session_id, org_id) REFERENCES ai_sessions (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ...and that org belongs to the thread's partner.
DO $$ BEGIN
  ALTER TABLE wisp_thread_sessions
    ADD CONSTRAINT wisp_thread_sessions_org_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Org cascade / org merge reach these rows by org_id; partner erasure by partner_id.
CREATE INDEX IF NOT EXISTS wisp_thread_sessions_org_idx ON wisp_thread_sessions (org_id);
CREATE INDEX IF NOT EXISTS wisp_thread_sessions_partner_idx ON wisp_thread_sessions (partner_id);
CREATE INDEX IF NOT EXISTS wisp_thread_sessions_thread_attached_idx ON wisp_thread_sessions (thread_id, attached_at DESC);

-- ---------------------------------------------------------------------------
-- 3. wisp_thread_attachments (w00 A24 / spec §6.1 (2))
-- ---------------------------------------------------------------------------
-- Target of the composite attachment -> artifact FK (no (id, org_id) unique
-- existed on ai_run_artifacts).
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_artifacts_id_org_uq ON ai_run_artifacts (id, org_id);

CREATE TABLE IF NOT EXISTS wisp_thread_attachments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid NOT NULL,
  partner_id       uuid NOT NULL,
  -- The artifact's org (= the thread's focus org at upload time, or the grant org).
  org_id           uuid NOT NULL,
  -- The handle the model reads with read_artifact.
  artifact_id      uuid NOT NULL,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  label            varchar(200) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_thread_attachments_thread_artifact_uq UNIQUE (thread_id, artifact_id)
);

DO $$ BEGIN
  ALTER TABLE wisp_thread_attachments
    ADD CONSTRAINT wisp_thread_attachments_thread_fk
    FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads (id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_thread_attachments
    ADD CONSTRAINT wisp_thread_attachments_org_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Artifact expiry (the sweeper's delete) removes the attachment.
DO $$ BEGIN
  ALTER TABLE wisp_thread_attachments
    ADD CONSTRAINT wisp_thread_attachments_artifact_fk
    FOREIGN KEY (artifact_id, org_id) REFERENCES ai_run_artifacts (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS wisp_thread_attachments_org_idx ON wisp_thread_attachments (org_id);
CREATE INDEX IF NOT EXISTS wisp_thread_attachments_partner_idx ON wisp_thread_attachments (partner_id);
CREATE INDEX IF NOT EXISTS wisp_thread_attachments_thread_created_idx ON wisp_thread_attachments (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wisp_thread_attachments_artifact_idx ON wisp_thread_attachments (artifact_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — ENABLE + FORCE in the creating file; one FOR ALL policy per table
-- ---------------------------------------------------------------------------
ALTER TABLE wisp_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_threads FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY wisp_threads_partner_access ON wisp_threads
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE wisp_thread_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_thread_sessions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY wisp_thread_sessions_partner_access ON wisp_thread_sessions
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE wisp_thread_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_thread_attachments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY wisp_thread_attachments_org_access ON wisp_thread_attachments
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The API connects as the unprivileged app role; without these grants every
-- statement is a 42501 regardless of the policies. DELETE is needed by the org
-- cascade and partner erasure; UPDATE by org merge.
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_threads TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_thread_sessions TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_thread_attachments TO breeze_app;

-- ---------------------------------------------------------------------------
-- 5. ai_sessions: the grant + revision a Wisp session was created under
-- ---------------------------------------------------------------------------
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS wisp_grant_id uuid;
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS wisp_grant_revision_id uuid;

DO $$ BEGIN
  ALTER TABLE ai_sessions
    ADD CONSTRAINT ai_sessions_wisp_grant_pair_chk
    CHECK ((wisp_grant_id IS NULL) = (wisp_grant_revision_id IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE ai_sessions VALIDATE CONSTRAINT ai_sessions_wisp_grant_pair_chk;

-- Both columns fall to NULL together when the revision goes (it goes only with
-- its grant, by erasure), so the pair CHECK holds through the RI action.
DO $$ BEGIN
  ALTER TABLE ai_sessions
    ADD CONSTRAINT ai_sessions_wisp_grant_revision_fk
    FOREIGN KEY (wisp_grant_revision_id, wisp_grant_id) REFERENCES wisp_grant_revisions (id, grant_id)
    ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE ai_sessions VALIDATE CONSTRAINT ai_sessions_wisp_grant_revision_fk;

CREATE INDEX IF NOT EXISTS ai_sessions_wisp_grant_idx ON ai_sessions (wisp_grant_id) WHERE wisp_grant_id IS NOT NULL;

-- The composite FK above ties the revision to its grant but not the grant to
-- the session's tenant. This guard (the ai_sessions twin of W02's
-- wisp_grant_link_tenant_guard, which keys on grant_id/org_id and so cannot be
-- attached here) refuses a pin whose grant belongs to another partner or is
-- scoped to another org (23503), and makes the pin immutable after insert
-- (42501) except for the RI action that nulls both columns when the revision
-- is erased with its grant (trigger depth > 1). It fires only on the grant
-- columns, so org merge repointing ai_sessions.org_id never runs it.
-- SECURITY DEFINER: the inserting request context may be org-scoped (a
-- partner-wide grant opened from an org token) and cannot see the partner-axis
-- wisp_grants row; the function only reads to validate (device_commands
-- incarnation stamp precedent).
CREATE OR REPLACE FUNCTION public.ai_sessions_wisp_grant_tenant_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT (pg_trigger_depth() > 1 AND NEW.wisp_grant_id IS NULL AND NEW.wisp_grant_revision_id IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'ai_sessions: the Wisp grant pin is immutable after the session is created';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.wisp_grant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM wisp_grants g
      JOIN organizations o ON o.partner_id = g.partner_id
     WHERE g.id = NEW.wisp_grant_id
       AND o.id = NEW.org_id
       AND (g.org_id IS NULL OR g.org_id = NEW.org_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = format('ai_sessions: Wisp grant %s is not in the tenant scope of org %s', NEW.wisp_grant_id, NEW.org_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_sessions_wisp_grant_tenant_guard ON ai_sessions;
CREATE TRIGGER ai_sessions_wisp_grant_tenant_guard
  BEFORE INSERT OR UPDATE OF wisp_grant_id, wisp_grant_revision_id ON ai_sessions
  FOR EACH ROW EXECUTE FUNCTION public.ai_sessions_wisp_grant_tenant_guard();
