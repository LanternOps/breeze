/**
 * The confirm-only token (#8318 spec §6.3, §6.4): `brz_rbc_` followed by the
 * agent's random secret. It authenticates `POST /agents/:id/rebind-confirm`
 * and nothing else — agent auth never matches it, since it is stored only as
 * a SHA-256 hash on the intent and the ledger.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { REBIND_CONFIRMATION_TOKEN_PREFIX, SHA256_HEX } from './protocol';

/** At least 128 bits of secret after the prefix; at most a generous bound. */
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;

/** The token from an `Authorization: Bearer brz_rbc_…` header, or null. */
export function parseConfirmationBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  if (!token.startsWith(REBIND_CONFIRMATION_TOKEN_PREFIX)) return null;
  if (token.length - REBIND_CONFIRMATION_TOKEN_PREFIX.length < MIN_SECRET_LENGTH) return null;
  return token;
}

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two SHA-256 hex digests; false for anything malformed. */
export function confirmationHashMatches(presentedHash: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !SHA256_HEX.test(presentedHash) || !SHA256_HEX.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(presentedHash, 'hex'), Buffer.from(storedHash, 'hex'));
}
