import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { NETWORK_ISOLATION_RELEASE_TOKEN } from '@breeze/shared';

/**
 * Signed offline release token for a network-isolation episode (#10102).
 *
 *   token     = base64url(payload) "." base64url(signature)              (no padding)
 *   payload   = {"v":1,"iid":"<uuid>","gen":<n>,"dev":"<uuid>","nbf":<unix s>,"exp":<unix s>}
 *   signature = Ed25519(key, RELEASE_TOKEN_DOMAIN || base64url(payload))
 *
 * The key is an Ed25519 key used for nothing else (NETWORK_ISOLATION_TOKEN_SIGNING_KEY): base64
 * of its 32-byte seed. Its public half is pinned on the device when the episode is applied, so the
 * agent verifies a token with no connectivity, and nothing stored in the database can mint one. The
 * agent (agent/internal/isolation/releasetoken.go) accepts only this exact payload encoding;
 * agent/internal/isolation/testdata/release_token_vectors.json pins both sides to an independent
 * implementation. Without a configured key there is no signer and no episode carries a key.
 */
export const RELEASE_TOKEN_DOMAIN = 'breeze-isolation-release-token-v1\n';
export const RELEASE_TOKEN_SIGNING_KEY_ENV = 'NETWORK_ISOLATION_TOKEN_SIGNING_KEY';

const SEED_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEED_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
/** PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The configured key is malformed. The message never contains key material. */
export class ReleaseTokenKeyError extends Error {
  constructor() { super(`${RELEASE_TOKEN_SIGNING_KEY_ENV} must be base64 of a 32-byte Ed25519 seed`); this.name = 'ReleaseTokenKeyError'; }
}

export interface ReleaseTokenClaims { isolationId: string; generation: number; deviceId: string; notBefore: number; expiresAt: number }

export interface ReleaseTokenSigner {
  /** Base64 (standard, padded) of the 32-byte public key, as the spec field carries it. */
  readonly publicKey: string;
  sign(claims: ReleaseTokenClaims): string;
}

/** Shape check shared with config validation: base64 (standard, padded) of exactly 32 bytes. */
export function isReleaseTokenSigningKeyShape(raw: string): boolean {
  return SEED_B64_RE.test(raw) && Buffer.from(raw, 'base64').length === SEED_BYTES;
}

/**
 * The signer for the configured key, or null when none is configured (tokens off). Throws
 * ReleaseTokenKeyError for a malformed key: a key that is set but wrong must never quietly turn
 * tokens off or sign with something else.
 */
export function releaseTokenSigner(env: Readonly<Record<string, string | undefined>> = process.env): ReleaseTokenSigner | null {
  const raw = env[RELEASE_TOKEN_SIGNING_KEY_ENV]?.trim();
  if (!raw) return null;
  if (!isReleaseTokenSigningKeyShape(raw)) throw new ReleaseTokenKeyError();
  let privateKey: KeyObject;
  let publicKey: string;
  try {
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'pkcs8' });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (typeof jwk.x !== 'string') throw new ReleaseTokenKeyError();
    publicKey = Buffer.from(jwk.x, 'base64url').toString('base64');
  } catch {
    throw new ReleaseTokenKeyError();
  }
  return {
    publicKey,
    sign(claims) {
      const payload = Buffer.from(canonicalReleaseTokenPayload(claims), 'utf8').toString('base64url');
      const signature = sign(null, Buffer.from(RELEASE_TOKEN_DOMAIN + payload, 'utf8'), privateKey);
      return `${payload}.${signature.toString('base64url')}`;
    },
  };
}

/** The only payload encoding the agent accepts: fixed key order, no whitespace, lowercase UUIDs. */
export function canonicalReleaseTokenPayload(claims: ReleaseTokenClaims): string {
  const iid = String(claims.isolationId).toLowerCase();
  const dev = String(claims.deviceId).toLowerCase();
  if (!UUID_RE.test(iid)) throw new Error('isolationId must be a UUID');
  if (!UUID_RE.test(dev)) throw new Error('deviceId must be a UUID');
  if (!Number.isSafeInteger(claims.generation) || claims.generation < 1) throw new Error('generation must be a positive integer');
  const { notBefore: nbf, expiresAt: exp } = claims;
  if (!Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) || nbf <= 0 || exp <= nbf) throw new Error('the validity window is invalid');
  if (exp - nbf > NETWORK_ISOLATION_RELEASE_TOKEN.maxValiditySeconds) throw new Error('the validity window is longer than 24 h');
  return JSON.stringify({ v: NETWORK_ISOLATION_RELEASE_TOKEN.version, iid, gen: claims.generation, dev, nbf, exp });
}

export interface MintedReleaseToken { token: string; notBefore: Date; expiresAt: Date }

/** A token for one episode at one generation on one device, valid from `now` for `validitySeconds`. */
export function mintReleaseToken(signer: ReleaseTokenSigner, input: { isolationId: string; generation: number; deviceId: string; now: Date; validitySeconds: number }): MintedReleaseToken {
  const ms = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('now must be a valid date');
  if (!Number.isSafeInteger(input.validitySeconds) || input.validitySeconds < 1) throw new Error('validitySeconds must be a positive integer');
  const notBefore = Math.floor(ms / 1000);
  const expiresAt = notBefore + input.validitySeconds;
  const token = signer.sign({ isolationId: input.isolationId, generation: input.generation, deviceId: input.deviceId, notBefore, expiresAt });
  return { token, notBefore: new Date(notBefore * 1000), expiresAt: new Date(expiresAt * 1000) };
}
