import { z } from 'zod';

// Quick Support one-time codes — shared between the API (generation, hashing),
// the web landing page (client-side normalization before the check call) and
// the Go agent's filename parsing (which mirrors SUPPORT_CODE_PATTERN).
//
// The alphabet deliberately omits I, L, O, 0 and 1: the code is read aloud
// over the phone as often as it is copy-pasted, and those five are where
// transcription goes wrong. 30 symbols x 9 characters is ~44 bits, which
// together with the 15-minute TTL and per-IP rate limiting on /support/check
// and /support/redeem is what makes guessing impractical.
export const SUPPORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const SUPPORT_CODE_LENGTH = 9;
export const SUPPORT_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{9}$/;

/**
 * Canonicalize user-entered input ("ktm-4h7 p2x", "KTM 4H7 P2X") to the stored
 * form ("KTM4H7P2X"), or null when it could never be a valid code.
 *
 * Returning null rather than throwing lets callers treat malformed input as a
 * miss without a DB round-trip.
 */
export function normalizeSupportCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '');
  return SUPPORT_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Display form: KTM4H7P2X -> KTM-4H7-P2X. */
export function formatSupportCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

export const createSupportSessionSchema = z.object({
  /** Reporting attribution only — carries no tenancy effect. */
  attributedOrgId: z.string().guid().optional(),
  attributionLabel: z.string().max(200).optional(),
});

// osType is a hand-written enum rather than one derived from a Drizzle
// pgEnum: deriving from `pgEnum.enumValues` breaks the schema mocks the API
// route tests rely on.
export const redeemSupportSessionSchema = z.object({
  // Accepts the formatted or raw form; the route normalizes before hashing.
  code: z.string().min(SUPPORT_CODE_LENGTH).max(15),
  hostname: z.string().min(1).max(255),
  osType: z.enum(['windows', 'macos', 'linux']),
});

export type CreateSupportSessionInput = z.infer<typeof createSupportSessionSchema>;
export type RedeemSupportSessionInput = z.infer<typeof redeemSupportSessionSchema>;
