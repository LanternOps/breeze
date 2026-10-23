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
import { buildOrgAccessClosures, siteAccessCheck } from '../middleware/auth';
import { resolvePartnerAccessibleOrgIds } from '../middleware/bearerTokenAuth';
import { getUserPermissions } from './permissions';
import { authorizeHumanApiKeyCreator, authorizeServicePrincipalKey } from './apiKeyAuthorization';
import { getActiveOrgTenant } from './tenantStatus';
import { mcpTier3IntentsEnabled } from './mcpIntentConfig';
import { db, withSystemDbAccessContext } from '../db';
import { apiKeys } from '../db/schema/apiKeys';
import { users } from '../db/schema/users';
import { oauthClients, oauthGrants } from '../db/schema/oauth';
import type { ActionIntent } from '../db/schema/actionIntents';
import { expandOAuthScopes, filterBlockedOAuthClientOrgIds } from '../middleware/bearerTokenAuth';
import { isApiKeyCreatorEpochStale } from '../middleware/apiKeyAuth';
import { activeGrantCondition } from '../oauth/grantStatus';
import { isGrantRevoked } from '../oauth/revocationCache';
import { computeEffectiveMcpScopes } from '../oauth/effectiveScopes';
import { assertActiveTenantContext, TenantInactiveError } from './tenantStatus';
import { isDomainGranted, mcpToolDomain, parseStoredMcpDomains, type McpDomainGrant } from './mcpDomains';
import { isMcpOriginIntent } from './mcpIntentEligibility';
import { isMfaGatedToolAction, mfaGateRefusesCaller } from './aiToolMfaGate';
import { resolveTenantMutationTargetOrgId } from './actionIntents/actorContext';

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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

// ============================================
// B-W04 (#6158, D-B26): release under the live origin credential
// ============================================

/** The credential shape buildAuthFromApiKey consumes. */
export type McpAuthKeyInput = Parameters<typeof buildAuthFromApiKey>[0];

export type LiveMcpOriginCredential = {
  kind: 'api_key' | 'oauth_grant';
  keyInput: McpAuthKeyInput;
  /** Live, clamped scopes in the ai:* vocabulary (OAuth: mcp:* expanded). */
  scopes: string[];
  domainGrant: McpDomainGrant;
  /** The human behind the credential (key creator / grant account). */
  humanUserId: string;
  /** OAuth client id, for the client-block re-check; null for API keys. */
  oauthClientId: string | null;
};

export type McpOriginReleaseErrorCode =
  | 'mcp_origin_revoked'
  | 'mcp_scope_lost'
  | 'mcp_domain_lost'
  | 'mcp_org_out_of_scope'
  | 'mcp_tool_not_allowed'
  | 'mcp_mfa_required'
  | 'mcp_intents_disabled';

const REVOKED = { error: 'mcp_origin_revoked' } as const;

/**
 * A transient read failure while re-proving the origin credential. Thrown,
 * never mapped to `mcp_origin_revoked`: the release is retried (or reaped as
 * execution_lost), and the user is not told a healthy credential was revoked.
 */
export class McpOriginTransientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`transient: ${message}`);
    this.name = 'McpOriginTransientError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Loads the credential an `mcp_api` intent was filed with and re-proves it is
 * still live, re-using the request path's own checks rather than re-spelling
 * them: key status/expiry, creator status + credential/MFA epoch
 * (`isApiKeyCreatorEpochStale`), the creator re-clamp
 * (`authorizeHumanApiKeyCreator`), and for OAuth `activeGrantCondition`, the
 * Redis revocation marker, the strict tenant check, the client kill switch
 * and the per-org client block. The human behind the credential must still
 * be the intent's requester.
 *
 * `mcp_scope_lost` is returned (rather than `mcp_origin_revoked`) only when
 * the creator still exists but no longer backs the key's stored scopes.
 */
export async function loadLiveMcpOriginCredential(
  intent: ActionIntent,
): Promise<LiveMcpOriginCredential | { error: 'mcp_origin_revoked' | 'mcp_scope_lost' }> {
  if (!isMcpOriginIntent(intent) || !intent.originPrincipalId || !intent.requestedByUserId) return REVOKED;
  const requester = intent.requestedByUserId;
  const originId = intent.originPrincipalId;
  return withSystemDbAccessContext(async () => {
    if (intent.originPrincipalKind === 'api_key') {
      return loadLiveApiKey(originId, requester);
    }
    return loadLiveOAuthGrant(intent, originId, requester);
  });
}

async function loadLiveApiKey(
  keyId: string,
  requester: string,
): Promise<LiveMcpOriginCredential | { error: 'mcp_origin_revoked' | 'mcp_scope_lost' }> {
  const [key] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      createdBy: apiKeys.createdBy,
      status: apiKeys.status,
      source: apiKeys.source,
      principalType: apiKeys.principalType,
      principalId: apiKeys.principalId,
      creatorAuthEpoch: apiKeys.creatorAuthEpoch,
      creatorMfaEpoch: apiKeys.creatorMfaEpoch,
      creatorCredentialEpoch: apiKeys.creatorCredentialEpoch,
      mcpDomains: apiKeys.mcpDomains,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  if (!key || key.status !== 'active') return REVOKED;
  if (key.expiresAt && new Date(key.expiresAt) < new Date()) return REVOKED;
  // An org service-principal key can never own an mcp_api intent (refused at
  // creation); a row that claims otherwise is not released.
  if (key.principalType === 'service') return REVOKED;
  if (key.createdBy !== requester) return REVOKED;

  const [creator] = await db
    .select({
      status: users.status,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      credentialEpoch: users.credentialEpoch,
    })
    .from(users)
    .where(eq(users.id, key.createdBy))
    .limit(1);
  if (!creator || creator.status !== 'active') return REVOKED;
  if (isApiKeyCreatorEpochStale(key, creator)) return REVOKED;

  const ownerTenant = await getActiveOrgTenant(key.orgId);
  if (!ownerTenant) return REVOKED;

  // The middleware's re-clamp, so the scopes checked at release are the ones
  // the request path would serve today.
  const authz = await authorizeHumanApiKeyCreator({
    createdBy: key.createdBy,
    orgId: key.orgId,
    partnerId: ownerTenant.partnerId,
    scopes: key.scopes ?? [],
  });
  if (!authz.ok) {
    // A failed permission READ is not a revocation: throw so the release is
    // retried / reaped as execution_lost, never misreported as revoked.
    if (authz.reason === 'lookup_error') {
      throw new McpOriginTransientError('creator permission lookup failed for the origin API key');
    }
    return authz.reason === 'scope_exceeds_current_permissions' ? { error: 'mcp_scope_lost' } : REVOKED;
  }

  return {
    kind: 'api_key',
    keyInput: {
      id: key.id,
      orgId: key.orgId,
      // apiKeyAuthMiddleware resolves the partner only for MCP-provisioning
      // keys; mirror it so the rebuilt context is the request-path one.
      partnerId: key.source === 'mcp_provisioning' ? ownerTenant.partnerId : null,
      name: key.name,
      createdBy: key.createdBy,
      scopes: authz.clampedScopes,
      principalType: key.principalType,
      principalId: key.principalId ?? null,
    },
    scopes: authz.clampedScopes,
    domainGrant: parseStoredMcpDomains(key.mcpDomains),
    humanUserId: key.createdBy,
    oauthClientId: null,
  };
}

/** The scopes the consent wrote for the MCP resource (oidc-provider Grant payload). */
function grantRequestedScopes(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { resources?: Record<string, unknown>; openid?: { scope?: unknown } };
  const resource = process.env.OAUTH_RESOURCE_URL;
  const fromResource = resource && p.resources ? p.resources[resource] : undefined;
  const raw = typeof fromResource === 'string' ? fromResource : typeof p.openid?.scope === 'string' ? p.openid.scope : '';
  return raw.split(' ').filter(Boolean);
}

async function loadLiveOAuthGrant(
  intent: ActionIntent,
  grantId: string,
  requester: string,
): Promise<LiveMcpOriginCredential | { error: 'mcp_origin_revoked' }> {
  const [grant] = await db
    .select({
      id: oauthGrants.id,
      accountId: oauthGrants.accountId,
      clientId: oauthGrants.clientId,
      partnerId: oauthGrants.partnerId,
      orgId: oauthGrants.orgId,
      payload: oauthGrants.payload,
      mcpDomains: oauthGrants.mcpDomains,
    })
    .from(oauthGrants)
    .where(activeGrantCondition(grantId, new Date()))
    .limit(1);
  if (!grant || grant.accountId !== requester || !grant.partnerId) return REVOKED;
  // Eager revocation signal (fails closed when Redis is missing with OAuth on).
  if (await isGrantRevoked(grant.id)) return REVOKED;

  const [user] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, grant.accountId))
    .limit(1);
  if (!user || user.status !== 'active') return REVOKED;

  const [client] = await db
    .select({ id: oauthClients.id, disabledAt: oauthClients.disabledAt })
    .from(oauthClients)
    .where(eq(oauthClients.id, grant.clientId))
    .limit(1);
  if (!client || client.disabledAt) return REVOKED;

  try {
    await assertActiveTenantContext(
      { scope: grant.orgId ? 'organization' : 'partner', partnerId: grant.partnerId, orgId: grant.orgId ?? null },
      { strictForOauth: true },
    );
  } catch (err) {
    if (err instanceof TenantInactiveError) return REVOKED;
    throw err;
  }

  // The org-wide client block, for the intent's org and any recorded
  // tenant-mutation target org.
  const targetOrgId = resolveTenantMutationTargetOrgId(intent);
  const orgIds = targetOrgId && targetOrgId !== intent.orgId ? [intent.orgId, targetOrgId] : [intent.orgId];
  const unblocked = await filterBlockedOAuthClientOrgIds(orgIds, grant.clientId);
  if (unblocked.length !== orgIds.length) return REVOKED;

  // buildAuthFromApiKey fails a partner-permission READ error closed (null),
  // which release would report as revoked. Read it here first so a transient
  // fault throws (retryable) and only a real "no membership" revokes.
  if (!grant.orgId) {
    let partnerPerms: Awaited<ReturnType<typeof getUserPermissions>>;
    try {
      partnerPerms = await getUserPermissions(grant.accountId, { partnerId: grant.partnerId });
    } catch (err) {
      throw new McpOriginTransientError('partner permission lookup failed for the origin OAuth grant', err);
    }
    if (!partnerPerms) return REVOKED;
  }

  const effective = await computeEffectiveMcpScopes({
    requested: grantRequestedScopes(grant.payload),
    partnerId: grant.partnerId,
    hasGrant: true,
  });
  const scopes = expandOAuthScopes(effective, grant.clientId);

  return {
    kind: 'oauth_grant',
    keyInput: {
      // Per-grant, not per-token (`oauth:<jti>`): release has no token.
      id: `oauth:grant:${grant.id}`,
      orgId: grant.orgId ?? null,
      partnerId: grant.partnerId,
      name: 'OAuth bearer',
      createdBy: grant.accountId,
      scopes,
      oauthGrantId: grant.id,
    },
    scopes,
    domainGrant: parseStoredMcpDomains(grant.mcpDomains),
    humanUserId: grant.accountId,
    oauthClientId: grant.clientId,
  };
}

/**
 * Rebuilds the caller's AuthContext for a queued `mcp_api` intent with the
 * SAME function the MCP request path uses, from the live credential — so a
 * release can never be wider than the call: same org pin, same `token: {}`
 * (no synthetic MFA), same creator re-authorisation, same site set.
 */
export async function rebuildMcpOriginAuthContext(
  intent: ActionIntent,
): Promise<{ auth: AuthContext; credential: LiveMcpOriginCredential } | { error: McpOriginReleaseErrorCode }> {
  const credential = await loadLiveMcpOriginCredential(intent);
  if ('error' in credential) return { error: credential.error };
  const built = await withSystemDbAccessContext(() => buildAuthFromApiKey(credential.keyInput));
  if (!built) return REVOKED;
  let auth = built;
  // The bearer path removes orgs the OAuth client is blocked in from a
  // partner-scope token's org set (bearerTokenAuth.ts); buildAuthFromApiKey
  // does not, so apply the same filter to the rebuilt context.
  if (credential.kind === 'oauth_grant' && auth.scope === 'partner' && auth.accessibleOrgIds) {
    const allowed = await filterBlockedOAuthClientOrgIds(auth.accessibleOrgIds, credential.oauthClientId ?? undefined);
    auth = { ...auth, accessibleOrgIds: allowed, ...buildOrgAccessClosures(allowed) };
  }
  return { auth, credential };
}

/**
 * Re-runs the creation gates against the live state at release: the kill
 * switch, `ai:execute` (+ `ai:execute_admin` in production), the production
 * allowlist, the credential's MCP domain grant, org reach (the intent org and
 * any recorded tenant-mutation target — an org-pinned key never widens to a
 * `targetOrgId`), and the MFA gate. RBAC and the governance site ceiling run
 * afterwards in revalidateApprovedIntentCore, unchanged.
 */
export function checkMcpOriginReleaseAuthority(
  intent: ActionIntent,
  rebuilt: { auth: AuthContext; credential: LiveMcpOriginCredential },
): { ok: true } | { ok: false; errorCode: McpOriginReleaseErrorCode } {
  const no = (errorCode: McpOriginReleaseErrorCode) => ({ ok: false as const, errorCode });
  const { auth, credential } = rebuilt;
  if (!mcpTier3IntentsEnabled()) return no('mcp_intents_disabled');
  if (!credential.scopes.includes('ai:execute')) return no('mcp_scope_lost');
  if (shouldRequireExecuteAdminInProd() && !credential.scopes.includes('ai:execute_admin')) return no('mcp_scope_lost');
  if (process.env.NODE_ENV === 'production' && !isExecuteToolAllowedInProd(intent.actionName)) {
    return no('mcp_tool_not_allowed');
  }
  if (!isDomainGranted(credential.domainGrant, mcpToolDomain(intent.actionName))) return no('mcp_domain_lost');
  if (!auth.canAccessOrg(intent.orgId)) return no('mcp_org_out_of_scope');
  const targetOrgId = resolveTenantMutationTargetOrgId(intent);
  if (targetOrgId && !auth.canAccessOrg(targetOrgId)) return no('mcp_org_out_of_scope');
  const action = typeof intent.arguments?.action === 'string' ? intent.arguments.action : undefined;
  if (isMfaGatedToolAction(intent.actionName, action) && mfaGateRefusesCaller(auth)) return no('mcp_mfa_required');
  return { ok: true };
}
