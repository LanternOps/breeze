-- #8318 wave 1b — org-access gate on breeze_device_command_incarnation_is_current
-- (review note (a) on #9385; spec
-- docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.2, §6.4).
--
-- The wave 1a resolver (2027-01-02-120100) answered one bit about ANY command
-- id across tenants: it elected system scope for its read and never asked
-- whether the caller may see the command's device. This replaces it with the
-- breeze_command_requester_is_active shape (2026-11-05-101500): the caller's
-- org access to the command's device org is evaluated in the CALLER's scope,
-- and the answer is false without it.
--
-- CONTRACT — true iff ALL of:
--   1. the command exists and its device exists;
--   2. COALESCE(device_commands.device_incarnation, 1) = devices.install_incarnation
--      (a NULL stamp is incarnation 1, the null rule §4.1), read past RLS, newest
--      committed row (VOLATILE);
--   3. the CALLER may see the device's org, by scope:
--        - 'organization' / 'partner': public.breeze_has_org_access(device org),
--          evaluated against the caller's own GUCs (breeze.scope restored,
--          breeze.accessible_org_ids never touched) — an org or partner
--          principal cannot probe another tenant's command;
--        - 'system': allowed (system scope sees every tenant);
--        - 'none' (no DB access context; breeze_current_scope() defaults to it):
--          ALLOWED, and deliberately so. A tenant request always runs under a
--          context, so 'none' is never a tenant principal: it is app code on
--          the bare pool. The two callers that read device_commands contextless
--          — the REST result route's pre-read and the WebSocket result lookup —
--          do so on purpose (device_commands is RLS-free; the context would cost
--          a BEGIN + set_config×6 + COMMIT per result on the hottest agent path,
--          #1105), and they could already read the command row they ask about.
--          Refusing 'none' would silently reject every WS result. Deny-default
--          (0012) governs RLS policies on tenant tables; this function reveals
--          one bit about a row the caller can already read.
--      Every other scope value answers false.
--
-- Callers today and the scope they run under, all green under this rule:
--   services/commandDispatch.ts claim flips — system (heartbeat, parked beat,
--     REST poll) or the pushing user's own org/partner context (which queued
--     the command for a device it can access);
--   services/commandResultAcceptance.ts via routes/agents/commands.ts — the
--     pre-read contextless, the CAS in the agent's org context (its own device);
--   routes/agentWs.ts — lookups contextless or system, the CAS in the agent's
--     org context; applyLateCallerVerifyRejection system;
--   services/commandResultProcessingFailure.ts — the request's org context
--     (REST) or a fresh system context (WS).
--
-- Same discipline as 2027-01-02-120100: SECURITY DEFINER with the in-body
-- save/elevate/restore of `breeze.scope` (a function-attribute SET is
-- superuser-only, migrationGucAttributes.test.ts), fixed search_path, one
-- RETURN immediately after the restore, EXECUTE revoked from PUBLIC and
-- granted to breeze_app only. Idempotent (CREATE OR REPLACE); writes no rows,
-- so no migration-level system-scope election. No inner BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.breeze_device_command_incarnation_is_current(p_command_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  -- The CALLER's scope, captured before elevating.
  _caller_scope text := public.breeze_current_scope();
  _device_org_id uuid;
  _current boolean;
  _caller_has_access boolean := false;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT COALESCE(c.device_incarnation, 1) = d.install_incarnation, d.org_id
    INTO _current, _device_org_id
    FROM public.device_commands c
    JOIN public.devices d ON d.id = c.device_id
   WHERE c.id = p_command_id;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);

  -- Evaluated in the CALLER's scope (restored above; the access GUCs were
  -- never changed), per the contract in the header.
  IF _caller_scope IN ('organization', 'partner') THEN
    _caller_has_access := _device_org_id IS NOT NULL
      AND COALESCE(public.breeze_has_org_access(_device_org_id), false);
  ELSIF _caller_scope IN ('system', 'none') THEN
    _caller_has_access := true;
  END IF;

  RETURN COALESCE(_current, false) AND _caller_has_access;
END;
$$;

COMMENT ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) IS
  '#8318 §4.2/§5.2/§6.4: true iff the command''s device_incarnation (NULL = 1) equals its device''s current install_incarnation AND the caller may see the device''s org (org/partner scope: breeze_has_org_access in the caller''s scope; system and contextless ''none'': allowed). Claim and result acceptance refuse a row for which this is false.';

REVOKE ALL ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_device_command_incarnation_is_current(uuid) TO breeze_app;
  END IF;
END $$;
