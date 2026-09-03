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
 * `type`. Higher assurance (L3 recency, L4 fresh re-auth) is derived from the
 * signature + account re-auth on the server, not from a separate PIN factor.
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
 * Mobile hardware-key registration body. A phone registers itself as an
 * approver device by POSTing its Secure-Enclave / Keystore SPKI public key —
 * no password step-up and no PIN. The key is stored pending and activates on
 * its first approval signature (deferred proof-of-possession). `.strict()` so a
 * stray `currentPassword` / `pin` field is rejected rather than silently kept.
 */
export const mobileHwKeyRegisterSchema = z
  .object({
    publicKey: z.string().min(1),
    label: z.string().min(1).max(255),
  })
  .strict();

export type MobileHwKeyRegister = z.infer<typeof mobileHwKeyRegisterSchema>;

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

/**
 * The platform attestation a phone presents at registration (#1374 W02).
 *
 * Structural validation only — this schema says "the client sent something
 * shaped like an iOS/Android attestation", never "the attestation is valid".
 * The cryptographic verification lives server-side in
 * `services/authenticatorAttestation.ts` (dispatching to the App Attest
 * verifier in W03 and the Key Attestation verifier in W04); until those land
 * every attestation resolves `unattested` and the registered key cannot reach
 * L4.
 *
 * `.strict()` on both branches: a field this server does not understand must be
 * a 400, never something silently dropped on the floor.
 */
export const mobileAttestationSchema = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('ios'),
      /** base64 CBOR attestation object from DCAppAttestService.attestKey. */
      attestationObject: z.string().min(1).max(16384),
      /** base64 App Attest keyId. */
      keyId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      platform: z.literal('android'),
      /** base64 DER certs, leaf first, from KeyStore.getCertificateChain. */
      certificateChain: z.array(z.string().min(1).max(16384)).min(2).max(8),
      /** Play Integrity token; optional for non-Play enterprise distribution. */
      playIntegrityToken: z.string().min(1).max(16384).optional(),
    })
    .strict(),
]);

export type MobileAttestation = z.infer<typeof mobileAttestationSchema>;

/**
 * Mobile attested-registration verify body (#1374 W02) — step 2 of the
 * challenge/verify protocol (`POST /authenticator/devices/mobile/challenge`
 * then `POST /authenticator/devices/mobile/verify`).
 *
 * `.strict()` throughout: the whole point of this wave is that the client no
 * longer gets to assert anything about platform-binding, so a stray
 * `isPlatformBound` must be a 400, never a silently-dropped field.
 *
 * `publicKeyAlg` is NOT a free client choice about how to verify an existing
 * key — it is part of the signed registration transcript and is stored on the
 * new row, so a mismatch between the declared algorithm and the presented key
 * makes the proof-of-possession fail rather than changing how the key is read.
 */
export const mobileAttestationVerifySchema = z
  .object({
    registerGrantId: z.string().min(1).max(128).optional(),
    attemptId: z.string().min(1).max(64),
    /** SPKI DER public key, base64. */
    publicKey: z.string().min(1).max(8192),
    publicKeyAlg: z.enum(['RS256', 'ES256']),
    label: z.string().trim().min(1).max(255),
    /**
     * Registration proof-of-possession: a biometric-gated signature by the new
     * approval key over `base64(registrationTranscript(...))`. Distinct from
     * `last_used_at`, which keeps meaning "used for a real approval".
     */
    popSignature: z.string().min(1).max(4096),
    attestation: mobileAttestationSchema,
  })
  .strict();

export type MobileAttestationVerify = z.infer<typeof mobileAttestationVerifySchema>;

/**
 * Mobile attested-registration challenge body (#1374 W02) — step 1 of 2. The
 * register grant is validated NON-consuming here and consumed at /verify, so a
 * client that fails attestation does not burn its single-use grant.
 */
export const mobileAttestationChallengeSchema = z
  .object({
    registerGrantId: z.string().min(1).max(128).optional(),
    platform: z.enum(['ios', 'android']),
  })
  .strict();

export type MobileAttestationChallenge = z.infer<typeof mobileAttestationChallengeSchema>;
