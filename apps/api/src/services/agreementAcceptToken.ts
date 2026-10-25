// Signed, revocable bearer token for a standalone agreement request's public
// signing link (#9075 W2a; spec §3.5 "Token").
//
// A SIBLING of quoteAcceptToken.ts, deliberately not a generalisation: a quote
// token's claim insertion order and payload key order are load-bearing for
// byte-identical regeneration and pinned by its golden vector, so quote tokens
// keep their exact no-`kind` payload. This module shares the keyring / `kid`
// helpers (jwt.ts) and mirrors the Redis revoke helpers, but has:
//  - its own audience, so a quote verifier's jwtVerify rejects an agreement
//    token and vice versa;
//  - its own claim set `{ kind: 'agreement_request', requestId, orgId,
//    partnerId, jti }`, `kind` required on verify;
//  - `exp = expires_at` of the request (an instant), never a default TTL;
//  - its own Redis namespace and golden vector (agreementAcceptToken.test.ts).
//
// The DB columns (agreement_requests.public_link_revoked_at,
// public_response_*) are the durable authority; the Redis jti marker is only
// the hot path.

import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { getSignKey, getSignKeyByKid, getVerifyKey, buildHeader } from './jwt';
import { captureException } from './sentry';

const ISSUER = 'breeze';
const AUDIENCE = 'breeze-agreement-accept';
const KIND = 'agreement_request';
const REVOKE_KEY_PREFIX = 'agreement-accept-jti-revoked:';
/** Floor for the revoke marker's TTL. The marker must outlive the token it
 *  kills, so it is the larger of this and the token's remaining lifetime. */
const REVOKE_TTL_FLOOR_SECONDS = 30 * 24 * 60 * 60;

export interface AgreementAcceptClaims { requestId: string; orgId: string; partnerId: string; jti: string; }

export interface AgreementAcceptTokenInput { requestId: string; orgId: string; partnerId: string; }

/** Everything needed to reproduce an already-issued token byte-for-byte —
 *  persisted on agreement_requests.accept_token_* at send. None of it is
 *  secret on its own: the token is only derivable with the signing key. */
export interface AgreementAcceptTokenIdentity {
  jti: string;
  /** `iat`, whole seconds since the epoch. */
  issuedAtSeconds: number;
  /** `exp`, whole seconds since the epoch. */
  expiresAtSeconds: number;
  /** Protected-header `kid`; null in legacy single-secret mode. */
  kid: string | null;
}

/**
 * Sign the claim set. HS256 is deterministic and regenerate depends on it:
 * the payload KEY order and the setter ORDER below are part of the wire
 * contract (jose serializes in insertion order). Pinned by the golden vector
 * in agreementAcceptToken.test.ts — never reorder.
 */
function signAgreementAcceptToken(
  input: AgreementAcceptTokenInput,
  identity: { jti: string; issuedAtSeconds: number; expiresAtSeconds: number },
  signKey: { key: Uint8Array; kid?: string },
): Promise<string> {
  return new SignJWT({ kind: KIND, requestId: input.requestId, orgId: input.orgId, partnerId: input.partnerId })
    .setProtectedHeader(buildHeader(signKey.kid))
    .setJti(identity.jti)
    .setIssuedAt(identity.issuedAtSeconds)
    .setExpirationTime(identity.expiresAtSeconds)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(signKey.key);
}

/**
 * Mint the request's signing token, expiring exactly at the request's
 * `expires_at`. Throws when `expiresAt` is not in the future: unlike the quote
 * token there is no default-TTL fallback, because a link that outlives its
 * request would be a credential for something already expired. Callers gate
 * on isAgreementRequestExpired first.
 *
 * Persist the returned `identity` so resend / copy-link reproduce the SAME
 * url via regenerateAgreementAcceptToken; never store the token itself.
 */
export async function createAgreementAcceptToken(
  input: AgreementAcceptTokenInput & { expiresAt: Date },
): Promise<{ token: string; jti: string; identity: AgreementAcceptTokenIdentity }> {
  const nowMs = Date.now();
  const expSeconds = Math.floor(input.expiresAt.getTime() / 1000);
  if (!(expSeconds * 1000 > nowMs)) {
    throw new Error('[agreementAcceptToken] expires_at must be in the future to mint a signing link');
  }
  const signKey = getSignKey();
  const identity: AgreementAcceptTokenIdentity = {
    jti: randomUUID(),
    issuedAtSeconds: Math.floor(nowMs / 1000),
    expiresAtSeconds: expSeconds,
    kid: signKey.kid ?? null,
  };
  const token = await signAgreementAcceptToken(input, identity, signKey);
  return { token, jti: identity.jti, identity };
}

/**
 * Rebuild the exact token previously issued from its persisted identity.
 * Returns null when it cannot be reproduced (no identity, or its `kid` has
 * been rotated out of the keyring) — never re-signs with another key.
 */
export async function regenerateAgreementAcceptToken(
  input: AgreementAcceptTokenInput,
  identity: AgreementAcceptTokenIdentity | null,
): Promise<string | null> {
  if (!identity) return null;
  const signKey = getSignKeyByKid(identity.kid);
  if (!signKey) {
    // Fleet-wide: a kid leaving the keyring kills every link signed with it.
    const err = new Error(`[agreementAcceptToken] signing key '${identity.kid ?? 'legacy'}' unavailable — cannot reproduce the signing link for agreement request ${input.requestId}`);
    console.error(err.message);
    captureException(err);
    return null;
  }
  return signAgreementAcceptToken(input, identity, signKey);
}

export async function verifyAgreementAcceptToken(token: string): Promise<AgreementAcceptClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.kind !== KIND) return null;
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) return null;
    const { requestId, orgId, partnerId } = payload as Record<string, unknown>;
    if (typeof requestId !== 'string' || typeof orgId !== 'string' || typeof partnerId !== 'string') return null;
    return { requestId, orgId, partnerId, jti: payload.jti };
  } catch (err) {
    console.debug('[agreementAcceptToken] verification failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Hot-path kill for a jti (void, accept, decline — always post-commit). The
 *  marker lives at least as long as the token could still verify. Redis down
 *  → logged and skipped: the DB columns remain the durable authority. */
export async function revokeAgreementAcceptJti(jti: string, tokenExpiresAt: Date | null): Promise<void> {
  const redis = getRedis();
  if (!redis) { console.error('[agreementAcceptToken] Redis unavailable — jti revocation skipped'); return; }
  const remaining = tokenExpiresAt ? Math.ceil((tokenExpiresAt.getTime() - Date.now()) / 1000) : 0;
  await redis.set(`${REVOKE_KEY_PREFIX}${jti}`, '1', 'EX', Math.max(REVOKE_TTL_FLOOR_SECONDS, remaining));
}

/** Fails CLOSED: with Redis down every jti reads as revoked. */
export async function isAgreementAcceptJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) { console.error('[agreementAcceptToken] Redis unavailable — failing closed on jti check'); return true; }
  return (await redis.get(`${REVOKE_KEY_PREFIX}${jti}`)) === '1';
}
