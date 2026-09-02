import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fetchWithAuthMock, startAuthenticationMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  startAuthenticationMock: vi.fn(),
}));

vi.mock('../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: startAuthenticationMock }));

import { mintStepUpGrant } from './mfaStepUp';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('mintStepUpGrant (RMM-QA-176 D10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a TOTP body carrying the operation and its resource binding', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-1' }));
    const resource = { deviceIds: ['d1'], reason: 'scheduled patching', durationHours: 2 };

    const grant = await mintStepUpGrant({
      operation: 'device_maintenance',
      resource,
      reauth: { method: 'totp', code: '123456' },
    });

    expect(grant).toBe('grant-1');
    const [path, init] = fetchWithAuthMock.mock.calls[0];
    expect(path).toBe('/auth/mfa/step-up');
    expect(JSON.parse(init.body)).toEqual({
      method: 'totp',
      code: '123456',
      operation: 'device_maintenance',
      resource,
    });
  });

  it('runs the passkey ceremony BEFORE proving it, in order', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(ok({ options: { challenge: 'c' } }))
      .mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-2' }));
    startAuthenticationMock.mockResolvedValueOnce({ id: 'credential-1' });

    const grant = await mintStepUpGrant({
      operation: 'device_maintenance',
      resource: { deviceIds: ['d1'], reason: 'r r r', durationHours: 1 },
      reauth: { method: 'passkey' },
    });

    expect(grant).toBe('grant-2');
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe('/auth/mfa/step-up/options');
    expect(startAuthenticationMock).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(JSON.parse(fetchWithAuthMock.mock.calls[1][1].body)).toMatchObject({
      method: 'passkey',
      credential: { id: 'credential-1' },
    });
  });

  it('never replays the mint on a 401 — a 401 means a bad code, not a stale token', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid code' }),
    });

    await expect(
      mintStepUpGrant({ operation: 'device_maintenance', reauth: { method: 'totp', code: '000000' } }),
    ).rejects.toMatchObject({ code: 'invalid_factor' });
    // The store's rationale (authenticator.ts) applies verbatim: replaying
    // would resubmit the same rejected factor.
    expect(fetchWithAuthMock.mock.calls[0][1].skipUnauthorizedRetry).toBe(true);
  });

  it('maps a 5xx to unavailable, distinctly from a rejected factor', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(
      mintStepUpGrant({ operation: 'device_maintenance', reauth: { method: 'totp', code: '123456' } }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('omits `resource` entirely when the operation is not resource-bound', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-3' }));
    await mintStepUpGrant({
      operation: 'register_approver_device',
      reauth: { method: 'totp', code: '123456' },
    });
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body)).not.toHaveProperty('resource');
    // The mint route 400s an unbound operation that carries a resource
    // (RESOURCE_BOUND_OPERATIONS, routes/auth/mfa.ts) — sending `resource:
    // undefined` would serialise it away, but an explicit null would not.
  });

  it('a 2xx with an unparseable body is a clean StepUpMintError, not a raw SyntaxError', async () => {
    // Behaviour parity with the store's jsonOrThrow, which this helper replaces
    // for the TOTP/passkey branches: every caller immediately reads
    // `stepUpGrantId` off the result.
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    await expect(
      mintStepUpGrant({ operation: 'device_maintenance', reauth: { method: 'totp', code: '123456' } }),
    ).rejects.toMatchObject({ name: 'StepUpMintError', message: 'Unexpected server response.' });
  });
});
