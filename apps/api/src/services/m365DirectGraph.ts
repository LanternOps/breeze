/**
 * Direct Microsoft Graph backend for the M365 identity tools.
 *
 * For self-hosted deployments that DON'T use the external Delegant broker, this
 * talks to Graph directly with a client-credentials token built from the per-org
 * `m365_connections` row (tenant id + client id + encrypted client secret).
 *
 * It exposes `invokeDirect(orgId, toolName, params)` which maps the same
 * `DelegantToolName` set the tool handlers already use to Graph calls, and
 * returns the SAME result shape (`{kind:'ok',data}` | `{kind:'error',code,message}`)
 * that `formatResultForLlm` consumes — so the existing handlers work unchanged
 * once `aiToolsM365.ts` routes through here when a direct connection exists.
 *
 * Reuses `acquireClientCredentialsToken` from c2cM365 (fixed-host, SSRF-safe).
 * Reads need only User.Read.All / Group.Read.All / AuditLog.Read.All; the
 * mutations (disable, reset password) additionally require the app to hold
 * User.ReadWrite.All / User-PasswordProfile.ReadWrite.All plus the User
 * Administrator Entra role — surfaced as a clear error if the grant is missing.
 */

import { randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { m365Connections } from '../db/schema/m365';
import { decryptForColumn } from './secretCrypto';
import { acquireClientCredentialsToken, isM365TenantId } from './c2cM365';
import type { DelegantToolName } from './delegantClient';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export type DirectInvokeError = { kind: 'error'; code: string; message: string };
export type DirectInvokeResult<T = unknown> =
  | { kind: 'ok'; data: T }
  | DirectInvokeError;

// Bound on any single Graph/token round-trip. Delivery-path callers run inside
// the agent heartbeat response (post-#1105-hoist), where a hung upstream fetch
// would stall the response past the agent's client timeout and drop that
// cycle's already-claimed command delivery. An abort lands in the fetch catch
// as a normal error result (graph_unreachable / auth_failed) — fail closed.
export const GRAPH_HTTP_TIMEOUT_MS = 5_000;

/** True when a direct M365 connection exists for the org (selects the direct backend). */
export async function hasDirectM365Connection(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: m365Connections.id })
    .from(m365Connections)
    .where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'legacy-direct'),
    ))
    .limit(1);
  return !!row;
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'auth_failed';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    default: return status >= 500 ? 'graph_unavailable' : 'tool_error';
  }
}

/** Strong temporary password (mixed classes), used by reset_user_password. */
function generateTempPassword(): string {
  const raw = randomBytes(18).toString('base64').replace(/[+/=]/g, '');
  return `Mz9!${raw.slice(0, 18)}`;
}

// Process-level cache of acquired Graph tokens, keyed `${orgId}:${clientId}`
// so a stored connection's client id rotating (new app registration on the
// same org) can never collide with a stale cached token from the old one.
// Every getToken caller (invokeDirect here, plus onedriveGraph.ts's
// listSharePointLibraries/resolveUserGroupMembership) goes through this same
// function, so the cache is transparent to all of them.
const TOKEN_CACHE_SKEW_MS = 60_000;
// Bounded even when Graph grants a longer-lived token — keeps the worst-case
// staleness window (e.g. after an app permission change) predictable.
const TOKEN_CACHE_MAX_TTL_MS = 30 * 60 * 1000;
export const TOKEN_CACHE_MAX = 1_000;

type TokenCacheEntry = { token: string; expiresAt: number };
const tokenCache = new Map<string, TokenCacheEntry>();

/** Test hook. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Insert/refresh a cache entry, bounding the map size. Map preserves
 * insertion order, so delete-then-set moves a refreshed key to the back, and
 * evicting past the bound just means deleting the first (oldest) key. */
function setTokenCacheEntry(key: string, token: string, expiresInSeconds: number): void {
  const ttlMs = Math.min(Math.max(expiresInSeconds * 1000 - TOKEN_CACHE_SKEW_MS, 0), TOKEN_CACHE_MAX_TTL_MS);
  tokenCache.delete(key);
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlMs });
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
}

export async function getToken(orgId: string): Promise<{ token: string } | DirectInvokeError> {
  const [row] = await db
    .select()
    .from(m365Connections)
    .where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'legacy-direct'),
      eq(m365Connections.status, 'active'),
    ))
    .limit(1);
  if (!row) {
    return { kind: 'error', code: 'no_connection', message: 'No legacy Microsoft 365 connection for this organization.' };
  }
  if (!row.clientSecret) {
    return { kind: 'error', code: 'connection_key_error', message: 'Legacy Microsoft 365 connection has no stored client secret.' };
  }

  const cacheKey = `${orgId}:${row.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { token: cached.token };
  }

  const secret = decryptForColumn('m365_connections', 'client_secret', row.clientSecret);
  if (!secret) {
    return { kind: 'error', code: 'connection_key_error', message: 'Could not decrypt the stored client secret.' };
  }
  // The stored tenant id must still be a canonical Entra tenant GUID (the
  // M365TenantId brand acquireClientCredentialsToken requires); fail closed if not.
  const tenantId = row.tenantId;
  if (!tenantId || !isM365TenantId(tenantId)) {
    return { kind: 'error', code: 'connection_key_error', message: 'Stored Microsoft 365 tenant id is not a valid tenant GUID.' };
  }
  try {
    const t = await acquireClientCredentialsToken({
      tenantId,
      clientId: row.clientId,
      clientSecret: secret,
    });
    setTokenCacheEntry(cacheKey, t.accessToken, t.expiresIn);
    return { token: t.accessToken };
  } catch (err) {
    // Reaching here means we didn't have a live cache hit (a hit above
    // returns before ever calling Azure), so any entry still sitting under
    // this key is already-expired debris. Delete it explicitly rather than
    // leaving it for the next TTL check — belt-and-suspenders so a rotated
    // secret can never be blocked by a stale entry, including across a
    // future refactor of the cache-hit branch above.
    tokenCache.delete(cacheKey);
    return { kind: 'error', code: 'auth_failed', message: err instanceof Error ? err.message : 'token acquisition failed' };
  }
}

export async function graphFetch(
  token: string,
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { headers?: Record<string, string> },
): Promise<DirectInvokeResult> {
  let resp: Response;
  try {
    // path is normally relative to GRAPH_BASE; pagination follows Graph's
    // absolute @odata.nextLink URLs. Only same-origin Graph URLs may pass
    // through — the Authorization header must never follow a link elsewhere.
    let url: string;
    if (path.startsWith('https://')) {
      if (!path.startsWith(`${GRAPH_BASE}/`)) {
        return { kind: 'error', code: 'bad_request', message: 'Refusing non-Graph absolute URL.' };
      }
      url = path;
    } else {
      url = `${GRAPH_BASE}${path}`;
    }
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts?.headers ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GRAPH_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'error', code: 'graph_unreachable', message: err instanceof Error ? err.message : 'Graph request failed' };
  }
  if (resp.status === 204) return { kind: 'ok', data: { ok: true } };
  let json: unknown = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const message =
      (json as any)?.error?.message ?? `Graph returned HTTP ${resp.status}`;
    return { kind: 'error', code: mapStatusToCode(resp.status), message };
  }
  return { kind: 'ok', data: json };
}

/**
 * Map a Delegant tool name + params to a direct Graph call. `userId` may be a UPN
 * or an object id (Graph /users/{key} accepts either); sign-in filtering needs
 * the object id, which the handler resolves first via get_user.
 */
export async function invokeDirect(
  orgId: string,
  toolName: DelegantToolName,
  params: Record<string, unknown>,
): Promise<DirectInvokeResult> {
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok; // error result
  const token = tok.token;
  const userId = typeof params.userId === 'string' ? params.userId : '';
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';

  switch (toolName) {
    case 'get_user':
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      return graphFetch(token, 'GET', `/users/${encodeURIComponent(userId)}`);

    case 'get_user_signin_activity': {
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      // Escape single quotes per OData (double them) so a quote in the id can't
      // break out of the literal; encodeURIComponent only handles URL transport.
      const odataId = userId.replace(/'/g, "''");
      // Sign-in logs require Entra ID P1/P2 on the tenant; a clear error surfaces if not.
      return graphFetch(
        token,
        'GET',
        `/auditLogs/signIns?$filter=${encodeURIComponent(`userId eq '${odataId}'`)}&$top=10`,
      );
    }

    case 'list_groups':
      return graphFetch(token, 'GET', `/groups?$top=50&$select=id,displayName,mail,description`);

    case 'get_group_members':
      if (!groupId) return { kind: 'error', code: 'bad_request', message: 'groupId is required.' };
      return graphFetch(token, 'GET', `/groups/${encodeURIComponent(groupId)}/members`);

    case 'disable_user':
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      return graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, { accountEnabled: false });

    case 'reset_user_password': {
      if (!userId) return { kind: 'error', code: 'bad_request', message: 'userId is required.' };
      const password = generateTempPassword();
      const res = await graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, {
        passwordProfile: { forceChangePasswordNextSignIn: true, password },
      });
      // On success, return the temp password so the handler can surface it.
      if (res.kind === 'ok') return { kind: 'ok', data: { ok: true, temporaryPassword: password } };
      return res;
    }

    default:
      return { kind: 'error', code: 'bad_request', message: `Unsupported tool: ${toolName}` };
  }
}
