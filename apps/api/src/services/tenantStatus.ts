import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, partners } from '../db/schema';
import { getRedis } from './redis';

export class TenantInactiveError extends Error {
  constructor(message = 'Tenant is not active') {
    super(message);
    this.name = 'TenantInactiveError';
  }
}

function isUsableOrgStatus(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trial';
}

export async function getActivePartner(partnerId: string): Promise<{ id: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ id: partners.id, status: partners.status, deletedAt: partners.deletedAt })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);

    if (!partner || partner.status !== 'active') return null;
    return { id: partner.id };
  });
}

// Partner statuses allowed to hold an authenticated session. `pending`
// is legitimate — a self-service signup that has verified email but not
// yet completed payment. It MUST be able to authenticate so the
// downstream partnerGuard (status !== 'active' → 403 PARTNER_INACTIVE)
// can redirect it to the billing page. Feature gating is partnerGuard's
// job, not the auth/token gate's. `suspended`/`churned`/soft-deleted
// stay rejected — that is the SR-001..SR-024 (PR #568) mid-session
// cutoff we keep. Deliberately distinct from getActivePartner (strictly
// 'active'), which the org-cascade / API-key path relies on — do not
// merge them.
const PARTNER_SESSION_ALLOWED_STATUSES = new Set(['active', 'pending']);

export async function getSessionAllowedPartner(partnerId: string): Promise<{ id: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ id: partners.id, status: partners.status, deletedAt: partners.deletedAt })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);

    if (!partner || !PARTNER_SESSION_ALLOWED_STATUSES.has(partner.status)) return null;
    return { id: partner.id };
  });
}

export async function getActiveOrgTenant(orgId: string): Promise<{ orgId: string; partnerId: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db
      .select({
        orgId: organizations.id,
        orgStatus: organizations.status,
        orgDeletedAt: organizations.deletedAt,
        partnerId: organizations.partnerId,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .limit(1);

    if (!org || !isUsableOrgStatus(org.orgStatus) || org.orgDeletedAt) return null;

    const activePartner = await getActivePartner(org.partnerId);
    if (!activePartner) return null;

    return { orgId: org.orgId, partnerId: org.partnerId };
  });
}

/**
 * Options for tightening the tenant-status gate when the caller is NOT a
 * first-party dashboard session.
 *
 * `strictForOauth` (Task 15 / MCP H-1): when true, require partners.status
 * === 'active' for partner-scope contexts (instead of admitting `pending`).
 * The lax behavior is correct for first-party JWTs — a `pending` partner
 * needs to authenticate so partnerGuard can redirect them to billing — but
 * is WRONG for OAuth bearer tokens: a `pending` partner should never have
 * an OAuth grant honored, and any flip to suspended/churned post-issuance
 * must invalidate already-minted access tokens at request time (proactive
 * revoke + this request-time check are belt-and-suspenders). Org-scope is
 * unaffected — `getActiveOrgTenant` already cascades through
 * `getActivePartner` which is strict.
 */
export interface AssertActiveTenantOptions {
  strictForOauth?: boolean;
}

export async function assertActiveTenantContext(
  context: {
    scope: 'system' | 'partner' | 'organization';
    partnerId: string | null;
    orgId: string | null;
  },
  options: AssertActiveTenantOptions = {},
): Promise<void> {
  if (context.scope === 'system') return;

  if (context.scope === 'partner') {
    if (!context.partnerId) {
      throw new TenantInactiveError('Partner is not active');
    }
    if (options.strictForOauth) {
      // OAuth bearer / non-session caller: require strictly active.
      // Rejects pending, suspended, churned, soft-deleted.
      if (!(await getActivePartner(context.partnerId))) {
        throw new TenantInactiveError('Partner is not active');
      }
      return;
    }
    // Session gate, not feature gate: admit `pending` (partnerGuard
    // handles the billing redirect). Strictly-dead tenants still rejected.
    if (!(await getSessionAllowedPartner(context.partnerId))) {
      throw new TenantInactiveError('Partner is not active');
    }
    return;
  }

  if (!context.orgId) {
    throw new TenantInactiveError('Organization context required');
  }

  const org = await getActiveOrgTenant(context.orgId);
  if (!org || (context.partnerId && org.partnerId !== context.partnerId)) {
    throw new TenantInactiveError('Organization is not active');
  }
}

// Hot-path agent tenant-status gate for the agent REST (heartbeat, inventory,
// log-ship, command fetch/result, patches) and WS upgrade paths. Agent
// credentials are org-scoped; a suspended/churned/soft-deleted org or partner
// must not keep authenticating its fleet. The first-party JWT and API-key
// paths already enforce this via getActiveOrgTenant — the agent paths did not.
//
// Positive results are cached in Redis for a short TTL, so the per-heartbeat
// cost on the happy path is a single GET. Negatives are deliberately NOT
// cached: a reactivated tenant should resume promptly, and a suspended one is
// bounded by the agent rate-limiter rather than a cache entry. Redis errors
// fall through to the authoritative DB check — fail to the source of truth,
// never fail open.
const AGENT_TENANT_OK_CACHE_PREFIX = 'agent_tenant_ok:';
const AGENT_TENANT_OK_CACHE_SECONDS = 60;

export async function isAgentTenantActive(orgId: string): Promise<boolean> {
  const cacheKey = `${AGENT_TENANT_OK_CACHE_PREFIX}${orgId}`;
  const redis = getRedis();

  if (redis) {
    try {
      if ((await redis.get(cacheKey)) === '1') return true;
    } catch {
      // Cache read failed — fall through to the authoritative DB check.
    }
  }

  const tenant = await getActiveOrgTenant(orgId);
  if (!tenant) return false;

  if (redis) {
    try {
      await redis.set(cacheKey, '1', 'EX', AGENT_TENANT_OK_CACHE_SECONDS);
    } catch {
      // Best-effort cache write; correctness does not depend on it.
    }
  }

  return true;
}

/**
 * Drop the cached positive `isAgentTenantActive` result for each org. Called
 * when a tenant is suspended/deleted so a still-cached `OK` can't admit the
 * fleet during the brief window before (or if) the device-level
 * `agentTokenSuspendedAt` flag is written — the next agent request re-checks
 * the (now-inactive) DB status. Best-effort: the device flag remains the
 * real-time cutoff, so a Redis error here is non-fatal.
 */
export async function invalidateAgentTenantCache(orgIds: string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await Promise.all(orgIds.map((id) => redis.del(`${AGENT_TENANT_OK_CACHE_PREFIX}${id}`)));
  } catch {
    // Best-effort; the device-level agentTokenSuspendedAt flag is the cutoff.
  }
}
