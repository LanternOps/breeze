import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureApproverDevice } from './approverDevice';
import type { HardwareSigner } from './hardwareSigner';

/**
 * The ANDROID branch of attested registration (#1374, feature #4707 wave W06).
 *
 * `attestingSigner.test.ts` covers the platform-agnostic fallback contract and
 * `approverDevice.test.ts` runs the flow with `Platform.OS === 'ios'`. Neither
 * exercises the Android shape, and the two differ in ways that would fail
 * silently in the field rather than loudly here:
 *
 *  - the challenge call must say `platform: 'android'`, or the server binds the
 *    attempt to iOS and refuses the attestation it later receives;
 *  - `attestationChallengeB64` must be the DERIVED keygen digest, because
 *    `setAttestationChallenge` is fixed before the key (and so the transcript's
 *    SPKI) exists;
 *  - the attestation forwarded to /verify carries `certificateChain`, with
 *    `playIntegrityToken` OPTIONAL — a device with no Play services omits it,
 *    and the client must forward that omission rather than inventing a token.
 *
 * The Kotlin behind all of this is not testable here (no hardware keystore, no
 * biometric, no Play services in the node runner). What is testable — and what
 * this file pins — is that the JS hands the native module and the server
 * exactly the values each one expects.
 */

vi.mock('./serverConfig', () => ({
  getServerUrl: vi.fn().mockResolvedValue('https://api.test'),
}));
vi.mock('./installationId', () => ({
  getOrCreateInstallationId: vi.fn().mockResolvedValue('device-uuid-1'),
}));

const secureStore = {
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
};
/**
 * `/devices/mobile/verify` 201s whether or not the attestation held; the
 * verdict is the `platformBoundBasis` on the returned row (W05 round 2).
 */
const ANDROID_ATTESTED_DEVICE = {
  device: { id: 'dev-and', platformBoundBasis: 'android_strongbox_key_attestation' },
};

vi.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => secureStore.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => secureStore.setItemAsync(...a),
  deleteItemAsync: (...a: unknown[]) => secureStore.deleteItemAsync(...a),
}));

vi.mock('./hardwareSigner', () => ({
  getHardwareSigner: () => ({
    isAvailable: async () => false,
    createKeys: async () => ({ publicKey: '' }),
    sign: async () => ({ signature: '' }),
    deleteKeys: async () => false,
  }),
}));

const attesting = {
  isAvailable: vi.fn(),
  createAttestedKey: vi.fn(),
  attestApp: vi.fn(),
  signPayload: vi.fn(),
  deleteAttestedKey: vi.fn(),
};
// `Platform.OS` is 'android' for every test in this file — that is the whole
// point of it being a separate file rather than a describe block.
vi.mock('./attestingSigner', () => ({
  getAttestingSigner: () => attesting,
  attestationPlatform: () => 'android',
}));

// Substitute ONLY the digest primitive; the real pre-image builders still run,
// so the values asserted below are the ones the server derives. A blanket
// module mock would make every assertion here vacuous.
vi.mock('./authenticatorTranscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./authenticatorTranscript')>();
  const nodeSha = async (utf8: string) => createHash('sha256').update(utf8, 'utf8').digest('base64');
  return {
    ...actual,
    registrationTranscriptB64: (input: Parameters<typeof actual.registrationTranscriptB64>[0]) =>
      actual.registrationTranscriptB64(input, nodeSha),
    androidKeyGenChallengeB64: (input: Parameters<typeof actual.androidKeyGenChallengeB64>[0]) =>
      actual.androidKeyGenChallengeB64(input, nodeSha),
  };
});

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const CHALLENGE_PATH = '/api/v1/authenticator/devices/mobile/challenge';
const VERIFY_PATH = '/api/v1/authenticator/devices/mobile/verify';
const LEGACY_PATH = '/api/v1/authenticator/devices';

const CHAIN = ['LEAF-DER-B64', 'INTERMEDIATE-DER-B64', 'GOOGLE-ROOT-DER-B64'];

/** What the SERVER derives for these fixtures — recomputed, not copied. */
const expectedTranscriptB64 = createHash('sha256')
  .update(
    [
      'breeze.authenticator.mobile-register.v1',
      'attempt-1',
      'server-challenge',
      'ES256',
      'SB-SPKI-B64',
    ].join('\n'),
    'utf8',
  )
  .digest('base64');

const expectedKeyGenChallengeB64 = createHash('sha256')
  .update(
    ['breeze.authenticator.mobile-register.keygen.v1', 'attempt-1', 'server-challenge', 'ES256'].join(
      '\n',
    ),
    'utf8',
  )
  .digest('base64');

function fakeSigner(overrides: Partial<HardwareSigner> = {}): HardwareSigner {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    createKeys: vi.fn().mockResolvedValue({ publicKey: 'LEGACY-RSA-SPKI' }),
    sign: vi.fn().mockResolvedValue({ signature: 'LEGACY-SIG' }),
    deleteKeys: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** No stored credential yet, but an auth token for authedFetch. */
function noCredentialYet() {
  secureStore.getItemAsync.mockImplementation(async (k: string) =>
    k === 'breeze_approver_credential_id' ? null : 'test-token',
  );
}

function challengeIssued() {
  fetchMock.mockResolvedValueOnce(
    json({
      attemptId: 'attempt-1',
      challenge: 'server-challenge',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  secureStore.getItemAsync.mockReset().mockResolvedValue('test-token');
  secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  attesting.isAvailable.mockReset().mockResolvedValue(true);
  attesting.createAttestedKey
    .mockReset()
    .mockResolvedValue({ publicKeySpkiB64: 'SB-SPKI-B64', alg: 'ES256' });
  attesting.attestApp
    .mockReset()
    .mockResolvedValue({ platform: 'android', certificateChain: CHAIN });
  attesting.signPayload.mockReset().mockResolvedValue({ signature: 'POP-SIG' });
  attesting.deleteAttestedKey.mockReset().mockResolvedValue(true);
  noCredentialYet();
});
afterEach(() => vi.restoreAllMocks());

describe('ensureApproverDevice — Android attested path', () => {
  it('asks for an ANDROID challenge, so the server binds the attempt to this platform', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: true,
    });

    expect(fetchMock.mock.calls[0][0]).toContain(CHALLENGE_PATH);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      platform: 'android',
      registerGrantId: 'grant-1',
    });
  });

  it('generates the key with the DERIVED keygen digest, not the raw challenge', async () => {
    // The leaf certificate carries these bytes and the server compares them
    // against `androidKeyGenChallenge`. Passing `challenge` through verbatim
    // would fail every Android registration in the field at once.
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(attesting.createAttestedKey).toHaveBeenCalledWith({
      attestationChallengeB64: expectedKeyGenChallengeB64,
    });
    expect(expectedKeyGenChallengeB64).not.toBe('server-challenge');
    expect(expectedKeyGenChallengeB64).not.toBe(expectedTranscriptB64);
  });

  it('mints the key BEFORE the transcript — the transcript commits to its SPKI', async () => {
    const order: string[] = [];
    attesting.createAttestedKey.mockImplementation(async () => {
      order.push('createAttestedKey');
      return { publicKeySpkiB64: 'SB-SPKI-B64', alg: 'ES256' };
    });
    attesting.attestApp.mockImplementation(async () => {
      order.push('attestApp');
      return { platform: 'android', certificateChain: CHAIN };
    });
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(order).toEqual(['createAttestedKey', 'attestApp']);
  });

  it('attests and signs the SERVER-derived transcript, not the keygen challenge', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(attesting.attestApp).toHaveBeenCalledWith(expectedTranscriptB64);
    expect(attesting.signPayload).toHaveBeenCalledWith(expectedTranscriptB64, expect.any(String));
  });

  it('forwards the certificate chain to /verify verbatim, leaf first', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(fetchMock.mock.calls[1][0]).toContain(VERIFY_PATH);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.attestation).toEqual({ platform: 'android', certificateChain: CHAIN });
    // Order is load-bearing: the server's verifier walks leaf -> root.
    expect(body.attestation.certificateChain[0]).toBe('LEAF-DER-B64');
    expect(body).toMatchObject({
      attemptId: 'attempt-1',
      publicKey: 'SB-SPKI-B64',
      publicKeyAlg: 'ES256',
      popSignature: 'POP-SIG',
    });
  });

  it('forwards a Play Integrity token when the device produced one', async () => {
    attesting.attestApp.mockResolvedValue({
      platform: 'android',
      certificateChain: CHAIN,
      playIntegrityToken: 'PI-JWS',
    });
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).attestation.playIntegrityToken).toBe(
      'PI-JWS',
    );
  });

  it('OMITS the token when Play services are absent rather than sending a placeholder', async () => {
    // The schema marks the token optional precisely so an enterprise or
    // sideloaded build can register. A fabricated token would be a forged
    // integrity claim; an empty string would be a schema violation.
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    const attestation = JSON.parse(fetchMock.mock.calls[1][1].body).attestation;
    expect(attestation).not.toHaveProperty('playIntegrityToken');
  });

  it('still registers (attested) when the token is absent — the chain alone earns L4', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ANDROID_ATTESTED_DEVICE, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: true,
    });
  });
});

describe('ensureApproverDevice — Android fail-closed cases', () => {
  it('reports attestation_failed (NOT a silent legacy fallback) when key generation refuses', async () => {
    // A StrongBox/TEE device that cannot mint an attested key must not quietly
    // register an unattested one: the technician would believe their phone can
    // approve critical requests, and discover otherwise at the worst moment.
    attesting.createAttestedKey.mockRejectedValue(new Error('keystore refused'));
    challengeIssued();

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith(LEGACY_PATH))).toBe(false);
  });

  it('reports attestation_failed when the certificate chain cannot be exported', async () => {
    attesting.attestApp.mockRejectedValue(new Error('no attested key on this device'));
    challengeIssued();

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
  });

  it('reports attestation_failed when the biometric prompt is cancelled', async () => {
    // The Kotlin rejects on cancellation rather than returning a placeholder
    // signature — an approval the user declined must never look like one they
    // gave.
    attesting.signPayload.mockRejectedValue(new Error('biometric authentication failed: cancelled'));
    challengeIssued();

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
  });

  it('reports attestation_probe_failed when the availability probe itself throws', async () => {
    // "I don't know" is not "no". Registering unattested here would be a silent
    // downgrade on a phone that may well support StrongBox.
    attesting.isAvailable.mockRejectedValue(new Error('bridge exploded'));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_probe_failed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the legacy unattested endpoint when attestation is UNAVAILABLE', async () => {
    // Pre-API-28 Android, or a device with no hardware keystore. This IS an
    // honest downgrade: the server records `unattested` and W07's banner says
    // so, which is different from a device that supports attestation and failed.
    attesting.isAvailable.mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-legacy' } }, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: false,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(LEGACY_PATH);
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
  });

  it('does not retry the same attemptId after /verify returns 400', async () => {
    // The attempt is single-use and already consumed server-side, so a replay
    // could only 400 again while burning the grant.
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json({ error: 'attestation rejected' }, 400));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toMatchObject({
      status: 'failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails before minting a key when the challenge response is incomplete', async () => {
    // Hashing `undefined` would yield a well-formed digest that could never
    // verify, and a 401 nobody could trace back to this response.
    fetchMock.mockResolvedValueOnce(json({ expiresAt: 'x' }));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'missing_challenge',
    });
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
  });

  it('refuses a key whose algorithm disagrees with the keygen challenge', async () => {
    // The challenge committed to ES256 BEFORE the key existed. A key of any
    // other algorithm carries a challenge the server will not reproduce, so
    // fail here with a legible client error instead of at /verify with an
    // opaque attestation rejection.
    attesting.createAttestedKey.mockResolvedValue({
      publicKeySpkiB64: 'SB-SPKI-B64',
      alg: 'RS256',
    });
    challengeIssued();

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
    expect(attesting.attestApp).not.toHaveBeenCalled();
  });
});
