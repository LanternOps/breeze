/**
 * Portal OIDC flow state (portal registration W4, plan D3).
 *
 * One record per started sign-in: the purpose, nonce, PKCE verifier and a
 * browser binding. It is
 *   - stored under `PORTAL_REDIS_KEYS.oidcState(sha256(state))` for 600 s —
 *     the raw `state` travels only through the browser and Microsoft;
 *   - single-use: consumed by the shared Lua GET+DEL (`luaGetDel`) on Redis,
 *     a get + delete in one synchronous tick in memory, so a replayed or
 *     double-delivered callback gets nothing;
 *   - bound to the browser that started it: a random 32-byte cookie
 *     (`breeze_portal_oidc`) whose sha256 is stored and compared in constant
 *     time AFTER the record is consumed, so a callback from another browser
 *     (or with no cookie) burns the state and gets nothing.
 *
 * The backend follows `PORTAL_USE_REDIS` — Redis in production, the
 * in-memory twin in routes/portal/helpers.ts otherwise — the same mutually
 * exclusive switch as sessions and capability tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getRedis } from '../redis';
import { generatePKCEChallenge } from '../sso';
import { PORTAL_REDIS_KEYS, PORTAL_USE_REDIS } from '../../routes/portal/schemas';
import { PORTAL_OIDC_STATE_CAP, capMapByOldest, luaGetDel, portalOidcStates } from '../../routes/portal/helpers';
import type { PortalOidcProvider, PortalOidcPurpose, PortalOidcState } from './types';
import { PORTAL_ENTRA_SIGN_IN_AUTHORITY, isGuid, isProvableEntraTenantId, isSha256Hex } from './validators';

export const PORTAL_OIDC_STATE_TTL_SECONDS = 600;
export const PORTAL_OIDC_BINDING_COOKIE = 'breeze_portal_oidc';
/** Only the OIDC routes (start sets it, callback reads and clears it) ever see the cookie. */
const BINDING_COOKIE_PATH = '/api/v1/portal/auth/oidc';
const STATE_TTL_MS = PORTAL_OIDC_STATE_TTL_SECONDS * 1000;
/** Generous bound on a `state` query value; ours are 43 characters. */
const MAX_RAW_STATE_LENGTH = 512;

/** Redis is required (production backend) but not available: nothing was stored. */
export class PortalOidcStateUnavailableError extends Error {
  override readonly name = 'PortalOidcStateUnavailableError';
  constructor() {
    super('Portal OIDC state store unavailable');
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 32 random bytes, base64url. */
function randomValue(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Mints state + nonce + PKCE, stores the record, returns what the authorize
 * URL and the Set-Cookie need. Throws on a record its own consume would refuse
 * (a caller bug), and PortalOidcStateUnavailableError when Redis is required
 * but absent, so no authorize URL is ever handed out for a flow whose callback
 * could not succeed.
 */
export async function createPortalOidcState(input: {
  provider: PortalOidcProvider;
  purpose: PortalOidcPurpose;
  hostOrgId: string | null;
  authority: string;
}): Promise<{ state: string; nonce: string; codeChallenge: string; bindingCookie: string }> {
  const state = randomValue();
  const nonce = randomValue();
  const bindingCookie = randomValue();
  const pkce = generatePKCEChallenge();
  const createdAt = Date.now();

  const record: PortalOidcState = {
    v: 1,
    provider: input.provider,
    purpose: input.purpose,
    nonce,
    codeVerifier: pkce.codeVerifier,
    bindingHash: sha256Hex(bindingCookie),
    hostOrgId: input.hostOrgId,
    authority: input.authority,
    createdAt,
  };
  // A caller bug (an unpinned proof, an authority that does not match the
  // purpose, a non-GUID id) fails here, at start, instead of burning the state
  // at the callback after a full Microsoft round trip.
  if (typeof recordShape(record) === 'string') {
    throw new Error('createPortalOidcState: the purpose, authority or host org is not a well-formed flow state');
  }
  const payload = JSON.stringify(record);
  const stateHash = sha256Hex(state);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) throw new PortalOidcStateUnavailableError();
    await redis.setex(PORTAL_REDIS_KEYS.oidcState(stateHash), PORTAL_OIDC_STATE_TTL_SECONDS, payload);
  } else {
    portalOidcStates.set(stateHash, { payload, createdAt: new Date(createdAt), expiresAt: new Date(createdAt + STATE_TTL_MS) });
    capMapByOldest(portalOidcStates, PORTAL_OIDC_STATE_CAP, (entry) => entry.createdAt.getTime());
  }

  return { state, nonce, codeChallenge: pkce.codeChallenge, bindingCookie };
}

/** A found record that was refused. Logged by reason only — never a state, cookie or payload value. */
function reject(reason: 'parse' | 'version' | 'shape' | 'expired' | 'binding'): null {
  console.warn('[portal] OIDC state rejected', { reason });
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The purpose, only in the exact shapes the start routes write: sha256 hex
 * capability hashes, GUID ids, and a proof pinned to a provable tenant (a
 * lowercase GUID, never the consumer tenant — D6). Anything else is null.
 */
function parsePurpose(value: unknown): PortalOidcPurpose | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, inviteTokenHash, portalUserId, orgId, authEpoch, runTokenHash, expectedTenantId } = value as Record<string, unknown>;
  switch (kind) {
    case 'login':
      return { kind: 'login' };
    case 'invite':
      return isSha256Hex(inviteTokenHash) ? { kind: 'invite', inviteTokenHash } : null;
    case 'link':
      return isGuid(portalUserId)
        && isGuid(orgId)
        && typeof authEpoch === 'number'
        && Number.isSafeInteger(authEpoch)
        && authEpoch > 0
        ? { kind: 'link', portalUserId, orgId, authEpoch }
        : null;
    case 'tenant_proof':
      // A proof run is always pinned to a tenant (D6): an unpinned state is refused.
      return isSha256Hex(runTokenHash) && isGuid(orgId) && isProvableEntraTenantId(expectedTenantId)
        ? { kind: 'tenant_proof', runTokenHash, orgId, expectedTenantId }
        : null;
    default:
      return null;
  }
}

/**
 * The only authority a purpose may carry: the pinned tenant for a proof run
 * (D6), `organizations` for every user sign-in (the structural guest refusal).
 * The callback redeems the code at the stored authority, so a record pairing a
 * purpose with any other authority is refused.
 */
function authorityFor(purpose: PortalOidcPurpose): string {
  return purpose.kind === 'tenant_proof' ? purpose.expectedTenantId : PORTAL_ENTRA_SIGN_IN_AUTHORITY;
}

/** The record, or why it is not one. Pure (no log, no clock), so create and consume share it. */
function recordShape(parsed: unknown): PortalOidcState | 'version' | 'shape' {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'shape';
  const { v, provider, purpose: rawPurpose, nonce, codeVerifier, bindingHash, hostOrgId, authority, createdAt } =
    parsed as Record<string, unknown>;
  if (v !== 1) return 'version';

  const purpose = parsePurpose(rawPurpose);
  const host = hostOrgId === null ? null : isGuid(hostOrgId) ? hostOrgId : undefined;
  if (
    provider !== 'entra'
    || !purpose
    || !isNonEmptyString(nonce)
    || !isNonEmptyString(codeVerifier)
    || !isSha256Hex(bindingHash)
    || typeof authority !== 'string'
    || authority !== authorityFor(purpose)
    || typeof createdAt !== 'number'
    || !Number.isFinite(createdAt)
    || host === undefined
  ) {
    return 'shape';
  }
  return { v: 1, provider, purpose, nonce, codeVerifier, bindingHash, hostOrgId: host, authority, createdAt };
}

function parseState(raw: string): PortalOidcState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('parse');
  }
  const record = recordShape(parsed);
  if (typeof record === 'string') return reject(record);
  // The store's TTL is the primary expiry; this holds the same 600 s across
  // both backends even if a TTL was lost.
  if (Date.now() - record.createdAt >= STATE_TTL_MS) return reject('expired');
  return record;
}

function bindingMatches(bindingHash: string, bindingCookieValue: string | undefined): boolean {
  if (!bindingCookieValue) return false;
  // Both sides are 32-byte digests, so the comparison is constant-time and
  // length-independent of whatever the browser sent.
  return timingSafeEqual(Buffer.from(sha256Hex(bindingCookieValue), 'hex'), Buffer.from(bindingHash, 'hex'));
}

/**
 * GET+DEL by sha256(state); then constant-time compare of sha256(cookie) with
 * bindingHash. Any miss → null (state is gone either way). Also null, with
 * nothing consumed, when Redis is required but unavailable.
 */
export async function consumePortalOidcState(
  rawState: string,
  bindingCookieValue: string | undefined,
): Promise<PortalOidcState | null> {
  if (!rawState || rawState.length > MAX_RAW_STATE_LENGTH) return null;
  const stateHash = sha256Hex(rawState);

  let raw: string | null;
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    raw = await luaGetDel(redis, PORTAL_REDIS_KEYS.oidcState(stateHash));
  } else {
    // get + delete in one synchronous tick: no await between them.
    const entry = portalOidcStates.get(stateHash);
    portalOidcStates.delete(stateHash);
    raw = entry && entry.expiresAt.getTime() > Date.now() ? entry.payload : null;
  }
  if (raw === null) return null;

  const record = parseState(raw);
  if (!record) return null;
  if (!bindingMatches(record.bindingHash, bindingCookieValue)) return reject('binding');
  return record;
}

function bindingCookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  // Always Lax, never the configurable portal SameSite: the cookie must ride
  // Microsoft's top-level cross-site GET back to the callback
  // (response_mode=query), which Strict would drop and None does not need.
  return `; Path=${BINDING_COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;
}

export function buildPortalOidcBindingCookie(value: string, opts: { secure: boolean }): string {
  return `${PORTAL_OIDC_BINDING_COOKIE}=${encodeURIComponent(value)}${bindingCookieAttributes(opts.secure, PORTAL_OIDC_STATE_TTL_SECONDS)}`;
}

export function buildClearPortalOidcBindingCookie(opts: { secure: boolean }): string {
  return `${PORTAL_OIDC_BINDING_COOKIE}=${bindingCookieAttributes(opts.secure, 0)}`;
}
