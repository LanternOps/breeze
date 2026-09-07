/**
 * `breeze-attestation` — hardware-attested approver keys (#1374, feature #4707).
 *
 * This entry point uses `requireNativeModule`, which THROWS when the native
 * module is not linked (Expo Go, Vitest, a web build). That is deliberate and
 * is why nothing in `src/services/` imports this file statically: the client
 * wrapper `src/services/attestingSigner.ts` optional-requires it and degrades
 * to a null object, exactly like `hardwareSigner.ts` does for
 * `react-native-biometrics`.
 */
import { requireNativeModule } from 'expo-modules-core';

import type {
  AttestedKey,
  BreezeAttestationNativeModule,
  CreateAttestedKeyOptions,
  PlatformAttestation,
} from './BreezeAttestation.types';

export type {
  AndroidAttestation,
  AttestedKey,
  BreezeAttestationNativeModule,
  CreateAttestedKeyOptions,
  IosAttestation,
  PlatformAttestation,
} from './BreezeAttestation.types';

const BreezeAttestation = requireNativeModule<BreezeAttestationNativeModule>('BreezeAttestation');

/** True when the OS supports attestation AND a hardware key can be minted. */
export function isAttestationAvailable(): Promise<boolean> {
  return BreezeAttestation.isAttestationAvailable();
}

/** Mint a hardware-backed P-256 key with a biometry-current-set ACL. */
export function createAttestedKey(options?: CreateAttestedKeyOptions): Promise<AttestedKey> {
  return BreezeAttestation.createAttestedKey(options);
}

/** Attest the app instance, binding `transcriptB64` (decoded) as the challenge. */
export function attestApp(transcriptB64: string): Promise<PlatformAttestation> {
  return BreezeAttestation.attestApp(transcriptB64);
}

/**
 * Biometric-gated ECDSA-SHA256 over the UTF-8 bytes of `payloadB64` AS GIVEN —
 * see the contract note on {@link BreezeAttestationNativeModule.signWithAttestedKey}.
 */
export function signWithAttestedKey(
  payloadB64: string,
  reason: string,
): Promise<{ signature: string }> {
  return BreezeAttestation.signWithAttestedKey(payloadB64, reason);
}

/** Remove the hardware key. True when one was deleted. */
export function deleteAttestedKey(): Promise<boolean> {
  return BreezeAttestation.deleteAttestedKey();
}
