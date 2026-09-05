import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityLevel } from '@peculiar/asn1-android';
import type { MobileAttestation } from '@breeze/shared';
import {
  __resetPinnedRootsForTests,
  __setPinnedRootsForTests,
} from './androidKeyAttestation';
import { mintAndroidKeyAttestationFixture } from './__fixtures__/androidKeyAttestationFixture';

/**
 * End-to-end Android attestation: a REAL fixture chain through the REAL
 * verifier through the REAL `verifyPlatformAttestation` branch (#1374 W04).
 *
 * `androidPlatformAttestation.test.ts` mocks the verifier to exercise the
 * wiring, and `androidKeyAttestation.test.ts` exercises the verifier in
 * isolation — but between them sits the check that actually stops an attacker
 * from pairing a genuine hardware attestation with a software key of their own:
 * the canonical-SPKI comparison of the attested leaf against the key being
 * registered. Both isolated suites can be green while that comparison compares
 * two differently-encoded byte strings and never matches (or, worse, matches
 * things it should not), because each side of it is produced by a different
 * library — `@peculiar/x509` via WebCrypto on one side, node's
 * `crypto.createPublicKey` on the other.
 *
 * Only Play Integrity is mocked here, because it is the one leg that would need
 * the network.
 */

vi.mock('./playIntegrity', () => ({
  verifyPlayIntegrityToken: vi.fn(async () => null),
}));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { verifyPlatformAttestation } from '../authenticatorAttestation';
import { captureException } from '../sentry';

const captureExceptionMock = vi.mocked(captureException);

afterEach(() => {
  __resetPinnedRootsForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Android attestation end to end (#1374 W04)', () => {
  it('produces a trusted basis from a real chain bound to the registered key', async () => {
    const fixture = await mintAndroidKeyAttestationFixture({
      keyMintSecurityLevel: SecurityLevel.strongBox,
    });
    __setPinnedRootsForTests([fixture.rootPem]);

    const result = await verifyPlatformAttestation({
      attestation: {
        platform: 'android',
        certificateChain: fixture.certificateChainDerB64,
      } as MobileAttestation,
      // The fixture's challenge IS the transcript the client committed to.
      transcript: fixture.challenge,
      publicKeySpkiB64: fixture.attestedPublicKeyB64,
    });

    expect(result.basis).toBe('android_strongbox_key_attestation');
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(result.keyId).toBe(fixture.leafSerial);
    expect(result.evidence).toMatchObject({
      keyMintSecurityLevel: 'StrongBox',
      verifiedBootState: 'Verified',
      deviceLocked: true,
      packageName: 'com.breeze.rmm',
    });
    // Not a server defect — nothing should have been reported.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('refuses a genuine chain paired with a DIFFERENT registered key', async () => {
    // The attack the SPKI comparison exists for: a real, fully valid hardware
    // attestation presented alongside a software key the attacker holds.
    const fixture = await mintAndroidKeyAttestationFixture();
    const attackerKey = await mintAndroidKeyAttestationFixture();
    __setPinnedRootsForTests([fixture.rootPem]);

    const result = await verifyPlatformAttestation({
      attestation: {
        platform: 'android',
        certificateChain: fixture.certificateChainDerB64,
      } as MobileAttestation,
      transcript: fixture.challenge,
      publicKeySpkiB64: attackerKey.attestedPublicKeyB64,
    });

    expect(result.basis).toBe('unattested');
    expect(result.verifiedAt).toBeNull();
    expect(result.evidence).toMatchObject({
      rejected: expect.stringMatching(/does not cover the registered key/i),
    });
  });

  it('refuses a chain whose challenge is not the transcript', async () => {
    const fixture = await mintAndroidKeyAttestationFixture();
    __setPinnedRootsForTests([fixture.rootPem]);

    const result = await verifyPlatformAttestation({
      attestation: {
        platform: 'android',
        certificateChain: fixture.certificateChainDerB64,
      } as MobileAttestation,
      transcript: Buffer.alloc(32, 7),
      publicKeySpkiB64: fixture.attestedPublicKeyB64,
    });

    expect(result.basis).toBe('unattested');
    expect(result.evidence).toMatchObject({
      rejected: expect.stringMatching(/challenge/i),
    });
  });

  it('refuses a Software-level key end to end', async () => {
    const fixture = await mintAndroidKeyAttestationFixture({
      keyMintSecurityLevel: SecurityLevel.software,
    });
    __setPinnedRootsForTests([fixture.rootPem]);

    const result = await verifyPlatformAttestation({
      attestation: {
        platform: 'android',
        certificateChain: fixture.certificateChainDerB64,
      } as MobileAttestation,
      transcript: fixture.challenge,
      publicKeySpkiB64: fixture.attestedPublicKeyB64,
    });

    expect(result.basis).toBe('unattested');
    expect(result.evidence).toMatchObject({
      rejected: expect.stringMatching(/security level/i),
    });
  });

  it('refuses an unparseable registered key without calling it a server defect', async () => {
    const fixture = await mintAndroidKeyAttestationFixture();
    __setPinnedRootsForTests([fixture.rootPem]);

    const result = await verifyPlatformAttestation({
      attestation: {
        platform: 'android',
        certificateChain: fixture.certificateChainDerB64,
      } as MobileAttestation,
      transcript: fixture.challenge,
      publicKeySpkiB64: 'not-a-key',
    });

    expect(result.basis).toBe('unattested');
    // Client-supplied and therefore attacker-provokable: quiet, not Sentry.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
