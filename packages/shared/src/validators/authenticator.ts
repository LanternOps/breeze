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
