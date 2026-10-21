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
 * The flag and host allowlist are checked on every use (cache hits included),
 * so oidc-provider's in-process document cache never bypasses them. Their
 * values change only on restart; a disabled client (DB) is refused on its
 * next use.
 */
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { checkSsrfSafe } from '../services/ssrfGuard';
import { safeFetch, type SafeFetchInit } from '../services/urlSafety';
import { validateRedirectUris } from './redirectUriPolicy';
import { ERROR_IDS, logOauthWarn } from './log';
import { cimdHostAllowed, isCimdClientId, parseCimdAllowedHosts } from './cimdHosts';
import { isActiveMaterializedCimdClient } from './cimdKnownClient';

export { cimdHostAllowed, isCimdClientId, parseCimdAllowedHosts };

export const CIMD_FETCH_BUDGET = { perHostPerMinute: 10, globalPerMinute: 120, createsPerHour: 200 } as const;
/**
 * Refetches for an already-admitted client (its cached document expired or was
 * evicted) draw on this separate, larger global budget, so a flood of new
 * client ids exhausting `globalPerMinute` cannot stop connected clients from
 * refreshing their tokens.
 */
export const CIMD_KNOWN_CLIENT_REFETCH_PER_MINUTE = 1200;
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

/** Live host policy: `OAUTH_CIMD_ALLOWED_HOSTS` as of now. */
export function cimdHostAllowedNow(host: string): boolean {
  return cimdHostAllowed(host, liveAllowlist());
}

function liveAllowlist(): string[] {
  const parsed = parseCimdAllowedHosts(process.env.OAUTH_CIMD_ALLOWED_HOSTS);
  // Boot validation rejects a malformed value; if one appears at runtime
  // anyway, fail closed with a list nothing can match.
  return parsed.ok ? parsed.hosts : ['.invalid.cimd-allowlist'];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// One log line per (host, reason) per window: allowClient runs on every use,
// so a client hammering a refused id must not produce unbounded log volume.
const REFUSAL_LOG_WINDOW_MS = 60_000;
const REFUSAL_LOG_MAX_KEYS = 1000;
const refusalLoggedAt = new Map<string, number>();

function logCimdRefusal(reason: string, host: string | null, err?: unknown): void {
  const key = `${host ?? ''}|${reason}`;
  const now = Date.now();
  const last = refusalLoggedAt.get(key);
  if (last !== undefined && now - last < REFUSAL_LOG_WINDOW_MS) return;
  refusalLoggedAt.delete(key);
  refusalLoggedAt.set(key, now);
  while (refusalLoggedAt.size > REFUSAL_LOG_MAX_KEYS) {
    const oldest = refusalLoggedAt.keys().next().value;
    if (oldest === undefined) break;
    refusalLoggedAt.delete(oldest);
  }
  logOauthWarn({
    errorId: ERROR_IDS.OAUTH_CIMD_REFUSED,
    message: 'CIMD client refused',
    ...(err === undefined ? {} : { err }),
    context: { reason, host },
  });
}

/** Log (rate-limited per host+reason) and refuse. `err` carries the cause of an infrastructure failure. */
export function refuseCimd(reason: string, clientId: string, err?: unknown): false {
  logCimdRefusal(reason, hostOf(clientId), err);
  return false;
}

// Approved-fetch registry: URL → { outstanding approvals, expiry }. Each
// approval admits one fetch; concurrent first uses of one id each get their
// own. Bounded (oldest URL evicted).
const approvals = new Map<string, { count: number; expiresAt: number }>();

function registerApproval(url: string, now: number): void {
  const existing = approvals.get(url);
  const live = existing && now <= existing.expiresAt ? existing.count : 0;
  approvals.delete(url);
  approvals.set(url, { count: live + 1, expiresAt: now + CIMD_APPROVAL_TTL_MS });
  while (approvals.size > CIMD_APPROVAL_MAX_ENTRIES) {
    const oldest = approvals.keys().next().value;
    if (oldest === undefined) break;
    approvals.delete(oldest);
  }
}

function consumeApproval(url: string, now: number): boolean {
  const entry = approvals.get(url);
  if (!entry) return false;
  if (now > entry.expiresAt) {
    approvals.delete(url);
    return false;
  }
  if (entry.count <= 1) approvals.delete(url);
  else entry.count -= 1;
  return true;
}

type BudgetResult = { kind: 'ok' } | { kind: 'exceeded' } | { kind: 'no_redis' } | { kind: 'error'; err: unknown };

async function withinFetchBudget(host: string, knownClient: boolean): Promise<BudgetResult> {
  const redis = getRedis();
  if (!redis) return { kind: 'no_redis' };
  try {
    const perHost = await rateLimiter(redis, `oauth:cimd:fetch:host:${host}`, CIMD_FETCH_BUDGET.perHostPerMinute, 60);
    if (!perHost.allowed) return { kind: 'exceeded' };
    const global = knownClient
      ? await rateLimiter(redis, 'oauth:cimd:fetch:known', CIMD_KNOWN_CLIENT_REFETCH_PER_MINUTE, 60)
      : await rateLimiter(redis, 'oauth:cimd:fetch:global', CIMD_FETCH_BUDGET.globalPerMinute, 60);
    return global.allowed ? { kind: 'ok' } : { kind: 'exceeded' };
  } catch (err) {
    return { kind: 'error', err };
  }
}

async function isKnownClient(clientId: string): Promise<boolean> {
  try {
    return await isActiveMaterializedCimdClient(clientId);
  } catch {
    // Unknown → the stricter new-client budget applies; nothing is admitted
    // that the policy would otherwise refuse.
    return false;
  }
}

export async function cimdAllowFetch(_ctx: unknown, clientId: string): Promise<boolean> {
  if (!cimdEnabledNow()) return refuseCimd('disabled', clientId);
  if (!isCimdClientId(clientId)) return refuseCimd('invalid_client_id', clientId);
  const ssrf = checkSsrfSafe(clientId, { mode: 'strict-https' });
  if (!ssrf.ok) return refuseCimd('ssrf_guard', clientId);
  const host = new URL(clientId).hostname.toLowerCase();
  if (!cimdHostAllowed(host, liveAllowlist())) return refuseCimd('host_not_allowed', clientId);
  const budget = await withinFetchBudget(host, await isKnownClient(clientId));
  if (budget.kind === 'no_redis') {
    if (process.env.NODE_ENV === 'production') return refuseCimd('redis_unavailable', clientId);
  } else if (budget.kind === 'error') {
    return refuseCimd('budget_check_failed', clientId, budget.err);
  } else if (budget.kind === 'exceeded') {
    return refuseCimd('fetch_budget_exceeded', clientId);
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
    if (!consumeApproval(target, now())) {
      logCimdRefusal('fetch_not_approved', hostOf(target));
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
    } catch (err) {
      // SSRF block on the resolved address, timeout, body cap, TLS failure:
      // oidc-provider reports all of these as a bare invalid_client.
      logCimdRefusal('fetch_failed', hostOf(target), err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Test-only. */
export function __cimdApprovalsForTests(): ReadonlyMap<string, { count: number; expiresAt: number }> {
  return approvals;
}

/** Test-only. */
export function __resetCimdRefusalLogForTests(): void {
  refusalLoggedAt.clear();
}

/** Test-only. */
export function __resetCimdApprovalsForTests(): void {
  approvals.clear();
}
