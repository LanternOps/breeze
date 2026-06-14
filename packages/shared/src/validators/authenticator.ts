import { z } from 'zod';

/**
 * The browser's WebAuthn assertion response (from @simplewebauthn/browser
 * startAuthentication) that a technician presents when approving. Shapes match
 * @simplewebauthn/server's AuthenticationResponseJSON. base64url strings.
 */
export const assertionProofSchema = z.object({
  credentialId: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  signature: z.string().min(1),
  userHandle: z.string().nullable().optional(),
});

export type AssertionProof = z.infer<typeof assertionProofSchema>;

/**
 * Approver PIN — a 4-6 digit numeric secret used as the L3 step-up factor.
 * Stored argon2-hashed server-side; this only constrains the wire format.
 */
export const approverPinSchema = z.string().regex(/^\d{4,6}$/);

export type ApproverPin = z.infer<typeof approverPinSchema>;
