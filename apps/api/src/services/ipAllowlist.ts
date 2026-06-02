import { eq } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema/orgs';
import { ipMatchesAny } from './ipMatch';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { writeAuditEvent, type RequestLike } from './auditEvents';

export type IpAllowlistMode = 'enforce' | 'off';

export type IpAllowlistDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'not_in_list' }
  | { decision: 'skip'; reason: 'mode_off' | 'empty_list' | 'untrusted_ip' | 'platform_admin' };

/** Pure decision. `clientIp === undefined` means the IP is not trustable. */
export function evaluateIpAllowlist(params: {
  mode: IpAllowlistMode;
  allowlist: string[] | undefined;
  clientIp: string | undefined;
  isPlatformAdmin: boolean;
}): IpAllowlistDecision {
  const { mode, allowlist, clientIp, isPlatformAdmin } = params;
  if (mode === 'off') return { decision: 'skip', reason: 'mode_off' };
  if (!allowlist || allowlist.length === 0) return { decision: 'skip', reason: 'empty_list' };
  if (isPlatformAdmin) return { decision: 'skip', reason: 'platform_admin' };
  if (clientIp === undefined) return { decision: 'skip', reason: 'untrusted_ip' };
  return ipMatchesAny(clientIp, allowlist)
    ? { decision: 'allow' }
    : { decision: 'deny', reason: 'not_in_list' };
}

/** Reads the global enforcement mode from env (mirrors clientIp.ts env reads). */
export function ipAllowlistMode(): IpAllowlistMode {
  return process.env.IP_ALLOWLIST_ENFORCEMENT_MODE === 'off' ? 'off' : 'enforce';
}

// --- Per-partner allowlist read with a short in-process cache -----------------
// Trade-off (per spec): a change propagates to other API instances within the
// TTL; the writing instance invalidates immediately. The login check is always
// immediate because it reads fresh below only on a cache miss.

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string[]; expiresAt: number }>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function readPartnerAllowlist(partnerId: string): Promise<string[]> {
  const now = Date.now();
  const hit = cache.get(partnerId);
  if (hit && hit.expiresAt > now) return hit.value;

  const [row] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  if (!row) {
    throw new Error(`ipAllowlist: partner ${partnerId} not found`);
  }

  const security = asRecord(asRecord(row?.settings).security);
  const raw = security.ipAllowlist;
  const value = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];

  cache.set(partnerId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function clearPartnerAllowlistCache(partnerId: string): void {
  cache.delete(partnerId);
}

/**
 * Full enforcement for a request. Reads mode, allowlist, and trusted client IP,
 * evaluates, and writes audit on deny / platform-admin bypass. Returns the
 * decision so the caller can respond (middleware throws 403; login returns 403).
 */
export async function enforceIpAllowlist(
  c: RequestLike,
  params: { partnerId: string | null; isPlatformAdmin: boolean; actorId?: string | null; actorEmail?: string | null },
): Promise<IpAllowlistDecision> {
  if (!params.partnerId) return { decision: 'skip', reason: 'empty_list' };

  const mode = ipAllowlistMode();
  const readList = () => readPartnerAllowlist(params.partnerId as string);
  const allowlist = mode === 'off'
    ? []
    : (hasDbAccessContext() ? await readList() : await withSystemDbAccessContext(readList));
  const clientIp = getTrustedClientIpOrUndefined(c);

  const decision = evaluateIpAllowlist({
    mode,
    allowlist,
    clientIp,
    isPlatformAdmin: params.isPlatformAdmin,
  });

  if (decision.decision === 'deny') {
    writeAuditEvent(c, {
      orgId: null,
      action: 'ip_allowlist.denied',
      resourceType: 'partner',
      resourceId: params.partnerId,
      result: 'denied',
      actorType: 'user',
      actorId: params.actorId ?? null,
      actorEmail: params.actorEmail ?? undefined,
      details: { clientIp: clientIp ?? null },
    });
  } else if (decision.decision === 'skip' && decision.reason === 'platform_admin') {
    writeAuditEvent(c, {
      orgId: null,
      action: 'ip_allowlist.bypass_platform_admin',
      resourceType: 'partner',
      resourceId: params.partnerId,
      result: 'success',
      actorType: 'user',
      actorId: params.actorId ?? null,
      actorEmail: params.actorEmail ?? undefined,
      details: { clientIp: clientIp ?? null },
    });
  } else if (decision.decision === 'skip' && decision.reason === 'untrusted_ip') {
    console.warn(
      `[ipAllowlist] configured but inactive: client IP not trusted for partner ${params.partnerId}`,
    );
  }

  return decision;
}
