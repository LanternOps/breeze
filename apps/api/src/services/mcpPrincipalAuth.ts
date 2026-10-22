/**
 * MCP principal auth (B-W04 #6158, D-B26).
 *
 * `buildAuthFromApiKey` is the ONE function that turns an MCP credential (a
 * human API key, an org service-principal key, a partner service principal,
 * or an OAuth grant injected through the same apiKey slot) into the caller's
 * AuthContext. It lives here, not in routes/mcpServer.ts, so the MCP request
 * path and the action-intent release worker build the context with the same
 * code: a released `mcp_api` intent can never run wider than the call that
 * filed it.
 */
import { eq, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext, PrincipalKind } from '../middleware/auth';
import { siteAccessCheck } from '../middleware/auth';
import { resolvePartnerAccessibleOrgIds } from '../middleware/bearerTokenAuth';
import { getUserPermissions } from './permissions';
import { authorizeHumanApiKeyCreator, authorizeServicePrincipalKey } from './apiKeyAuthorization';
import { getActiveOrgTenant } from './tenantStatus';
import { envFlag } from '../config/env';

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

const mcpExecuteToolAllowlist = parseCsvSet(process.env.MCP_EXECUTE_TOOL_ALLOWLIST);

export function isExecuteToolAllowedInProd(toolName: string): boolean {
  if (mcpExecuteToolAllowlist.size === 0) return false;
  return mcpExecuteToolAllowlist.has('*') || mcpExecuteToolAllowlist.has(toolName);
}

export function shouldRequireExecuteAdminInProd(): boolean {
  return process.env.NODE_ENV === 'production' && envFlag('MCP_REQUIRE_EXECUTE_ADMIN', true);
}

export type McpApiKeyContext = {
  id: string;
  orgId: string | null;
  partnerId?: string | null;
  oauthGrantId?: string | null;
  // Set by bearerTokenAuth for OAuth callers (the token's client_id claim).
  oauthClientId?: string | null;
  // API key creator, the signed `sub` (user id) for OAuth bearers, or the
  // principal's owner for a partner service principal key.
  createdBy?: string;
  // Partner service principal (`brz_sp_` key) this request authenticated as;
  // `id` is then its partner_service_principal_keys row id.
  partnerServicePrincipalId?: string | null;
  // B-W02 (#6156): MCP tool domains. `null` = unrestricted. REQUIRED: every
  // MCP auth middleware sets it explicitly, and a value that is somehow
  // missing at runtime fails CLOSED to core-only (parseStoredMcpDomains).
  mcpDomains: readonly string[] | null;
};

/**
 * Build a minimal AuthContext from an API key or OAuth-backed API key context.
 * API keys remain org-scoped; OAuth bearer tokens may be partner-scoped when
 * they carry a partner_id without an org_id.
 *
 * Defense-in-depth fix (M-B1): partner-scope callers used to receive
 * `accessibleOrgIds: null` + `orgCondition: () => undefined`, which is
 * the "system, no filter" shape — but `canAccessOrg: () => false`
 * contradicted that, leaving any code paths that switch on `canAccessOrg`
 * vs `orgCondition` in inconsistent states. Now we resolve the actual
 * partner→org list and use a proper inArray filter.
 */
export async function buildAuthFromApiKey(apiKey: {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  createdBy: string;
  scopes: string[];
  principalType?: string;
  principalId?: string | null;
  /**
   * Set when this "API key" is actually an MCP-OAuth bearer grant.
   * bearerTokenAuth injects OAuth tokens through the SAME apiKey context slot
   * (id `oauth:<jti>`, keyPrefix `oauth`), so without this the two are
   * indistinguishable here and an OAuth grant would be labelled `api_key`.
   * Same discriminator `mcpPrincipalKey` already uses.
   */
  oauthGrantId?: string | null;
  /**
   * Set when this is a partner service principal key (`brz_sp_`, see
   * middleware/partnerServicePrincipalMcpAuth.ts). Always partner scope:
   * `id` is the key id, `createdBy` the principal's owner, orgId null.
   */
  partnerServicePrincipalId?: string | null;
}): Promise<AuthContext | null> {
  // A partner service principal is partner-scoped by construction. Anything
  // else (an org pin, or no partner) is a malformed context: deny.
  if (apiKey.partnerServicePrincipalId && (apiKey.orgId || !apiKey.partnerId)) {
    return null;
  }

  const principal: PrincipalKind = apiKey.partnerServicePrincipalId
    ? { kind: 'api_key', apiKeyId: apiKey.id, partnerServicePrincipalId: apiKey.partnerServicePrincipalId }
    : apiKey.oauthGrantId
      ? { kind: 'oauth_grant', grantId: apiKey.oauthGrantId }
      : { kind: 'api_key', apiKeyId: apiKey.id };

  const user = {
    id: apiKey.createdBy,
    email: `apikey-${apiKey.name}@breeze.local`,
    name: apiKey.partnerServicePrincipalId
      ? `Partner service principal: ${apiKey.name}`
      : `API Key: ${apiKey.name}`,
    isPlatformAdmin: false
  };

  if (apiKey.orgId) {
    // A key inherits the CREATING user's access, including their site-axis
    // restriction — it can never be broader than the user who minted it. Load
    // the creator's allowedSiteIds for this org so the site gate (verifyDeviceAccess)
    // applies to MCP/API-key callers exactly as it does to the JWT request path.
    //
    // The creator may be a Partner Admin with NO organization_users row for this
    // org — their role lives in partner_users. getUserPermissions only consults
    // the partner axis when given a partnerId, but manual (user-created) keys
    // carry partnerId: null because apiKeyAuth deliberately gates partner-axis
    // RLS visibility (accessiblePartnerIds) to mcp_provisioning keys. Resolve the
    // owning org's partner here purely for ROLE resolution so a partner-admin-
    // minted key can pass checkToolPermission. This does NOT widen the key's RLS
    // partner visibility: the middleware still established this request's DB
    // context with an empty accessiblePartnerIds, so partner-scoped tables stay
    // unreadable. The key remains org-scoped (orgCondition pins to this org).
    const partnerId =
      apiKey.partnerId ?? (await getActiveOrgTenant(apiKey.orgId))?.partnerId ?? null;

    // SR2-15 (PR 5): a service-principal key (principalType === 'service')
    // is authorized against the PRINCIPAL, never the human who last rotated
    // it — `createdBy` on a service key is an audit trail (who minted the
    // current key), not an acting identity to delegate from. Human keys (the
    // default; also every OAuth-bearer caller, which never carries
    // principalType) take the unchanged authorizeHumanApiKeyCreator path.
    const isServicePrincipalKey = apiKey.principalType === 'service' && !!apiKey.principalId;

    // SR2-15: LIVE-authorize the human creator via the shared resolver — it does
    // BOTH the null-perms fail-closed deny (#2510) AND the scope re-clamp this
    // task adds. The old code read `creatorPerms?.allowedSiteIds` off a raw
    // getUserPermissions() call: a null read collapsed to `undefined`, and
    // siteAccessCheck(undefined) means "full access to EVERY site in the org" —
    // the same value a legitimate full-access admin gets. #2510 already closed
    // that hole with an explicit null-check. What #2510 did NOT do: re-validate
    // that the key's STORED scopes are still backed by the creator's CURRENT
    // permissions. A creator whose role was downgraded after the key was minted
    // (e.g. admin -> read-only) would still have their key served with the
    // original, now-stale, broader scopes — the MCP path never re-clamped. A
    // key delegates its creator's authority; it must never outlive a reduction
    // in that authority, any more than it may outlive its total loss.
    const authz = isServicePrincipalKey
      ? await authorizeServicePrincipalKey({
          principalId: apiKey.principalId as string,
          scopes: apiKey.scopes ?? [],
        })
      : await authorizeHumanApiKeyCreator({
          createdBy: apiKey.createdBy,
          orgId: apiKey.orgId,
          partnerId,
          scopes: apiKey.scopes ?? [],
        });
    if (!authz.ok) {
      // buildCheckedAuthFromApiKey maps null -> 403 (creator/principal has no
      // access, or the key's scopes exceed the current permission/scope ceiling).
      return null;
    }
    const allowedSiteIds = authz.allowedSiteIds;
    return {
      // `user` here is the key's CREATOR (apiKey.createdBy), not a caller who
      // logged in. Without this discriminator the two are indistinguishable.
      principal,
      user,
      token: {} as AuthContext['token'],
      partnerId,
      orgId: apiKey.orgId,
      scope: 'organization',
      accessibleOrgIds: [apiKey.orgId],
      orgCondition: (orgIdColumn) => eq(orgIdColumn, apiKey.orgId!),
      canAccessOrg: (checkOrgId) => checkOrgId === apiKey.orgId,
      allowedSiteIds,
      canAccessSite: siteAccessCheck(allowedSiteIds)
    };
  }

  // Partner-scope caller (OAuth bearer token, or a partner service principal
  // key: its `createdBy` is the principal's owner, so the same live
  // partner-role check and org resolver apply as for the owner's own bearer).
  //
  // SR2-15: this branch had no explicit null-perms deny — an off-boarded
  // partner admin's bearer key was only "data-starved" (accessibleOrgIds
  // resolves to [] via resolvePartnerAccessibleOrgIds, which reads
  // partner_users fresh and returns [] when the membership row is gone),
  // never outright rejected. That's an unsatisfiable org filter, not a
  // denial: tools/list still succeeds and the caller looks authenticated.
  // Add an explicit reject so an off-boarded partner admin's key is denied,
  // matching the org-scope branch's fail-closed behavior above.
  if (apiKey.partnerId) {
    let partnerPerms: Awaited<ReturnType<typeof getUserPermissions>>;
    try {
      partnerPerms = await getUserPermissions(apiKey.createdBy, { partnerId: apiKey.partnerId });
    } catch {
      // FAIL CLOSED: a DB/RLS error is indistinguishable from "no access".
      return null;
    }
    if (!partnerPerms) {
      return null;
    }
  }

  // Resolve the concrete org allowlist so orgCondition / canAccessOrg are
  // consistent and defense-in-depth filtering works alongside RLS.
  const accessibleOrgIds = apiKey.partnerId
    ? await resolvePartnerAccessibleOrgIds(apiKey.partnerId, apiKey.createdBy)
    : [];

  const orgCondition = (orgIdColumn: PgColumn): SQL | undefined => {
    if (accessibleOrgIds.length === 0) {
      // No accessible orgs — return an impossible condition so any query
      // using this filter matches no rows. Same pattern as auth.ts.
      return eq(orgIdColumn, '00000000-0000-0000-0000-000000000000');
    }
    if (accessibleOrgIds.length === 1) {
      return eq(orgIdColumn, accessibleOrgIds[0]);
    }
    return inArray(orgIdColumn, accessibleOrgIds);
  };

  return {
    principal,
    user,
    token: {} as AuthContext['token'],
    partnerId: apiKey.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds,
    orgCondition,
    canAccessOrg: (checkOrgId) => accessibleOrgIds.includes(checkOrgId),
  };
}
