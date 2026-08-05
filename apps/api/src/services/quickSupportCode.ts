import { createHash, randomInt } from 'node:crypto';
import { SUPPORT_CODE_ALPHABET, SUPPORT_CODE_LENGTH } from '@breeze/shared';

/** How long a freshly minted code can still be redeemed. */
export const SUPPORT_CODE_TTL_MINUTES = 15;

/**
 * Absolute ceiling on a session's life, enforced by the reaper. Guarantees no
 * support session — and therefore no ephemeral device — outlives the workday
 * even if every cooperative teardown path fails.
 */
export const SUPPORT_SESSION_HARD_CAP_HOURS = 8;

/**
 * Cryptographically random one-time code.
 *
 * `randomInt` (rejection sampling) rather than `randomBytes() % len`: the
 * alphabet's 30 symbols do not divide 256 evenly, so modulo would bias the
 * first 16 characters and cost real entropy.
 */
export function generateSupportCode(): string {
  let code = '';
  for (let i = 0; i < SUPPORT_CODE_LENGTH; i++) {
    code += SUPPORT_CODE_ALPHABET[randomInt(SUPPORT_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * SHA-256 hex of a normalized code. Only the hash is stored, so a database
 * disclosure never yields a usable code.
 *
 * Plain SHA-256 (not a slow KDF) is deliberate: the code carries ~44 bits of
 * fresh entropy, lives 15 minutes, and lookups happen on the request path.
 */
export function hashSupportCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
