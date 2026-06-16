import crypto from 'node:crypto';
import { getRedis } from './redis'; // match the import used by approverWebAuthn.ts

const ASSERTION_TTL = 120;
const REG_TTL = 300;
const regKey = (userId: string) => `mobile-reg:${userId}`;
const assertionKey = (approvalId: string, userId: string) => `mobile-assertion:${approvalId}:${userId}`;

/** Verify an RSA-SHA256 signature (PKCS#1 v1.5) over `payload` against an SPKI DER public key (base64).
 *  This is exactly what react-native-biometrics produces. Returns false on any malformed input (never throws). */
export function verifyMobileSignature(input: { publicKeySpkiB64: string; payload: string; signatureB64: string }): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(input.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('RSA-SHA256', Buffer.from(input.payload, 'utf8'), key, Buffer.from(input.signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** A consumed assertion nonce carries the epoch-ms it was ISSUED so the L3/L4
 *  recency gate can bound how stale the signed challenge was — derived
 *  server-side from the stored value, never trusted from the client/route. */
export interface ConsumedNonce {
  nonce: string;
  issuedAt: number;
}

// Stored value is `<issuedAtMs>:<nonce>` so the recency clock travels with the
// nonce (Redis TTL alone proves "within window", but the explicit issued-at
// gives an exact server-side age for the L3 recency bound and audit).
function encodeNonce(nonce: string, issuedAt: number): string {
  return `${issuedAt}:${nonce}`;
}
function decodeNonce(stored: string): ConsumedNonce {
  const sep = stored.indexOf(':');
  // Legacy/raw value (no issued-at prefix): treat as issued "now" so a nonce
  // written before this change still verifies (it was alive → within TTL).
  if (sep === -1) return { nonce: stored, issuedAt: Date.now() };
  const issuedAt = Number(stored.slice(0, sep));
  return {
    nonce: stored.slice(sep + 1),
    issuedAt: Number.isFinite(issuedAt) ? issuedAt : Date.now(),
  };
}

async function issueNonce(key: string, ttl: number): Promise<string> {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  await redis.setex(key, ttl, encodeNonce(nonce, Date.now()));
  return nonce;
}
async function consumeNonce(key: string): Promise<ConsumedNonce | null> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  const stored = await redis.getdel(key);
  return stored == null ? null : decodeNonce(stored);
}

export const issueMobileRegistrationNonce = (userId: string) => issueNonce(regKey(userId), REG_TTL);
export const consumeMobileRegistrationNonce = (userId: string) => consumeNonce(regKey(userId));
export const issueMobileAssertionNonce = (approvalId: string, userId: string) => issueNonce(assertionKey(approvalId, userId), ASSERTION_TTL);
export const consumeMobileAssertionNonce = (approvalId: string, userId: string) => consumeNonce(assertionKey(approvalId, userId));
