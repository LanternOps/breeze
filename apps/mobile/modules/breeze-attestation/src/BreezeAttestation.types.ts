/**
 * The TS surface of the `breeze-attestation` local Expo module (#1374, feature
 * #4707).
 *
 * Both platforms are declared here even though only the iOS (Swift) half ships
 * in W05: W06 adds `android/` and needs nothing from this file or from
 * `expo-module.config.json` to change, so the two waves cannot collide over a
 * shared type or a rename.
 */

/** A freshly-minted, non-exportable hardware key ready to register. */
export interface AttestedKey {
  /** SPKI DER of the public key, base64 — sent verbatim as `publicKey`. */
  publicKeySpkiB64: string;
  /**
   * Always ES256. The Secure Enclave (and the Android P-256 KeyStore path)
   * holds only P-256 keys; the server rejects an ES256 claim over any other
   * curve, so this is a proven property rather than a client assertion.
   */
  alg: 'ES256';
}

/** Apple App Attest evidence, matching the server's `mobileAttestationSchema`. */
export interface IosAttestation {
  platform: 'ios';
  /** base64 CBOR attestation object from `DCAppAttestService.attestKey`. */
  attestationObject: string;
  /** base64 App Attest key id. */
  keyId: string;
}

/** Android Key Attestation evidence (produced by W06's Kotlin module). */
export interface AndroidAttestation {
  platform: 'android';
  /** base64 DER certificates, leaf first, from `KeyStore.getCertificateChain`. */
  certificateChain: string[];
  /** Play Integrity token; absent for non-Play enterprise distribution. */
  playIntegrityToken?: string;
}

export type PlatformAttestation = IosAttestation | AndroidAttestation;

/** Options for {@link createAttestedKeyNative}. */
export interface CreateAttestedKeyOptions {
  /**
   * base64 challenge to bind INTO the key at generation time.
   *
   * iOS ignores this: App Attest binds the transcript later, via
   * `attestKey(_:clientDataHash:)`, so the key can be minted before the
   * transcript exists. Android (W06) cannot — `setAttestationChallenge` is a
   * key-generation parameter, so the Android branch must pass it here.
   *
   * The parameter lives on both platforms so the shared client flow in
   * `attestingSigner.ts` has one call shape.
   */
  attestationChallengeB64?: string;
}

/**
 * The native module's method surface. `signWithAttestedKey` has a contract that
 * is easy to get wrong, so it is spelled out on the method itself.
 */
export interface BreezeAttestationNativeModule {
  /** True when the OS supports attestation AND a hardware key can be minted. */
  isAttestationAvailable(): Promise<boolean>;
  /** Mint the hardware key, replacing any previous one. */
  createAttestedKey(options?: CreateAttestedKeyOptions): Promise<AttestedKey>;
  /**
   * Attest the app instance, binding `transcriptB64` as the platform challenge.
   * The base64 is DECODED — the platform commits to the 32 raw digest bytes.
   */
  attestApp(transcriptB64: string): Promise<PlatformAttestation>;
  /**
   * Biometric-gated ECDSA-SHA256 by the attested key. Rejects on cancel.
   *
   * CONTRACT: signs the UTF-8 BYTES OF THE STRING AS GIVEN — it does NOT
   * base64-decode `payloadB64` first. The server verifies the registration
   * proof-of-possession over `transcript.toString('base64')` as UTF-8
   * (`verifyMobileSignature` in `apps/api/src/services/mobileHwKey.ts`), so
   * decoding here would produce a signature that never verifies.
   */
  signWithAttestedKey(payloadB64: string, reason: string): Promise<{ signature: string }>;
  /** Remove the hardware key. True when one was deleted. */
  deleteAttestedKey(): Promise<boolean>;
}
