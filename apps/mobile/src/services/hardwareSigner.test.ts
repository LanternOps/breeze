// Tests for the HardwareSigner interface contract. We never test the native
// `react-native-biometrics` module itself (it's not installed in this JS test
// runtime and must NEVER be required at module top-level) — only that:
//   1. The interface round-trips with a fake implementation.
//   2. `getHardwareSigner()` falls back to the `nullSigner` when the native
//      module is absent (Expo Go / Vitest / CI), so the consumer code never
//      crashes and `isAvailable()` reports false.
//   3. Consumer code can depend on the `HardwareSigner` interface, not the
//      concrete library.
//
// The concrete `reactNativeBiometricsSigner` adapter is the one piece NOT
// unit-tested here — it's flagged for on-device verification (Secure Enclave /
// StrongBox), since it requires real biometric hardware.

import { describe, expect, it } from 'vitest';

import {
  getHardwareSigner,
  nullSigner,
  type HardwareSigner,
} from './hardwareSigner';

// A fake in-memory signer used to prove the interface contract and to stand in
// for the native adapter in consumer tests (Task 8).
function makeFakeSigner(): HardwareSigner & { _keys: { publicKey: string } | null } {
  const state: { _keys: { publicKey: string } | null } = { _keys: null };
  return {
    _keys: state._keys,
    async isAvailable() {
      return true;
    },
    async createKeys() {
      const keys = { publicKey: 'FAKE_SPKI_BASE64' };
      state._keys = keys;
      return keys;
    },
    async sign(payload: string, _reason: string) {
      if (!state._keys) {
        throw new Error('no keys');
      }
      return { signature: `sig(${payload})` };
    },
    async deleteKeys() {
      state._keys = null;
      return true;
    },
  };
}

describe('HardwareSigner interface', () => {
  it('a fake signer round-trips create → sign → delete', async () => {
    const signer = makeFakeSigner();

    expect(await signer.isAvailable()).toBe(true);

    const { publicKey } = await signer.createKeys();
    expect(publicKey).toBe('FAKE_SPKI_BASE64');

    const { signature } = await signer.sign('nonce-123', 'Approve request');
    expect(signature).toBe('sig(nonce-123)');

    expect(await signer.deleteKeys()).toBe(true);
  });

  it('the fake signer satisfies the HardwareSigner type (consumer depends on the interface, not the lib)', async () => {
    // If this assigns without a TS error, the interface shape is correct.
    const signer: HardwareSigner = makeFakeSigner();
    expect(typeof signer.isAvailable).toBe('function');
    expect(typeof signer.createKeys).toBe('function');
    expect(typeof signer.sign).toBe('function');
    expect(typeof signer.deleteKeys).toBe('function');
  });
});

describe('nullSigner', () => {
  it('reports not available', async () => {
    expect(await nullSigner.isAvailable()).toBe(false);
  });

  it('throws on createKeys / sign (no hardware backing)', async () => {
    await expect(nullSigner.createKeys()).rejects.toThrow();
    await expect(nullSigner.sign('nonce', 'reason')).rejects.toThrow();
  });

  it('deleteKeys is a safe no-op returning false', async () => {
    expect(await nullSigner.deleteKeys()).toBe(false);
  });
});

describe('getHardwareSigner', () => {
  it('returns the nullSigner when react-native-biometrics is absent (test/Expo Go)', async () => {
    // The native module is NOT installed in this JS test runtime; the factory
    // must optional-require it and fall back to nullSigner.
    const signer = getHardwareSigner();
    expect(await signer.isAvailable()).toBe(false);
    expect(signer).toBe(nullSigner);
  });

  it('returns a stable signer (idempotent factory)', () => {
    expect(getHardwareSigner()).toBe(getHardwareSigner());
  });
});
