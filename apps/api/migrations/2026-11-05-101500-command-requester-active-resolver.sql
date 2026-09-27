-- Heartbeat claim: resolve a queued command's requester correctly when the
-- requester is a PARTNER-LEVEL user (MSP technician, users.org_id IS NULL).
--
-- THE BUG. `partitionClaimable` (services/commandClaimEligibility.ts, #5145)
-- re-checks at delivery that the command's `created_by` user is still active,
-- by selecting `users.status` inside the claim transaction. On the heartbeat
-- that transaction runs under the AGENT's access context: scope organization,
-- accessible_org_ids = [device org], accessible_partner_ids = [] (agents have
-- no partner-axis access, by design — agentAuth.ts). `users` is a dual-axis RLS
-- table (partner access OR org access OR self), so a technician row
-- (org_id NULL, partner_id = P) is INVISIBLE there. The select returned no
-- row, `active` became false, and every heartbeat-delivered command a
-- technician had queued was cancelled as `requester_inactive`.
--
-- THE FIX is this narrow, read-only resolver instead of widening agent RLS on
-- `users` (which would expose every technician row — email, MFA state, … — to
-- every agent) or opening a nested system-context connection inside the claim
-- transaction (the #1105 pool double-hold shape). It returns ONE boolean and
-- nothing else.
--
-- CONTRACT — true iff ALL of:
--   1. the CALLER's own context has org access to `target_org_id`
--      (breeze_has_org_access, evaluated BEFORE elevation, so it reads the
--      caller's GUCs). For an org the caller cannot access it returns false.
--   2. the user exists and `status = 'active'`;
--   3. the user belongs to the target org's MSP (users.partner_id =
--      organizations.partner_id) — a user of a different partner never counts;
--   4. and is still attached to THIS tenant: the org is their own org
--      (users.org_id), OR they hold a live `partner_users` membership in the
--      org's partner (technicians, including MSP staff whose users.org_id is
--      the MSP's internal org), OR a live `organization_users` membership in
--      the org itself. A customer user of a SIBLING org of the same MSP does
--      NOT count.
-- It deliberately does NOT rehydrate role/site/org_access permissions — that
-- is OD-4 (#3985), out of scope for the active-requester gate.
--
-- WHY THE IN-BODY save/elevate/restore of `breeze.scope`. SECURITY DEFINER
-- alone is ownership-dependent: `users` is FORCE ROW LEVEL SECURITY, which
-- binds the owner too, so on a deployment whose migration role is not a
-- superuser / BYPASSRLS the lookup would be filtered by the caller's scope and
-- the bug would silently survive. A function-attribute `SET "breeze.scope"`
-- is superuser-only (v0.97.0 EU incident; migrationGucAttributes.test.ts), so
-- the sanctioned pattern is the in-body one — reference implementation
-- breeze_config_policy_feature_reference_is_valid (2026-07-27-a). The body has
-- exactly ONE RETURN, immediately preceded by the restore, and no early
-- return; an error aborts the (sub)transaction, which rolls the is_local GUC
-- back to its saved value with no code running. The elevated region is three
-- SELECTs — no writes, no dynamic SQL.
--
-- EXECUTE is revoked from PUBLIC and granted only to breeze_app.
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
         AND u.partner_id = o.partner_id
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
    ) INTO _result;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_result, false);
END;
$$;

COMMENT ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) IS
  'Claim-time requester gate (#5145 follow-up): true iff the caller has org access to target_org_id and the user is active, belongs to that org''s partner, and is attached to the tenant (own org, partner_users membership in the partner, or organization_users membership in the org). Returns only a boolean; lets the org-scoped agent claim resolve partner-level technicians without widening users RLS.';

REVOKE ALL ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_command_requester_is_active(uuid, uuid) TO breeze_app;
  END IF;
END $$;
