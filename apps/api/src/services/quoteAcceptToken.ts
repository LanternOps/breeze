import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getSignKey, getSignKeyByKid, getVerifyKey, buildHeader } from './jwt';
import { captureException } from './sentry';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-quote-accept';
const PURPOSE = 'quote-accept';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REVOKE_TTL_SECONDS = DEFAULT_TTL_SECONDS;

export interface QuoteAcceptClaims { quoteId: string; orgId: string; partnerId: string; jti: string; }

/** Everything needed to reproduce an already-issued accept token byte-for-byte.
 *  None of it is secret on its own — the token string is only derivable with
 *  the signing key — so these are safe to persist on `quotes` (see
 *  regenerateQuoteAcceptToken). */
export interface QuoteAcceptTokenIdentity {
  jti: string;
  /** `iat` claim, in whole seconds since the epoch. */
  issuedAtSeconds: number;
  /** `exp` claim, in whole seconds since the epoch. */
  expiresAtSeconds: number;
  /** Protected-header `kid`; null in legacy single-secret mode. */
  kid: string | null;
}

/**
 * Sign the accept-token claim set.
 *
 * IMPORTANT: HS256 is deterministic, and regenerateQuoteAcceptToken depends on
 * that — the same inputs through this function MUST produce a byte-identical
 * token, because a quote's share link is reproduced (not re-minted) on every
 * re-send and every "copy link". That makes the setter ORDER below part of the
 * contract: jose serializes claims in insertion order, so reordering these
 * calls silently changes every existing quote's link. Both callers go through
 * here so there is exactly one such order to keep — and the payload KEY order
 * in the constructor below is load-bearing for the same reason.
 * Pinned by the golden-vector test in quoteAcceptToken.test.ts, which asserts a
 * hardcoded token string. (The mint-vs-regenerate byte-equality test alongside
 * it CANNOT catch a reorder — both sides go through this function, so they
 * change together and stay equal.)
 */
function signAcceptToken(
  input: { quoteId: string; orgId: string; partnerId: string },
  identity: { jti: string; issuedAtSeconds: number; expiresAtSeconds: number },
  signKey: { key: Uint8Array; kid?: string },
): Promise<string> {
  return new SignJWT({ quoteId: input.quoteId, orgId: input.orgId, partnerId: input.partnerId, purpose: PURPOSE })
    .setProtectedHeader(buildHeader(signKey.kid))
    .setJti(identity.jti)
    .setIssuedAt(identity.issuedAtSeconds)
    .setExpirationTime(identity.expiresAtSeconds)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(signKey.key);
}

/**
 * Mint a signed, revocable token that lets a prospect without a portal account
 * open + accept exactly one quote. Mirrors the viewer-token pattern (jwt.ts +
 * viewerTokenRevocation.ts) but with its own audience/purpose so a viewer token
 * can never be replayed against the accept path.
 *
 * Returns the token's `identity` alongside it: persist that on the quote and a
 * later re-send/copy-link can hand out the SAME url via
 * regenerateQuoteAcceptToken, without ever storing the bearer token itself.
 */
export async function createQuoteAcceptToken(input: {
  quoteId: string; orgId: string; partnerId: string; expiresAt?: Date | null;
}): Promise<{ token: string; jti: string; identity: QuoteAcceptTokenIdentity }> {
  const signKey = getSignKey();
  const jti = randomUUID();
  // Expiry = the quote's expiry_date if it's in the future, else +30d. jose's
  // setExpirationTime accepts a number of seconds since the epoch.
  const expSeconds = input.expiresAt && input.expiresAt.getTime() > Date.now()
    ? Math.floor(input.expiresAt.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
  // setIssuedAt() would stamp its own clock read; take it explicitly so the
  // exact `iat` we persist is the one that got signed.
  const iatSeconds = Math.floor(Date.now() / 1000);
  const identity: QuoteAcceptTokenIdentity = {
    jti, issuedAtSeconds: iatSeconds, expiresAtSeconds: expSeconds, kid: signKey.kid ?? null,
  };
  const token = await signAcceptToken(input, identity, signKey);
  return { token, jti, identity };
}

/**
 * Rebuild the exact token previously issued for a quote from its persisted,
 * non-secret identity. This is how a quote keeps ONE stable share link across
 * re-sends: the link is derived on demand rather than stored, so DB read access
 * alone never yields a usable accept credential.
 *
 * Returns null when the token cannot be reproduced — the quote predates
 * identity persistence, or its signing `kid` has been rotated out of the
 * keyring. Callers mint a fresh token in that case (the link changes).
 */
export async function regenerateQuoteAcceptToken(
  input: { quoteId: string; orgId: string; partnerId: string },
  identity: QuoteAcceptTokenIdentity | null,
): Promise<string | null> {
  if (!identity) return null;
  const signKey = getSignKeyByKid(identity.kid);
  if (!signKey) {
    // Fleet-wide, not per-quote: a kid dropping out of the keyring silently
    // reissues EVERY quote signed with it on next touch, and — unlike the
    // legacy case — getVerifyKey refuses to fall back for an unknown kid, so
    // each customer's existing link is dead, not merely duplicated. That
    // deserves an alert, not a line in the logs.
    const err = new Error(`[quoteAcceptToken] signing key '${identity.kid ?? 'legacy'}' unavailable — cannot reproduce the accept link for quote ${input.quoteId}`);
    console.error(err.message);
    captureException(err);
    return null;
  }
  return signAcceptToken(input, identity, signKey);
}

export async function verifyQuoteAcceptToken(token: string): Promise<QuoteAcceptClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.purpose !== PURPOSE) return null;
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;
    const { quoteId, orgId, partnerId } = payload as Record<string, unknown>;
    if (typeof quoteId !== 'string' || typeof orgId !== 'string' || typeof partnerId !== 'string') return null;
    return { quoteId, orgId, partnerId, jti: payload.jti };
  } catch (err) {
    console.debug('[quoteAcceptToken] verification failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function revokeQuoteAcceptJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) { console.error('[quoteAcceptToken] Redis unavailable — jti revocation skipped'); return; }
  await redis.set(`quote-accept-jti-revoked:${jti}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isQuoteAcceptJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) { console.error('[quoteAcceptToken] Redis unavailable — failing closed on jti check'); return true; }
  return (await redis.get(`quote-accept-jti-revoked:${jti}`)) === '1';
}
