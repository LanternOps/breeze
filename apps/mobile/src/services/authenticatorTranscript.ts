/**
 * The client half of the attested-registration transcript (#1374, feature
 * #4707 wave W05).
 *
 * The server derives the same bytes in
 * `apps/api/src/services/authenticatorAttestation.ts` (`registrationTranscript`)
 * from the attempt it minted. The phone must reproduce them EXACTLY, because
 * the digest is bound three ways at once:
 *
 *   - Apple App Attest `clientDataHash` (the raw 32 bytes),
 *   - Android KeyStore `setAttestationChallenge` (the raw 32 bytes, W06),
 *   - the registration proof-of-possession signature by the new approval key.
 *
 * A drift of one byte does not fail loudly on one device — it fails on every
 * device in the field at once, with a 401 the user cannot act on. So the
 * pre-image is pinned by `authenticatorTranscript.test.ts` against the SAME
 * vector the API pins, and the two tests are the contract.
 *
 * **Why this is duplicated rather than imported from `@breeze/shared`.**
 * `apps/mobile` deliberately has NO `@breeze/shared` dependency: Metro resolves
 * no workspace packages here, so a workspace import bundles as a hard runtime
 * failure rather than a build error. `ticketAttachmentContract.ts` and
 * `ticketPushPrefs.ts` mirror server constants for the same reason. The plan
 * for this wave proposed hoisting the formula into `packages/shared`; that is
 * not available to this app, and a shared module the phone cannot import would
 * be a worse illusion of a single source of truth than an honest mirror pinned
 * to a shared test vector.
 *
 * **Nothing native is imported at module scope.** The SHA-256 primitive is a
 * parameter with a lazily-resolved `expo-crypto` default, so the pre-image
 * logic — the only part that can actually drift — is testable in the Vitest
 * node runtime, which cannot load Expo native modules.
 */

/**
 * Domain tag hashed INTO the transcript, versioned so a future layout change is
 * a new tag rather than two app versions silently reinterpreting the same
 * bytes. Must equal `TRANSCRIPT_DOMAIN` in the API service.
 */
export const TRANSCRIPT_DOMAIN = 'breeze.authenticator.mobile-register.v1';

/** Signature algorithms the server's `publicKeyAlg` enum accepts. */
export type MobileKeyAlg = 'RS256' | 'ES256';

export interface RegistrationTranscriptInput {
  /** `attemptId` returned by POST /authenticator/devices/mobile/challenge. */
  attemptId: string;
  /** `challenge` returned by the same call (base64url, server-chosen). */
  challenge: string;
  /** The algorithm of the key being registered. Inside the signed bytes. */
  publicKeyAlg: MobileKeyAlg;
  /** The new key's SPKI DER, base64 — exactly the string sent as `publicKey`. */
  publicKeySpkiB64: string;
}

/** Hashes a UTF-8 string to standard base64. */
export type Sha256Base64 = (utf8: string) => Promise<string>;

/**
 * The exact string the server hashes. Newline-delimited; every field is
 * base64/base64url/uuid/enum, i.e. newline-free, so the separator is
 * unambiguous and 'ab'+'c' cannot collide with 'a'+'bc'.
 */
export function registrationTranscriptPreimage(input: RegistrationTranscriptInput): string {
  return [
    TRANSCRIPT_DOMAIN,
    input.attemptId,
    input.challenge,
    input.publicKeyAlg,
    input.publicKeySpkiB64,
  ].join('\n');
}

/**
 * Lazily resolve `expo-crypto`. Never a top-level static import: the package is
 * a native module, absent in Vitest and unloadable there. Throws rather than
 * degrading — a transcript we cannot compute must abort registration, not
 * produce something the server will reject in a way nobody can diagnose.
 */
async function expoSha256Base64(utf8: string): Promise<string> {
  let mod: {
    digestStringAsync?: (
      algorithm: string,
      data: string,
      options?: { encoding?: string },
    ) => Promise<string>;
    CryptoDigestAlgorithm?: Record<string, string>;
    CryptoEncoding?: Record<string, string>;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    mod = require('expo-crypto');
  } catch {
    throw new Error('Attestation transcript unavailable: expo-crypto is not installed');
  }
  if (typeof mod?.digestStringAsync !== 'function') {
    throw new Error('Attestation transcript unavailable: expo-crypto has no digestStringAsync');
  }
  return mod.digestStringAsync(mod.CryptoDigestAlgorithm?.SHA256 ?? 'SHA-256', utf8, {
    encoding: mod.CryptoEncoding?.BASE64 ?? 'base64',
  });
}

/**
 * `base64(SHA256(preimage))` — the wire form. The server sends this value's
 * decoded bytes to the attestation verifiers and verifies the PoP signature
 * over this base64 STRING (see `signWithAttestedKey`'s contract note).
 */
export async function registrationTranscriptB64(
  input: RegistrationTranscriptInput,
  sha256Base64: Sha256Base64 = expoSha256Base64,
): Promise<string> {
  return sha256Base64(registrationTranscriptPreimage(input));
}

/**
 * Domain tag for the Android KEY-GENERATION challenge. Deliberately distinct
 * from {@link TRANSCRIPT_DOMAIN} so the two digests can never be confused for
 * one another. Must equal `ANDROID_KEYGEN_CHALLENGE_DOMAIN` in the API service.
 */
export const ANDROID_KEYGEN_CHALLENGE_DOMAIN = 'breeze.authenticator.mobile-register.keygen.v1';

export interface AndroidKeyGenChallengeInput {
  /** `attemptId` returned by POST /authenticator/devices/mobile/challenge. */
  attemptId: string;
  /** `challenge` returned by the same call (base64url, server-chosen). */
  challenge: string;
  /** The algorithm of the key about to be generated. */
  publicKeyAlg: MobileKeyAlg;
}

/**
 * The pre-image of the Android KeyStore attestation challenge.
 *
 * WHY THIS IS NOT THE TRANSCRIPT. `setAttestationChallenge` is a
 * `KeyGenParameterSpec` property, so its value is fixed BEFORE the key exists —
 * and {@link registrationTranscriptPreimage} embeds the key's own SPKI, which
 * therefore cannot be known yet. Passing the transcript there is impossible,
 * and passing the raw server challenge would leave the algorithm unbound. So
 * the keygen challenge binds the attempt and the declared algorithm only; key
 * identity is bound separately, server-side, by `verifyAndroid` comparing the
 * attested leaf key against the registered SPKI.
 *
 * Pinned by `authenticatorTranscript.test.ts` against the same vector the API
 * pins in `authenticatorAttestation.test.ts` (`androidKeyGenChallenge`).
 */
export function androidKeyGenChallengePreimage(input: AndroidKeyGenChallengeInput): string {
  return [
    ANDROID_KEYGEN_CHALLENGE_DOMAIN,
    input.attemptId,
    input.challenge,
    input.publicKeyAlg,
  ].join('\n');
}

/**
 * `base64(SHA256(preimage))` — passed to the native module as
 * `attestationChallengeB64`, which DECODES it and hands the 32 raw bytes to
 * `setAttestationChallenge`. The leaf certificate then carries those bytes and
 * the server compares them with `androidKeyGenChallenge(...)`.
 */
export async function androidKeyGenChallengeB64(
  input: AndroidKeyGenChallengeInput,
  sha256Base64: Sha256Base64 = expoSha256Base64,
): Promise<string> {
  return sha256Base64(androidKeyGenChallengePreimage(input));
}
