-- #8318 wave 1b-2 — the bounded rebind
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.4, §6.4).
--
-- device_reattachments: the append-only ledger, one row per CONFIRMED
-- reattach, written by rebind-confirm in its own transaction. Modelled on
-- device_pool_assignment_events (2026-11-08-190200 / 190300):
--   * Tenancy shape 3 (partner-axis), registered in PARTNER_TENANT_TABLES.
--     No org_id column, so NO org cascade / device cascade / org-merge /
--     tenant-export registration: the org ids here are historical snapshots,
--     not tenancy keys.
--   * Snapshots with NO FK — intent, both devices, both orgs, the target's
--     site, the actor — so the record outlives every one of them, and a device
--     purge or org erasure never fires a cascading SET NULL the append-only
--     trigger would refuse.
--   * partner_id FK ON DELETE CASCADE: erased with the partner
--     (cascadeDeletePartner's partner_id sweep also reaches it).
--   * The target's previous and new agent_id and incarnation, the evidence
--     level, the step-up reference and the boundary's invalidation counts
--     (jsonb, by handler).
--   * confirmation_token_hash and the confirmed identity (target device, org,
--     site and the staged agent id): what idempotent confirm replay answers
--     once the intent is pruned (§6.4, §6.6). No secret is stored.
--   * UPDATE blocked by trigger (ensureAppRole re-grants UPDATE on every
--     table, so the trigger is the real guard). DELETE stays granted for the
--     partner erasure sweep.
--
-- Policies:
--   * permissive FOR ALL `system OR breeze_has_partner_access(partner_id)`;
--   * RESTRICTIVE writes: INSERT, UPDATE and DELETE are system-scope only
--     (every writer — confirm, partner erasure — runs in system scope);
--   * RESTRICTIVE reads: the intent table's org-access branch over the
--     snapshot org columns, so a technician limited to selected orgs reads
--     only the reattaches that touch their orgs (§4.4).
--
-- Indexes: source_device_id serves the "never target a retired source" check
-- (§6.5); source_agent_id serves confirm replay after the intent is pruned
-- (the route's `:id`; the token hash is then compared in constant time);
-- confirmation_token_hash and intent_id are unique (one ledger row per
-- confirmation token and per intent).
--
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

CREATE TABLE IF NOT EXISTS public.device_reattachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  source_device_id uuid NOT NULL,
  source_agent_id varchar(64) NOT NULL,
  source_org_id uuid NOT NULL,
  source_parked boolean NOT NULL,
  target_device_id uuid NOT NULL,
  target_org_id uuid NOT NULL,
  target_site_id uuid NOT NULL,
  target_previous_agent_id varchar(64) NOT NULL,
  staged_agent_id varchar(64) NOT NULL,
  target_previous_incarnation integer NOT NULL,
  target_new_incarnation integer NOT NULL,
  actor_user_id uuid NOT NULL,
  evidence_level text NOT NULL,
  restore_decommissioned boolean NOT NULL DEFAULT false,
  step_up_grant_ref text,
  invalidation_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmation_token_hash varchar(64) NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_reattachments_evidence_level_chk
    CHECK (evidence_level IN ('hint', 'tpm_continuity')),
  CONSTRAINT device_reattachments_distinct_devices_chk
    CHECK (source_device_id <> target_device_id),
  CONSTRAINT device_reattachments_incarnation_chk
    CHECK (target_previous_incarnation >= 1 AND target_new_incarnation = target_previous_incarnation + 1),
  CONSTRAINT device_reattachments_confirmation_hash_chk
    CHECK (confirmation_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS device_reattachments_intent_uq
  ON public.device_reattachments (intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_reattachments_confirmation_hash_uq
  ON public.device_reattachments (confirmation_token_hash);
CREATE INDEX IF NOT EXISTS device_reattachments_source_agent_idx
  ON public.device_reattachments (source_agent_id);
CREATE INDEX IF NOT EXISTS device_reattachments_source_device_idx
  ON public.device_reattachments (source_device_id);
CREATE INDEX IF NOT EXISTS device_reattachments_target_device_idx
  ON public.device_reattachments (target_device_id);
CREATE INDEX IF NOT EXISTS device_reattachments_partner_confirmed_idx
  ON public.device_reattachments (partner_id, confirmed_at);

ALTER TABLE public.device_reattachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_reattachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_reattachments_partner_access ON public.device_reattachments;
CREATE POLICY device_reattachments_partner_access ON public.device_reattachments
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

DROP POLICY IF EXISTS device_reattachments_org_access_read ON public.device_reattachments;
CREATE POLICY device_reattachments_org_access_read ON public.device_reattachments
  AS RESTRICTIVE
  FOR SELECT
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      public.breeze_has_org_access(target_org_id)
      AND (source_parked OR public.breeze_has_org_access(source_org_id))
    )
  );

DROP POLICY IF EXISTS device_reattachments_system_insert ON public.device_reattachments;
CREATE POLICY device_reattachments_system_insert ON public.device_reattachments
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (public.breeze_current_scope() = 'system');

DROP POLICY IF EXISTS device_reattachments_system_update ON public.device_reattachments;
CREATE POLICY device_reattachments_system_update ON public.device_reattachments
  AS RESTRICTIVE
  FOR UPDATE
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

DROP POLICY IF EXISTS device_reattachments_system_delete ON public.device_reattachments;
CREATE POLICY device_reattachments_system_delete ON public.device_reattachments
  AS RESTRICTIVE
  FOR DELETE
  USING (public.breeze_current_scope() = 'system');

GRANT SELECT, INSERT, DELETE ON public.device_reattachments TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_device_reattachments_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'device_reattachments is append-only',
    HINT = 'Rows cannot be modified once written. DELETE remains allowed for partner erasure.';
END;
$$;

DROP TRIGGER IF EXISTS device_reattachments_block_update ON public.device_reattachments;
CREATE TRIGGER device_reattachments_block_update
  BEFORE UPDATE ON public.device_reattachments
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_reattachments_immutable();
