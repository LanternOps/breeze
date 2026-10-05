-- Claim-time requester authority: the role grants and access facts a queued
-- `script` command's requester holds for the device's org, readable from the
-- agent's org-scoped claim context.
--
-- Delivery-time script revalidation (services/scriptCommandRevalidation.ts)
-- re-derives the requester's live RBAC immediately before a queued script is
-- delivered. On the heartbeat / HTTP claim it runs on the claim transaction,
-- under the AGENT's DB context: scope 'organization', the device's org only,
-- no partner-axis access. From there:
--   - `users` (dual-axis RLS) hides a partner-level technician (org_id NULL),
--     so the requester lookup found no row and every script a technician
--     queued for an offline device was cancelled as `scope_changed`;
--   - `partner_users` (partner-axis RLS) hides the technician's role row, so
--     the app-layer resolver escalated to a fresh system transaction — a
--     SECOND pooled connection while the claim still holds its own (#1105).
-- Same class as `breeze_command_requester_is_active` (2026-11-05-101500,
-- extended 2026-12-08-100000), which answers the companion "is the requester
-- still active" question the same way.
--
-- CONTRACT. Returns NULL unless
--   (a) the CALLER's own context has org access to `target_org_id`
--       (evaluated before elevation), AND
--   (b) the user is bound to that org's tenant: same partner as the org, or a
--       platform admin (`users.is_platform_admin` — the same two branches as
--       breeze_command_requester_is_active, so the resolver never describes a
--       user the requester gate would not already accept).
-- Otherwise resolves what `getUserPermissions(userId, { orgId: target_org_id,
-- partnerId: users.partner_id })` resolves, with the same precedence:
--   1. an organization_users membership in target_org_id
--      -> {"scope":"organization", roleId, allowedSiteIds}
--   2. else a partner_users membership in the user's own partner
--      -> {"scope":"partner", roleId, orgAccess, allowedOrgIds}
--   3. else NULL (no such user, or no membership on either axis).
-- `allowedOrgIds` is narrowed to the target org: [target] when the partner
-- allowlist contains it, [] when it does not, NULL when the allowlist is NULL.
-- canAccessOrg(…, target) answers exactly as on the full list, and the user's
-- other customer orgs are never disclosed to the caller.
-- plus `permissions`: the role's grants as [{resource, action}]. The caller
-- evaluates them with the same app-layer helpers as every request
-- (hasPermission / canAccessOrg / canAccessSite), so there is one definition
-- of what a grant or an access list means. User status is NOT checked here —
-- that is the requester-active gate's job, which runs first.
--
-- Same shape as breeze_command_requester_is_active: SECURITY DEFINER, fixed
-- search_path, in-body save/elevate/restore of `breeze.scope` with exactly ONE
-- RETURN immediately preceded by the restore and no early return; the elevated
-- region is a single SELECT keyed by the explicit user id and org id — no
-- writes, no dynamic SQL. EXECUTE revoked from PUBLIC, granted only to
-- breeze_app.
--
-- Idempotent (CREATE OR REPLACE; REVOKE/GRANT are repeatable). Writes no rows,
-- so no migration-level system-scope elevation is needed. No inner BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.breeze_command_requester_authority(
  requester_user_id uuid,
  target_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _caller_has_access boolean;
  _result jsonb := NULL;
BEGIN
  -- Evaluated in the CALLER's scope, before elevating.
  _caller_has_access := requester_user_id IS NOT NULL
    AND target_org_id IS NOT NULL
    AND COALESCE(public.breeze_has_org_access(target_org_id), false);

  PERFORM set_config('breeze.scope', 'system', true);

  IF _caller_has_access THEN
    SELECT jsonb_build_object(
             'scope', m.scope,
             'roleId', m.role_id,
             'orgAccess', m.org_access,
             'allowedOrgIds', CASE
                                WHEN m.org_ids IS NULL THEN NULL
                                WHEN target_org_id = ANY (m.org_ids) THEN jsonb_build_array(target_org_id)
                                ELSE '[]'::jsonb
                              END,
             'allowedSiteIds', to_jsonb(m.site_ids),
             'permissions', COALESCE((
               SELECT jsonb_agg(jsonb_build_object('resource', p.resource, 'action', p.action))
                 FROM public.role_permissions rp
                 JOIN public.permissions p ON p.id = rp.permission_id
                WHERE rp.role_id = m.role_id
             ), '[]'::jsonb)
           )
      INTO _result
      FROM public.users u
      JOIN public.organizations o ON o.id = target_org_id
      JOIN LATERAL (
             SELECT 0 AS priority,
                    'organization'::text AS scope,
                    ou.role_id,
                    NULL::text AS org_access,
                    NULL::uuid[] AS org_ids,
                    ou.site_ids
               FROM public.organization_users ou
              WHERE ou.user_id = u.id
                AND ou.org_id = target_org_id
                AND ou.role_id IS NOT NULL
             UNION ALL
             SELECT 1,
                    'partner'::text,
                    pu.role_id,
                    pu.org_access::text,
                    pu.org_ids,
                    NULL::uuid[]
               FROM public.partner_users pu
              WHERE pu.user_id = u.id
                AND pu.partner_id = u.partner_id
                AND pu.role_id IS NOT NULL
             ORDER BY 1
             LIMIT 1
           ) m ON true
     WHERE u.id = requester_user_id
       AND (u.partner_id = o.partner_id OR u.is_platform_admin = true);
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.breeze_command_requester_authority(uuid, uuid) IS
  'Claim-time requester authority: NULL unless the caller has org access to target_org_id and the user belongs to that org''s partner (or is a platform admin); otherwise the requester''s membership for that org (organization_users in the org, else partner_users in the user''s own partner) as {scope, roleId, orgAccess, allowedOrgIds narrowed to the target org, allowedSiteIds, permissions[]}, or NULL when there is none. Lets the org-scoped agent claim revalidate a partner-level technician''s queued script on its own connection without widening users/partner_users RLS.';

REVOKE ALL ON FUNCTION public.breeze_command_requester_authority(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_command_requester_authority(uuid, uuid) TO breeze_app;
  END IF;
END $$;
