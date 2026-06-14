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
