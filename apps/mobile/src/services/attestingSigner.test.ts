import { describe, expect, it } from 'vitest';

import {
  getAttestingSigner,
  nativeAttestingSigner,
  nullAttestingSigner,
} from './attestingSigner';

// Vitest runs `environment: 'node'` and only picks up `src/**/*.test.ts`, so the
// local Expo module under `modules/breeze-attestation` is never resolvable here
// — which is exactly the condition the fallback exists for. These tests assert
// the fallback REFUSES rather than fabricating, because a null object that
// returned a plausible-looking key or signature would register an unattested
// key while telling the user it was hardware-attested.
describe('getAttestingSigner (native module unresolvable)', () => {
  it('reports unavailable when the native module cannot be resolved', async () => {
    await expect(getAttestingSigner().isAvailable()).resolves.toBe(false);
  });

  it('refuses to mint a key when unavailable rather than returning a fake one', async () => {
    await expect(getAttestingSigner().createAttestedKey()).rejects.toThrow(/unavailable/i);
  });

  it('refuses to attest when unavailable', async () => {
    await expect(getAttestingSigner().attestApp('dHJhbnNjcmlwdA==')).rejects.toThrow(/unavailable/i);
  });

  it('refuses to sign when unavailable', async () => {
    await expect(getAttestingSigner().signPayload('dHJhbnNjcmlwdA==', 'why')).rejects.toThrow(
      /unavailable/i,
    );
  });

  it('reports no key deleted when unavailable', async () => {
    await expect(getAttestingSigner().deleteAttestedKey()).resolves.toBe(false);
  });

  it('memoizes — the same signer instance every call', () => {
    expect(getAttestingSigner()).toBe(getAttestingSigner());
  });

  it('resolves to the null object, not a partially-wired native adapter', () => {
    expect(getAttestingSigner()).toBe(nullAttestingSigner);
  });
});

describe('nullAttestingSigner', () => {
  it('names the missing capability in the error, not a generic failure', async () => {
    // The reason surfaces in `approverDevice`'s `failed` outcome, which is the
    // only thing a support engineer sees when a phone will not reach L4.
    await expect(nullAttestingSigner.createAttestedKey()).rejects.toThrow(/attestation/i);
  });
});

describe('nativeAttestingSigner', () => {
  /** A native module whose availability probe blows up. */
  function brokenProbe() {
    return nativeAttestingSigner({
      isAttestationAvailable: async () => {
        throw new Error('bridge exploded');
      },
      createAttestedKey: async () => ({ publicKeySpkiB64: 'x', alg: 'ES256' as const }),
      attestApp: async () => ({ platform: 'ios' as const, attestationObject: 'x', keyId: 'x' }),
      signWithAttestedKey: async () => ({ signature: 'x' }),
      deleteAttestedKey: async () => true,
    });
  }

  it('PROPAGATES a rejected availability probe instead of reporting unavailable', async () => {
    // "I don't know" must not be reported as "no". Swallowing this would send a
    // phone that may well have a Secure Enclave down the legacy unattested path
    // and register it at L2/L3 with nothing telling the user — the exact silent
    // downgrade this wave exists to prevent.
    await expect(brokenProbe().isAvailable()).rejects.toThrow(/bridge exploded/);
  });

  it('reports availability straight from the native probe', async () => {
    const signer = nativeAttestingSigner({
      isAttestationAvailable: async () => true,
      createAttestedKey: async () => ({ publicKeySpkiB64: 'x', alg: 'ES256' as const }),
      attestApp: async () => ({ platform: 'ios' as const, attestationObject: 'x', keyId: 'x' }),
      signWithAttestedKey: async () => ({ signature: 'x' }),
      deleteAttestedKey: async () => true,
    });
    await expect(signer.isAvailable()).resolves.toBe(true);
  });
});
