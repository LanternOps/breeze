-- Wisp W02 (#9908, feature #9906): the delegation ceiling (Wisp design §4.2).
--
-- `wisp_grants` is the durable object a user creates when they turn Wisp on
-- for a scope; `wisp_grant_revisions` is the append-only history of the
-- ceiling it pins. Every run / Operator task Wisp creates carries the grant and
-- the revision it was admitted under (the two nullable column pairs at the end).
--
-- Tenancy: shape 3 (partner-axis) plus ownership constraints. `org_id` is the
-- grant's SCOPE (NULL = partner-wide), bound to the anchor partner by a
-- deferrable composite FK — it is not the tenancy axis, so the table is in
-- PARTNER_TENANT_TABLES and ORG_AXIS_POLICY_EXCLUDED_TABLES, and (because it
-- has an org_id column) in the org cascade / merge / export registries too.
--
-- Writes no rows (DDL only), so no system-scope election is needed. The
-- ai_workspace:execute permission row lives in its own file (…100110).
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- ---------------------------------------------------------------------------
-- 1. users (id, partner_id) unique — target of the composite grantor FK, so a
--    grantor is always a member of the grant's anchor partner (w00 A5).
--    2026-08-22-office-addin-user-bindings.sql already ships this exact unique
--    index (same name) for the same purpose; IF NOT EXISTS keeps this a no-op
--    there and makes the dependency explicit here.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS users_id_partner_id_key ON users (id, partner_id);

-- ---------------------------------------------------------------------------
-- 2. wisp_grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id           uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id               uuid NULL,
  grantor_user_id      uuid NOT NULL,
  grantee              text NOT NULL DEFAULT 'wisp',
  current_revision_id  uuid NULL,
  status               text NOT NULL DEFAULT 'active',
  paused_reason        text NULL,
  paused_at            timestamptz NULL,
  revoked_at           timestamptz NULL,
  revoked_by_user_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  budget_cents_per_day integer NOT NULL DEFAULT 200,
  floor_tick_minutes   integer NOT NULL DEFAULT 30,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_grants_status_chk CHECK (status IN ('active','paused','revoked','expired')),
  CONSTRAINT wisp_grants_grantee_chk CHECK (grantee IN ('wisp')),
  CONSTRAINT wisp_grants_paused_reason_chk CHECK (paused_reason IS NULL OR paused_reason IN ('grantor_access_lost','grantor_suspended','factor_expired','entitlement_lost','budget_exhausted','user_paused','partner_disabled')),
  CONSTRAINT wisp_grants_paused_shape_chk CHECK ((status = 'paused') = (paused_reason IS NOT NULL)),
  CONSTRAINT wisp_grants_budget_chk CHECK (budget_cents_per_day >= 0 AND floor_tick_minutes BETWEEN 15 AND 240)
);

-- (id, partner_id) unique: target of the revisions' composite FK (w00 A5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_grants_id_partner_uq') THEN
    ALTER TABLE wisp_grants ADD CONSTRAINT wisp_grants_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

-- Composite (org_id, partner_id) → organizations: the scope org always belongs
-- to the anchor partner. DEFERRABLE INITIALLY IMMEDIATE per the org-merge
-- contract (tenancy-rls.md), even though grants never follow a merge.
ALTER TABLE wisp_grants DROP CONSTRAINT IF EXISTS wisp_grants_org_partner_fk;
ALTER TABLE wisp_grants ADD CONSTRAINT wisp_grants_org_partner_fk
  FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- Composite (grantor_user_id, partner_id) → users: a grant borrows its
-- grantor's authority inside ONE partner and dies with the grantor.
ALTER TABLE wisp_grants DROP CONSTRAINT IF EXISTS wisp_grants_grantor_partner_fk;
ALTER TABLE wisp_grants ADD CONSTRAINT wisp_grants_grantor_partner_fk
  FOREIGN KEY (grantor_user_id, partner_id) REFERENCES users (id, partner_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS wisp_grants_partner_idx ON wisp_grants (partner_id);
CREATE INDEX IF NOT EXISTS wisp_grants_grantor_idx ON wisp_grants (grantor_user_id);
CREATE INDEX IF NOT EXISTS wisp_grants_org_idx ON wisp_grants (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wisp_grants_live_expiry_idx ON wisp_grants (expires_at) WHERE status IN ('active','paused');

-- One live (active or paused) grant per (grantor, partner, scope). Two
-- concurrent creates for the same scope: the second gets 23505.
CREATE UNIQUE INDEX IF NOT EXISTS wisp_grants_one_live_per_scope_uq
  ON wisp_grants (grantor_user_id, partner_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('active','paused');

-- ---------------------------------------------------------------------------
-- 3. wisp_grant_revisions (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wisp_grant_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id         uuid NOT NULL,
  partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  revision         integer NOT NULL,
  ceiling_snapshot jsonb NOT NULL,
  factor_proof     jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_grant_revisions_id_grant_uq UNIQUE (id, grant_id),
  CONSTRAINT wisp_grant_revisions_grant_rev_uq UNIQUE (grant_id, revision),
  CONSTRAINT wisp_grant_revisions_revision_chk CHECK (revision >= 1)
);

-- Composite (grant_id, partner_id) → wisp_grants: a revision always carries
-- its grant's partner (the RLS anchor), never another one.
ALTER TABLE wisp_grant_revisions DROP CONSTRAINT IF EXISTS wisp_grant_revisions_grant_partner_fk;
ALTER TABLE wisp_grant_revisions ADD CONSTRAINT wisp_grant_revisions_grant_partner_fk
  FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS wisp_grant_revisions_partner_idx ON wisp_grant_revisions (partner_id);

-- current_revision_id → a revision OF THIS GRANT. DEFERRABLE INITIALLY
-- DEFERRED: the grant row is inserted before its first revision inside one
-- transaction. ON DELETE SET NULL (current_revision_id) breaks the
-- grants ↔ revisions FK cycle for the partner-axis erasure sweep, which
-- deletes revisions before grants (CASCADE_ORDER_SET_NULL_EDGE_BREAKS in
-- services/tenantCascade.ts); the column-list form never nulls `id`.
ALTER TABLE wisp_grants DROP CONSTRAINT IF EXISTS wisp_grants_current_revision_fk;
ALTER TABLE wisp_grants ADD CONSTRAINT wisp_grants_current_revision_fk
  FOREIGN KEY (current_revision_id, id) REFERENCES wisp_grant_revisions (id, grant_id)
  ON DELETE SET NULL (current_revision_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 4. RLS — both tables ENABLE + FORCE in the creating file
-- ---------------------------------------------------------------------------
ALTER TABLE wisp_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE wisp_grant_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_grant_revisions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grants' AND policyname = 'wisp_grants_select') THEN
    CREATE POLICY wisp_grants_select ON wisp_grants
      FOR SELECT TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;

  -- Grants are self-only: a user mints a grant for THEMSELVES (Wisp design
  -- §4.2); a partner admin can never mint one for another tech.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grants' AND policyname = 'wisp_grants_insert') THEN
    CREATE POLICY wisp_grants_insert ON wisp_grants
      FOR INSERT TO breeze_app
      WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR (public.breeze_has_partner_access(partner_id) AND grantor_user_id = public.breeze_current_user_id())
      );
  END IF;

  -- The tighten/revoke-only restriction for partner admins lives in the
  -- wisp_grants_update_guard trigger below: RLS cannot compare OLD and NEW.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grants' AND policyname = 'wisp_grants_update') THEN
    CREATE POLICY wisp_grants_update ON wisp_grants
      FOR UPDATE TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;

  -- Partner reach for DELETE (the shape-3 contract covers all four commands);
  -- grants are revoked, never deleted by users — wisp_grants_delete_guard
  -- admits a DELETE only in system scope (erasure) or as an FK cascade.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grants' AND policyname = 'wisp_grants_delete') THEN
    CREATE POLICY wisp_grants_delete ON wisp_grants
      FOR DELETE TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grant_revisions' AND policyname = 'wisp_grant_revisions_select') THEN
    CREATE POLICY wisp_grant_revisions_select ON wisp_grant_revisions
      FOR SELECT TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;

  -- Only the grantor appends a revision (create / refresh).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grant_revisions' AND policyname = 'wisp_grant_revisions_insert') THEN
    CREATE POLICY wisp_grant_revisions_insert ON wisp_grant_revisions
      FOR INSERT TO breeze_app
      WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR (
          public.breeze_has_partner_access(partner_id)
          AND EXISTS (
            SELECT 1 FROM wisp_grants g
            WHERE g.id = wisp_grant_revisions.grant_id
              AND g.partner_id = wisp_grant_revisions.partner_id
              AND public.breeze_has_partner_access(g.partner_id)
              AND g.grantor_user_id = public.breeze_current_user_id()
          )
        )
      );
  END IF;

  -- Partner reach for UPDATE/DELETE (shape-3 contract). Revisions are
  -- append-only: wisp_grant_revisions_immutable_guard refuses every UPDATE,
  -- and every DELETE outside system scope (erasure) or an FK cascade.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grant_revisions' AND policyname = 'wisp_grant_revisions_update') THEN
    CREATE POLICY wisp_grant_revisions_update ON wisp_grant_revisions
      FOR UPDATE TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wisp_grant_revisions' AND policyname = 'wisp_grant_revisions_delete') THEN
    CREATE POLICY wisp_grant_revisions_delete ON wisp_grant_revisions
      FOR DELETE TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. wisp_grants_update_guard — ownership is immutable, terminal states stay
--    terminal, and outside system scope:
--      * nobody changes paused_reason / paused_at / revoked_at without a
--        status change (a grantor cannot relabel a system pause as
--        'user_paused' and then resume it);
--      * paused → active only from 'user_paused' (system pauses resume only
--        through their own reconcilers, which run in system scope — w00 A29);
--      * a partner admin (actor ≠ grantor) may only pause, revoke, or change
--        the two operational settings budget/tick (w00 A6). current_revision_id,
--        expires_at and any move back to 'active' are the grantor's alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wisp_grants_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_system boolean := public.breeze_current_scope() = 'system';
  v_status_changed boolean := NEW.status IS DISTINCT FROM OLD.status;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.grantor_user_id IS DISTINCT FROM OLD.grantor_user_id
     OR NEW.grantee IS DISTINCT FROM OLD.grantee
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: ownership columns are immutable';
  END IF;

  IF OLD.status IN ('revoked','expired') AND v_status_changed THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: a revoked or expired grant cannot change status';
  END IF;

  IF NOT v_system THEN
    IF NOT v_status_changed
       AND (NEW.paused_reason IS DISTINCT FROM OLD.paused_reason
            OR NEW.paused_at IS DISTINCT FROM OLD.paused_at
            OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
            -- revoked_by_user_id may only fall to NULL (ON DELETE SET NULL of the revoker).
            OR (NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id AND NEW.revoked_by_user_id IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: pause/revoke stamps change only with a status change';
    END IF;

    IF OLD.status = 'paused' AND NEW.status = 'active' AND OLD.paused_reason IS DISTINCT FROM 'user_paused' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: only a user pause can be resumed by a user';
    END IF;

    IF public.breeze_current_user_id() IS DISTINCT FROM OLD.grantor_user_id THEN
      IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
         OR (v_status_changed AND NEW.status NOT IN ('paused','revoked'))
         OR (v_status_changed AND NEW.status = 'paused' AND OLD.status <> 'active') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: a partner admin may only pause, revoke, or change budget/tick';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wisp_grants_update_guard ON wisp_grants;
CREATE TRIGGER wisp_grants_update_guard BEFORE UPDATE ON wisp_grants
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grants_update_guard();

-- Grants are revoked, never deleted by a user. A DELETE passes only in
-- system scope (org / partner erasure) or as an FK cascade from the
-- grantor, scope org or partner (pg_trigger_depth() > 1).
CREATE OR REPLACE FUNCTION public.wisp_grants_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF public.breeze_current_scope() = 'system' OR pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: grants are revoked, never deleted';
END $$;

DROP TRIGGER IF EXISTS wisp_grants_delete_guard ON wisp_grants;
CREATE TRIGGER wisp_grants_delete_guard BEFORE DELETE ON wisp_grants
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grants_delete_guard();

-- ---------------------------------------------------------------------------
-- 6. wisp_grant_revisions_immutable_guard — revisions are never updated, and
--    deleted only by system-scope erasure or as an FK cascade from the grant /
--    partner (pg_trigger_depth() > 1: fired from the RI action trigger).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wisp_grant_revisions_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (public.breeze_current_scope() = 'system' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grant_revisions: revisions are append-only';
END $$;

DROP TRIGGER IF EXISTS wisp_grant_revisions_immutable_guard ON wisp_grant_revisions;
CREATE TRIGGER wisp_grant_revisions_immutable_guard BEFORE UPDATE OR DELETE ON wisp_grant_revisions
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grant_revisions_immutable_guard();

-- ---------------------------------------------------------------------------
-- 7. Runs and Operator tasks pin the grant + revision they were admitted under.
--    Both-or-none. The (grant_revision_id, grant_id) FK is ON DELETE SET NULL
--    over BOTH columns, so the both-or-none CHECK holds: a revision is only
--    ever deleted with its grant, by erasure, and the erasure contract
--    (orgCascadeFkOnDelete) needs the edge cleared by Postgres rather than by
--    ordering. The plain grant_id FK stays RESTRICT: both ends are in the org
--    cascade set, so it makes "runs/tasks before wisp_grants" an FK edge the
--    topological order honours. The pin guard below lets only this FK action
--    (pg_trigger_depth() > 1, both columns to NULL) clear a pin.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS grant_id uuid;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS grant_revision_id uuid;
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_grant_link_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_grant_link_chk CHECK ((grant_id IS NULL) = (grant_revision_id IS NULL));
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_grant_revision_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_grant_revision_fk
  FOREIGN KEY (grant_revision_id, grant_id) REFERENCES wisp_grant_revisions (id, grant_id) ON DELETE SET NULL;
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_grant_fk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_grant_fk
  FOREIGN KEY (grant_id) REFERENCES wisp_grants (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ai_agent_runs_grant_id_idx ON ai_agent_runs (grant_id) WHERE grant_id IS NOT NULL;

ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS grant_id uuid;
ALTER TABLE ai_operator_tasks ADD COLUMN IF NOT EXISTS grant_revision_id uuid;
ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_grant_link_chk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_grant_link_chk CHECK ((grant_id IS NULL) = (grant_revision_id IS NULL));
ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_grant_revision_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_grant_revision_fk
  FOREIGN KEY (grant_revision_id, grant_id) REFERENCES wisp_grant_revisions (id, grant_id) ON DELETE SET NULL;
ALTER TABLE ai_operator_tasks DROP CONSTRAINT IF EXISTS ai_operator_tasks_grant_fk;
ALTER TABLE ai_operator_tasks ADD CONSTRAINT ai_operator_tasks_grant_fk
  FOREIGN KEY (grant_id) REFERENCES wisp_grants (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ai_operator_tasks_grant_id_idx ON ai_operator_tasks (grant_id) WHERE grant_id IS NOT NULL;

-- Tenant binding for the pinned grant. Runs and tasks carry no partner_id, so
-- no composite FK can tie grant_id to the row's tenant; this guard does: the
-- grant must belong to the partner of the row's org, and an org-scoped grant
-- may only pin work in its own org. It reads under the CALLER's RLS, so it
-- fails closed in a context that cannot see the grant (grant-bearing work is
-- admitted in system scope). The pin is also IMMUTABLE after admission — a
-- writer clearing it would strip the ceiling from a live run — except on the
-- enqueue-failed reclaim, which re-admits the row as a new attempt.
CREATE OR REPLACE FUNCTION public.wisp_grant_link_tenant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.grant_id IS DISTINCT FROM OLD.grant_id OR NEW.grant_revision_id IS DISTINCT FROM OLD.grant_revision_id)
     -- The revision FK's ON DELETE SET NULL during erasure (an RI action, so
     -- trigger depth > 1) clears both columns; a direct UPDATE never may.
     AND NOT (pg_trigger_depth() > 1 AND NEW.grant_id IS NULL AND NEW.grant_revision_id IS NULL) THEN
    -- Nested IFs: OLD.error_code exists only on ai_agent_runs.
    IF TG_TABLE_NAME = 'ai_agent_runs' THEN
      IF NOT (OLD.status = 'failed' AND OLD.error_code = 'enqueue_failed') THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = format('%s: the delegation grant pin is immutable after admission', TG_TABLE_NAME);
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = format('%s: the delegation grant pin is immutable after admission', TG_TABLE_NAME);
    END IF;
  END IF;
  IF NEW.grant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM wisp_grants g
      JOIN organizations o ON o.partner_id = g.partner_id
     WHERE g.id = NEW.grant_id
       AND o.id = NEW.org_id
       AND (g.org_id IS NULL OR g.org_id = NEW.org_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = format('%s: grant %s is not in the tenant scope of org %s', TG_TABLE_NAME, NEW.grant_id, NEW.org_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_agent_runs_grant_tenant_guard ON ai_agent_runs;
CREATE TRIGGER ai_agent_runs_grant_tenant_guard BEFORE INSERT OR UPDATE OF grant_id, grant_revision_id, org_id ON ai_agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grant_link_tenant_guard();
DROP TRIGGER IF EXISTS ai_operator_tasks_grant_tenant_guard ON ai_operator_tasks;
CREATE TRIGGER ai_operator_tasks_grant_tenant_guard BEFORE INSERT OR UPDATE OF grant_id, grant_revision_id, org_id ON ai_operator_tasks
  FOR EACH ROW EXECUTE FUNCTION public.wisp_grant_link_tenant_guard();

-- ---------------------------------------------------------------------------
-- 8. Grants + comments
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_grants TO breeze_app;
GRANT SELECT, INSERT ON wisp_grant_revisions TO breeze_app;

COMMENT ON TABLE wisp_grants IS
  'Wisp delegation grant (Wisp design §4.2). Shape 3 (partner-axis) + ownership constraints: self-only INSERT, grantor or partner-admin UPDATE with tighten/revoke-only enforced by wisp_grants_update_guard. org_id is the grant SCOPE (NULL = partner-wide), not the tenancy axis.';
COMMENT ON TABLE wisp_grant_revisions IS
  'Append-only ceiling snapshots of a wisp_grants row (Wisp design §4.2). Work is pinned to the revision it was admitted under; refresh appends revision n+1 and never mutates an old one.';
COMMENT ON COLUMN wisp_grant_revisions.factor_proof IS
  'Step-up proof metadata { method, verifiedAt } — never the step-up grant id or any secret.';
