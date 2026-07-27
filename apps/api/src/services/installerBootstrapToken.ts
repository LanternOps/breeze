import { randomInt } from 'node:crypto';
import { envInt } from '../utils/envInt';

/**
 * Canonical shape of a bootstrap token: 10 chars of base36 (uppercase
 * letters + digits). 36^10 ≈ 3.7 trillion values (~52 bits) — strong
 * entropy for a single-use 24h-TTL token. Used by both the generator and
 * the route-side input validator.
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
 * Default TTL for a freshly-issued bootstrap token. Tunable via env
 * for testing; production default is 24 hours which matches the
 * "admin downloads installer, sends to user, user runs sometime
 * within a day" mental model.
 *
 * Must go through `envInt`, never `Number(process.env.X ?? default)`:
 * compose threads this in as `${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-}`,
 * which renders as the empty STRING when the operator hasn't set it. `??`
 * doesn't fire on `''` and `Number('') === 0`, so the naive form gave every
 * bootstrap token a 0-minute TTL — born expired — on any self-host that
 * pulled this release without adding the key to its .env (#2776).
 */
export function bootstrapTokenExpiresAt(): Date {
  const ttlMin = envInt('INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES', 24 * 60);
  return new Date(Date.now() + ttlMin * 60 * 1000);
}
