import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileAttestation } from '@breeze/shared';

/**
 * The Android branch of `verifyPlatformAttestation` (#1374 W04).
 *
 * Lives here rather than in `authenticatorAttestation.test.ts` because W03
 * (Apple) is editing that file's sibling branch in parallel; the verifier under
 * test is this directory's, so the co-location is honest either way.
 *
 * `verifyAndroidKeyAttestation` and `verifyPlayIntegrityToken` are mocked: both
 * are exhaustively tested against real crypto in their own suites, and what
 * this file has to prove is the WIRING — key binding, basis mapping, verdict
 * handling, and the never-throws contract the route depends on.
 */

const { androidMock, playIntegrityMock } = vi.hoisted(() => ({
  androidMock: { verifyAndroidKeyAttestation: vi.fn() },
  playIntegrityMock: { verifyPlayIntegrityToken: vi.fn() },
}));

vi.mock('./androidKeyAttestation', () => androidMock);
vi.mock('./playIntegrity', () => playIntegrityMock);
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { verifyPlatformAttestation } from '../authenticatorAttestation';

// A real P-256 key, so the SPKI canonicalization in the branch is exercised for
// real rather than against a string that happens to compare equal.
const registeredKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const REGISTERED_SPKI_DER = registeredKey.publicKey.export({ format: 'der', type: 'spki' });
const REGISTERED_SPKI_B64 = REGISTERED_SPKI_DER.toString('base64');

const otherKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const OTHER_SPKI_DER = otherKey.publicKey.export({ format: 'der', type: 'spki' });

const TRANSCRIPT = crypto.randomBytes(32);

function keyAttestationResult(overrides: Record<string, unknown> = {}) {
  return {
    keyMintSecurityLevel: 'TrustedEnvironment',
    attestationSecurityLevel: 'TrustedEnvironment',
    verifiedBootState: 'Verified',
    deviceLocked: true,
    attestedPublicKeyDer: REGISTERED_SPKI_DER,
    packageName: 'com.breeze.rmm',
    leafSerial: '0A1B2C3D',
    ...overrides,
  };
}

const androidAttestation = (extra: Record<string, unknown> = {}): MobileAttestation =>
  ({ platform: 'android', certificateChain: ['leaf', 'ca'], ...extra }) as MobileAttestation;

const run = (attestation: MobileAttestation = androidAttestation()) =>
  verifyPlatformAttestation({
    attestation,
    transcript: TRANSCRIPT,
    publicKeySpkiB64: REGISTERED_SPKI_B64,
  });

beforeEach(() => {
  vi.clearAllMocks();
  androidMock.verifyAndroidKeyAttestation.mockReturnValue(keyAttestationResult());
  playIntegrityMock.verifyPlayIntegrityToken.mockResolvedValue(null);
});

describe('verifyPlatformAttestation — Android branch (#1374 W04)', () => {
  it('sets android_tee_key_attestation for a TEE-backed key', async () => {
    const result = await run();

    expect(result.basis).toBe('android_tee_key_attestation');
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(result.keyId).toBe('0A1B2C3D');
    expect(result.evidence).toMatchObject({
      verifier: 'android_key_attestation',
      verifierVersion: 1,
      keyMintSecurityLevel: 'TrustedEnvironment',
      verifiedBootState: 'Verified',
      deviceLocked: true,
      packageName: 'com.breeze.rmm',
      playIntegrity: null,
    });
    expect(result.appIntegrityVerifiedAt).toBeNull();
  });

  it('sets android_strongbox_key_attestation for a StrongBox key', async () => {
    androidMock.verifyAndroidKeyAttestation.mockReturnValue(
      keyAttestationResult({ keyMintSecurityLevel: 'StrongBox' }),
    );
    expect((await run()).basis).toBe('android_strongbox_key_attestation');
  });

  it('binds the attestation to the registration transcript and our package', async () => {
    await run();
    expect(androidMock.verifyAndroidKeyAttestation).toHaveBeenCalledWith({
      certificateChainDerB64: ['leaf', 'ca'],
      expectedChallenge: TRANSCRIPT,
      expectedPackageName: 'com.breeze.rmm',
    });
  });

  it('refuses an attestation that covers a DIFFERENT key', async () => {
    androidMock.verifyAndroidKeyAttestation.mockReturnValue(
      keyAttestationResult({ attestedPublicKeyDer: OTHER_SPKI_DER }),
    );
    const result = await run();

    expect(result.basis).toBe('unattested');
    expect(result.verifiedAt).toBeNull();
    expect(result.evidence).toMatchObject({ rejected: expect.stringMatching(/registered key/i) });
  });

  it('accepts a re-encoded SPKI for the same key', async () => {
    // Same key, PEM-round-tripped so the base64 differs byte-for-byte. The
    // canonical-SPKI digest is what makes this equal, not string comparison.
    const reEncoded = crypto
      .createPublicKey({ key: REGISTERED_SPKI_DER, format: 'der', type: 'spki' })
      .export({ format: 'der', type: 'spki' });
    androidMock.verifyAndroidKeyAttestation.mockReturnValue(
      keyAttestationResult({ attestedPublicKeyDer: Buffer.from(reEncoded) }),
    );
    expect((await run()).basis).toBe('android_tee_key_attestation');
  });

  it('never throws when the chain fails — the route has no catch', async () => {
    androidMock.verifyAndroidKeyAttestation.mockImplementation(() => {
      throw new Error('attestation chain does not terminate in a pinned Google root');
    });
    const result = await run();

    expect(result.basis).toBe('unattested');
    expect(result.verifiedAt).toBeNull();
    expect(result.keyId).toBeNull();
    expect(result.appIntegrityVerifiedAt).toBeNull();
    expect(result.evidence).toMatchObject({ rejected: expect.stringMatching(/pinned Google/) });
  });

  describe('Play Integrity', () => {
    it('is not consulted when the client supplied no token', async () => {
      const result = await run();
      expect(playIntegrityMock.verifyPlayIntegrityToken).not.toHaveBeenCalled();
      expect(result.basis).toBe('android_tee_key_attestation');
      expect(result.appIntegrityVerifiedAt).toBeNull();
    });

    it('stamps appIntegrityVerifiedAt when a verdict passes', async () => {
      const verdict = {
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        deviceRecognitionVerdicts: ['MEETS_DEVICE_INTEGRITY'],
        packageName: 'com.breeze.rmm',
      };
      playIntegrityMock.verifyPlayIntegrityToken.mockResolvedValue(verdict);

      const result = await run(androidAttestation({ playIntegrityToken: 'pi-token' }));

      expect(result.appIntegrityVerifiedAt).toBeInstanceOf(Date);
      expect(result.evidence).toMatchObject({ playIntegrity: verdict });
      // Still the Key Attestation basis — Play Integrity never upgrades it.
      expect(result.basis).toBe('android_tee_key_attestation');
    });

    it('binds the verdict to the registration transcript', async () => {
      await run(androidAttestation({ playIntegrityToken: 'pi-token' }));
      expect(playIntegrityMock.verifyPlayIntegrityToken).toHaveBeenCalledWith('pi-token', {
        packageName: 'com.breeze.rmm',
        expectedRequestHash: TRANSCRIPT.toString('base64url'),
      });
    });

    it('keeps the Key Attestation basis when Play Integrity is unconfigured', async () => {
      playIntegrityMock.verifyPlayIntegrityToken.mockResolvedValue(null);
      const result = await run(androidAttestation({ playIntegrityToken: 'pi-token' }));

      expect(result.basis).toBe('android_tee_key_attestation');
      expect(result.appIntegrityVerifiedAt).toBeNull();
      expect(result.evidence).toMatchObject({ playIntegrity: null });
    });

    it('revokes the attested basis when a supplied verdict is disqualifying', async () => {
      playIntegrityMock.verifyPlayIntegrityToken.mockRejectedValue(
        new Error('Play Integrity device integrity verdict [empty] does not include MEETS_DEVICE_INTEGRITY'),
      );
      const result = await run(androidAttestation({ playIntegrityToken: 'pi-token' }));

      // StrongBox or not, a device that fails Play's integrity check is not a
      // place a critical-tier approver key gets to live.
      expect(result.basis).toBe('unattested');
      expect(result.verifiedAt).toBeNull();
      expect(result.evidence).toMatchObject({
        rejected: expect.stringMatching(/device integrity/i),
      });
    });
  });

  it('leaves iOS alone — W03 owns that branch', async () => {
    const result = await verifyPlatformAttestation({
      attestation: { platform: 'ios', attestationObject: 'cbor', keyId: 'kid' },
      transcript: TRANSCRIPT,
      publicKeySpkiB64: REGISTERED_SPKI_B64,
    });
    expect(androidMock.verifyAndroidKeyAttestation).not.toHaveBeenCalled();
    expect(result.basis).toBe('unattested');
  });
});
