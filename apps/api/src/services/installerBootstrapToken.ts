import { createHmac, randomInt } from 'node:crypto';
import {
  DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES,
  MAX_BOOTSTRAP_TOKEN_TTL_MINUTES,
} from '@breeze/shared';
import { positiveIntEnv } from '../config/env';
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
 * Lifetime of a freshly-issued bootstrap token, in minutes: 7 days by
 * default, never more than 30 days. The values live in packages/shared
 * (`enrollmentDefaults.ts`) so the Add Device modal's installer picker offers
 * exactly what the installer routes accept; re-exported here for API callers.
 *
 * Interactive routes REJECT an explicit ttlMinutes above the maximum with a
 * 400 (routes/enrollmentKeys.ts). `issueBootstrapTokenForKey` still clamps,
 * as defense in depth for callers that pass a derived lifetime (an installer
 * link's remaining time).
 *
 * This is the lifetime of the token embedded in an installer, not of
 * enrollment keys or installer links — those follow
 * PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES / ENROLLMENT_KEY_DEFAULT_TTL_MINUTES
 * and MAX_ENROLLMENT_TTL_MINUTES, independently.
 *
 * Changing these values never touches tokens already issued: each row keeps
 * the `expires_at` it was minted with.
 */
export { DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES, MAX_BOOTSTRAP_TOKEN_TTL_MINUTES };

/**
 * The configured base TTL: INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES, or the
 * 7-day default, clamped to the 30-day maximum. A value above the maximum is
 * reported once at boot (config/validate.ts), not here.
 *
 * Read through `positiveIntEnv`, never `Number(process.env.X ?? default)`:
 * compose threaded this in as `${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-}`,
 * which renders as the empty STRING when the operator hasn't set it. `??`
 * doesn't fire on `''` and `Number('') === 0`, so the naive form gave every
 * bootstrap token a 0-minute TTL — born expired — on any self-host that
 * pulled this release without adding the key to its .env (#2776). Empty,
 * non-integer, zero and negative values all fall back to the default.
 *
 * Read per call (not cached at import) so the value follows the environment.
 */
export function bootstrapTokenTtlMinutes(): number {
  return positiveIntEnv(
    'INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES',
    DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES,
    1,
    MAX_BOOTSTRAP_TOKEN_TTL_MINUTES,
  );
}

/**
 * Bound a requested installer-credential lifetime to whole minutes in
 * [1, MAX_BOOTSTRAP_TOKEN_TTL_MINUTES]. The floor keeps the
 * `expires_at > created_at` CHECK satisfiable; NaN (which would build an
 * Invalid Date) maps to the default rather than reaching the insert.
 */
export function clampBootstrapTokenTtlMinutes(ttlMinutes: number): number {
  if (Number.isNaN(ttlMinutes)) return DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES;
  return Math.max(1, Math.min(Math.floor(ttlMinutes), MAX_BOOTSTRAP_TOKEN_TTL_MINUTES));
}
