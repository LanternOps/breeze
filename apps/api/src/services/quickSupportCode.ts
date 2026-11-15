import { createHash, randomInt } from 'node:crypto';
import { SUPPORT_CODE_ALPHABET, SUPPORT_CODE_LENGTH } from '@breeze/shared';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secretCrypto';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from './encryptedColumnRegistry';

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
 * SHA-256 hex of a normalized code — the redeem lookup key. The only other
 * copy is the sealed, display-only `code_encrypted`, which exists only while
 * the session is pending (#11836), so a database-only disclosure yields no
 * usable code without the secret-encryption key.
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

/** The registry entry, so sealing here and key rotation derive the same AAD. */
const CODE_ENCRYPTED_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (s) => s.table === 'support_sessions' && s.column === 'code_encrypted',
  );
  if (!spec) throw new Error('support_sessions.code_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

/**
 * Seal a code for `support_sessions.code_encrypted` (#11836), bound to the
 * session's row id: pasted onto another session (another partner's, say) the
 * value does not open. The row binding needs an active encryption key id
 * (APP_ENCRYPTION_KEY_ID, the production default); without one encryptSecret
 * falls back to v1, which is still encrypted but carries no AAD — the same as
 * every other row-bound column. The hash stays the redeem lookup key; this
 * copy exists only so the technician can read the code back while pending.
 */
export function sealSupportCode(sessionId: string, code: string): string {
  const sealed = encryptSecret(code, { aad: columnAad(CODE_ENCRYPTED_SPEC, sessionId) });
  // encryptSecret only returns null for an empty input; never store a code we
  // could not seal.
  if (!sealed) throw new Error('support code could not be sealed');
  return sealed;
}

/**
 * Open a sealed code. Returns null — never throws — when the value does not
 * open under this row (wrong row, rotated-away key, corrupt value): the caller
 * then simply shows no code and the technician can mint a new one. The value
 * is never logged.
 */
export function openSupportCode(sessionId: string, sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  // decryptSecret passes plaintext through unchanged; this column only ever
  // holds sealed values, so anything else is refused rather than displayed.
  if (!isEncryptedSecret(sealed)) return null;
  try {
    return decryptSecret(sealed, { aad: columnAad(CODE_ENCRYPTED_SPEC, sessionId) });
  } catch (err) {
    console.warn(
      `[quickSupportCode] sealed code for support session ${sessionId} did not open:`,
      err instanceof Error ? err.message : 'unknown error',
    );
    return null;
  }
}
