-- Claim-time requester gate: an ACTIVE platform admin counts as an active
-- requester for any org the caller can access.
--
-- `breeze_command_requester_is_active` (2026-11-05-101500) is the boolean the
-- claim-time eligibility check (`partitionClaimable`, both the heartbeat claim
-- and the WebSocket push) uses to decide whether a queued command's
-- `created_by` user may still have it delivered. It required the user to
-- belong to the target org's partner (users.partner_id = organizations.
-- partner_id). A platform admin acting through the system-scope device
-- command routes keeps their own users.id as `created_by`, but their home
-- partner is not the device's partner, so every command they sent to another
-- partner's device was cancelled as `requester_inactive` at claim time.
--
-- CONTRACT — unchanged, plus one branch. True iff the CALLER's own context
-- has org access to `target_org_id` (evaluated before elevation, as before)
-- AND the user exists with `status = 'active'` AND EITHER:
--   (a) the existing tenant attachment holds (same partner as the org, and own
--       org / partner_users membership / organization_users membership), OR
--   (b) the user is a platform admin (`users.is_platform_admin = true`, the
--       flag authMiddleware binds system scope to).
-- A deactivated platform admin (`status <> 'active'`) never counts, and a
-- non-admin user of a different partner still never counts.
--
-- Same shape as the original: SECURITY DEFINER, fixed search_path, in-body
-- save/elevate/restore of `breeze.scope` with exactly ONE RETURN immediately
-- preceded by the restore and no early return; the elevated region is a single
-- SELECT — no writes, no dynamic SQL. EXECUTE revoked from PUBLIC, granted
-- only to breeze_app.
--
-- Idempotent (CREATE OR REPLACE; REVOKE/GRANT are repeatable). Writes no rows,
-- so no migration-level system-scope elevation is needed. No inner BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.breeze_command_requester_is_active(
  requester_user_id uuid,
  target_org_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _caller_has_access boolean;
  _result boolean := false;
BEGIN
  -- Evaluated in the CALLER's scope, before elevating.
  _caller_has_access := requester_user_id IS NOT NULL
    AND target_org_id IS NOT NULL
    AND COALESCE(public.breeze_has_org_access(target_org_id), false);

  PERFORM set_config('breeze.scope', 'system', true);

  IF _caller_has_access THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.users u
        JOIN public.organizations o ON o.id = target_org_id
       WHERE u.id = requester_user_id
         AND u.status = 'active'
         AND (
              u.is_platform_admin = true
           OR (
                u.partner_id = o.partner_id
                AND (
                     u.org_id = o.id
                  OR EXISTS (
                       SELECT 1 FROM public.partner_users pu
                        WHERE pu.user_id = u.id
                          AND pu.partner_id = o.partner_id
                     )
                  OR EXISTS (
                       SELECT 1 FROM public.organization_users ou
                        WHERE ou.user_id = u.id
                          AND ou.org_id = o.id
                     )
                )
              )
         )
    ) INTO _result;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_result, false);
END;
$$;

COMMENT ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) IS
  'Claim-time requester gate: true iff the caller has org access to target_org_id and the user is active and EITHER a platform admin (users.is_platform_admin) OR belongs to that org''s partner and is attached to the tenant (own org, partner_users membership in the partner, or organization_users membership in the org). Returns only a boolean; lets the org-scoped agent claim resolve partner-level technicians without widening users RLS.';

REVOKE ALL ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) TO breeze_app;
  END IF;
END $$;
