import { createHmac, randomInt } from 'node:crypto';
import { envInt } from '../utils/envInt';
import { getEnrollmentKeyPepper } from './enrollmentKeyPepper';

/**
 * Canonical shape of a bootstrap token: 10 chars of base36 (uppercase
 * letters + digits). 36^10 ≈ 3.7 trillion values (~52 bits). Used by both the
 * generator and the route-side input validator.
 */
export const BOOTSTRAP_TOKEN_PATTERN = /^[A-Z0-9]{10}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a 10-character base36 bootstrap token using a CSPRNG.
 * Output is always 10 chars of [A-Z0-9] (~52 bits of entropy).
 */
export function generateBootstrapToken(): string {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Domain label mixed into every bootstrap-token digest, so the pepper that
 * also keys enrollment-key hashes can never yield a value that matches across
 * the two credential types. Bump the version only together with a lookup that
 * still accepts the previous one for the life of outstanding tokens.
 */
const BOOTSTRAP_TOKEN_HASH_DOMAIN = 'breeze.installer-bootstrap-token.v1:';

/**
 * The value stored in `installer_bootstrap_tokens.token_hash` and matched at
 * redemption: HMAC-SHA256 keyed by ENROLLMENT_KEY_PEPPER, hex-encoded.
 *
 * Keyed rather than a bare SHA-256 because the token space is small (~52
 * bits): an unkeyed digest of a 10-char [A-Z0-9] value can be reversed by
 * enumeration from a copy of the table alone. With the pepper held only in the
 * API environment, a copy of the table is not enough to recover a live token.
 * Deterministic (no per-row salt) so redemption stays one indexed equality.
 *
 * Rotating ENROLLMENT_KEY_PEPPER invalidates outstanding bootstrap tokens:
 * unlike enrollment keys there is no legacy-pepper fallback, because no token
 * was ever hashed under another secret.
 */
export function hashBootstrapToken(rawToken: string): string {
  return createHmac('sha256', getEnrollmentKeyPepper())
    .update(`${BOOTSTRAP_TOKEN_HASH_DOMAIN}${rawToken}`)
    .digest('hex');
}

/**
 * Default TTL for a freshly-issued bootstrap token. Tunable via env
 * for testing; production default is 30 days — installers get staged
 * through deploy tooling (RMM/GPO/Intune) and are expected to keep
 * working well past the day they were downloaded. Keep in step with
 * PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES (packages/shared).
 *
 * Must go through `envInt`, never `Number(process.env.X ?? default)`:
 * compose threads this in as `${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-}`,
 * which renders as the empty STRING when the operator hasn't set it. `??`
 * doesn't fire on `''` and `Number('') === 0`, so the naive form gave every
 * bootstrap token a 0-minute TTL — born expired — on any self-host that
 * pulled this release without adding the key to its .env (#2776).
 */
export function bootstrapTokenExpiresAt(): Date {
  const ttlMin = envInt('INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES', 60 * 24 * 30);
  return new Date(Date.now() + ttlMin * 60 * 1000);
}
