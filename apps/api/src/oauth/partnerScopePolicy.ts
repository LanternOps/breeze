import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';

/**
 * Per-tenant OAuth scope policy, stored under the
 * `partners.settings.oauth_scope_policy` JSONB key. `undefined` /
 * missing key means "no policy" — all scopes allowed (back-compat).
 */
export interface PartnerOauthScopePolicy {
  /**
   * Whitelist of MCP scopes this partner is allowed to issue. If present,
   * any scope NOT in this list is stripped from issued tokens at the
   * `getResourceServerInfo` hot path. If absent/undefined, every scope
   * the client requested is allowed (current default).
   */
  mcp_allowed_scopes?: string[];
}

export const OAUTH_SCOPE_POLICY_SETTINGS_KEY = 'oauth_scope_policy';

type CacheEntry = { value: PartnerOauthScopePolicy; expiresAt: number };

// Short-lived, process-local cache. `getResourceServerInfo` is called on
// every token mint and every token validation, so even a cheap DB lookup
// here multiplies the per-request latency noticeably at MCP RPS. A 60s
// TTL keeps the policy change propagation window small while absorbing
// the >99% hot-path repeat reads from the same partner. The cache is
// intentionally NOT Redis-backed: the data is already tiny, eventual
// consistency is fine, and Redis unavailability must not break token
// issuance.
const POLICY_CACHE_TTL_MS = 60_000;
const policyCache = new Map<string, CacheEntry>();

// In-flight promises so concurrent callers for the same partner share a
// single DB read (stampede avoidance). Node is single-threaded but the
// event loop still interleaves ~N concurrent token mints during a burst,
// and without this every one of them would hit the DB before the first
// writes the cache.
const inflight = new Map<string, Promise<PartnerOauthScopePolicy>>();

function cacheGet(partnerId: string): PartnerOauthScopePolicy | null {
  const hit = policyCache.get(partnerId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    policyCache.delete(partnerId);
    return null;
  }
  return hit.value;
}

function cachePut(partnerId: string, value: PartnerOauthScopePolicy) {
  policyCache.set(partnerId, {
    value,
    expiresAt: Date.now() + POLICY_CACHE_TTL_MS,
  });
}

async function fetchPolicyFromDb(partnerId: string): Promise<PartnerOauthScopePolicy> {
  // `getResourceServerInfo` runs inside the oidc-provider hot path which
  // is not inside a request DB context, but defensively use
  // `runOutsideDbContext` + `withSystemDbAccessContext` so we always have
  // a well-defined context regardless of where the caller came from.
  // This mirrors the pattern in bearerTokenAuth.ts:resolvePartnerAccessibleOrgIds.
  const row = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [r] = await db
        .select({ settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1);
      return r;
    }),
  );
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const raw = settings[OAUTH_SCOPE_POLICY_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: PartnerOauthScopePolicy = {};
  if (Array.isArray(obj.mcp_allowed_scopes)) {
    const arr = obj.mcp_allowed_scopes.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    out.mcp_allowed_scopes = arr;
  }
  return out;
}

/**
 * Hot-path lookup with a short TTL cache. Returns `{}` (no policy) on
 * lookup failure so token issuance is never blocked by a transient DB
 * hiccup — the OAuth layer is defense-in-depth here; bearer middleware
 * still enforces per-call authz.
 */
export async function getPartnerScopePolicy(
  partnerId: string,
): Promise<PartnerOauthScopePolicy> {
  const cached = cacheGet(partnerId);
  if (cached) return cached;

  const existing = inflight.get(partnerId);
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await fetchPolicyFromDb(partnerId);
      cachePut(partnerId, value);
      return value;
    } catch (_err) {
      // Fail-open to {} so a DB wobble doesn't break token mint; do NOT
      // cache the miss — next caller retries.
      return {};
    } finally {
      inflight.delete(partnerId);
    }
  })();
  inflight.set(partnerId, p);
  return p;
}

export function clearPartnerScopePolicyCache(partnerId?: string): void {
  if (partnerId) policyCache.delete(partnerId);
  else policyCache.clear();
}

// Test-only: peek at cache state.
export const _policyCacheForTests = policyCache;
