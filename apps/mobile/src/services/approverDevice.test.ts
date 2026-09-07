import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApproverDevice,
  gatherApprovalProof,
  type MobileApprovalProof,
} from './approverDevice';
import type { HardwareSigner } from './hardwareSigner';

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
vi.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => secureStore.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => secureStore.setItemAsync(...a),
  deleteItemAsync: (...a: unknown[]) => secureStore.deleteItemAsync(...a),
}));

// Default getHardwareSigner returns an UNAVAILABLE signer; tests that need a
// working one pass an explicit fake to the function under test.
vi.mock('./hardwareSigner', () => ({
  getHardwareSigner: () => ({
    isAvailable: async () => false,
    createKeys: async () => ({ publicKey: '' }),
    sign: async () => ({ signature: '' }),
    deleteKeys: async () => false,
  }),
}));

// The ATTESTED path is opt-in per test: `attesting.isAvailable` defaults to
// false so every legacy-path test above keeps exercising the single-POST flow,
// which is exactly what a phone with no Secure Enclave / StrongBox does.
const attesting = {
  isAvailable: vi.fn(),
  createAttestedKey: vi.fn(),
  attestApp: vi.fn(),
  signPayload: vi.fn(),
  deleteAttestedKey: vi.fn(),
};
let attestingPlatform: 'ios' | 'android' | null = 'ios';
vi.mock('./attestingSigner', () => ({
  getAttestingSigner: () => attesting,
  attestationPlatform: () => attestingPlatform,
}));

// The transcript is hashed with expo-crypto on a device, and expo-crypto cannot
// load in the node runner. Substitute ONLY the digest primitive: the REAL
// pre-image builder still runs, because the pre-image is the part that can
// drift from the server and `authenticatorTranscript.test.ts` pins it against
// the API's own vector. A blanket module mock here would make every transcript
// assertion below vacuous.
vi.mock('./authenticatorTranscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./authenticatorTranscript')>();
  return {
    ...actual,
    registrationTranscriptB64: (input: Parameters<typeof actual.registrationTranscriptB64>[0]) =>
      actual.registrationTranscriptB64(input, async (utf8) =>
        createHash('sha256').update(utf8, 'utf8').digest('base64'),
      ),
  };
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  secureStore.getItemAsync.mockReset().mockResolvedValue('test-token');
  secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  attestingPlatform = 'ios';
  attesting.isAvailable.mockReset().mockResolvedValue(false);
  attesting.createAttestedKey
    .mockReset()
    .mockResolvedValue({ publicKeySpkiB64: 'SE-SPKI-B64', alg: 'ES256' });
  attesting.attestApp
    .mockReset()
    .mockResolvedValue({ platform: 'ios', attestationObject: 'ATT-CBOR', keyId: 'KEY-ID' });
  attesting.signPayload.mockReset().mockResolvedValue({ signature: 'POP-SIG' });
  attesting.deleteAttestedKey.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fakeSigner(overrides: Partial<HardwareSigner> = {}): HardwareSigner {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    createKeys: vi.fn().mockResolvedValue({ publicKey: 'SPKI-PUBKEY-B64' }),
    sign: vi.fn().mockResolvedValue({ signature: 'SIG-B64' }),
    deleteKeys: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('ensureApproverDevice', () => {
  it('mints + registers a key when none exists, stores the credential id', async () => {
    const signer = fakeSigner();
    // No stored credential id yet; auth token present for authedFetch.
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-1' } }));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({ status: 'registered', attested: false });

    // Grant-based registration body — no kind/isPlatformBound/currentPassword.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      registerGrantId: 'grant-1',
      publicKey: 'SPKI-PUBKEY-B64',
      label: 'This device',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('currentPassword');
    expect(signer.createKeys).toHaveBeenCalledTimes(1);
    // credential id persisted for later assertions
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('breeze_approver_credential_id', 'dev-1');
  });

  it('returns deferred and does NOT POST when no grant is available', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    await expect(ensureApproverDevice(signer)).resolves.toEqual({
      status: 'deferred',
      reason: 'no_reauth_grant',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signer.createKeys).not.toHaveBeenCalled();
  });

  it('POSTs registerGrantId (and neither kind nor isPlatformBound) when a grant is provided', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-1' } }));
    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({ status: 'registered', attested: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ registerGrantId: 'grant-1', publicKey: 'SPKI-PUBKEY-B64', label: 'This device' });
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('isPlatformBound');
    expect(body).not.toHaveProperty('currentPassword');
  });

  it('concurrent calls share one in-flight attempt (single POST, one grant burn)', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const first = ensureApproverDevice(signer, 'grant-1');
    const second = ensureApproverDevice(signer, 'grant-1');
    release(json({ device: { id: 'dev-1' } }));
    await expect(first).resolves.toEqual({ status: 'registered', attested: false });
    await expect(second).resolves.toEqual({ status: 'registered', attested: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // B4: the grant is single-use — a second key mint would mean a second
    // (wasted, or worse duplicate) attempt slipped through the single-flight
    // gate.
    expect(signer.createKeys).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when a credential id already exists', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? 'dev-1' : 'test-token',
    );

    await expect(ensureApproverDevice(signer)).resolves.toEqual({
      status: 'already_registered',
    });

    expect(signer.createKeys).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unsupported (not failed) when there is no biometric hardware', async () => {
    const signer = fakeSigner({ isAvailable: vi.fn().mockResolvedValue(false) });
    secureStore.getItemAsync.mockResolvedValue(null);

    // 'unsupported' is a normal resting state — the UI must NOT warn about it.
    await expect(ensureApproverDevice(signer)).resolves.toEqual({
      status: 'unsupported',
      reason: 'no_hardware',
    });
    expect(signer.createKeys).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails open (no throw) when registration POST fails; nothing persisted', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 500));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'http_500',
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith(
      'breeze_approver_credential_id',
      expect.anything(),
    );
  });

  it('REGRESSION: reports the 400 the server returns for the missing currentPassword step-up', async () => {
    // The server's mobileRegisterSchema requires `currentPassword` (deliberately
    // — passwordless enrollment was reverted as a HIGH security finding), and
    // this client does not send it, so zValidator 400s before the handler runs.
    // That used to be swallowed by `if (!res.ok) return;`, leaving every
    // approval from this phone silently capped at L1. It must be reported.
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ error: 'Validation failed' }, 400));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith(
      'breeze_approver_credential_id',
      expect.anything(),
    );
  });

  it('reports failure when the server 200s without a device id (no silent success)', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ device: {} }));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'missing_device_id',
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('never throws on the login path when the network blows up; reason names the exception', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    // B2: the reason must name the exception (not the bare literal 'exception')
    // so a failure that never leaves the device is at least distinguishable in
    // aggregate telemetry once RootNavigator reports it.
    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'exception:Error',
    });
  });

  it('starts a FRESH attempt after a failed outcome — the in-flight slot is cleared', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ error: 'nope' }, 500));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'http_500',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-2' } }));
    await expect(ensureApproverDevice(signer, 'grant-2')).resolves.toEqual({ status: 'registered', attested: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('B1: a grant-bearing call joins a grant-less in-flight attempt, then fires its OWN POST once it resolves non-registered', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    // Grant-less caller — RootNavigator can start this before its grant read
    // resolves. No POST: it resolves 'deferred' without touching the network.
    const grantless = ensureApproverDevice(signer);
    // A grant-bearing caller shows up while the grant-less attempt is still
    // in flight — it must NOT be dropped (that's the B1 bug): it should join,
    // see the non-registered outcome, and fire its own POST with the grant.
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-1' } }));
    const withGrant = ensureApproverDevice(signer, 'grant-1');

    await expect(grantless).resolves.toEqual({ status: 'deferred', reason: 'no_reauth_grant' });
    await expect(withGrant).resolves.toEqual({ status: 'registered', attested: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ registerGrantId: 'grant-1' });
  });
});

describe('gatherApprovalProof (non-blocking)', () => {
  it('returns a signed mobile_hw_key proof when a device + mobile nonce exist', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? 'cred-99' : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ mobileNonce: 'approval-nonce' }));

    const proof = (await gatherApprovalProof('appr-1', signer)) as MobileApprovalProof;

    expect(proof).toEqual({
      type: 'mobile_hw_key',
      credentialId: 'cred-99',
      nonce: 'approval-nonce',
      signature: 'SIG-B64',
    });
    expect(signer.sign).toHaveBeenCalledWith('approval-nonce', expect.any(String));
  });

  it('returns null (→ L1, never blocks) when the signer is unavailable', async () => {
    const signer = fakeSigner({ isAvailable: vi.fn().mockResolvedValue(false) });
    const proof = await gatherApprovalProof('appr-1', signer);
    expect(proof).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no credential is registered on this device', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockResolvedValue(null); // no stored credential id
    const proof = await gatherApprovalProof('appr-1', signer);
    expect(proof).toBeNull();
  });

  it('returns null when the server issues no mobile nonce (device-less server view)', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? 'cred-99' : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ webauthn: {} })); // no mobileNonce
    const proof = await gatherApprovalProof('appr-1', signer);
    expect(proof).toBeNull();
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it('propagates a cancelled biometric prompt (does not silently downgrade)', async () => {
    const signer = fakeSigner({ sign: vi.fn().mockRejectedValue(new Error('Biometric cancelled')) });
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? 'cred-99' : 'test-token',
    );
    fetchMock.mockResolvedValueOnce(json({ mobileNonce: 'approval-nonce' }));
    await expect(gatherApprovalProof('appr-1', signer)).rejects.toThrow(/cancelled/i);
  });
});

// ============================================================
// #1374 W05 — two-step ATTESTED registration
//
// The whole point of the round-trip is that the phone signs a transcript the
// SERVER chose. These tests exist to stop three specific regressions: a
// client-chosen challenge, a silent downgrade to the unattested endpoint when
// attestation fails, and a retry that reuses a single-use attemptId.
// ============================================================

const CHALLENGE_PATH = '/api/v1/authenticator/devices/mobile/challenge';
const VERIFY_PATH = '/api/v1/authenticator/devices/mobile/verify';
const LEGACY_PATH = '/api/v1/authenticator/devices';

/** The transcript the server would derive for the fixtures used below. */
const expectedTranscriptB64 = createHash('sha256')
  .update(
    [
      'breeze.authenticator.mobile-register.v1',
      'attempt-1',
      'server-challenge',
      'ES256',
      'SE-SPKI-B64',
    ].join('\n'),
    'utf8',
  )
  .digest('base64');

/**
 * `/devices/mobile/verify` 201s whether or not the attestation held; the
 * verdict is the `platformBoundBasis` on the returned row. Success fixtures
 * carry it explicitly so a client that stops reading it goes red.
 */
const ATTESTED_DEVICE = { device: { id: 'dev-att', platformBoundBasis: 'ios_se_p256_app_attest' } };

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

describe('ensureApproverDevice — attested path', () => {
  beforeEach(() => {
    attesting.isAvailable.mockResolvedValue(true);
    noCredentialYet();
  });

  it('POSTs challenge then verify, carrying the grant on BOTH calls', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.test${CHALLENGE_PATH}`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      platform: 'ios',
      registerGrantId: 'grant-1',
    });

    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.test${VERIFY_PATH}`);
    // The grant is validated non-consuming at /challenge and CONSUMED at
    // /verify, so omitting it on the second call would 403 every registration.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      registerGrantId: 'grant-1',
      attemptId: 'attempt-1',
      publicKey: 'SE-SPKI-B64',
      publicKeyAlg: 'ES256',
      label: 'This device',
      popSignature: 'POP-SIG',
      attestation: { platform: 'ios', attestationObject: 'ATT-CBOR', keyId: 'KEY-ID' },
    });
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'breeze_approver_credential_id',
      'dev-att',
    );
    // Recorded so approval-time signing picks the ES256 key the server row
    // expects. Without this the device registers at L4 and then fails every
    // proof it offers.
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('breeze_approver_attested', '1');
  });

  it('CLEARS the attested marker when the legacy path ran, so a stale one cannot pin the wrong signer', async () => {
    // A marker left over from an earlier attested enrolment (or a crash between
    // the marker write and the credential write) would make gatherApprovalProof
    // offer an ES256 signature for an RSA row: every approval rejected, no error.
    attesting.isAvailable.mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-legacy' } }));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: false,
    });

    expect(secureStore.setItemAsync).not.toHaveBeenCalledWith(
      'breeze_approver_attested',
      expect.anything(),
    );
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('breeze_approver_attested');
    // Marker cleared BEFORE the credential id is written.
    const del = secureStore.deleteItemAsync.mock.invocationCallOrder[0];
    const cred = secureStore.setItemAsync.mock.invocationCallOrder[0];
    expect(del).toBeLessThan(cred);
  });

  it('reports attested:false with a reason when /verify 201s but the server stored the row as unattested', async () => {
    // The server never refuses a rejected attestation — it inserts the row with
    // platformBoundBasis 'unattested' and returns 201. Reading only res.ok would
    // record L4 on a phone permanently capped at L3, and the on-device gate
    // would show "registered" while the server row says otherwise.
    challengeIssued();
    fetchMock.mockResolvedValueOnce(
      json({ device: { id: 'dev-att', platformBoundBasis: 'unattested' } }, 201),
    );

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: false,
      reason: 'attestation_rejected_by_server',
    });
    // The row exists and is keyed by the SE key (ES256), so the signer marker
    // is still set and the credential is stored: no re-registration loop.
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('breeze_approver_attested', '1');
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('breeze_approver_credential_id', 'dev-att');
  });

  it('treats a 201 with no platformBoundBasis at all as not attested', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-att' } }, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: false,
      reason: 'attestation_rejected_by_server',
    });
  });

  it('signs and attests the transcript derived from the SERVER challenge, not a client-chosen value', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(attesting.attestApp).toHaveBeenCalledWith(expectedTranscriptB64);
    expect(attesting.signPayload).toHaveBeenCalledWith(expectedTranscriptB64, expect.any(String));
    // Bound three ways to ONE digest — attestation, PoP, and the key inside it.
    expect(attesting.attestApp.mock.calls[0][0]).toBe(attesting.signPayload.mock.calls[0][0]);
  });

  it('passes the server challenge to key generation so Android can bind it at key-gen time', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(attesting.createAttestedKey).toHaveBeenCalledWith({
      attestationChallengeB64: 'server-challenge',
    });
  });

  it('sends the platform the RUNTIME reports, so the server can refuse a cross-platform attestation', async () => {
    attestingPlatform = 'android';
    attesting.attestApp.mockResolvedValue({
      platform: 'android',
      certificateChain: ['leaf', 'root'],
    });
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));

    await ensureApproverDevice(fakeSigner(), 'grant-1');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).platform).toBe('android');
  });

  it('falls back to the legacy unattested endpoint when attestation is UNAVAILABLE', async () => {
    attesting.isAvailable.mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(json({ device: { id: 'dev-legacy' } }));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'registered',
      attested: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.test${LEGACY_PATH}`);
  });

  it('returns failed/attestation_failed — NOT a silent legacy fallback — when attestApp throws', async () => {
    // A device that SUPPORTS attestation but fails it must not quietly register
    // an unattested L2 key: the user would believe their phone can approve
    // critical requests when it cannot, and nothing would ever tell them.
    challengeIssued();
    attesting.attestApp.mockRejectedValue(new Error('DCError 2'));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // challenge only, never the legacy POST
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => c[0] === `https://api.test${LEGACY_PATH}`),
    ).toBe(false);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('returns failed/attestation_failed when the biometric PoP signature is refused', async () => {
    challengeIssued();
    attesting.signPayload.mockRejectedValue(new Error('User cancelled'));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => c[0] === `https://api.test${LEGACY_PATH}`),
    ).toBe(false);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('returns failed/attestation_failed when key generation is refused', async () => {
    challengeIssued();
    attesting.createAttestedKey.mockRejectedValue(new Error('SecKeyCreateRandomKey -25293'));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_failed',
    });
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => c[0] === `https://api.test${LEGACY_PATH}`),
    ).toBe(false);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('does not retry with the same attemptId after a 400 — the attempt is single-use', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json({ error: 'registration_attempt_expired' }, 400));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'http_400',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A second call mints a FRESH attempt rather than replaying attempt-1 (the
    // server consumed it on the 400 and would reject the replay).
    fetchMock.mockResolvedValueOnce(
      json({ attemptId: 'attempt-2', challenge: 'server-challenge-2', expiresAt: 'x' }),
    );
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));
    await expect(ensureApproverDevice(fakeSigner(), 'grant-2')).resolves.toEqual({
      status: 'registered',
      attested: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).attemptId).toBe('attempt-2');
  });

  it('reports the challenge call failing without ever minting a key', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'rate limited' }, 429));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'http_429',
    });
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
  });

  it('reports a challenge response missing attemptId/challenge rather than hashing undefined', async () => {
    fetchMock.mockResolvedValueOnce(json({ expiresAt: 'x' }));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'missing_challenge',
    });
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
  });

  it('reports failure when verify 200s without a device id (no silent success)', async () => {
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json({ device: {} }, 201));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'missing_device_id',
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('still defers without a grant, and never mints a key or opens an attempt', async () => {
    await expect(ensureApproverDevice(fakeSigner())).resolves.toEqual({
      status: 'deferred',
      reason: 'no_reauth_grant',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
  });

  it('is unsupported only when NEITHER signer is available', async () => {
    attesting.isAvailable.mockResolvedValue(false);
    await expect(
      ensureApproverDevice(fakeSigner({ isAvailable: vi.fn().mockResolvedValue(false) }), 'grant-1'),
    ).resolves.toEqual({ status: 'unsupported', reason: 'no_hardware' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the availability probe itself throws — never a legacy fallback', async () => {
    // A probe that rejects means "unknown", not "unavailable". Treating it as
    // unavailable would silently register an unattested key on a phone that may
    // support L4, and nothing would ever surface that.
    attesting.isAvailable.mockRejectedValue(new Error('bridge exploded'));

    await expect(ensureApproverDevice(fakeSigner(), 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'attestation_probe_failed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attesting.createAttestedKey).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('takes the attested path even when the LEGACY signer is unavailable', async () => {
    // A phone with a Secure Enclave but no react-native-biometrics key must not
    // be reported as having no hardware.
    challengeIssued();
    fetchMock.mockResolvedValueOnce(json(ATTESTED_DEVICE, 201));

    await expect(
      ensureApproverDevice(fakeSigner({ isAvailable: vi.fn().mockResolvedValue(false) }), 'grant-1'),
    ).resolves.toEqual({ status: 'registered', attested: true });
  });
});

// ============================================================
// #1374 W05 — approval-time signer selection
//
// The server verifies an approval assertion with the algorithm stored on the
// DEVICE ROW ("the algorithm comes from the DEVICE ROW, never from the proof",
// `apps/api/src/services/authenticatorAssurance.ts`). So a phone that registered
// through the attested path holds an ES256 row and MUST sign with the Secure
// Enclave key. Signing with the legacy RSA key would produce a proof the server
// rejects — an approval that silently lands at L1 on a device the UI calls
// hardware-attested.
// ============================================================
describe('gatherApprovalProof — signer selection', () => {
  function registeredAs(attested: boolean) {
    secureStore.getItemAsync.mockImplementation(async (k: string) => {
      if (k === 'breeze_approver_credential_id') return 'cred-99';
      if (k === 'breeze_approver_attested') return attested ? '1' : null;
      return 'test-token';
    });
  }

  it('signs with the ATTESTED key when this device registered attested', async () => {
    registeredAs(true);
    attesting.isAvailable.mockResolvedValue(true);
    attesting.signPayload.mockResolvedValue({ signature: 'SE-SIG' });
    const legacy = fakeSigner();
    fetchMock.mockResolvedValueOnce(json({ mobileNonce: 'approval-nonce' }));

    await expect(gatherApprovalProof('appr-1', legacy, attesting)).resolves.toEqual({
      type: 'mobile_hw_key',
      credentialId: 'cred-99',
      nonce: 'approval-nonce',
      signature: 'SE-SIG',
    });
    // Signed as the raw nonce string — what `verifyMobileSignature` hashes.
    expect(attesting.signPayload).toHaveBeenCalledWith('approval-nonce', expect.any(String));
    expect(legacy.sign).not.toHaveBeenCalled();
  });

  it('signs with the LEGACY key when this device registered unattested', async () => {
    registeredAs(false);
    attesting.isAvailable.mockResolvedValue(true);
    const legacy = fakeSigner();
    fetchMock.mockResolvedValueOnce(json({ mobileNonce: 'approval-nonce' }));

    const proof = (await gatherApprovalProof('appr-1', legacy, attesting)) as MobileApprovalProof;

    expect(proof.signature).toBe('SIG-B64');
    expect(legacy.sign).toHaveBeenCalledWith('approval-nonce', expect.any(String));
    expect(attesting.signPayload).not.toHaveBeenCalled();
  });

  it('returns null rather than offering an RSA signature the ES256 row would reject', async () => {
    // Attested row, but the attested signer is gone (older build, module not
    // linked). Falling back to the legacy key would turn "no proof" into a
    // server-side verification FAILURE, which is strictly worse.
    registeredAs(true);
    attesting.isAvailable.mockResolvedValue(false);
    const legacy = fakeSigner();

    await expect(gatherApprovalProof('appr-1', legacy, attesting)).resolves.toBeNull();
    expect(legacy.sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a REJECTED availability probe instead of coercing it to "unavailable"', async () => {
    // Registration treats a thrown probe as "unknown" and fails closed. The
    // approval path must not quietly convert the same throw into a null proof:
    // that is an L1 approval from a phone registered at L4, with no signal.
    registeredAs(true);
    attesting.isAvailable.mockRejectedValue(new Error('bridge exploded'));
    const legacy = fakeSigner();

    await expect(gatherApprovalProof('appr-1', legacy, attesting)).rejects.toThrow(/bridge exploded/);
    expect(legacy.sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a Secure Enclave key invalidated by a new biometric enrolment', async () => {
    // `.biometryCurrentSet` means enrolling a new face/finger kills the key.
    // The app must report that, not silently sign with something else.
    registeredAs(true);
    attesting.isAvailable.mockResolvedValue(true);
    attesting.signPayload.mockRejectedValue(new Error('errSecAuthFailed: key invalidated'));
    fetchMock.mockResolvedValueOnce(json({ mobileNonce: 'approval-nonce' }));

    await expect(gatherApprovalProof('appr-1', fakeSigner(), attesting)).rejects.toThrow(
      /invalidated/i,
    );
  });
});
