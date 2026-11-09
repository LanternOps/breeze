/**
 * Purpose-bound portal capability tokens: invite and password reset (portal
 * registration W2, spec §6 invariant 7).
 *
 * Before W2 the invite token stored only the portal user id and was read and
 * deleted in two separate steps, and the reset token stored `{userId}`. A
 * token is now bound to everything that must still hold when it is used —
 * `{ v: 2, purpose, portalUserId, orgId, email, authEpoch }` — and is:
 *   - consumed ATOMICALLY: a Lua GET+DEL on Redis, a get+delete in one
 *     synchronous tick in memory, so a double-click or a second tab gets
 *     nothing (exactly one activation);
 *   - re-validated against the row at consume (`validatePortalCapability`):
 *     the same org, the same address, the same durable `auth_epoch`, the right
 *     lifecycle state, and an active org. A disable, a password change, an
 *     accepted invite, or a re-invite that changes the row's state bumps the
 *     epoch and so invalidates every earlier token; resending to an
 *     already-invited row does not (both links stay valid until one is used).
 *
 * Storage keys and TTLs are unchanged (`PORTAL_REDIS_KEYS.inviteToken /
 * resetToken`, 7 d / 1 h), so a token issued by the previous release is still
 * found. Legacy handling (W2 plan decision D3, docs/superpowers/plans/portal/
 * 2026-11-08-portal-registration-options-w02-account-foundations.md): a legacy
 * `{portalUserId}` invite is accepted once for an `invited`, password-eligible,
 * browser-granted row in an active org, because invites live 7 days and
 * rejecting them would break every in-flight invite on deploy; a legacy
 * `{userId}` reset is always refused (1 h TTL, the user just asks again).
 * TODO(W3): remove the legacy-invite branch once every pre-W2 invite has
 * expired (7-day TTL after this deploys).
 *
 * The backend is Redis when `PORTAL_USE_REDIS`, otherwise the in-memory maps
 * in ./helpers — the same mutually exclusive switch as sessions.
 */
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import type Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, portalUsers } from '../../db/schema';
import { getRedis } from '../../services/redis';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { isPasswordEligible } from '../../services/portalAccountState';
import { portalUserHasIdentitySql } from '../../services/portalUserIdentities';
import {
  INVITE_TTL_MS,
  INVITE_TTL_SECONDS,
  PORTAL_INVITE_TOKEN_CAP,
  PORTAL_REDIS_KEYS,
  PORTAL_RESET_TOKEN_CAP,
  PORTAL_USE_REDIS,
  RESET_TTL_MS,
  RESET_TTL_SECONDS,
} from './schemas';
import { capMapByOldest, normalizeEmail, portalInviteTokens, portalResetTokens, type PortalTokenEntry } from './helpers';

export type PortalCapabilityPurpose = 'invite' | 'reset';

export interface PortalCapabilityPayload {
  v: 2;
  purpose: PortalCapabilityPurpose;
  portalUserId: string;
  orgId: string;
  /** Normalized (trimmed, lower-cased) at issue. */
  email: string;
  /** The row's durable generation at issue. */
  authEpoch: number;
}

export type ConsumedCapability =
  | { format: 'v2'; payload: PortalCapabilityPayload }
  /** Issued by the previous release: `{portalUserId}` (invite) or `{userId}` (reset). */
  | { format: 'legacy'; portalUserId: string };

/** The row a valid capability resolves to (everything accept-invite and reset need). */
export interface CapabilityUserRow {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  authMethod: string;
  receiveNotifications: boolean;
  status: string;
  authEpoch: number;
  browserAccess: string;
  /** Any `portal_user_identities` row (identities release B, W3). */
  hasExternalIdentity: boolean;
  orgName: string | null;
}

export type CapabilityCheck =
  | { ok: true; user: CapabilityUserRow }
  | { ok: false; reason: 'invalid' | 'org_unavailable' };

/** GET then DEL in one server-side step: exactly one concurrent consumer sees the value. */
const CONSUME_LUA = "local v=redis.call('GET',KEYS[1]) if v then redis.call('DEL',KEYS[1]) end return v";

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function storage(purpose: PortalCapabilityPurpose) {
  return purpose === 'invite'
    ? { key: PORTAL_REDIS_KEYS.inviteToken, ttlSeconds: INVITE_TTL_SECONDS, ttlMs: INVITE_TTL_MS, map: portalInviteTokens, cap: PORTAL_INVITE_TOKEN_CAP }
    : { key: PORTAL_REDIS_KEYS.resetToken, ttlSeconds: RESET_TTL_SECONDS, ttlMs: RESET_TTL_MS, map: portalResetTokens, cap: PORTAL_RESET_TOKEN_CAP };
}

async function consumeFromRedis(redis: Redis, key: string): Promise<string | null> {
  const value = await redis.eval(CONSUME_LUA, 1, key);
  return typeof value === 'string' ? value : null;
}

function consumeFromMemory(map: Map<string, PortalTokenEntry>, tokenHash: string): string | null {
  // get + delete in one synchronous tick: no await between them.
  const entry = map.get(tokenHash);
  map.delete(tokenHash);
  if (!entry || entry.expiresAt.getTime() <= Date.now()) return null;
  return entry.payload;
}

/**
 * Mint a token for `p` and store it. Returns the raw token (the only copy;
 * only its sha256 is stored), or null when Redis is required but unavailable,
 * so the caller never emails a link that cannot be redeemed.
 */
export async function issuePortalCapabilityToken(p: Omit<PortalCapabilityPayload, 'v'>): Promise<string | null> {
  const s = storage(p.purpose);
  const rawToken = nanoid(48);
  const tokenHash = hashToken(rawToken);
  const payload: PortalCapabilityPayload = {
    v: 2,
    purpose: p.purpose,
    portalUserId: p.portalUserId,
    orgId: p.orgId,
    email: normalizeEmail(p.email),
    authEpoch: p.authEpoch,
  };
  const serialized = JSON.stringify(payload);
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    await redis.setex(s.key(tokenHash), s.ttlSeconds, serialized);
  } else {
    s.map.set(tokenHash, { payload: serialized, expiresAt: new Date(Date.now() + s.ttlMs), createdAt: new Date() });
    capMapByOldest(s.map, s.cap, (t) => t.createdAt.getTime());
  }
  return rawToken;
}

/** A stored payload that was found but refused. Logged (never the token) so a version skew is visible. */
function rejectPayload(purpose: PortalCapabilityPurpose, reason: 'parse' | 'version' | 'purpose' | 'shape'): null {
  console.warn('[portal] capability token payload rejected', { purpose, reason });
  return null;
}

function parseCapability(purpose: PortalCapabilityPurpose, raw: string | null): ConsumedCapability | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejectPayload(purpose, 'parse');
  }
  if (!parsed || typeof parsed !== 'object') return rejectPayload(purpose, 'shape');
  const p = parsed as Record<string, unknown>;
  if ('v' in p) {
    if (p.v !== 2) return rejectPayload(purpose, 'version');
    if (p.purpose !== purpose) return rejectPayload(purpose, 'purpose');
    if (
      typeof p.portalUserId !== 'string'
      || typeof p.orgId !== 'string'
      || typeof p.email !== 'string'
      || !Number.isSafeInteger(p.authEpoch)
      || (p.authEpoch as number) <= 0
    ) {
      return rejectPayload(purpose, 'shape');
    }
    return {
      format: 'v2',
      payload: { v: 2, purpose, portalUserId: p.portalUserId, orgId: p.orgId, email: p.email, authEpoch: p.authEpoch as number },
    };
  }
  const legacyId = purpose === 'invite' ? p.portalUserId : p.userId;
  return typeof legacyId === 'string' && legacyId.length > 0 ? { format: 'legacy', portalUserId: legacyId } : rejectPayload(purpose, 'shape');
}

/**
 * Consume (burn) the token for `purpose` and parse it. Returns null for an
 * unknown, expired, already-used or malformed token, for a payload whose
 * purpose differs from the one requested (still burned), and when Redis is
 * required but unavailable (nothing is consumed; the routes answer 503 first).
 */
export async function consumePortalCapabilityToken(
  purpose: PortalCapabilityPurpose,
  rawToken: string,
): Promise<ConsumedCapability | null> {
  const s = storage(purpose);
  const tokenHash = hashToken(rawToken);
  let raw: string | null;
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    raw = await consumeFromRedis(redis, s.key(tokenHash));
  } else {
    raw = consumeFromMemory(s.map, tokenHash);
  }
  return parseCapability(purpose, raw);
}

/**
 * Re-check a consumed token against the row it names. Runs its own system
 * context: the public portal auth routes hold no DB context. Only a token
 * that is valid in every other respect learns that its org is unavailable.
 */
export async function validatePortalCapability(
  purpose: PortalCapabilityPurpose,
  consumed: ConsumedCapability,
): Promise<CapabilityCheck> {
  const invalid: CapabilityCheck = { ok: false, reason: 'invalid' };
  if (consumed.format === 'legacy' && purpose === 'reset') return invalid;
  if (consumed.format === 'v2' && consumed.payload.purpose !== purpose) return invalid;

  const portalUserId = consumed.format === 'v2' ? consumed.payload.portalUserId : consumed.portalUserId;
  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        passwordHash: portalUsers.passwordHash,
        authMethod: portalUsers.authMethod,
        receiveNotifications: portalUsers.receiveNotifications,
        status: portalUsers.status,
        authEpoch: portalUsers.authEpoch,
        browserAccess: portalUsers.browserAccess,
        hasExternalIdentity: portalUserHasIdentitySql(),
        orgName: organizations.name,
      })
      .from(portalUsers)
      // A join, not a correlated subquery: drizzle strips table qualifiers in
      // single-table selections (#9692). (portalUserHasIdentitySql spells its
      // outer column out, so it is correct with or without this join.)
      .leftJoin(organizations, eq(organizations.id, portalUsers.orgId))
      .where(eq(portalUsers.id, portalUserId))
      .limit(1),
  );
  if (!user) return invalid;

  if (consumed.format === 'v2') {
    const p = consumed.payload;
    if (user.orgId !== p.orgId || normalizeEmail(user.email) !== p.email || user.authEpoch !== p.authEpoch) return invalid;
  }
  if (!isPasswordEligible(user)) return invalid;
  if (purpose === 'invite') {
    if (user.status !== 'invited' || user.browserAccess !== 'granted') return invalid;
  } else if (user.status !== 'active' && user.status !== 'invited') {
    return invalid;
  }

  if (!(await getActiveOrgTenant(user.orgId))) return { ok: false, reason: 'org_unavailable' };

  if (consumed.format === 'legacy') {
    console.warn('[portal] legacy invite token accepted', { portalUserId: user.id });
  }
  return { ok: true, user };
}

export const __testOnly = { consumeFromRedis };
