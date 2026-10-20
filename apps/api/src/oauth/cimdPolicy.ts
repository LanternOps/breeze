/**
 * B-W03 (#6157, D-B20): Breeze trust policy for OAuth Client ID Metadata
 * Documents (CIMD), wrapped around oidc-provider 9.12.2's built-in
 * `features.clientIdMetadataDocument`.
 *
 * A CIMD client's `client_id` is an https URL whose document describes the
 * client. oidc-provider calls:
 *   - `allowFetch(ctx, url)` on a cache miss, before fetching the document;
 *   - `allowClient(ctx, client)` on EVERY use, cache hits included
 *     (see cimdClients.ts — it re-evaluates the live flag/host policy and
 *     materialises the `oauth_clients` row).
 *
 * Every outbound fetch the provider makes goes through
 * `createOidcProviderFetch`, which only lets through a URL `allowFetch`
 * approved in the last 30 s (single use), and routes it through `safeFetch`
 * (DNS-pinned, private ranges refused, no redirects, 5 KiB cap, hard 5 s
 * deadline). A `jwks_uri` / `sector_identifier_uri` a document names can
 * therefore never be fetched.
 *
 * Flags are read per call from the environment so a policy change applies
 * to cached clients too (the provider's own feature switch is boot-time).
 */
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { checkSsrfSafe } from '../services/ssrfGuard';
import { safeFetch, type SafeFetchInit } from '../services/urlSafety';
import { validateRedirectUris } from './redirectUriPolicy';
import { ERROR_IDS, logOauthWarn } from './log';
import { cimdHostAllowed, parseCimdAllowedHosts } from './cimdHosts';

export { cimdHostAllowed, parseCimdAllowedHosts };

export const CIMD_FETCH_BUDGET = { perHostPerMinute: 10, globalPerMinute: 120, createsPerHour: 200 } as const;
export const CIMD_FETCH_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_APPROVAL_TTL_MS = 30_000;
const CIMD_APPROVAL_MAX_ENTRIES = 1000;
const CLIENT_NAME_MAX = 128;

/**
 * Client metadata Breeze never accepts from a self-registering client — DCR
 * (routes/oauth.ts) and CIMD share this list. Each names a URL the provider
 * would fetch, or an unauthenticated identity claim.
 */
export const OAUTH_REJECTED_CLIENT_METADATA = [
  'jwks',
  'jwks_uri',
  'request_uris',
  'sector_identifier_uri',
  'software_statement',
  'software_id',
] as const;

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
const ALLOWED_RESPONSE_TYPES = new Set(['code']);
const ALLOWED_SCOPES = new Set(['openid', 'offline_access', 'mcp:read', 'mcp:write', 'mcp:execute']);

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Live read of `OAUTH_CIMD_ENABLED` (envFlag vocabulary, default off). */
export function cimdEnabledNow(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUE_VALUES.has((env.OAUTH_CIMD_ENABLED ?? '').trim().toLowerCase());
}

function liveAllowlist(): string[] {
  const parsed = parseCimdAllowedHosts(process.env.OAUTH_CIMD_ALLOWED_HOSTS);
  // Boot validation rejects a malformed value; if one appears at runtime
  // anyway, fail closed with a list nothing can match.
  return parsed.ok ? parsed.hosts : ['.invalid.cimd-allowlist'];
}

function hasForbiddenCodePoint(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0x20 || code === 0x5c || code === 0x7f) return true;
  }
  return false;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A CIMD client id: https, a hostname (never an IP literal), a real path
 * (not `/`), no userinfo, query, fragment or dot segments. oidc-provider
 * 9.12.2 dropped its own path check. A DCR-issued id is never an https URL,
 * so this shape alone tells the two kinds apart.
 */
export function isCimdClientId(id: unknown): id is string {
  if (typeof id !== 'string' || !/^https:\/\//i.test(id)) return false;
  if (hasForbiddenCodePoint(id) || id.includes('#') || id.includes('?')) return false;
  const afterScheme = id.slice('https://'.length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority === '' || authority.includes('@')) return false;
  const rawPath = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  if (rawPath.split('/').some((seg) => {
    const normalized = seg.replace(/%2e/gi, '.');
    return normalized === '.' || normalized === '..';
  })) return false;
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.hostname.startsWith('[') || IPV4_LITERAL.test(url.hostname)) return false;
  if (url.pathname === '' || url.pathname === '/') return false;
  return true;
}

function refuse(reason: string, clientId: string): false {
  let host: string | null = null;
  try {
    host = new URL(clientId).hostname;
  } catch {
    host = null;
  }
  logOauthWarn({
    errorId: ERROR_IDS.OAUTH_CIMD_REFUSED,
    message: 'CIMD client refused',
    context: { reason, host },
  });
  return false;
}

// Approved-fetch registry: URL → expiry. Single use; bounded (oldest evicted).
const approvals = new Map<string, number>();

function registerApproval(url: string, now: number): void {
  approvals.delete(url);
  approvals.set(url, now + CIMD_APPROVAL_TTL_MS);
  while (approvals.size > CIMD_APPROVAL_MAX_ENTRIES) {
    const oldest = approvals.keys().next().value;
    if (oldest === undefined) break;
    approvals.delete(oldest);
  }
}

async function withinFetchBudget(host: string): Promise<boolean | 'no_redis'> {
  const redis = getRedis();
  if (!redis) return 'no_redis';
  try {
    const perHost = await rateLimiter(redis, `oauth:cimd:fetch:host:${host}`, CIMD_FETCH_BUDGET.perHostPerMinute, 60);
    if (!perHost.allowed) return false;
    const global = await rateLimiter(redis, 'oauth:cimd:fetch:global', CIMD_FETCH_BUDGET.globalPerMinute, 60);
    return global.allowed;
  } catch {
    return false;
  }
}

export async function cimdAllowFetch(_ctx: unknown, clientId: string): Promise<boolean> {
  if (!cimdEnabledNow()) return refuse('disabled', clientId);
  if (!isCimdClientId(clientId)) return refuse('invalid_client_id', clientId);
  const ssrf = checkSsrfSafe(clientId, { mode: 'strict-https' });
  if (!ssrf.ok) return refuse('ssrf_guard', clientId);
  const host = new URL(clientId).hostname.toLowerCase();
  if (!cimdHostAllowed(host, liveAllowlist())) return refuse('host_not_allowed', clientId);
  const budget = await withinFetchBudget(host);
  if (budget === 'no_redis') {
    if (process.env.NODE_ENV === 'production') return refuse('redis_unavailable', clientId);
  } else if (!budget) {
    return refuse('fetch_budget_exceeded', clientId);
  }
  registerApproval(clientId, Date.now());
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateCimdMetadata(
  clientId: string,
  metadata: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (metadata.client_id !== clientId) return { ok: false, reason: 'client_id_mismatch' };
  const name = metadata.client_name;
  if (typeof name !== 'string' || name.length === 0 || name.length > CLIENT_NAME_MAX) {
    return { ok: false, reason: 'client_name_invalid' };
  }
  const auth = metadata.token_endpoint_auth_method;
  if (auth !== undefined && auth !== 'none') return { ok: false, reason: 'not_public_client' };
  const redirects = validateRedirectUris(metadata.redirect_uris);
  if (!redirects.ok) return { ok: false, reason: 'redirect_uris_invalid' };
  for (const field of OAUTH_REJECTED_CLIENT_METADATA) {
    if (field in metadata && metadata[field] !== undefined) return { ok: false, reason: `rejected_field:${field}` };
  }
  if (metadata.grant_types !== undefined
    && (!isStringArray(metadata.grant_types) || !metadata.grant_types.every((g) => ALLOWED_GRANT_TYPES.has(g)))) {
    return { ok: false, reason: 'grant_types_invalid' };
  }
  if (metadata.response_types !== undefined
    && (!isStringArray(metadata.response_types) || !metadata.response_types.every((r) => ALLOWED_RESPONSE_TYPES.has(r)))) {
    return { ok: false, reason: 'response_types_invalid' };
  }
  if (metadata.scope !== undefined
    && (typeof metadata.scope !== 'string' || !metadata.scope.split(/\s+/).filter(Boolean).every((s) => ALLOWED_SCOPES.has(s)))) {
    return { ok: false, reason: 'scope_invalid' };
  }
  return { ok: true };
}

type ProviderFetchInit = RequestInit & { dispatcher?: unknown };

/**
 * The provider-level `fetch` (oidc-provider top-level `fetch` option). Only a
 * URL approved by `cimdAllowFetch` within CIMD_APPROVAL_TTL_MS passes, once.
 */
export function createOidcProviderFetch(deps: {
  fetchImpl?: (url: string, init?: SafeFetchInit) => Promise<Response>;
  now?: () => number;
} = {}): (url: string | URL, init?: ProviderFetchInit) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? safeFetch;
  const now = deps.now ?? Date.now;
  return async (url, init = {}) => {
    const target = String(url);
    const expiresAt = approvals.get(target);
    approvals.delete(target);
    if (expiresAt === undefined || now() > expiresAt) {
      throw new Error('outbound OAuth provider fetch refused: URL was not approved by the CIMD policy');
    }
    // safeFetch's timeoutMs is an inactivity timeout; this is the hard cap.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('CIMD fetch deadline exceeded', 'TimeoutError')),
      CIMD_FETCH_TIMEOUT_MS,
    );
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    try {
      // safeFetch buffers the (capped) body before resolving, so the deadline
      // covers the whole exchange.
      return await fetchImpl(target, {
        method: init.method ?? 'GET',
        headers: init.headers,
        signal,
        timeoutMs: CIMD_FETCH_TIMEOUT_MS,
        maxBytes: CIMD_MAX_BYTES,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Test-only. */
export function __cimdApprovalsForTests(): ReadonlyMap<string, number> {
  return approvals;
}

/** Test-only. */
export function __resetCimdApprovalsForTests(): void {
  approvals.clear();
}
