/**
 * Hardware-ATTESTED approver signing (#1374, feature #4707 wave W05).
 *
 * The sibling {@link import('./hardwareSigner').HardwareSigner} wraps
 * `react-native-biometrics`, which mints a biometric-gated Keychain **RSA** key.
 * That key is not in the Secure Enclave and carries no platform attestation, so
 * the server records it as `unattested` and it can never reach L4. This module
 * is the attested path: a Secure Enclave P-256 key (iOS) or a StrongBox/TEE
 * P-256 key (Android, W06), plus a platform attestation bound to a server-chosen
 * registration transcript.
 *
 * Same structural pattern as `hardwareSigner.ts`, for the same reason: the local
 * Expo module is absent in Expo Go, Vitest and CI, and `modules/breeze-attestation`
 * throws at import time when the native module is not linked. So it is
 * optional-required at runtime and falls back to {@link nullAttestingSigner}.
 *
 * The null object REFUSES rather than degrading. A signer that returned a
 * plausible key or signature would let a device register as attested while
 * holding nothing — the fail-closed rule in `approverDevice.ts` depends on these
 * rejections being real.
 */
/** Mirrors the native module's `AttestedKey`. */
export interface AttestedKey {
  publicKeySpkiB64: string;
  alg: 'ES256';
}

export interface IosAttestation {
  platform: 'ios';
  attestationObject: string;
  keyId: string;
}

export interface AndroidAttestation {
  platform: 'android';
  certificateChain: string[];
  playIntegrityToken?: string;
}

export type PlatformAttestation = IosAttestation | AndroidAttestation;

export interface AttestingSigner {
  /** Whether this build can mint an attested hardware key AND attest the app. */
  isAvailable(): Promise<boolean>;
  /**
   * Mint the hardware key.
   *
   * `attestationChallengeB64` is ignored on iOS (App Attest binds the transcript
   * later, at {@link AttestingSigner.attestApp}) and REQUIRED on Android, where
   * `setAttestationChallenge` is a key-generation parameter. Passing it on both
   * keeps one call shape in the registration flow.
   */
  createAttestedKey(opts?: { attestationChallengeB64?: string }): Promise<AttestedKey>;
  /** Attest the app instance, binding the (base64) registration transcript. */
  attestApp(transcriptB64: string): Promise<PlatformAttestation>;
  /**
   * Biometric-gated ECDSA-SHA256 proof of possession.
   *
   * Signs the UTF-8 bytes of `transcriptB64` AS GIVEN — it does not decode the
   * base64. The server verifies the registration PoP over
   * `transcript.toString('base64')` as UTF-8 (`verifyMobileSignature` in
   * `apps/api/src/services/mobileHwKey.ts`); decoding here would produce a
   * signature that never verifies, on every device at once.
   */
  signTranscript(transcriptB64: string, reason: string): Promise<{ signature: string }>;
  /** Remove the hardware key. True when one was deleted. */
  deleteAttestedKey(): Promise<boolean>;
}

const UNAVAILABLE = 'Hardware attestation unavailable: no attested keystore on this build';

/**
 * Null object used when the native module is unavailable (Expo Go, Vitest, a
 * device with no Secure Enclave / StrongBox, or an Android build before W06
 * ships the Kotlin half). Reports unavailable and refuses to produce anything —
 * callers fall back to the legacy unattested registration path, which is honest
 * about registering at L2/L3.
 */
export const nullAttestingSigner: AttestingSigner = {
  async isAvailable() {
    return false;
  },
  async createAttestedKey(): Promise<AttestedKey> {
    throw new Error(UNAVAILABLE);
  },
  async attestApp(): Promise<PlatformAttestation> {
    throw new Error(UNAVAILABLE);
  },
  async signTranscript(): Promise<{ signature: string }> {
    throw new Error(UNAVAILABLE);
  },
  async deleteAttestedKey() {
    return false;
  },
};

/** The subset of the local Expo module this adapter uses. */
interface NativeAttestationModule {
  isAttestationAvailable(): Promise<boolean>;
  createAttestedKey(opts?: { attestationChallengeB64?: string }): Promise<AttestedKey>;
  attestApp(transcriptB64: string): Promise<PlatformAttestation>;
  signWithAttestedKey(payloadB64: string, reason: string): Promise<{ signature: string }>;
  deleteAttestedKey(): Promise<boolean>;
}

/**
 * Optional-require the local module. Never a top-level static import: its entry
 * point calls `requireNativeModule`, which throws when the module is not linked,
 * so a static import would take the whole app down in Expo Go and every test.
 */
export function loadNativeAttestation(): NativeAttestationModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const mod = require('../../modules/breeze-attestation') as
      | Partial<NativeAttestationModule>
      | undefined;
    if (
      !mod ||
      typeof mod.isAttestationAvailable !== 'function' ||
      typeof mod.createAttestedKey !== 'function' ||
      typeof mod.attestApp !== 'function' ||
      typeof mod.signWithAttestedKey !== 'function' ||
      typeof mod.deleteAttestedKey !== 'function'
    ) {
      // A partially-shaped module is treated as absent rather than adapted:
      // discovering a missing method halfway through registration would strand
      // a consumed server challenge.
      return null;
    }
    return mod as NativeAttestationModule;
  } catch {
    return null;
  }
}

/**
 * Adapter over the native module. NOT unit-tested — the Swift/Kotlin behind it
 * only exists on a physical dev-client build, the same precedent as
 * `reactNativeBiometricsSigner`. What IS tested is the fallback contract above.
 */
export function nativeAttestingSigner(native: NativeAttestationModule): AttestingSigner {
  return {
    async isAvailable() {
      try {
        return await native.isAttestationAvailable();
      } catch {
        // An availability probe that throws is a "no", not a crash — but it is
        // never a "yes", so a device that supports attestation and errors here
        // takes the legacy path rather than a broken attested one.
        return false;
      }
    },
    createAttestedKey(opts) {
      return native.createAttestedKey(opts);
    },
    attestApp(transcriptB64) {
      return native.attestApp(transcriptB64);
    },
    signTranscript(transcriptB64, reason) {
      return native.signWithAttestedKey(transcriptB64, reason);
    },
    deleteAttestedKey() {
      return native.deleteAttestedKey();
    },
  };
}

let cached: AttestingSigner | null = null;

/**
 * The active attesting signer for this runtime, memoized. Resolves to
 * {@link nullAttestingSigner} wherever the native module is absent — including
 * Android until W06 lands its Kotlin half, which is why this is one module for
 * both platforms rather than an iOS-only import.
 */
export function getAttestingSigner(): AttestingSigner {
  if (cached) {
    return cached;
  }
  const native = loadNativeAttestation();
  cached = native ? nativeAttestingSigner(native) : nullAttestingSigner;
  return cached;
}

/**
 * The `platform` field for `POST /authenticator/devices/mobile/challenge`.
 *
 * The server binds the attempt to this value and refuses an attestation from
 * the other platform, so it must describe the RUNTIME, not the build target.
 * Anything that is neither iOS nor Android has no attested path at all — the
 * null signer already reports unavailable there, so this is only ever read on a
 * platform that has one.
 */
export function attestationPlatform(): 'ios' | 'android' | null {
  // Optional-require for the same reason as the native module: `react-native`
  // is Flow-typed source that the Vitest node runtime cannot parse, and
  // `apps/mobile/vitest.config.ts` exists precisely to keep it out of the
  // runner. A static import here would take every suite that transitively
  // reaches this file down at import time.
  let os: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const rn = require('react-native') as { Platform?: { OS?: string } } | undefined;
    os = rn?.Platform?.OS;
  } catch {
    os = undefined;
  }
  if (os === 'ios') return 'ios';
  if (os === 'android') return 'android';
  return null;
}
