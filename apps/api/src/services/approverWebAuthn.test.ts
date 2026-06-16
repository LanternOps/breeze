import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, webauthnMocks } = vi.hoisted(() => ({
  redisMock: {
    getdel: vi.fn(),
    setex: vi.fn(),
  },
  webauthnMocks: {
    generateRegistrationOptions: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  },
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

vi.mock('@simplewebauthn/server', () => webauthnMocks);

import { getRedis } from './redis';
import {
  generateApprovalAssertionOptions,
  generateApproverRegistrationOptions,
  verifyApprovalAssertion,
  verifyApproverRegistration,
} from './approverWebAuthn';
import type { StoredPasskeyCredential } from './passkeys';

const getRedisMock = vi.mocked(getRedis);

const fakeDevice: StoredPasskeyCredential = {
  credentialId: 'cred-1',
  publicKey: 'AQID', // base64url of [1,2,3]
  counter: 3,
  transports: ['internal'],
};

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock as never);
  redisMock.setex.mockResolvedValue('OK');
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGIN;
  delete process.env.WEBAUTHN_RP_NAME;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.DASHBOARD_URL;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('generateApproverRegistrationOptions', () => {
  it('requests a platform-attachment, user-verification-required credential', async () => {
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-c' });

    const options = await generateApproverRegistrationOptions({
      user: { id: 'u1', name: 'alice@b.co', displayName: 'Alice' },
    });

    expect(options).toEqual({ challenge: 'reg-c' });
    expect(webauthnMocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'platform',
          userVerification: 'required',
        }),
      })
    );
  });

  it('stores the registration challenge at approver-reg:<userId>', async () => {
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-c' });

    await generateApproverRegistrationOptions({
      user: { id: 'u1', name: 'alice@b.co', displayName: 'Alice' },
    });

    expect(redisMock.setex).toHaveBeenCalledWith(
      'approver-reg:u1',
      expect.any(Number),
      'reg-c'
    );
  });
});

describe('generateApprovalAssertionOptions', () => {
  it('stores a 120s challenge at approval-assertion:<approvalId>:<userId> and returns allowCredentials', async () => {
    webauthnMocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'assert-c',
      allowCredentials: [{ id: 'cred-1' }],
    });

    const options = await generateApprovalAssertionOptions({
      approvalId: 'a1',
      userId: 'u1',
      devices: [{ credentialId: 'cred-1', transports: ['internal'] }],
    });

    expect(options.allowCredentials).toEqual([{ id: 'cred-1' }]);
    expect(webauthnMocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        userVerification: 'required',
        allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
      })
    );
    expect(redisMock.setex).toHaveBeenCalledWith(
      'approval-assertion:a1:u1',
      120,
      'assert-c'
    );
  });
});

describe('verifyApprovalAssertion', () => {
  it('consumes the challenge via getdel, verifies, and returns verified + newSignCount', async () => {
    redisMock.getdel.mockResolvedValueOnce('assert-c');
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    });

    const result = await verifyApprovalAssertion({
      approvalId: 'a1',
      userId: 'u1',
      response: { id: 'cred-1' } as never,
      device: fakeDevice,
    });

    expect(redisMock.getdel).toHaveBeenCalledWith('approval-assertion:a1:u1');
    expect(webauthnMocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'assert-c',
        requireUserVerification: true,
      })
    );
    expect(result).toEqual({ verified: true, newSignCount: 7 });
  });

  it('rejects a second call once the challenge is consumed (getdel returns null)', async () => {
    redisMock.getdel.mockResolvedValueOnce('assert-c');
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    });

    await verifyApprovalAssertion({
      approvalId: 'a1',
      userId: 'u1',
      response: { id: 'cred-1' } as never,
      device: fakeDevice,
    });

    redisMock.getdel.mockResolvedValueOnce(null);

    await expect(
      verifyApprovalAssertion({
        approvalId: 'a1',
        userId: 'u1',
        response: { id: 'cred-1' } as never,
        device: fakeDevice,
      })
    ).rejects.toThrow(/expired or already used/);
  });
});

describe('verifyApproverRegistration', () => {
  it('consumes the reg challenge and flags a non-syncable single-device credential as platform-bound', async () => {
    redisMock.getdel.mockResolvedValueOnce('reg-c');
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        aaguid: 'aaguid-1',
      },
    });

    const fields = await verifyApproverRegistration({
      userId: 'u1',
      response: { response: { transports: ['internal'] } } as never,
    });

    expect(redisMock.getdel).toHaveBeenCalledWith('approver-reg:u1');
    expect(fields.isPlatformBound).toBe(true);
    expect(fields.credentialId).toBe('cred-1');
  });

  it('marks a synced (backedUp) credential as NOT platform-bound', async () => {
    redisMock.getdel.mockResolvedValueOnce('reg-c');
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-2', publicKey: new Uint8Array([4, 5, 6]), counter: 0 },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        aaguid: 'aaguid-2',
      },
    });

    const fields = await verifyApproverRegistration({
      userId: 'u1',
      response: { response: {} } as never,
    });

    expect(fields.isPlatformBound).toBe(false);
  });

  it('throws when the registration challenge has expired', async () => {
    redisMock.getdel.mockResolvedValueOnce(null);

    await expect(
      verifyApproverRegistration({ userId: 'u1', response: {} as never })
    ).rejects.toThrow(/challenge expired/);
  });
});
