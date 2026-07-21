import { beforeEach, describe, expect, it, vi } from 'vitest';

const { webauthnMocks } = vi.hoisted(() => ({
  webauthnMocks: {
    startAuthentication: vi.fn(),
    startRegistration: vi.fn(),
  },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: webauthnMocks.startAuthentication,
  startRegistration: webauthnMocks.startRegistration,
}));

import {
  getApprovalAssertion,
  listApproverDevices,
  registerApproverDevice,
  revokeApproverDevice,
} from './authenticator';

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('authenticator store approver helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('breeze-auth');
  });

  it('registerApproverDevice fetches options, runs startRegistration, and posts the attestation', async () => {
    const options = {
      challenge: 'reg-challenge-b64url',
      rp: { id: 'breeze.example', name: 'Breeze' },
      user: { id: 'user-1', name: 'tech', displayName: 'Tech' },
      authenticatorSelection: { authenticatorAttachment: 'platform' },
    };
    const attResp = {
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key',
      response: { attestationObject: 'att', clientDataJSON: 'cdj' },
      clientExtensionResults: {},
    };
    webauthnMocks.startRegistration.mockResolvedValueOnce(attResp);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(options))
      .mockResolvedValueOnce(makeResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await registerApproverDevice('My laptop');

    // Step 1: options request
    expect(fetchMock.mock.calls[0][0]).toContain('/authenticator/devices/webauthn/options');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });

    // Step 2: startRegistration called with { optionsJSON }
    expect(webauthnMocks.startRegistration).toHaveBeenCalledWith({ optionsJSON: options });

    // Step 3: verify request carries label + the attestation response
    expect(fetchMock.mock.calls[1][0]).toContain('/authenticator/devices/webauthn/verify');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      label: 'My laptop',
      response: attResp,
    });
  });

  it('listApproverDevices GETs the collection and unwraps the { devices } envelope', async () => {
    // The real route returns `{ devices: [...] }` — the store must unwrap it.
    const devices = [{ id: 'd1', label: 'Laptop' }];
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ devices }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listApproverDevices();

    expect(fetchMock.mock.calls[0][0]).toContain('/me/approver-devices');
    expect(result).toEqual(devices);
  });

  it('registerApproverDevice REJECTS on a non-2xx verify (no false success)', async () => {
    webauthnMocks.startRegistration.mockResolvedValueOnce({ id: 'cred-1', response: {} });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ challenge: 'c' })) // options ok
      .mockResolvedValueOnce(makeResponse({ error: 'challenge expired' }, false, 400)); // verify fails
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerApproverDevice('My laptop')).rejects.toThrow(/challenge expired|registration failed/i);
  });

  it('registerApproverDevice REJECTS on a non-2xx options response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ error: 'nope' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(registerApproverDevice('x')).rejects.toThrow();
    expect(webauthnMocks.startRegistration).not.toHaveBeenCalled();
  });

  it('listApproverDevices throws on a server error (no empty-list masking)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ error: 'boom' }, false, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listApproverDevices()).rejects.toThrow(/load approver devices/i);
  });

  it('getApprovalAssertion throws a NON-NoApproverDeviceError on a server failure (no silent L1)', async () => {
    // A 500 on the challenge must NOT be misread as the device-less case.
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ error: 'redis down' }, false, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getApprovalAssertion('/pam/elevation-requests', 'req-z')).rejects.toMatchObject({
      name: expect.not.stringMatching(/NoApproverDeviceError/),
    });
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty 2xx body', null],
    ['an empty object', {}],
    ['a challenge-less options object', { options: { allowCredentials: [] } }],
  ])('getApprovalAssertion rejects on a malformed 2xx challenge (%s)', async (_label, payload) => {
    // A malformed 200 must NOT fall through to the device-less branch: that
    // tells a user who HAS a registered authenticator to go register one, and
    // in PamRespondModal it silently downgrades the approve to a proofless L1.
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(payload));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getApprovalAssertion('/pam/elevation-requests', 'req-m')).rejects.toMatchObject({
      name: expect.not.stringMatching(/NoApproverDeviceError/),
    });
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled();
  });

  it('getApprovalAssertion still reports NoApproverDeviceError for a WELL-FORMED device-less challenge', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ challenge: 'c-b64url', allowCredentials: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getApprovalAssertion('/pam/elevation-requests', 'req-n')).rejects.toMatchObject({
      name: 'NoApproverDeviceError',
    });
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled();
  });

  it('revokeApproverDevice POSTs to the revoke endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeApproverDevice('d1');

    expect(fetchMock.mock.calls[0][0]).toContain('/me/approver-devices/d1/revoke');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('getApprovalAssertion requests a challenge, runs startAuthentication, and returns the proof body', async () => {
    const options = {
      challenge: 'assertion-challenge-b64url',
      allowCredentials: [{ id: 'cred-1', type: 'public-key' }],
    };
    const asseResp = {
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key',
      response: {
        authenticatorData: 'auth-data',
        clientDataJSON: 'client-data',
        signature: 'signature',
        userHandle: 'handle-1',
      },
      clientExtensionResults: {},
    };
    webauthnMocks.startAuthentication.mockResolvedValueOnce(asseResp);
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(options));
    vi.stubGlobal('fetch', fetchMock);

    const proof = await getApprovalAssertion('/pam/elevation-requests', 'req-9');

    // Step 1: challenge request on the resource path
    expect(fetchMock.mock.calls[0][0]).toContain('/pam/elevation-requests/req-9/assertion-challenge');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });

    // Step 2: startAuthentication called with { optionsJSON }
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });

    // Step 3: proof body shape (base64url strings from the assertion) — carries
    // the webauthn_platform discriminant for the server's approvalProofSchema.
    expect(proof).toEqual({
      type: 'webauthn_platform',
      credentialId: 'cred-1',
      authenticatorData: 'auth-data',
      clientDataJSON: 'client-data',
      signature: 'signature',
      userHandle: 'handle-1',
    });
  });

  it('getApprovalAssertion normalizes a missing userHandle to null', async () => {
    const options = { challenge: 'c', allowCredentials: [{ id: 'cred-2', type: 'public-key' }] };
    const asseResp = {
      id: 'cred-2',
      rawId: 'cred-2',
      type: 'public-key',
      response: {
        authenticatorData: 'auth-data',
        clientDataJSON: 'client-data',
        signature: 'signature',
      },
      clientExtensionResults: {},
    };
    webauthnMocks.startAuthentication.mockResolvedValueOnce(asseResp);
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(options));
    vi.stubGlobal('fetch', fetchMock);

    const proof = await getApprovalAssertion('/approvals', 'ap-1');

    expect(proof.userHandle).toBeNull();
  });

  it('getApprovalAssertion throws NoApproverDeviceError (no Hello prompt) when the challenge has no allowCredentials', async () => {
    // A technician with no registered approver device → empty allowCredentials.
    // The store must signal this BEFORE the ceremony so callers fall back to L1,
    // never firing a Windows Hello prompt the tech can't satisfy.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ challenge: 'c', allowCredentials: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getApprovalAssertion('/pam/elevation-requests', 'req-x'),
    ).rejects.toMatchObject({ name: 'NoApproverDeviceError' });
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled();
  });
});
