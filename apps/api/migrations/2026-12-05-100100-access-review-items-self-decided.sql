-- Access-review separation of duties.
--
-- A reviewer may not decide the item that reviews their own access unless no
-- other user in the review's scope could decide it (single-admin exception).
-- Enforced in PATCH /access-reviews/:id/items/:itemId
-- (services/accessReviewSelfDecision.ts).
--
-- 1. access_review_items.self_decided — when the exception is used, the
--    decision is flagged so the review record and its CSV export show the
--    control was not separated. Existing decisions predate the rule and are
--    recorded as not self-decided (default). access_review_items has no org_id
--    column (tenancy is the parent review), so it is not in the org cascade /
--    tenant export policy lists.
--
-- 2. breeze_access_review_has_other_decider(owner_scope, owner_id, self) — a
--    narrow, read-only SECURITY DEFINER resolver returning ONE boolean: is
--    there at least one user OTHER than `self` who could decide an item on a
--    review owned by (owner_scope, owner_id)?
--
--    WHY A RESOLVER. The request's own RLS context cannot answer this: `users`
--    is dual-axis RLS keyed on each user's HOME partner/org, so a co-admin
--    whose home tenant differs from the reviewed scope is invisible in the
--    join — an undercount that would wrongly grant the exception. Opening a
--    nested system-context connection from inside the request transaction is
--    the #1105 pool double-hold shape. This function answers on the request's
--    own connection and exposes nothing but the boolean.
--
--    CONTRACT — "eligible decider" mirrors what the PATCH route demands:
--      * membership on the review's owner axis: partner_users for
--        owner_scope = 'partner', organization_users for 'organization';
--      * the membership's role grants users:write ('*' wildcards honoured on
--        either axis, same as permissionGrantMatches);
--      * partner reviews only: partner_users.org_access = 'all';
--      * users.status = 'active' (invited / disabled users cannot sign in).
--    MFA enrolment and site/device-group restrictions are NOT disqualifiers.
--
--    The caller's own context must have access to the owner (partner or org
--    access, evaluated BEFORE elevation). If it does not — or the arguments
--    are malformed — the function returns TRUE ("someone else decides"), the
--    fail-closed answer: it never grants the exception for a scope the caller
--    cannot see.
--
--    In-body save/elevate/restore of breeze.scope, same pattern and rationale
--    as breeze_command_requester_is_active (2026-11-05-101500): a function
--    attribute `SET "breeze.scope"` is superuser-only, and FORCE RLS binds the
--    owner. Exactly ONE RETURN, immediately after the restore; the elevated
--    region is a single SELECT — no writes, no dynamic SQL. EXECUTE is revoked
--    from PUBLIC and granted only to breeze_app.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, repeatable
-- REVOKE/GRANT). Writes no rows, so no migration-level system-scope election
-- is needed. No inner BEGIN/COMMIT.

ALTER TABLE public.access_review_items
  ADD COLUMN IF NOT EXISTS self_decided boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.breeze_access_review_has_other_decider(
  owner_scope text,
  owner_id uuid,
  self_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _caller_has_access boolean;
  _result boolean := true;
BEGIN
  -- Evaluated in the CALLER's scope, before elevating.
  _caller_has_access := owner_id IS NOT NULL
    AND self_user_id IS NOT NULL
    AND CASE owner_scope
          WHEN 'partner' THEN COALESCE(public.breeze_has_partner_access(owner_id), false)
          WHEN 'organization' THEN COALESCE(public.breeze_has_org_access(owner_id), false)
          ELSE false
        END;

  PERFORM set_config('breeze.scope', 'system', true);

  IF _caller_has_access THEN
    SELECT EXISTS (
      SELECT 1
        FROM (
              SELECT pu.user_id, pu.role_id
                FROM public.partner_users pu
               WHERE owner_scope = 'partner'
                 AND pu.partner_id = owner_id
                 AND pu.org_access = 'all'
              UNION ALL
              SELECT ou.user_id, ou.role_id
                FROM public.organization_users ou
               WHERE owner_scope = 'organization'
                 AND ou.org_id = owner_id
             ) m
        JOIN public.users u ON u.id = m.user_id
       WHERE m.user_id <> self_user_id
         AND u.status = 'active'
         AND EXISTS (
               SELECT 1
                 FROM public.role_permissions rp
                 JOIN public.permissions p ON p.id = rp.permission_id
                WHERE rp.role_id = m.role_id
                  AND p.resource IN ('users', '*')
                  AND p.action IN ('write', '*')
             )
    ) INTO _result;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN COALESCE(_result, true);
END;
$$;

COMMENT ON FUNCTION public.breeze_access_review_has_other_decider(text, uuid, uuid) IS
  'Access-review separation of duties: true iff some user other than self_user_id is an active member of the owner scope (partner_users with org_access=all, or organization_users) whose role grants users:write. Fail-closed (true) when the caller lacks access to the owner. Returns only a boolean.';

REVOKE ALL ON FUNCTION public.breeze_access_review_has_other_decider(text, uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_access_review_has_other_decider(text, uuid, uuid) TO breeze_app;
  END IF;
END $$;
