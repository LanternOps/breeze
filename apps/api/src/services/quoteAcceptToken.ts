import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getSignKey, getVerifyKey, buildHeader } from './jwt';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-quote-accept';
const PURPOSE = 'quote-accept';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REVOKE_TTL_SECONDS = DEFAULT_TTL_SECONDS;

export interface QuoteAcceptClaims { quoteId: string; orgId: string; partnerId: string; jti: string; }

/**
 * Mint a signed, revocable token that lets a prospect without a portal account
 * open + accept exactly one quote. Mirrors the viewer-token pattern (jwt.ts +
 * viewerTokenRevocation.ts) but with its own audience/purpose so a viewer token
 * can never be replayed against the accept path.
 */
export async function createQuoteAcceptToken(input: {
  quoteId: string; orgId: string; partnerId: string; expiresAt?: Date | null;
}): Promise<{ token: string; jti: string }> {
  const { key, kid } = getSignKey();
  const jti = randomUUID();
  // Expiry = the quote's expiry_date if it's in the future, else +30d. jose's
  // setExpirationTime accepts a number of seconds since the epoch.
  const expSeconds = input.expiresAt && input.expiresAt.getTime() > Date.now()
    ? Math.floor(input.expiresAt.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
  const token = await new SignJWT({ quoteId: input.quoteId, orgId: input.orgId, partnerId: input.partnerId, purpose: PURPOSE })
    .setProtectedHeader(buildHeader(kid))
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expSeconds)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(key);
  return { token, jti };
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
