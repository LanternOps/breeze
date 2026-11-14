SELECT set_config('breeze.scope', 'system', true);

-- Portal registration W8 (#11385): directory deprovisioning.
-- Plan: docs/superpowers/plans/portal/2026-11-12-portal-registration-options-w08-directory-deprovisioning.md
--   (Task 1; decisions D1, D2, D5, D12).
-- WRITES ROWS (portal_users.disabled_by backfill) → system scope first (line 1).
-- autoMigrate wraps the file in a transaction: no BEGIN/COMMIT. Idempotent: every
-- column, constraint, index, table and policy is guarded.

-- 1. portal_user_identities: a disabled state made of independent blockers (D1),
--    plus the directory observation columns (D5). Disabling never deletes the row,
--    so (issuer, subject) stays reserved.
ALTER TABLE public.portal_user_identities
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS disabled_blockers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS directory_chain text,
  ADD COLUMN IF NOT EXISTS directory_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS directory_absent_runs smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS directory_absent_since timestamptz,
  ADD COLUMN IF NOT EXISTS directory_last_run_id uuid,
  ADD COLUMN IF NOT EXISTS directory_rearm_since timestamptz;

DO $$ BEGIN
  -- Disabled iff at least one blocker, and a disabled identity always says why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_user_identities'::regclass
                    AND conname = 'portal_user_identities_disabled_chk') THEN
    ALTER TABLE public.portal_user_identities
      ADD CONSTRAINT portal_user_identities_disabled_chk CHECK (
            ((disabled_at IS NULL) = (cardinality(disabled_blockers) = 0))
        AND ((disabled_at IS NULL) = (disabled_reason IS NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_user_identities'::regclass
                    AND conname = 'portal_user_identities_blockers_chk') THEN
    ALTER TABLE public.portal_user_identities
      ADD CONSTRAINT portal_user_identities_blockers_chk
      CHECK (disabled_blockers <@ ARRAY['entra_directory','google_directory','scim','msp']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_user_identities'::regclass
                    AND conname = 'portal_user_identities_disabled_reason_chk') THEN
    ALTER TABLE public.portal_user_identities
      ADD CONSTRAINT portal_user_identities_disabled_reason_chk
      CHECK (disabled_reason IN ('account_disabled','absent','suspended','archived','scim_deactivated','msp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_user_identities'::regclass
                    AND conname = 'portal_user_identities_absent_runs_chk') THEN
    ALTER TABLE public.portal_user_identities
      ADD CONSTRAINT portal_user_identities_absent_runs_chk CHECK (directory_absent_runs >= 0);
  END IF;
END $$;

-- Composite-FK target for portal_directory_actions (same shape as portal_users_id_org_uq).
CREATE UNIQUE INDEX IF NOT EXISTS portal_user_identities_id_org_uq
  ON public.portal_user_identities (id, org_id);

-- 2. portal_users.disabled_by: who disabled the account (D2). Only MSP writers
--    disable today, so every existing disabled row is the MSP's.
ALTER TABLE public.portal_users ADD COLUMN IF NOT EXISTS disabled_by text;

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.portal_users SET disabled_by = 'msp'
   WHERE status = 'disabled' AND disabled_by IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE 'portal_users: backfilled disabled_by = msp on % disabled account(s)', n;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass
                    AND conname = 'portal_users_disabled_by_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_disabled_by_chk
      CHECK (disabled_by IS NULL OR disabled_by IN ('msp','directory','scim'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass
                    AND conname = 'portal_users_disabled_by_status_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_disabled_by_status_chk
      CHECK ((status = 'disabled') = (disabled_by IS NOT NULL)) NOT VALID;
  END IF;
END $$;
-- After the backfill. A no-op once the constraint is valid, so a replay is safe.
ALTER TABLE public.portal_users VALIDATE CONSTRAINT portal_users_disabled_by_status_chk;

-- 3. portal_directory_runs: one row per directory snapshot an org's source produced
--    (D4, D11, D12). Tenancy shape 1; org_id NOT NULL by design (run evidence for one
--    org's portal, not configuration).
CREATE TABLE IF NOT EXISTS public.portal_directory_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source text NOT NULL,
  -- NULL when the run was refused before a chain is known.
  chain_key text,
  -- entra: <connectionId>:<consentGeneration>:<generation>; google: <connectionId>:<utcDate>
  snapshot_key text NOT NULL,
  snapshot_at timestamptz NOT NULL,
  outcome text NOT NULL,
  reason text,
  mode text NOT NULL,
  directory_user_count integer,
  usable_count integer NOT NULL DEFAULT 0,
  affected_count integer NOT NULL DEFAULT 0,
  disposition text NOT NULL,
  hold_reason text,
  impact_digest text,
  decided_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_directory_runs_source_chk CHECK (source IN ('entra','google')),
  CONSTRAINT portal_directory_runs_outcome_chk
    CHECK (outcome IN ('evaluated','incomplete','suspect_shrink','skipped')),
  CONSTRAINT portal_directory_runs_reason_chk CHECK (reason IS NULL OR reason IN (
    'tenant_not_proven','tenant_mismatch','connection_inactive','org_inactive',
    'sync_incomplete','directory_too_large','scope_missing','access_denied','unavailable',
    'connection_invalid','admin_not_admin','mixed_customer','malformed')),
  CONSTRAINT portal_directory_runs_mode_chk CHECK (mode IN ('report','enforce')),
  CONSTRAINT portal_directory_runs_disposition_chk CHECK (disposition IN (
    'none','reported','applying','applied','held','held_applied','held_dismissed','superseded')),
  CONSTRAINT portal_directory_runs_hold_reason_chk
    CHECK (hold_reason IS NULL OR hold_reason IN ('threshold','first_enforcement')),
  CONSTRAINT portal_directory_runs_snapshot_uq UNIQUE (org_id, source, snapshot_key),
  CONSTRAINT portal_directory_runs_id_org_uq UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS portal_directory_runs_chain_idx
  ON public.portal_directory_runs (org_id, source, chain_key, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_directory_runs_disposition_idx
  ON public.portal_directory_runs (disposition, created_at)
  WHERE disposition IN ('applying','held');

ALTER TABLE public.portal_directory_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_directory_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_directory_runs;
CREATE POLICY breeze_org_isolation_select ON public.portal_directory_runs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_directory_runs;
CREATE POLICY breeze_org_isolation_insert ON public.portal_directory_runs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_directory_runs;
CREATE POLICY breeze_org_isolation_update ON public.portal_directory_runs
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_directory_runs;
CREATE POLICY breeze_org_isolation_delete ON public.portal_directory_runs
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_directory_runs TO breeze_app;

-- 4. portal_directory_actions: one proposed or applied identity disable per run
--    (D7, D8, D9, D12). Tenancy shape 1. Every composite FK names org_id, so an
--    action can never point at a run, identity or account of another org, and is
--    DEFERRABLE INITIALLY IMMEDIATE so org merge can re-tenant parent and child.
--    Deleting an account, identity or run cascades its actions; the audit log keeps
--    every applied disable.
--    Status lifecycle: a report run's actions are `reported` (terminal); a held
--    run's are `held`, an auto-apply (`applying`) run's are `pending`; both end
--    `applied`, `skipped` (with skip_reason) or `superseded`; `applied` can become
--    `restored`. A rearmed identity is listed as `skipped` (rearmed) at record time.
CREATE TABLE IF NOT EXISTS public.portal_directory_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  portal_user_id uuid NOT NULL,
  provider text NOT NULL,
  reason text NOT NULL,
  effect text NOT NULL,
  keeps_password boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  skip_reason text,
  applied_at timestamptz,
  sessions_purged_at timestamptz,
  restored_at timestamptz,
  restored_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_directory_actions_run_fk
    FOREIGN KEY (run_id, org_id) REFERENCES public.portal_directory_runs (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_identity_fk
    FOREIGN KEY (identity_id, org_id) REFERENCES public.portal_user_identities (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_user_fk
    FOREIGN KEY (portal_user_id, org_id) REFERENCES public.portal_users (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_run_identity_uq UNIQUE (run_id, identity_id),
  CONSTRAINT portal_directory_actions_provider_chk CHECK (provider IN ('entra','google')),
  CONSTRAINT portal_directory_actions_reason_chk
    CHECK (reason IN ('account_disabled','absent','suspended','archived')),
  CONSTRAINT portal_directory_actions_effect_chk CHECK (effect IN ('identity','identity_and_account')),
  CONSTRAINT portal_directory_actions_status_chk
    CHECK (status IN ('reported','held','pending','applied','skipped','superseded','restored')),
  CONSTRAINT portal_directory_actions_applied_chk
    CHECK ((status IN ('applied','restored')) = (applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS portal_directory_actions_identity_idx
  ON public.portal_directory_actions (identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_directory_actions_purge_idx
  ON public.portal_directory_actions (applied_at)
  WHERE status = 'applied' AND sessions_purged_at IS NULL;

ALTER TABLE public.portal_directory_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_directory_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_directory_actions;
CREATE POLICY breeze_org_isolation_select ON public.portal_directory_actions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_directory_actions;
CREATE POLICY breeze_org_isolation_insert ON public.portal_directory_actions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_directory_actions;
CREATE POLICY breeze_org_isolation_update ON public.portal_directory_actions
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_directory_actions;
CREATE POLICY breeze_org_isolation_delete ON public.portal_directory_actions
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_directory_actions TO breeze_app;
