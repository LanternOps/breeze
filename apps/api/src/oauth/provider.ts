import Provider from 'oidc-provider';
import * as Sentry from '@sentry/node';
import {
  OAUTH_COOKIE_SECRET,
  OAUTH_CONSENT_URL_BASE,
  OAUTH_DCR_ENABLED,
  OAUTH_ISSUER,
  OAUTH_RESOURCE_URL,
} from '../config/env';
import { BreezeOidcAdapter, getGrantBreezeMeta, getGrantBreezeMetaAsync } from './adapter';
import { findAccount } from './findAccount';
import { loadJwks } from './keys';
import { revokeJti } from './revocationCache';
import { isSentryEnabled } from '../services/sentry';
import { db } from '../db';
import { oauthClients } from '../db/schema';
import { isNull, lt, and as drizzleAnd } from 'drizzle-orm';
import { ERROR_IDS, logOauthError } from './log';

let providerInstance: Provider | null = null;

// Shared AccessToken TTL. Used for the JWT exp AND as the TTL for the
// grant-revocation cache marker (see revocationCache.revokeGrant) so the
// marker outlives every JWT derived from the grant.
export const ACCESS_TOKEN_TTL_SECONDS = 600;
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

// DCR cleanup TTL: a registered OAuth client that has never been used and
// is not bound to a partner is considered abandoned after this many ms.
export const DCR_STALE_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Garbage-collect DCR-registered OAuth clients that were never used.
 *
 * M-B5 (audit 2026-04-24): with `OAUTH_DCR_ENABLED=true` and
 * `initialAccessToken: false`, anyone can call POST /oauth/reg and create
 * a new client. Without GC, the table grows unbounded and abandoned client
 * IDs accumulate forever. We delete clients that:
 *   - were created more than DCR_STALE_CLIENT_TTL_MS ago (default 7 days),
 *   - have never been used (`last_used_at IS NULL`), AND
 *   - are not bound to a partner (`partner_id IS NULL`) — partner-bound
 *     clients represent a deliberate enterprise registration that should
 *     never be GC'd by time alone.
 *
 * Returns the number of rows deleted. Safe to call concurrently — the
 * SELECT-then-DELETE is a single SQL statement, no locks held across calls.
 *
 * SCHEDULING TODO: this helper is currently NOT wired into the BullMQ
 * worker registry in apps/api/src/index.ts. Adding the worker is a
 * separate, scheduled change because it touches index.ts (out of scope
 * for the security-fixes worktree). Operators can call this manually via
 * an admin script or a cron in the meantime.
 *
 * Skipped from this PR (per audit guidance): flipping
 * `initialAccessToken: true` would require building a dashboard UI for
 * issuing IATs to partners.
 */
export async function cleanupStaleOauthClients(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DCR_STALE_CLIENT_TTL_MS);
  const deleted = await db
    .delete(oauthClients)
    .where(
      drizzleAnd(
        lt(oauthClients.createdAt, cutoff),
        isNull(oauthClients.lastUsedAt),
        isNull(oauthClients.partnerId),
      ),
    )
    .returning({ id: oauthClients.id });
  return deleted.length;
}

export async function buildExtraTokenClaims(
  ctx: any,
  _token: any,
): Promise<{ partner_id: string | null; org_id: string | null; grant_id: string | null }> {
  const grant: any = ctx.oidc?.entities?.Grant;
  if (!grant) return { partner_id: null, org_id: null, grant_id: null };
  // The Grant instance's id is on `.jti` (oidc-provider's BaseToken sets jti
  // on every persisted entity). We can't read meta off `grant.breeze` because
  // Grant.IN_PAYLOAD doesn't include `breeze`, so unknown fields are dropped
  // on save and never restored on find. The side-table in adapter.ts is keyed
  // by that same jti — set in the consent route, read here at token mint.
  const grantId: string | undefined = grant.jti ?? grant.grantId;
  // First try the in-memory cache (warm path: same process as consent), then
  // fall back to the DB row for refresh-token grants that span an API
  // restart between consent and the next token exchange.
  const cached = getGrantBreezeMeta(grantId);
  const meta = cached ?? grant.breeze ?? (await getGrantBreezeMetaAsync(grantId));
  // Invariant: no null-claim JWT EVER leaves the server. If a grant_id is
  // present (the only case that produces a real access token), we must be
  // able to resolve its tenancy — otherwise bearer middleware would later
  // reject every request with a confusing 401 and the JWT itself would be
  // unreachable to refresh. Throw here so token mint fails with
  // `server_error` (surfaced by the `server_error` event listener below)
  // and the client can retry; better an immediate hard failure than a
  // silently broken token.
  if (grantId && (!meta || !meta.partner_id)) {
    const err = new Error(`OAuth grant meta missing for grant_id=${grantId}`);
    logOauthError({
      errorId: ERROR_IDS.OAUTH_GRANT_META_LOOKUP_FAILED,
      message: 'extraTokenClaims could not resolve grant meta; refusing to mint null-claim JWT',
      err,
      context: { grantId },
    });
    throw err;
  }
  return {
    partner_id: meta?.partner_id ?? null,
    org_id: meta?.org_id ?? null,
    // Surface the Grant id as a top-level JWT claim so bearer middleware can
    // check it against the grant-revocation cache. Without this, revoking a
    // refresh token (or deleting a connected app) would not invalidate the
    // ~10-minute access tokens already minted from the same grant.
    grant_id: grantId ?? null,
  };
}

export async function handleRevocationSuccess(
  ctx: any,
  token: { jti?: string; exp?: number },
  deps: { revokeJti: (jti: string, ttl: number) => Promise<void>; now?: () => number } = { revokeJti },
): Promise<void> {
  if (!token.jti || !token.exp) return;
  const nowMs = deps.now?.() ?? Date.now();
  const ttl = Math.max(token.exp - Math.floor(nowMs / 1000), 1);
  // Await the cache write and rethrow on failure so oidc-provider returns
  // a 5xx — fire-and-forget swallowed Redis outages, leaving the operator
  // with no signal that revocation had stopped working.
  try {
    await deps.revokeJti(token.jti, ttl);
  } catch (err) {
    const clientId = (ctx?.oidc?.client?.clientId as string | undefined)
      ?? (ctx?.oidc?.entities?.Client?.clientId as string | undefined);
    logOauthError({
      errorId: ERROR_IDS.OAUTH_REVOCATION_CACHE_WRITE_FAILED,
      message: 'Revocation cache write failed in handleRevocationSuccess',
      err,
      context: { jti: token.jti, clientId },
    });
    throw err;
  }
}

export async function getProvider(): Promise<Provider> {
  if (providerInstance) return providerInstance;
  if (!OAUTH_COOKIE_SECRET) {
    throw new Error('OAUTH_COOKIE_SECRET is required when MCP_OAUTH_ENABLED is true (set a strong random string in env)');
  }
  if (!OAUTH_ISSUER) {
    throw new Error('OAUTH_ISSUER is required when MCP_OAUTH_ENABLED is true (set the issuer URL in env)');
  }
  if (!OAUTH_RESOURCE_URL) {
    throw new Error('OAUTH_RESOURCE_URL is required when MCP_OAUTH_ENABLED is true (typically `${OAUTH_ISSUER}/mcp/server`)');
  }
  if (!OAUTH_CONSENT_URL_BASE) {
    throw new Error(
      'OAUTH_CONSENT_URL_BASE is required when MCP_OAUTH_ENABLED is true. ' +
      'For a single-origin deployment this should equal OAUTH_ISSUER; for cross-origin dev ' +
      'set it to the web app origin that hosts /oauth/consent (e.g. http://localhost:4321).',
    );
  }

  const jwks = await loadJwks();

  providerInstance = new Provider(OAUTH_ISSUER, {
    adapter: BreezeOidcAdapter,
    clients: [],
    jwks,
    cookies: {
      keys: [OAUTH_COOKIE_SECRET],
      // Widen the interaction cookie path so the consent UI (`/oauth/consent`)
      // AND the consent backend (`/api/v1/oauth/interaction/...`) both receive
      // it. Without this, the browser would scope the cookie to /oauth/consent
      // only and the API endpoint that resumes the flow would never see it.
      short: { path: '/' },
      long: { path: '/' },
    },
    findAccount,
    enabledJWA: {
      idTokenSigningAlgValues: ['EdDSA'],
      requestObjectSigningAlgValues: ['EdDSA'],
      userinfoSigningAlgValues: ['EdDSA'],
      introspectionSigningAlgValues: ['EdDSA'],
      authorizationSigningAlgValues: ['EdDSA'],
    },
    // oidc-provider's default `issueRefreshToken` returns false unless the
    // auth code's scopes include `offline_access`. The OIDC core spec then
    // silently drops `offline_access` from the request scope unless the
    // request explicitly carries `prompt=consent` (see oidc-provider's
    // `lib/actions/authorization/check_scope.js` and the `prompt` getter on
    // OIDCContext — `PARAM_LIST` always contains `'prompt'`, so the gate
    // simplifies to "did the request send prompt=consent?"). MCP clients in
    // the wild rarely send `prompt=consent`, so by default they never get a
    // refresh token, forcing re-consent every 10 minutes when the access
    // token expires. We override the gate to issue a refresh token whenever
    // the client is registered for the `refresh_token` grant — DCR-registered
    // clients default to `['authorization_code', 'refresh_token']` so this
    // covers everything the MCP installer registers, while still respecting
    // confidential-client config that explicitly disables refresh.
    issueRefreshToken: async (_ctx: any, client: any, _code: any) =>
      client.grantTypeAllowed('refresh_token'),
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: OAUTH_DCR_ENABLED, initialAccessToken: false },
      registrationManagement: { enabled: OAUTH_DCR_ENABLED },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => OAUTH_RESOURCE_URL,
        // SECURITY (M-B3, audit 2026-04-24): the scope returned here is
        // hardcoded — every tenant gets `mcp:read mcp:write mcp:execute`
        // regardless of partner-level policy. Per-tenant scope restriction
        // (e.g. partners that should only ever issue `mcp:read`) is NOT
        // wired up here yet. The reason this isn't a critical: the Grant's
        // breeze meta carries partner_id/org_id, and downstream bearer
        // middleware + AI guardrails enforce per-call permissions, so a
        // token with `mcp:execute` still cannot reach tools the partner
        // policy forbids. This finding is about defense-in-depth — not
        // issuing scopes the partner has explicitly disabled.
        //
        // To wire up: read `partners.settings.mcp_allowed_scopes` (jsonb)
        // and intersect the response. Requires (a) a hot-path DB lookup
        // here, (b) a per-process cache keyed on partner_id with a short
        // TTL, and (c) plumbing the partner_id from the Grant into _ctx
        // (currently the Grant entity is on ctx.oidc.entities.Grant).
        // Tracked for a follow-up PR; see audit doc.
        getResourceServerInfo: (_ctx: any, resource: string) => {
          const scope = 'mcp:read mcp:write mcp:execute';
          // Sentry breadcrumb so operators can detect over-issuance if a
          // partner policy is later set in DB but bypassed by this hot path.
          if (isSentryEnabled()) {
            Sentry.addBreadcrumb({
              category: 'oauth.scope',
              level: 'info',
              message: 'mcp_scope_issued',
              data: { resource, scope },
            });
          }
          return {
            scope,
            accessTokenFormat: 'jwt' as const,
            accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
            audience: resource,
            jwt: { sign: { alg: 'EdDSA' as const } },
          };
        },
        useGrantedResource: (_ctx: any, _model: any) => true,
      },
    },
    scopes: ['openid', 'offline_access', 'mcp:read', 'mcp:write', 'mcp:execute'],
    // S256 is the only PKCE method supported in oidc-provider v8 (the spec
    // dropped `plain`); pass only `required`.
    pkce: { required: () => true },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_SECONDS,
      AuthorizationCode: 600,
      RefreshToken: REFRESH_TOKEN_TTL_SECONDS,
      Session: 14 * 24 * 60 * 60,
      Interaction: 60 * 60,
      Grant: 14 * 24 * 60 * 60,
    },
    claims: {
      openid: ['sub'],
      profile: ['name', 'email'],
      breeze_tenant: ['partner_id', 'org_id'],
    },
    extraTokenClaims: buildExtraTokenClaims,
    // Tell the provider its endpoints sit under /oauth so it sets cookies
    // with the right path. Without this, _interaction_resume's path would
    // be /auth/<uid> and the browser would never send it back to
    // /oauth/auth/<uid>, breaking the flow on consent submission.
    routes: {
      authorization: '/oauth/auth',
      backchannel_authentication: '/oauth/backchannel',
      code_verification: '/oauth/device',
      device_authorization: '/oauth/device/auth',
      end_session: '/oauth/session/end',
      introspection: '/oauth/token/introspection',
      jwks: '/oauth/jwks',
      pushed_authorization_request: '/oauth/par',
      registration: '/oauth/reg',
      revocation: '/oauth/token/revocation',
      token: '/oauth/token',
      userinfo: '/oauth/me',
    },
    interactions: {
      url: (_ctx: any, interaction: any) =>
        `${OAUTH_CONSENT_URL_BASE}/oauth/consent?uid=${interaction.uid}`,
    },
  });

  providerInstance.proxy = true;
  // NOTE: oidc-provider 8.x does NOT emit `revocation.success`. We previously
  // attached `handleRevocationSuccess` here, but the event never fired so
  // revoked tokens kept passing the bearer middleware until they expired.
  // Revocation is now wired via the adapter's `destroy()` method (see
  // adapter.ts), which oidc-provider DOES call on revoke. The
  // `handleRevocationSuccess` helper is retained because its tests cover the
  // TTL-clamp logic we want to keep verified.
  // Surface OIDC error events to stderr. These are otherwise swallowed by
  // oidc-provider's debug() logging (only visible with DEBUG=oidc-provider:*),
  // and the JSON error responses sent to clients deliberately omit the
  // detail string for security — so without these listeners, on-call has
  // no way to diagnose a 400/500 from the OAuth endpoints.
  (providerInstance as any).on('server_error', (_ctx: any, err: any) => {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_PROVIDER_SERVER_ERROR,
      message: 'oidc-provider server_error',
      err,
    });
  });
  (providerInstance as any).on('authorization.error', (_ctx: any, err: any) => {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_PROVIDER_AUTHORIZATION_ERROR,
      message: 'oidc-provider authorization.error',
      err,
    });
  });
  (providerInstance as any).on('grant.error', (_ctx: any, err: any) => {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR,
      message: 'oidc-provider grant.error',
      err,
      context: {
        error: err?.error,
        detail: err?.error_detail,
      },
    });
  });
  return providerInstance;
}
