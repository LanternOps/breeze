import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema/orgs';
import { ipMatchesAny } from './ipMatch';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { writeAuditEvent, type RequestLike } from './auditEvents';
import { captureException } from './sentry';

export type IpAllowlistMode = 'enforce' | 'off';

export type IpAllowlistDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'not_in_list' }
  | { decision: 'skip'; reason: 'mode_off' | 'empty_list' | 'untrusted_ip' | 'platform_admin' | 'no_partner' };

export const IP_NOT_ALLOWED_BODY = {
  code: 'ip_not_allowed',
  error: 'Access denied from this IP address',
} as const;

export function isBlocked(d: IpAllowlistDecision): boolean {
  return d.decision === 'deny';
}

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
// All read paths (per-request guard and login) share this cache. The writing
// instance invalidates on save; other API instances converge within the TTL.

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string[]; expiresAt: number }>();
const INACTIVE_ALLOWLIST_WARN_INTERVAL_MS = 60_000;
const inactiveAllowlistWarnedAt = new Map<string, number>();

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

function warnInactiveAllowlist(partnerId: string): void {
  const now = Date.now();
  const lastWarnedAt = inactiveAllowlistWarnedAt.get(partnerId) ?? 0;
  if (now - lastWarnedAt < INACTIVE_ALLOWLIST_WARN_INTERVAL_MS) return;

  inactiveAllowlistWarnedAt.set(partnerId, now);
  const message = `[ipAllowlist] configured but inactive: client IP not trusted for partner ${partnerId}`;
  console.warn(message);
  captureException(new Error(message));
}

/**
 * Full enforcement for a request. Reads mode, allowlist, and trusted client IP,
 * evaluates, and writes audit on deny / platform-admin bypass. Returns the
 * decision so callers can return their own response (guard/API key/login).
 */
export async function enforceIpAllowlist(
  c: RequestLike,
  params: { partnerId: string | null; isPlatformAdmin: boolean; actorId?: string | null; actorEmail?: string | null },
): Promise<IpAllowlistDecision> {
  if (!params.partnerId) return { decision: 'skip', reason: 'no_partner' };

  const mode = ipAllowlistMode();
  // The partner-settings read must NOT run under the request's RLS context:
  // org-scoped callers have an empty accessible_partner_ids, so the partners
  // row is invisible to them and the read throws "partner not found" (which
  // the guard converts to a 503 — locking every customer-org user out).
  // `withSystemDbAccessContext` alone is not enough: inside an active request
  // context it is a no-op that inherits the caller's RLS scope, so the
  // AsyncLocalStorage context has to be exited first.
  const readList = () =>
    runOutsideDbContext(() => withSystemDbAccessContext(() => readPartnerAllowlist(params.partnerId as string)));
  const allowlist = mode === 'off' ? [] : await readList();
  const clientIp = getTrustedClientIpOrUndefined(c);

  const decision = evaluateIpAllowlist({
    mode,
    allowlist,
    clientIp,
    isPlatformAdmin: params.isPlatformAdmin,
  });

  if (isBlocked(decision)) {
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
    warnInactiveAllowlist(params.partnerId);
  }

  return decision;
}
