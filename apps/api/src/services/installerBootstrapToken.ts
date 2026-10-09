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
 * Lifetime of a freshly-issued bootstrap token, in minutes.
 *
 * Default 7 days: long enough for an installer to be staged through deploy
 * tooling (RMM/GPO/Intune) and run on the target machines, short enough that
 * a downloaded installer does not stay redeemable for a month after it is
 * forgotten. Operators can raise it with INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES,
 * up to the 30-day maximum; per-request lifetimes chosen in the Add Device
 * modal or inherited from an installer link are held to the same maximum (see
 * `issueBootstrapTokenForKey`), and the partner's
 * `maxEnrollmentLinkTtlMinutes` cap can lower it further.
 *
 * This is the lifetime of the token embedded in an installer, not of
 * enrollment keys — those follow PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES
 * (packages/shared) and ENROLLMENT_KEY_DEFAULT_TTL_MINUTES, independently.
 *
 * Changing these values never touches tokens already issued: each row keeps
 * the `expires_at` it was minted with.
 */
export const DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES = 60 * 24 * 7; // 10080
export const MAX_BOOTSTRAP_TOKEN_TTL_MINUTES = 60 * 24 * 30; // 43200

const BOOTSTRAP_TOKEN_TTL_ENV = 'INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES';

/** Bound a requested token lifetime to MAX_BOOTSTRAP_TOKEN_TTL_MINUTES. */
export function clampBootstrapTokenTtlMinutes(ttlMinutes: number): number {
  return Math.min(ttlMinutes, MAX_BOOTSTRAP_TOKEN_TTL_MINUTES);
}

let warnedEnvTtlClamped = false;

/**
 * The configured base TTL: INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES, or the
 * 7-day default, clamped to the 30-day maximum.
 *
 * Must go through `envInt`, never `Number(process.env.X ?? default)`:
 * compose threaded this in as `${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-}`,
 * which renders as the empty STRING when the operator hasn't set it. `??`
 * doesn't fire on `''` and `Number('') === 0`, so the naive form gave every
 * bootstrap token a 0-minute TTL — born expired — on any self-host that
 * pulled this release without adding the key to its .env (#2776). For the
 * same reason a zero or negative value falls back to the default rather than
 * minting tokens that are already expired.
 *
 * Read per call (not cached at import) so the value follows the environment.
 * The over-maximum warning is logged once per process.
 */
function configuredBootstrapTokenTtlMinutes(): number {
  const configured = envInt(BOOTSTRAP_TOKEN_TTL_ENV, DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES);
  if (configured <= 0) return DEFAULT_BOOTSTRAP_TOKEN_TTL_MINUTES;
  if (configured > MAX_BOOTSTRAP_TOKEN_TTL_MINUTES) {
    if (!warnedEnvTtlClamped) {
      warnedEnvTtlClamped = true;
      console.warn(
        `[installer] ${BOOTSTRAP_TOKEN_TTL_ENV}=${configured} exceeds the maximum of ` +
          `${MAX_BOOTSTRAP_TOKEN_TTL_MINUTES} minutes (30 days); installer bootstrap tokens ` +
          `will be issued with a ${MAX_BOOTSTRAP_TOKEN_TTL_MINUTES}-minute lifetime.`,
      );
    }
    return MAX_BOOTSTRAP_TOKEN_TTL_MINUTES;
  }
  return configured;
}

/** Expiry for a bootstrap token issued now with the configured base TTL. */
export function bootstrapTokenExpiresAt(): Date {
  return new Date(Date.now() + configuredBootstrapTokenTtlMinutes() * 60 * 1000);
}
