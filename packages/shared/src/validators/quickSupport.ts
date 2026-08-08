import { z } from 'zod';

// Quick Support one-time codes — shared between the API (generation, hashing),
// the web landing page (client-side normalization before the check call) and
// the Go agent's filename parsing.
//
// GENERATION alphabet: digits 2-9 only.
//
// The code is read aloud down a phone line far more often than it is
// copy-pasted, and a mixed letters+digits code is the hard case for that: the
// caller has to disambiguate letter-vs-digit for every character ("B as in
// bravo", "is that a five or an S?"). Digits alone read like a phone number,
// which every end user already knows how to transcribe. Dropping 0 and 1 on
// top of that removes the last ambiguous pairs (O/0, I/l/1).
//
// MUST stay a subset of [a-z2-9]. Already-released agent binaries parse the
// code out of the download filename with `[a-z0-9]{9}` (case-insensitive; see
// agent/internal/agentapp/support.go) — anything outside that set would
// silently strand every client already in the wild. Digits 2-9 qualify.
//
// Entropy tradeoff: log2(8^9) ~= 27 bits (~134M codes), down from the ~44 bits
// of the previous 30-symbol letters+digits alphabet. That is deliberate and
// acceptable here because a code lives 15 minutes, only its SHA-256 hash is
// stored, and the public /support/check and /support/redeem endpoints are
// per-IP rate limited (30/min and 10/min) — so an online search is bounded at
// a few thousand guesses per code lifetime against a 134M space. Per-IP limits
// alone would not stop a DISTRIBUTED guesser, so the API additionally enforces
// a deployment-wide failed-lookup budget across check/download/redeem
// (apps/api/src/services/supportCodeMissBudget.ts) — that is the control that
// makes the 27 bits defensible, and it is a precondition of this alphabet, not
// an optional extra. It is also in line with the industry norm for spoken
// support codes (ScreenConnect uses 7 digits). If any of those four controls
// is ever relaxed, revisit the length before revisiting the alphabet.
export const SUPPORT_CODE_ALPHABET = '23456789';
export const SUPPORT_CODE_LENGTH = 9;

// VALIDATION is deliberately wider than generation: it must keep accepting the
// legacy letters+digits alphabet so codes minted before a rolling deploy still
// check and redeem against a newer API. Syntax validation is only a cheap
// pre-filter — whether a code is real is decided by the hash lookup — so being
// permissive here costs nothing and being strict would break in-flight codes.
export const SUPPORT_CODE_PATTERN = /^[A-Z2-9]{9}$/;

/**
 * Canonicalize user-entered input ("234-567 892", "234 567 892") to the stored
 * form ("234567892"), or null when it could never be a valid code.
 *
 * Returning null rather than throwing lets callers treat malformed input as a
 * miss without a DB round-trip.
 */
export function normalizeSupportCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '');
  return SUPPORT_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Display form: 234567892 -> 234-567-892. */
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
