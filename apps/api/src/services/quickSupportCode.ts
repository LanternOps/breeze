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
 * Cryptographically random one-time code, drawn from the shared
 * SUPPORT_CODE_ALPHABET (digits 2-9 — see the rationale there; generation is
 * narrower than the permissive validation pattern on purpose).
 *
 * `randomInt` (rejection sampling) rather than `randomBytes() % len`: an
 * alphabet whose size does not divide 256 evenly would make modulo bias the
 * leading symbols and cost real entropy. 8 happens to divide 256, but the
 * alphabet has changed once already and rejection sampling is correct for any
 * size, so it stays.
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
 * Plain SHA-256 (not a slow KDF) is deliberate: the code carries ~27 bits of
 * fresh entropy, lives 15 minutes, and lookups happen on the request path. The
 * hash is a disclosure control, not a guessing control — guessing is bounded by
 * the TTL, the per-IP rate limits on /support/check and /support/redeem, and
 * the deployment-wide miss budget in `services/supportCodeMissBudget.ts`.
 */
export function hashSupportCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
