import crypto from 'node:crypto';
import { getRedis } from './redis'; // match the import used by approverWebAuthn.ts

const ASSERTION_TTL = 120;
const assertionKey = (approvalId: string, userId: string) => `mobile-assertion:${approvalId}:${userId}`;

/**
 * The signature algorithms an approver key may use (#1374 W02).
 *
 *  - `RS256` — RSASSA-PKCS1-v1_5 + SHA-256 over an RSA-2048 key. What
 *    react-native-biometrics mints, and therefore what every key registered
 *    before this wave uses. Biometric-gated Keychain/Keystore, but NOT
 *    hardware-resident on iOS (the Secure Enclave holds only 256-bit EC keys).
 *  - `ES256` — ECDSA + SHA-256 over P-256, DER (X9.62) encoded. The only shape
 *    a Secure Enclave key or an attested StrongBox/TEE key can take, so every
 *    attested platform-bound key is ES256.
 */
export type MobileKeyAlg = 'RS256' | 'ES256';

const MOBILE_KEY_ALGS: readonly MobileKeyAlg[] = ['RS256', 'ES256'];

/** react-native-biometrics mints RSA-2048; anything smaller is not strong enough
 *  to carry an approval signature, legacy row or not. */
const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Narrow a stored `authenticator_devices.public_key_alg` (a varchar, so the type
 * system cannot vouch for it) to a supported algorithm.
 *
 * Returns null rather than defaulting to RS256: a row carrying an unrecognised
 * label is a row we cannot describe, and silently verifying it as RSA would be
 * exactly the algorithm-confusion this wave exists to close.
 */
export function toMobileKeyAlg(value: string | null | undefined): MobileKeyAlg | null {
  return MOBILE_KEY_ALGS.includes(value as MobileKeyAlg) ? (value as MobileKeyAlg) : null;
}

/**
 * Verify an approval / registration signature over `payload` against an SPKI DER
 * public key (base64). Returns false on any malformed input (never throws).
 *
 * `alg` is read from the DEVICE ROW (`authenticator_devices.public_key_alg`) or
 * from a body field the caller has already bound into the signed transcript —
 * never from an unbound client assertion, because a client-chosen algorithm is
 * an algorithm-confusion vector.
 *
 * `crypto.verify('SHA256', …)` dispatches on the key type, so one call covers
 * both algorithms; the explicit key-shape checks below are what stop an EC key
 * from being verified as RSA (or vice versa) and what make the `ES256` label
 * actually mean P-256 rather than "any EC curve".
 *
 * ECDSA signatures must be DER (X9.62) encoded — node's default `dsaEncoding`,
 * and what both `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` and
 * Java's `Signature.getInstance("SHA256withECDSA")` emit. Raw/IEEE-P1363
 * 64-byte signatures are deliberately NOT accepted: taking both encodings would
 * make a signature malleable across two representations for no gain, since no
 * platform in this flow produces the raw form.
 */
export function verifyMobileSignature(input: {
  publicKeySpkiB64: string;
  payload: string;
  signatureB64: string;
  alg: MobileKeyAlg;
}): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(input.publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (input.alg === 'ES256') {
      if (key.asymmetricKeyType !== 'ec') return false;
      // "ES256" names ECDSA-SHA256 over P-256 specifically. Without this a
      // P-384/P-521 key would verify and the ios_se_p256_app_attest basis would
      // be describing a key the Secure Enclave cannot hold.
      if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    } else {
      if (key.asymmetricKeyType !== 'rsa') return false;
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
      if (bits < MIN_RSA_MODULUS_BITS) return false;
    }
    return crypto.verify(
      'SHA256',
      Buffer.from(input.payload, 'utf8'),
      key,
      Buffer.from(input.signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * SHA-256 of the CANONICAL SPKI DER for a base64 public key — the value stored
 * in `authenticator_devices.attested_public_key_sha256`, so an attestation
 * verified for key A can never later be read as vouching for a substituted
 * key B.
 *
 * Re-exports the key through `crypto.createPublicKey(...).export(...)` before
 * hashing, so a client that base64s with newlines, drops padding, or otherwise
 * re-encodes an equivalent key still produces the same digest. Returns null
 * (never throws) when the key does not parse.
 */
export function sha256CanonicalSpki(spkiB64: string): Buffer | null {
  try {
    const der = crypto
      .createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' })
      .export({ format: 'der', type: 'spki' });
    return crypto.createHash('sha256').update(der).digest();
  } catch {
    return null;
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

export const issueMobileAssertionNonce = (approvalId: string, userId: string) => issueNonce(assertionKey(approvalId, userId), ASSERTION_TTL);
export const consumeMobileAssertionNonce = (approvalId: string, userId: string) => consumeNonce(assertionKey(approvalId, userId));
