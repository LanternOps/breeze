import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gatherApprovalProof,
  registerApproverDevice,
  setApproverPin,
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

describe('registerApproverDevice', () => {
  it('creates a key, signs the PoP nonce, posts the public key, and stores the credential id', async () => {
    const signer = fakeSigner();
    fetchMock
      .mockResolvedValueOnce(json({ nonce: 'reg-nonce' })) // options
      .mockResolvedValueOnce(json({ device: { id: 'cred-99' } })); // verify

    const result = await registerApproverDevice('pw', 'My iPhone', signer);

    expect(result.credentialId).toBe('cred-99');
    // signed the server nonce, not anything else
    expect(signer.sign).toHaveBeenCalledWith('reg-nonce', expect.any(String));
    // options request carried the password step-up
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ currentPassword: 'pw' });
    // verify request carried the public key + signature
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      publicKey: 'SPKI-PUBKEY-B64',
      signature: 'SIG-B64',
      label: 'My iPhone',
    });
    // credential id persisted for later assertions
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('breeze_approver_credential_id', 'cred-99');
  });

  it('throws (does not register) when the device has no hardware key', async () => {
    const signer = fakeSigner({ isAvailable: vi.fn().mockResolvedValue(false) });
    await expect(registerApproverDevice('pw', 'X', signer)).rejects.toThrow(/no biometric hardware/i);
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('setApproverPin', () => {
  it('PUTs the PIN with the password step-up using the server field name `pin`', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await setApproverPin('pw', '1234');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/auth/pin');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    // Must serialize to `pin` (the server setPinSchema field), NOT `newPin`.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ currentPassword: 'pw', pin: '1234' });
  });

  it('throws on a server rejection', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'weak' }, 400));
    await expect(setApproverPin('pw', '12')).rejects.toThrow(/Could not set PIN/i);
  });
});
