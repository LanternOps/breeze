/**
 * Trust Center W3b (#8771): sign a published trust payload as a compact JWT.
 *
 * Contract (verifiers depend on it; documented in apps/docs security/trust-center-attestation.mdx):
 *   header  { alg: 'ES256', kid, typ: 'trust-attestation+jwt' }
 *   iss     origin of DASHBOARD_URL || PUBLIC_APP_URL — deployment configuration, never request headers
 *   sub     canonical public page URL, <iss>/portal/trust/<p>[/<o>]
 *   iat     signing time; exp = min(iat + 3600, lastEvaluatedAt + 86400); jti = random UUID per token
 *   trust   { v: 1, payload: <the exact public payload>, lastEvaluatedAt }
 * A stale page (lastEvaluatedAt null or ≥ 24 h old) gets no token at all.
 *
 * Signed on demand and cached in Redis per (kid, sub, snapshot, evaluation time), so the immutable
 * snapshot table needs no signature column and a rotation needs no re-signing. The cache never outlives
 * `exp − 60 s`. Redis is an optimisation only: its errors are logged and skipped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { TrustPagePublicPayload } from '@breeze/shared';
import { getRedis } from '../redis';
import type { ResolvedTrustPage } from './resolve';
import { ensureActiveTrustSigningKey, loadTrustSigningKey, TrustAttestationUnavailable, TRUST_SIGNING_ALG } from './attestationKeys';

export const TRUST_ATTESTATION_TYP = 'trust-attestation+jwt';
export const TRUST_ATTESTATION_VERSION = 1;
/** Upper bound on a token's validity. */
export const TRUST_ATTESTATION_MAX_TTL_SECONDS = 3600;
/** A page is stale (no token) once its last evaluation is this old; also caps `exp`. */
export const TRUST_ATTESTATION_FRESHNESS_SECONDS = 86_400;
const SERVER_CACHE_MAX_SECONDS = 300;
const SERVER_CACHE_EXP_MARGIN_SECONDS = 60;
const LOCAL_DASHBOARD_URL = 'http://localhost:4321';

/** The page has no evaluation within the freshness window: the route answers 503 ATTESTATION_STALE. */
export class TrustAttestationStale extends Error {
  constructor() {
    super('trust page evaluation is stale; no attestation is issued');
    this.name = 'TrustAttestationStale';
  }
}

/**
 * The deployment's issuer: the origin of DASHBOARD_URL || PUBLIC_APP_URL (precedence as
 * jobs/ticketNotifyWorker.ts). Production with neither set is unavailable rather than a localhost issuer.
 */
export function trustAttestationIssuer(): string {
  const configured = process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL;
  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      throw new TrustAttestationUnavailable('DASHBOARD_URL or PUBLIC_APP_URL must be set to issue trust attestations');
    }
    return LOCAL_DASHBOARD_URL;
  }
  try {
    return new URL(configured).origin;
  } catch {
    throw new TrustAttestationUnavailable('DASHBOARD_URL / PUBLIC_APP_URL is not a valid URL');
  }
}

export function trustCanonicalPageUrl(issuer: string, partnerSlug: string, orgSlug: string | null): string {
  const path = orgSlug === null
    ? `/portal/trust/${encodeURIComponent(partnerSlug)}`
    : `/portal/trust/${encodeURIComponent(partnerSlug)}/${encodeURIComponent(orgSlug)}`;
  return `${issuer}${path}`;
}

/** `exp` for a page evaluated at `lastEvaluatedAt`, or null when the page is stale at `iat`. */
export function trustAttestationExpiry(iat: number, lastEvaluatedAt: Date | null): number | null {
  if (!lastEvaluatedAt) return null;
  const freshUntil = Math.floor(lastEvaluatedAt.getTime() / 1000) + TRUST_ATTESTATION_FRESHNESS_SECONDS;
  if (freshUntil <= iat) return null;
  return Math.min(iat + TRUST_ATTESTATION_MAX_TTL_SECONDS, freshUntil);
}

const cacheKey = (kid: string, sub: string, snapshotId: string, lastEvaluatedAt: Date) =>
  `trust:attest:${kid}:${createHash('sha256').update(sub).digest('hex')}:${snapshotId}:${lastEvaluatedAt.getTime()}`;

async function readCached(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch (err) {
    console.warn('[trustAttestation] token cache read failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function writeCached(key: string, token: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, token, 'EX', ttlSeconds);
  } catch (err) {
    console.warn('[trustAttestation] token cache write failed', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sign `payload` (the exact current snapshot payload of `resolved`) for the page at `canonicalUrl`.
 * Throws TrustAttestationStale for a stale page and TrustAttestationUnavailable when there is no issuer or
 * no active key. Call outside any DB context (the key service opens its own; Redis runs after it closes).
 */
export async function signTrustAttestation(input: {
  resolved: ResolvedTrustPage;
  payload: TrustPagePublicPayload;
  canonicalUrl: string;
}): Promise<string> {
  const { resolved, payload, canonicalUrl } = input;
  if (!resolved.snapshotId) throw new Error('signTrustAttestation requires a current snapshot');
  const issuer = trustAttestationIssuer();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = trustAttestationExpiry(nowSeconds, resolved.lastEvaluatedAt);
  if (exp === null || !resolved.lastEvaluatedAt) throw new TrustAttestationStale();

  const { kid } = await ensureActiveTrustSigningKey();
  const key = cacheKey(kid, canonicalUrl, resolved.snapshotId, resolved.lastEvaluatedAt);
  const cached = await readCached(key);
  if (cached) return cached;

  const privateKey = await loadTrustSigningKey(kid);
  const token = await new SignJWT({
    trust: { v: TRUST_ATTESTATION_VERSION, payload, lastEvaluatedAt: resolved.lastEvaluatedAt.toISOString() },
  })
    .setProtectedHeader({ alg: TRUST_SIGNING_ALG, kid, typ: TRUST_ATTESTATION_TYP })
    .setIssuer(issuer)
    .setSubject(canonicalUrl)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(privateKey);

  const ttl = Math.min(SERVER_CACHE_MAX_SECONDS, exp - nowSeconds - SERVER_CACHE_EXP_MARGIN_SECONDS);
  if (ttl > 0) await writeCached(key, token, ttl);
  return token;
}
