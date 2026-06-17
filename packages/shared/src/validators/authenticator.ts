import { z } from 'zod';

// WebAuthn assertion fields shared by the back-compat standalone schema and the
// discriminated-union variant. base64url strings; shapes match
// @simplewebauthn/server's AuthenticationResponseJSON.
const webauthnProofFields = {
  credentialId: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  signature: z.string().min(1),
  userHandle: z.string().nullable().optional(),
} as const;

/**
 * The browser's WebAuthn assertion response (from @simplewebauthn/browser
 * startAuthentication) that a technician presents when approving.
 *
 * `type` defaults to `'webauthn_platform'` so pre-Phase-3 callers that POST the
 * proof without a discriminant still parse unchanged (back-compat); Phase 3
 * adds the discriminator for symmetry with the mobile variant.
 */
export const assertionProofSchema = z.object({
  type: z.literal('webauthn_platform').default('webauthn_platform'),
  ...webauthnProofFields,
});

export type AssertionProof = z.infer<typeof assertionProofSchema>;

/**
 * The mobile hardware-key (Secure-Enclave / Keystore) assertion proof. Not
 * WebAuthn — `signature` is a raw RSA-SHA256 (base64) signature over the
 * server-issued `nonce`, verified server-side against the device's stored SPKI
 * public key. `credentialId` carries the approver device id to verify against.
 */
export const mobileHwKeyProofSchema = z.object({
  type: z.literal('mobile_hw_key'),
  credentialId: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

export type MobileHwKeyProof = z.infer<typeof mobileHwKeyProofSchema>;

/**
 * The proof a technician presents when approving — EITHER the WebAuthn platform
 * assertion (L2) OR the mobile hardware-key assertion (L2), discriminated on
 * `type`. An optional approver PIN (L3) rides alongside this proof in the
 * request body, threaded separately (see `approverPinSchema`).
 */
export const approvalProofSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webauthn_platform'),
    ...webauthnProofFields,
  }),
  mobileHwKeyProofSchema,
]);

export type ApprovalProof = z.infer<typeof approvalProofSchema>;

/**
 * Approver PIN — a 4-6 digit numeric secret used as the L3 step-up factor.
 * Stored argon2-hashed server-side; this only constrains the wire format.
 */
export const approverPinSchema = z.string().regex(/^\d{4,6}$/);

export type ApproverPin = z.infer<typeof approverPinSchema>;

/**
 * Partner (MSP) approval-security policy (Phase 4). `floorOverrides` may only
 * RAISE a tier's required assurance level above the Breeze default — the
 * raise-only invariant is re-validated server-side (`validateRaiseOnly`); this
 * schema only constrains the wire shape (each level 1-4). `enforceFrom` is the
 * grace-window cutoff (null = enforce immediately when `requireEnrollment`).
 */
export const authenticatorPolicySchema = z.object({
  // Literal levels (not z.number().min/max) so the inferred type is
  // Partial<Record<RiskTier, 1|2|3|4>> = AssuranceFloorOverrides — the
  // raise-only invariant's value type is compile-checked, not runtime-only,
  // and downstream callers need no `as AssuranceFloorOverrides` cast.
  floorOverrides: z
    // v4: z.record(enum, …) is exhaustive (all keys required at runtime); use
    // z.partialRecord to keep the v3 Partial<Record<RiskTier, 1|2|3|4>> shape —
    // an org may raise only some tiers, and the default is {} (no overrides).
    .partialRecord(
      z.enum(['low', 'medium', 'high', 'critical']),
      z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    )
    .default({}),
  requireEnrollment: z.boolean(),
  enforceFrom: z.string().datetime().nullable(),
});

export type AuthenticatorPolicyInput = z.infer<typeof authenticatorPolicySchema>;
