import { randomBytes } from 'node:crypto';

/**
 * Canonical shape of a provision credential-handle token: 64 chars of
 * lowercase hex (32 bytes / 256 bits of CSPRNG entropy). The token IS the
 * bearer credential for the one-time fetch, so it must be unguessable.
 * Used by both the generator and the route-side input validator.
 */
export const PROVISION_HANDLE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** Generates a 64-char hex provision credential-handle token (256 bits). */
export function generateProvisionHandleToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * TTL for a freshly-issued provision credential handle. Short by design —
 * the admin provisions and immediately fetches the blob in the same flow.
 * Tunable via env for testing; production default is 5 minutes.
 */
export function provisionHandleExpiresAt(): Date {
  const ttlMin = Number(process.env.PROVISION_HANDLE_TTL_MINUTES ?? 5);
  return new Date(Date.now() + ttlMin * 60 * 1000);
}
