-- #8318 wave 1b-2 — the bounded rebind
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.3, §6).
--
-- device_reattach_intents: one row per human-authorized reattach of a newly
-- enrolled install (the SOURCE device) onto an existing record (the TARGET).
-- States requested → staged → confirmed; a requested or staged intent can also
-- end expired (60 / 15 minutes) or cancelled (with cancel_reason). The three
-- end states are terminal: nothing reopens an intent.
--
-- Columns (§4.3):
--   * the versions the human authorized (source_agent_id/org, target
--     agent_id/incarnation/org) — confirm refuses if any moved;
--   * source_parked — DERIVED by trigger from the source org's type, never
--     written by the caller;
--   * phase 1: hashes of credentials the AGENT generated (never copied into
--     devices.* before confirm), the staged agent id, the confirm-only token's
--     hash and the target's pending mTLS certificate row (no FK);
--   * step_up_grant_ref — the wave 2 step-up grant id, stored only.
--   Agent ids are varchar(64), like devices.agent_id.
--
-- Tenancy: shape 3 (partner-axis), narrowed by org access. Both policies are
-- here, in the creating migration:
--   (a) permissive FOR ALL `system OR breeze_has_partner_access(partner_id)`,
--       registered in PARTNER_TENANT_TABLES;
--   (b) RESTRICTIVE FOR ALL, USING and WITH CHECK
--       `system OR (breeze_has_org_access(target_org_id)
--                   AND (source_parked OR breeze_has_org_access(source_org_id)))`
--       — a technician limited to selected orgs reads or writes only intents
--       whose target org, and real source org, are theirs. A parked source
--       passes on source_parked (the holding org is in no user's accessible
--       orgs); whether a technician may act on one is the service's check.
-- The agent side (directive lookup, phase 1, confirm, expiry sweep) and the
-- service's conflict checks run in system scope.
--
-- No org_id column: the device FKs cascade, so org erasure reaches the table
-- through its devices; no org cascade / merge / export registration. The
-- users FK is ON DELETE SET NULL (orgCascadeFkOnDelete contract).
--
-- Triggers:
--   * device_reattach_intents_derive_source_parked (BEFORE INSERT OR UPDATE OF
--     the partner/org/flag columns, SECURITY DEFINER, search_path pinned,
--     scope save/elevate/restore of 2026-11-05-101500): sets source_parked
--     from organizations.type of source_org_id and raises 23514 unless BOTH
--     orgs belong to partner_id. The holding org is invisible to every user
--     context, hence the definer + elevation.
--   * device_reattach_intents_guard_identity (BEFORE UPDATE): the authorized
--     identity columns never change, and a terminal state is final.
--     Trigger names fire alphabetically: derive, then guard.
--
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

CREATE TABLE IF NOT EXISTS public.device_reattach_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  source_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  target_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  state text NOT NULL,
  cancel_reason text,
  evidence_level text NOT NULL,
  restore_decommissioned boolean NOT NULL DEFAULT false,
  requested_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  step_up_grant_ref text,
  source_agent_id varchar(64) NOT NULL,
  source_org_id uuid NOT NULL,
  source_parked boolean NOT NULL DEFAULT false,
  target_agent_id varchar(64) NOT NULL,
  target_incarnation integer NOT NULL,
  target_org_id uuid NOT NULL,
  staged_agent_id varchar(64),
  staged_token_hash varchar(64),
  staged_watchdog_token_hash varchar(64),
  staged_helper_token_hash varchar(64),
  confirmation_token_hash varchar(64),
  staged_mtls_certificate_id uuid,
  staged_at timestamptz,
  confirmed_at timestamptz,
  CONSTRAINT device_reattach_intents_state_chk
    CHECK (state IN ('requested', 'staged', 'confirmed', 'expired', 'cancelled')),
  CONSTRAINT device_reattach_intents_evidence_level_chk
    CHECK (evidence_level IN ('hint', 'tpm_continuity')),
  CONSTRAINT device_reattach_intents_distinct_devices_chk
    CHECK (source_device_id <> target_device_id),
  CONSTRAINT device_reattach_intents_target_incarnation_chk
    CHECK (target_incarnation >= 1),
  CONSTRAINT device_reattach_intents_expiry_chk
    CHECK (expires_at > requested_at),
  CONSTRAINT device_reattach_intents_cancel_reason_chk
    CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)
           AND (cancel_reason IS NULL OR cancel_reason ~ '^[a-z_]{1,64}$')),
  CONSTRAINT device_reattach_intents_hash_format_chk CHECK (
    (staged_token_hash IS NULL OR staged_token_hash ~ '^[0-9a-f]{64}$')
    AND (staged_watchdog_token_hash IS NULL OR staged_watchdog_token_hash ~ '^[0-9a-f]{64}$')
    AND (staged_helper_token_hash IS NULL OR staged_helper_token_hash ~ '^[0-9a-f]{64}$')
    AND (confirmation_token_hash IS NULL OR confirmation_token_hash ~ '^[0-9a-f]{64}$')
  ),
  -- What each state may hold (§6.3, §6.5): a requested intent has no staged
  -- set; a staged one has all of it; confirmed, expired and cancelled intents
  -- have discarded the staged agent/watchdog/helper hashes (the confirmation
  -- hash stays, for the typed answers of §6.4).
  CONSTRAINT device_reattach_intents_shape_chk CHECK (
    (state = 'requested'
       AND staged_agent_id IS NULL AND staged_token_hash IS NULL
       AND staged_watchdog_token_hash IS NULL AND staged_helper_token_hash IS NULL
       AND confirmation_token_hash IS NULL AND staged_mtls_certificate_id IS NULL
       AND staged_at IS NULL AND confirmed_at IS NULL)
    OR (state = 'staged'
       AND staged_agent_id IS NOT NULL AND staged_token_hash IS NOT NULL
       AND staged_watchdog_token_hash IS NOT NULL AND staged_helper_token_hash IS NOT NULL
       AND confirmation_token_hash IS NOT NULL AND staged_at IS NOT NULL
       AND confirmed_at IS NULL)
    OR (state = 'confirmed'
       AND staged_agent_id IS NOT NULL AND confirmation_token_hash IS NOT NULL
       AND staged_at IS NOT NULL AND confirmed_at IS NOT NULL
       AND staged_token_hash IS NULL AND staged_watchdog_token_hash IS NULL
       AND staged_helper_token_hash IS NULL)
    OR (state IN ('expired', 'cancelled')
       AND staged_token_hash IS NULL AND staged_watchdog_token_hash IS NULL
       AND staged_helper_token_hash IS NULL AND confirmed_at IS NULL)
  )
);

-- One open intent per device per role (the backstop of the service's
-- "either role" check under the holding-area lock, §4.3/§6.5). Also the index
-- of the heartbeat directive lookup (source_device_id, open).
CREATE UNIQUE INDEX IF NOT EXISTS device_reattach_intents_open_source_uq
  ON public.device_reattach_intents (source_device_id)
  WHERE state IN ('requested', 'staged');
CREATE UNIQUE INDEX IF NOT EXISTS device_reattach_intents_open_target_uq
  ON public.device_reattach_intents (target_device_id)
  WHERE state IN ('requested', 'staged');
-- FK cascade from devices, and the open-intent checks by either role.
CREATE INDEX IF NOT EXISTS device_reattach_intents_source_device_idx
  ON public.device_reattach_intents (source_device_id);
CREATE INDEX IF NOT EXISTS device_reattach_intents_target_device_idx
  ON public.device_reattach_intents (target_device_id);
CREATE INDEX IF NOT EXISTS device_reattach_intents_partner_idx
  ON public.device_reattach_intents (partner_id);
CREATE INDEX IF NOT EXISTS device_reattach_intents_requested_by_idx
  ON public.device_reattach_intents (requested_by);
-- rebind-confirm finds the caller's intents by the route's `:id` (the
-- source agent id), then compares the token hash in constant time (§6.4).
CREATE INDEX IF NOT EXISTS device_reattach_intents_source_agent_idx
  ON public.device_reattach_intents (source_agent_id);
-- The expiry sweep (open intents past expires_at) and the 30-day prune.
CREATE INDEX IF NOT EXISTS device_reattach_intents_open_expiry_idx
  ON public.device_reattach_intents (expires_at)
  WHERE state IN ('requested', 'staged');
CREATE INDEX IF NOT EXISTS device_reattach_intents_requested_at_idx
  ON public.device_reattach_intents (requested_at);

ALTER TABLE public.device_reattach_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_reattach_intents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_reattach_intents_partner_access ON public.device_reattach_intents;
CREATE POLICY device_reattach_intents_partner_access ON public.device_reattach_intents
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

DROP POLICY IF EXISTS device_reattach_intents_org_access ON public.device_reattach_intents;
CREATE POLICY device_reattach_intents_org_access ON public.device_reattach_intents
  AS RESTRICTIVE
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      public.breeze_has_org_access(target_org_id)
      AND (source_parked OR public.breeze_has_org_access(source_org_id))
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (
      public.breeze_has_org_access(target_org_id)
      AND (source_parked OR public.breeze_has_org_access(source_org_id))
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_reattach_intents TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_device_reattach_intents_derive_source_parked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _source_type text;
  _source_partner uuid;
  _target_partner uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT o.type::text, o.partner_id
    INTO _source_type, _source_partner
    FROM public.organizations o
   WHERE o.id = NEW.source_org_id;
  SELECT o.partner_id
    INTO _target_partner
    FROM public.organizations o
   WHERE o.id = NEW.target_org_id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);

  IF _source_partner IS NULL
     OR _target_partner IS NULL
     OR _source_partner IS DISTINCT FROM NEW.partner_id
     OR _target_partner IS DISTINCT FROM NEW.partner_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'device_reattach_intents: the source and target orgs must both belong to the intent''s partner',
      HINT = 'partner_mismatch';
  END IF;

  NEW.source_parked := (_source_type = 'unassigned_pool');
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.breeze_device_reattach_intents_derive_source_parked() IS
  '#8318 §4.3: derives device_reattach_intents.source_parked from the source org''s type (past RLS: the holding org is invisible to every user context) and refuses a row whose source or target org is not in the intent''s partner.';

REVOKE ALL ON FUNCTION public.breeze_device_reattach_intents_derive_source_parked() FROM PUBLIC;

DROP TRIGGER IF EXISTS device_reattach_intents_derive_source_parked ON public.device_reattach_intents;
CREATE TRIGGER device_reattach_intents_derive_source_parked
  BEFORE INSERT OR UPDATE OF partner_id, source_org_id, target_org_id, source_parked
  ON public.device_reattach_intents
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_reattach_intents_derive_source_parked();

CREATE OR REPLACE FUNCTION public.breeze_device_reattach_intents_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.source_device_id IS DISTINCT FROM OLD.source_device_id
     OR NEW.target_device_id IS DISTINCT FROM OLD.target_device_id
     OR NEW.source_agent_id IS DISTINCT FROM OLD.source_agent_id
     OR NEW.source_org_id IS DISTINCT FROM OLD.source_org_id
     OR NEW.target_agent_id IS DISTINCT FROM OLD.target_agent_id
     OR NEW.target_incarnation IS DISTINCT FROM OLD.target_incarnation
     OR NEW.target_org_id IS DISTINCT FROM OLD.target_org_id
     OR NEW.evidence_level IS DISTINCT FROM OLD.evidence_level
     OR NEW.restore_decommissioned IS DISTINCT FROM OLD.restore_decommissioned
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     -- requested_by may only go to NULL (the users FK's ON DELETE SET NULL).
     OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'device_reattach_intents: the authorized identity of an intent never changes';
  END IF;

  IF OLD.state IN ('confirmed', 'expired', 'cancelled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = format('device_reattach_intents: a %s intent is terminal', OLD.state);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS device_reattach_intents_guard_identity ON public.device_reattach_intents;
CREATE TRIGGER device_reattach_intents_guard_identity
  BEFORE UPDATE ON public.device_reattach_intents
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_reattach_intents_guard_identity();
