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

async function issueNonce(key: string, ttl: number): Promise<string> {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  await redis.setex(key, ttl, nonce);
  return nonce;
}
async function consumeNonce(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  return redis.getdel(key);
}

export const issueMobileRegistrationNonce = (userId: string) => issueNonce(regKey(userId), REG_TTL);
export const consumeMobileRegistrationNonce = (userId: string) => consumeNonce(regKey(userId));
export const issueMobileAssertionNonce = (approvalId: string, userId: string) => issueNonce(assertionKey(approvalId, userId), ASSERTION_TTL);
export const consumeMobileAssertionNonce = (approvalId: string, userId: string) => consumeNonce(assertionKey(approvalId, userId));
