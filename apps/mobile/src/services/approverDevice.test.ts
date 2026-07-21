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
};
vi.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => secureStore.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => secureStore.setItemAsync(...a),
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

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  secureStore.getItemAsync.mockReset().mockResolvedValue('test-token');
  secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
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

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({ status: 'registered' });

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
    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({ status: 'registered' });
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
    await expect(first).resolves.toEqual({ status: 'registered' });
    await expect(second).resolves.toEqual({ status: 'registered' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('never throws on the login path when the network blows up', async () => {
    const signer = fakeSigner();
    secureStore.getItemAsync.mockImplementation(async (k: string) =>
      k === 'breeze_approver_credential_id' ? null : 'test-token',
    );
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(ensureApproverDevice(signer, 'grant-1')).resolves.toEqual({
      status: 'failed',
      reason: 'exception',
    });
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
