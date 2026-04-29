import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import { OAUTH_ISSUER, OAUTH_RESOURCE_URL } from '../config/env';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { organizations, partnerUsers } from '../db/schema';
import { isGrantRevoked, isJtiRevoked } from '../oauth/revocationCache';

interface OAuthApiKeyContext {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimit: number;
  createdBy: string;
  oauthGrantId?: string;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(`${OAUTH_ISSUER}/.well-known/jwks.json`));
  return cachedJwks;
}

export function _resetJwksCacheForTests() {
  cachedJwks = null;
}

/**
 * Map OAuth scopes (mcp:read / mcp:write / mcp:execute) to the internal ai:*
 * scope vocabulary the MCP route handlers were built around. Without this,
 * every OAuth-authed MCP call fails the `ai:read` gate in routes/mcpServer.ts
 * even though the OAuth grant already scoped the token for MCP use. We
 * additively keep the original mcp:* scopes so future code paths can branch
 * on the OAuth vocabulary if needed.
 *
 * Mapping intent (target state):
 *   mcp:read    → ai:read       (tools/list, read-only tool calls)
 *   mcp:write   → ai:read, ai:write
 *   mcp:execute → ai:read, ai:write, ai:execute
 *
 * `ai:execute_admin` is intentionally NOT granted via OAuth — it gates the
 * most destructive operations and remains API-key-only by policy.
 *
 * Migration note: live 14-day refresh tokens were issued with `mcp:write`
 * back when that scope expanded to ai:read+ai:write+ai:execute. Splitting
 * `mcp:write` and the new `mcp:execute` cleanly would silently strip
 * `ai:execute` from those in-flight tokens and break MCP tool calls until
 * the user re-consented. To keep that release boundary clean, `mcp:write`
 * continues to grant `ai:execute` for one release while we emit a warning
 * per (process, client_id) — flip the legacy expansion off after
 * 2026-05-15 once the longest-lived legacy refresh tokens have rotated.
 */
const LEGACY_MCP_WRITE_WARNED_CLIENT_IDS = new Set<string>();

function warnLegacyMcpWriteExpansion(clientId: string | undefined): void {
  const key = clientId ?? '<no-client-id>';
  if (LEGACY_MCP_WRITE_WARNED_CLIENT_IDS.has(key)) return;
  LEGACY_MCP_WRITE_WARNED_CLIENT_IDS.add(key);
  // Lazy import keeps the bearer middleware free of an `oauth/log` dep
  // chain in the hot path; only loaded the first time a legacy token hits.
  void import('../oauth/log').then(({ ERROR_IDS, logOauthError }) => {
    logOauthError({
      errorId: ERROR_IDS.OAUTH_LEGACY_MCP_WRITE_SCOPE_GRANTED_EXECUTE,
      message: 'Legacy mcp:write scope granted ai:execute (remove after 2026-05-15)',
      context: { clientId },
    });
  }).catch(() => {
    // log import failure is non-fatal — silent dedupe still applies.
  });
}

// TODO(2026-05-15): drop the `ai:execute` line below — by then any live
// refresh token issued before the scope split will have aged out beyond
// the 14-day RefreshToken TTL.
function expandOAuthScopes(oauthScopes: string[], clientId?: string): string[] {
  const out = new Set<string>(oauthScopes);
  let legacyMcpWriteExpansion = false;
  for (const s of oauthScopes) {
    if (s === 'mcp:read') {
      out.add('ai:read');
    } else if (s === 'mcp:write') {
      out.add('ai:read');
      out.add('ai:write');
      // Backwards-compat for tokens minted before the scope split — see
      // file-level migration note.
      if (!oauthScopes.includes('mcp:execute')) {
        out.add('ai:execute');
        legacyMcpWriteExpansion = true;
      }
    } else if (s === 'mcp:execute') {
      out.add('ai:read');
      out.add('ai:write');
      out.add('ai:execute');
    }
  }
  if (legacyMcpWriteExpansion) warnLegacyMcpWriteExpansion(clientId);
  return Array.from(out);
}

export function _resetLegacyMcpWriteWarningsForTests() {
  LEGACY_MCP_WRITE_WARNED_CLIENT_IDS.clear();
}

/**
 * Resolve the actual list of orgs a partner-scope OAuth caller can reach.
 *
 * Defense-in-depth: without this, partner-scope OAuth tokens were passing
 * `accessibleOrgIds: null` to the DB context, which downstream
 * `auth.orgCondition()` interprets as "system scope, no filter" — meaning the
 * application-layer SQL filter is removed and we rely entirely on RLS. RLS is
 * still the primary tenant boundary, but the app-layer filter is a critical
 * second guard rail for any future code that bypasses the breeze_app role or
 * loses RLS GUCs (e.g. a worker, a misconfigured pool, a DELETE from a
 * privileged side-channel).
 *
 * This mirrors `computeAccessibleOrgIds` in middleware/auth.ts but is kept
 * inline here to avoid widening that file's export surface and to keep the
 * OAuth fast path cohesive. Returns `string[]` (never null) so the resulting
 * `accessibleOrgIds` always carries an explicit allowlist; an empty list
 * correctly produces "no rows match" rather than "all rows".
 *
 * Pre-auth lookup: this runs BEFORE we set the request's real RLS context,
 * so partner_users / organizations are queried via withSystemDbAccessContext
 * — same pattern as auth.ts. The returned list is then used to build the
 * non-system context the request actually runs under.
 */
async function resolvePartnerAccessibleOrgIds(
  partnerId: string,
  userId: string,
): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const [partnerMembership] = await db
      .select({
        orgAccess: partnerUsers.orgAccess,
        orgIds: partnerUsers.orgIds,
      })
      .from(partnerUsers)
      .where(
        and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, partnerId)),
      )
      .limit(1);

    if (!partnerMembership) return [];
    if (partnerMembership.orgAccess === 'none') return [];

    if (partnerMembership.orgAccess === 'selected') {
      const selected = (partnerMembership.orgIds ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (selected.length === 0) return [];
      const rows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.partnerId, partnerId),
            inArray(organizations.id, selected),
          ),
        );
      return rows.map((r) => r.id);
    }

    // orgAccess === 'all' — list every org under this partner.
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));
    return rows.map((r) => r.id);
  });
}

// Exported for unit tests that exercise the partner-scope resolution path.
export const _resolvePartnerAccessibleOrgIdsForTests = resolvePartnerAccessibleOrgIds;

export async function bearerTokenAuthMiddleware(c: Context, next: Next) {
  if (!OAUTH_ISSUER || !OAUTH_RESOURCE_URL) {
    throw new HTTPException(500, { message: 'OAuth not configured: OAUTH_ISSUER and OAUTH_RESOURCE_URL must be set' });
  }

  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new HTTPException(401, { message: 'missing bearer token' });

  const token = auth.slice(7);
  let payload: JWTPayload & {
    partner_id?: string | null;
    org_id?: string | null;
    grant_id?: string | null;
    scope?: string;
  };

  try {
    const result: JWTVerifyResult = await jwtVerify(token, getJwks(), {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_RESOURCE_URL,
      algorithms: ['EdDSA'],
      // Require `exp` — without it the token never expires, defeating
      // the entire 10-minute access-token lifetime model.
      requiredClaims: ['exp'],
    });
    payload = result.payload as typeof payload;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // jose throws errors with codes like ERR_JWS_*, ERR_JWT_*, ERR_JWKS_NO_MATCHING_KEY.
    // Anything else (no code, or non-jose code) is almost certainly a network/IO problem
    // talking to the JWKS endpoint - fail loud (503) rather than silently 401-ing every request.
    const isJoseError = typeof code === 'string' && code.startsWith('ERR_');
    if (!isJoseError) {
      console.error('[oauth] jwt verification failed for non-token reason (jwks fetch?)', e);
      throw new HTTPException(503, { message: 'oauth verification temporarily unavailable' });
    }
    throw new HTTPException(401, { message: `invalid token: ${code ?? (e as Error).message}` });
  }

  if (typeof payload.jti === 'string' && await isJtiRevoked(payload.jti)) {
    throw new HTTPException(401, { message: 'token revoked' });
  }
  // Grant-wide revocation: when a refresh token is revoked or a connected app
  // is deleted, every access JWT minted from the same Grant must die. The
  // grant_id claim is set by buildExtraTokenClaims (see oauth/provider.ts).
  if (typeof payload.grant_id === 'string' && await isGrantRevoked(payload.grant_id)) {
    throw new HTTPException(401, { message: 'token revoked' });
  }
  if (!payload.partner_id || !payload.sub) {
    throw new HTTPException(401, { message: 'token missing required claims' });
  }

  const oauthScopes = (payload.scope ?? '').split(' ').filter(Boolean);
  const clientIdClaim = typeof (payload as { client_id?: unknown }).client_id === 'string'
    ? (payload as { client_id?: string }).client_id
    : typeof (payload as { azp?: unknown }).azp === 'string'
      ? (payload as { azp?: string }).azp
      : undefined;
  const effectiveScopes = expandOAuthScopes(oauthScopes, clientIdClaim);

  (c.set as (key: 'apiKey', value: OAuthApiKeyContext) => void)('apiKey', {
    id: `oauth:${typeof payload.jti === 'string' ? payload.jti : 'no-jti'}`,
    orgId: payload.org_id ?? null,
    partnerId: payload.partner_id,
    name: 'OAuth bearer',
    keyPrefix: 'oauth',
    scopes: effectiveScopes,
    rateLimit: 1000,
    createdBy: payload.sub,
    ...(typeof payload.grant_id === 'string' ? { oauthGrantId: payload.grant_id } : {}),
  });
  if (payload.org_id) c.set('apiKeyOrgId', payload.org_id);

  // Defense-in-depth: resolve the concrete org allowlist for partner-scope
  // OAuth tokens BEFORE entering the request DB context. Without this we
  // were passing `accessibleOrgIds: null`, which downstream code interprets
  // as "system scope, no filter" — defeating the app-layer org filter and
  // leaning entirely on RLS. See resolvePartnerAccessibleOrgIds() above.
  const partnerAccessibleOrgIds = payload.org_id
    ? null
    : await resolvePartnerAccessibleOrgIds(payload.partner_id, payload.sub);

  await withDbAccessContext(
    payload.org_id
      ? {
          scope: 'organization',
          orgId: payload.org_id,
          accessibleOrgIds: [payload.org_id],
          accessiblePartnerIds: [payload.partner_id],
          userId: payload.sub,
        }
      : {
          scope: 'partner',
          orgId: null,
          // Resolved list (possibly []) — NEVER null for partner-scope tokens.
          // [] correctly produces "no rows match" (e.g. fresh tenant with no
          // orgs yet); null would mean "no filter, see everything".
          accessibleOrgIds: partnerAccessibleOrgIds ?? [],
          accessiblePartnerIds: [payload.partner_id],
          userId: payload.sub,
        },
    async () => {
      await next();
    }
  );
}
