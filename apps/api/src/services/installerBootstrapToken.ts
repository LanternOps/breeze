import { randomInt } from 'node:crypto';

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
 */
export function bootstrapTokenExpiresAt(): Date {
  const ttlMin = Number(process.env.INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES ?? 24 * 60);
  return new Date(Date.now() + ttlMin * 60 * 1000);
}
