/**
 * Browser portal sessions and the access policy (portal registration W3 #11380,
 * plan D6; W4 #11381, plan D9; spec §5.11 and §6 invariants 8, 9 and 11).
 *
 * A stored session (Redis JSON or the in-memory map) records the sign-in
 * method that minted it. Every session minted before W3 is a password
 * session, so a payload without `method` parses as `'password'`; a method this
 * release does not know is refused.
 *
 * SSO sessions (W4 `entra`, W7 `google`) carry an absolute lifetime from their
 * `createdAt`, capped per request by the CURRENT `ssoSessionMaxHours`, on top
 * of the sliding 24 h every session has. An `entra` session also pins the
 * org's proven Entra tenant at mint and dies when that is no longer the org's
 * proven tenant. Password sessions keep the sliding 24 h only.
 *
 * `isBrowserSessionAllowed` is re-checked on every session request, so a
 * policy change (org or inherited partner default) ends a session on its very
 * next request (plan D1: no policy cache).
 */
import type { Context } from 'hono';
import { nanoid } from 'nanoid';
import {
  PortalAccessPolicyOrgNotFoundError,
  isSignInMethodAllowed,
  resolvePortalAccessPolicy,
  type PortalSignInMethod,
  type ResolvedPortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import { isPasswordEligible } from '../../services/portalAccountState';
import { getRedis } from '../../services/redis';
import { capMapByOldest, portalSessions, setPortalSessionCookies } from './helpers';
import {
  PORTAL_REDIS_KEYS,
  PORTAL_SESSION_CAP,
  PORTAL_USE_REDIS,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
} from './schemas';

export type PortalSessionMethod = PortalSignInMethod;

const PORTAL_SESSION_METHODS: ReadonlySet<string> = new Set<PortalSessionMethod>(['password', 'entra', 'google']);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;

export interface StoredPortalSession {
  portalUserId: string;
  orgId: string;
  authEpoch: number;
  method: PortalSessionMethod;
  /** Mint time (epoch ms). Always set for an SSO session; null only for a password session without a readable `createdAt`. */
  createdAtMs: number | null;
  /** The org's proven Entra tenant at mint (lowercase GUID). Set for, and only for, an `entra` session. */
  entraTenantId: string | null;
}

/** `createdAt` as stored: an ISO string in Redis, a Date in the in-memory twin. Anything else is unreadable. */
function readCreatedAtMs(value: unknown): number | null {
  const ms = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Redis/in-memory payload → session. Missing method → 'password' (pre-W3
 * sessions). Unknown method or bad shape → null.
 *
 * - `password`: `createdAt` and `entraTenantId` are optional (pre-W4 payloads
 *   parse unchanged); a stray `entraTenantId` is ignored.
 * - `entra`: `createdAt` must parse and `entraTenantId` must be a GUID, else null.
 * - `google`: `createdAt` must parse, else null (the SSO absolute lifetime needs it).
 */
export function parseStoredPortalSession(raw: unknown): StoredPortalSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.portalUserId !== 'string' || typeof p.orgId !== 'string') return null;
  const authEpoch = p.authEpoch;
  if (typeof authEpoch !== 'number' || !Number.isSafeInteger(authEpoch) || authEpoch <= 0) return null;

  let method: PortalSessionMethod;
  if (p.method === undefined) {
    method = 'password';
  } else if (typeof p.method === 'string' && PORTAL_SESSION_METHODS.has(p.method)) {
    method = p.method as PortalSessionMethod;
  } else {
    return null;
  }

  const createdAtMs = readCreatedAtMs(p.createdAt);
  const session = { portalUserId: p.portalUserId, orgId: p.orgId, authEpoch, method, createdAtMs, entraTenantId: null };
  if (method === 'password') return session;

  if (createdAtMs === null) return null;
  if (method === 'entra') {
    if (typeof p.entraTenantId !== 'string' || !GUID_RE.test(p.entraTenantId)) return null;
    return { ...session, entraTenantId: p.entraTenantId.toLowerCase() };
  }
  return session;
}

/**
 * The per-request browser gate (inv. 9). Every session needs browser access
 * granted and its own method allowed by the effective policy (an entra session
 * never satisfies a password-only policy, nor a password session an `sso_only`
 * one). Then:
 * - a password session needs a password-eligible account, and has no absolute cap;
 * - an SSO session is refused once `nowMs - createdAtMs >= ssoSessionMaxHours`
 *   (refused AT the cap), read from the policy passed in, i.e. the current one;
 * - an entra session also needs its pinned tenant to equal the policy's
 *   proven tenant.
 * An unknown method fails closed (`isSignInMethodAllowed`).
 */
export function isBrowserSessionAllowed(
  session: Pick<StoredPortalSession, 'method' | 'createdAtMs' | 'entraTenantId'>,
  user: { authMethod: string; browserAccess: string },
  policy: Pick<ResolvedPortalAccessPolicy, 'effective' | 'entraTenant'>,
  nowMs: number,
): boolean {
  if (user.browserAccess !== 'granted') return false;
  if (!isSignInMethodAllowed(policy, session.method)) return false;
  if (session.method === 'password') return isPasswordEligible(user);

  if (session.createdAtMs === null) return false;
  const maxAgeMs = policy.effective.ssoSessionMaxHours.value * HOUR_MS;
  // `!(a < b)`, not `a >= b`: a non-finite cap or clock fails closed.
  if (!(nowMs - session.createdAtMs < maxAgeMs)) return false;

  if (session.method === 'entra') {
    const proven = policy.entraTenant?.tenantId;
    if (!proven || !session.entraTenantId || proven.toLowerCase() !== session.entraTenantId) return false;
  }
  return true;
}

/** The session store (Redis, required in production) could not take the session. Routes answer 503. */
export class PortalSessionStoreUnavailableError extends Error {
  constructor() {
    super('Portal session store unavailable');
    this.name = 'PortalSessionStoreUnavailableError';
  }
}

export interface MintPortalBrowserSessionInput {
  portalUserId: string;
  orgId: string;
  authEpoch: number;
  method: PortalSessionMethod;
  /** Required for, and only for, `method: 'entra'`: the org's proven tenant the sign-in was verified against. */
  entraTenantId?: string;
}

/**
 * The one browser-session mint (login, accept-invite and, from W4, the OIDC
 * callback). Writes `portal:session:{token}` =
 * `{portalUserId, orgId, authEpoch, method, createdAt, entraTenantId?}` (setex
 * 24 h), `sadd portal:user-sessions:{id}` (expire 48 h), or the in-memory twin
 * when Redis is off, then sets the session + CSRF cookies.
 *
 * Throws {@link PortalSessionStoreUnavailableError} when Redis is required but
 * missing, or (in production) when a session write failed; nothing is set on
 * the response then. Holds no DB context.
 */
export async function mintPortalBrowserSession(
  c: Context,
  input: MintPortalBrowserSessionInput,
): Promise<{ token: string; expiresAt: Date }> {
  const { portalUserId, orgId, authEpoch, method } = input;
  if ((method === 'entra') !== (input.entraTenantId !== undefined)) {
    throw new Error('mintPortalBrowserSession: entraTenantId is required for, and only for, an entra session');
  }
  if (input.entraTenantId !== undefined && !GUID_RE.test(input.entraTenantId)) {
    throw new Error('mintPortalBrowserSession: entraTenantId must be a GUID');
  }
  const entraTenantId = input.entraTenantId?.toLowerCase();

  const now = new Date();
  const token = nanoid(48);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) throw new PortalSessionStoreUnavailableError();
    // Key order is the stored byte layout: the pre-W4 payload, plus the tenant for entra.
    const stored = {
      portalUserId, orgId, authEpoch, method, createdAt: now.toISOString(),
      ...(entraTenantId ? { entraTenantId } : {}),
    };
    const results = await redis
      .multi()
      .setex(PORTAL_REDIS_KEYS.session(token), SESSION_TTL_SECONDS, JSON.stringify(stored))
      .sadd(PORTAL_REDIS_KEYS.userSessions(portalUserId), token)
      .expire(PORTAL_REDIS_KEYS.userSessions(portalUserId), SESSION_TTL_SECONDS * 2)
      .exec();
    // A null result is an aborted transaction: nothing was written.
    if (!results) {
      console.error('[portal] Redis session pipeline returned no result');
      throw new PortalSessionStoreUnavailableError();
    }
    const pipelineErrors = results.filter(([err]) => err);
    if (pipelineErrors.length > 0) {
      for (const [err] of pipelineErrors) {
        console.error('[portal] Redis session pipeline error:', err!.message);
      }
      if (process.env.NODE_ENV === 'production') throw new PortalSessionStoreUnavailableError();
    }
  } else {
    portalSessions.set(token, {
      token, portalUserId, orgId, authEpoch, method,
      ...(entraTenantId ? { entraTenantId } : {}),
      createdAt: now, expiresAt,
    });
    capMapByOldest(portalSessions, PORTAL_SESSION_CAP, (s) => s.createdAt.getTime());
  }

  setPortalSessionCookies(c, token);
  return { token, expiresAt };
}

/**
 * Whether the org's effective policy lets anyone use a password at all
 * (login, forgot-password, reset and invite consume). An org the resolver
 * cannot find is refused like `sso_only`, so every caller answers with its
 * ordinary generic failure (inv. 8). Any other error, SQL failures included,
 * propagates (fail closed).
 *
 * The one error caught is thrown in JS after a successful read (or before any
 * read, for a malformed id), so even under a held transaction it poisons
 * nothing and needs no `withDbTransaction`. Today every caller is a public
 * portal auth route or the session middleware's pre-transaction checks, so no
 * context is held and the resolver opens its own system context.
 */
export async function isPasswordSignInAllowedForOrg(orgId: string): Promise<boolean> {
  try {
    return isSignInMethodAllowed(await resolvePortalAccessPolicy(orgId), 'password');
  } catch (error) {
    if (error instanceof PortalAccessPolicyOrgNotFoundError) return false;
    throw error;
  }
}
