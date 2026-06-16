/**
 * Hardware-backed signing abstraction for approver proof-of-presence.
 *
 * Consumer code (the approval signing flow, the approver-setup screen) depends
 * ONLY on the {@link HardwareSigner} interface — never on the concrete native
 * library. This keeps the JS test runtime (Vitest / Expo Go) free of the native
 * module: it isn't installed there, and importing it at module top-level would
 * crash. Instead we optional-require `react-native-biometrics` at runtime and
 * fall back to {@link nullSigner} when it's absent.
 *
 * On a real dev-client build the adapter wraps the platform Secure Enclave
 * (iOS) / StrongBox-or-TEE (Android) keystore: keys are non-exportable,
 * device-bound, and every `sign()` is biometric-gated by the OS.
 */

export interface HardwareSigner {
  /** Whether a hardware keystore + enrolled biometrics are available. */
  isAvailable(): Promise<boolean>;
  /** Generate a device-bound, non-exportable key pair. Returns the SPKI public key (base64). */
  createKeys(): Promise<{ publicKey: string }>;
  /**
   * Produce an RSA-SHA256 signature over `payload`, gated by a biometric prompt
   * (the `reason` is shown to the user). Returns the signature as base64.
   * Rejects if the user cancels the biometric prompt or no key exists.
   */
  sign(payload: string, reason: string): Promise<{ signature: string }>;
  /** Remove the device-bound key. Returns true if a key was deleted. */
  deleteKeys(): Promise<boolean>;
}

/**
 * No-op signer used when the native module is unavailable (Expo Go, Vitest, a
 * device without biometric hardware). Reports unavailable and refuses to mint
 * keys/signatures so callers transparently fall back to the device-less (L1)
 * approval path instead of crashing.
 */
export const nullSigner: HardwareSigner = {
  async isAvailable() {
    return false;
  },
  async createKeys(): Promise<{ publicKey: string }> {
    throw new Error('Hardware signer unavailable: no biometric keystore on this build');
  },
  async sign(): Promise<{ signature: string }> {
    throw new Error('Hardware signer unavailable: no biometric keystore on this build');
  },
  async deleteKeys() {
    return false;
  },
};

// Minimal shape of the classic `react-native-biometrics` default export. We
// declare only the members we use so the adapter type-checks without the
// package's type declarations being present in this workspace.
interface RNBiometricsInstance {
  isSensorAvailable(): Promise<{ available: boolean; biometryType?: string; error?: string }>;
  createKeys(): Promise<{ publicKey: string }>;
  biometricKeysExist(): Promise<{ keysExist: boolean }>;
  createSignature(opts: {
    promptMessage: string;
    payload: string;
    cancelButtonText?: string;
  }): Promise<{ success: boolean; signature?: string; error?: string }>;
  deleteKeys(): Promise<{ keysDeleted: boolean }>;
}

type RNBiometricsCtor = new (opts?: { allowDeviceCredentials?: boolean }) => RNBiometricsInstance;

/**
 * Optional-require the native module. Never a top-level static import: the
 * package is absent in Expo Go / Vitest / CI, and a static import would throw
 * on load. Returns null when it can't be resolved or instantiated.
 */
function loadNativeBiometrics(): RNBiometricsInstance | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const mod = require('react-native-biometrics') as
      | { default?: RNBiometricsCtor }
      | RNBiometricsCtor
      | undefined;
    if (!mod) {
      return null;
    }
    const Ctor = (typeof mod === 'function' ? mod : mod.default) as RNBiometricsCtor | undefined;
    if (typeof Ctor !== 'function') {
      return null;
    }
    return new Ctor({ allowDeviceCredentials: false });
  } catch {
    // Module not installed (Expo Go / tests / CI) or failed to init.
    return null;
  }
}

/**
 * Adapter wrapping the classic `react-native-biometrics` class-based API into
 * the {@link HardwareSigner} interface. NOT unit-tested — exercised only on a
 * physical dev-client build (Secure Enclave / StrongBox), flagged for on-device
 * verification.
 */
export function reactNativeBiometricsSigner(rnBiometrics: RNBiometricsInstance): HardwareSigner {
  return {
    async isAvailable() {
      try {
        const { available } = await rnBiometrics.isSensorAvailable();
        return available;
      } catch {
        return false;
      }
    },
    async createKeys() {
      const { publicKey } = await rnBiometrics.createKeys();
      return { publicKey };
    },
    async sign(payload: string, reason: string) {
      const result = await rnBiometrics.createSignature({
        promptMessage: reason,
        payload,
        cancelButtonText: 'Cancel',
      });
      if (!result.success || !result.signature) {
        // User cancelled the biometric prompt or signing failed — never return
        // a bogus signature.
        throw new Error(result.error || 'Biometric signature was cancelled');
      }
      return { signature: result.signature };
    },
    async deleteKeys() {
      const { keysDeleted } = await rnBiometrics.deleteKeys();
      return keysDeleted;
    },
  };
}

let cached: HardwareSigner | null = null;

/**
 * Returns the active hardware signer for this runtime, memoized. The native
 * adapter when `react-native-biometrics` is installed (dev-client build),
 * otherwise {@link nullSigner}. Safe to call from JS tests — it never imports
 * the native module statically and always resolves to `nullSigner` there.
 */
export function getHardwareSigner(): HardwareSigner {
  if (cached) {
    return cached;
  }
  const native = loadNativeBiometrics();
  cached = native ? reactNativeBiometricsSigner(native) : nullSigner;
  return cached;
}
