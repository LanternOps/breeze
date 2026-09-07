import { describe, expect, it } from 'vitest';

import { getAttestingSigner, nullAttestingSigner } from './attestingSigner';

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
    await expect(getAttestingSigner().signTranscript('dHJhbnNjcmlwdA==', 'why')).rejects.toThrow(
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
