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
 *     lifecycle state, an org whose access policy still allows password
 *     sign-in (W3), and an active org. A disable, a password change, an
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
 * W4 (Sign in with Microsoft, plan Task 7): an invite can also be accepted
 * through Microsoft. The OIDC start PEEKS the invite (no consume), its state
 * carries only the token's sha256, and the callback consumes by that hash and
 * validates with `{ requirePasswordMethod: false }`.
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
import { capMapByOldest, luaGetDel, normalizeEmail, portalInviteTokens, portalResetTokens, type PortalTokenEntry } from './helpers';
import { isPasswordSignInAllowedForOrg } from './browserSession';

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

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * The sha256 (hex) a capability token is stored under. The OIDC invite flow
 * (W4) carries only this through its state and consumes by it
 * ({@link consumePortalCapabilityTokenByHash}), so the raw token never leaves
 * the browser's start request.
 */
export function hashPortalCapabilityToken(rawToken: string): string {
  return hashToken(rawToken);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function storage(purpose: PortalCapabilityPurpose) {
  return purpose === 'invite'
    ? { key: PORTAL_REDIS_KEYS.inviteToken, ttlSeconds: INVITE_TTL_SECONDS, ttlMs: INVITE_TTL_MS, map: portalInviteTokens, cap: PORTAL_INVITE_TOKEN_CAP }
    : { key: PORTAL_REDIS_KEYS.resetToken, ttlSeconds: RESET_TTL_SECONDS, ttlMs: RESET_TTL_MS, map: portalResetTokens, cap: PORTAL_RESET_TOKEN_CAP };
}

/** The shared Lua GET+DEL (./helpers `luaGetDel`): exactly one concurrent consumer sees the value. */
async function consumeFromRedis(redis: Redis, key: string): Promise<string | null> {
  return luaGetDel(redis, key);
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
  return consumePortalCapabilityTokenByHash(purpose, hashToken(rawToken));
}

/**
 * {@link consumePortalCapabilityToken} by the stored sha256 instead of the raw
 * token (W4: the OIDC invite callback holds only the hash its state carries).
 * The same atomic GET+DEL; a value that is not a lowercase sha256 hex digest
 * names no token and touches nothing.
 */
export async function consumePortalCapabilityTokenByHash(
  purpose: PortalCapabilityPurpose,
  tokenHash: string,
): Promise<ConsumedCapability | null> {
  if (!SHA256_HEX.test(tokenHash)) return null;
  const s = storage(purpose);
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
 * Read the token for `purpose` WITHOUT consuming it (W4): the Microsoft invite
 * start and the invite-methods lookup must leave the token for the callback
 * (or the password accept) that later consumes it. Null for an unknown,
 * expired or malformed token, and when Redis is required but unavailable.
 * A peek is never authority on its own: whatever it allows is re-checked at
 * consume.
 */
export async function peekPortalCapabilityToken(
  purpose: PortalCapabilityPurpose,
  rawToken: string,
): Promise<ConsumedCapability | null> {
  const s = storage(purpose);
  const tokenHash = hashToken(rawToken);
  let raw: string | null;
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    raw = await redis.get(s.key(tokenHash));
  } else {
    const entry = s.map.get(tokenHash);
    raw = entry && entry.expiresAt.getTime() > Date.now() ? entry.payload : null;
  }
  return parseCapability(purpose, raw);
}

export interface ValidatePortalCapabilityOptions {
  /**
   * Default true: the token is redeemed with a password (accept-invite, reset),
   * so the row must be password-eligible and the org's effective policy must
   * allow password sign-in. False (W4, an invite accepted through Microsoft):
   * neither is required — the credential is the identity the callback links,
   * and the resolver checks that Microsoft is allowed. Every other check
   * stands, and a legacy (pre-W2) invite or a reset is refused outright.
   */
  requirePasswordMethod?: boolean;
}

/**
 * Re-check a consumed token against the row it names. Runs its own system
 * context: the public portal auth routes hold no DB context. Only a token
 * that is valid in every other respect learns that its org is unavailable.
 */
export async function validatePortalCapability(
  purpose: PortalCapabilityPurpose,
  consumed: ConsumedCapability,
  opts: ValidatePortalCapabilityOptions = {},
): Promise<CapabilityCheck> {
  const requirePasswordMethod = opts.requirePasswordMethod ?? true;
  const invalid: CapabilityCheck = { ok: false, reason: 'invalid' };
  if (consumed.format === 'legacy' && purpose === 'reset') return invalid;
  if (consumed.format === 'v2' && consumed.payload.purpose !== purpose) return invalid;
  if (!requirePasswordMethod) {
    // A reset sets a password. A legacy invite carries no issue-time epoch, so
    // an SSO activation could not be pinned to the generation it was issued at.
    if (purpose !== 'invite' || consumed.format !== 'v2') return invalid;
  }

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
  if (requirePasswordMethod && !isPasswordEligible(user)) return invalid;
  if (purpose === 'invite') {
    if (user.status !== 'invited' || user.browserAccess !== 'granted') return invalid;
  } else if (user.status !== 'active' && user.status !== 'invited') {
    return invalid;
  }

  // Access policy (W3, inv. 7 / 8): a token outstanding when the org's
  // effective policy switched password sign-in off is refused with the generic
  // invalid, before the org gate, so it learns nothing about the org either.
  // No DB context is held (public routes), so the resolver opens its own.
  // (A Microsoft acceptance is not a password sign-in: the OIDC resolver
  // applies the policy's Microsoft gate instead.)
  if (requirePasswordMethod && !(await isPasswordSignInAllowedForOrg(user.orgId))) return invalid;

  if (!(await getActiveOrgTenant(user.orgId))) return { ok: false, reason: 'org_unavailable' };

  if (consumed.format === 'legacy') {
    console.warn('[portal] legacy invite token accepted', { portalUserId: user.id });
  }
  return { ok: true, user };
}

export const __testOnly = { consumeFromRedis };
