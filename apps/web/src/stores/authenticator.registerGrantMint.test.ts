import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9007 — the request shape and grant lifecycle of
 * POST /authenticator/register-grant, with `fetchWithAuth` mocked so the init
 * it receives can be inspected (authenticator.test.ts stubs the global fetch
 * underneath the real `fetchWithAuth`, which strips the option before fetch).
 */

const { fetchWithAuthMock, startRegistrationMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  startRegistrationMock: vi.fn(),
}));

vi.mock('./auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: startRegistrationMock,
}));

import { registerApproverDevice } from './authenticator';

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('register-grant mint (#9007)', () => {
  beforeEach(() => vi.clearAllMocks());

  // A rejected proof is a 400 since #9007 PR 1, so a 401 from this route is
  // only ever the auth middleware refusing the bearer — before the body (or a
  // single-use SSO grant) is read. fetchWithAuth's refresh-and-replay is then
  // safe, and it saves a still-valid grant from a needless IdP round-trip.
  it.each([
    ['password', { method: 'password' as const, password: 'hunter2!' }],
    ['sso', { method: 'sso' as const, ssoReauthGrantId: 'sso-g' }],
  ])('%s road lets fetchWithAuth refresh a dead bearer (no skipUnauthorizedRetry)', async (_road, reauth) => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ error: 'Invalid or expired token' }, 401));

    await expect(registerApproverDevice('x', reauth)).rejects.toMatchObject({ status: 401 });
    expect(String(fetchWithAuthMock.mock.calls[0][0])).toBe('/authenticator/register-grant');
    expect(fetchWithAuthMock.mock.calls[0][1].skipUnauthorizedRetry).toBeUndefined();
  });

  it('reports the register grant minted after the exchange and before the ceremony', async () => {
    const order: string[] = [];
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      order.push(url);
      if (url === '/authenticator/register-grant') return json({ registerGrantId: 'g-1' });
      if (url === '/authenticator/devices/webauthn/options') return json({ options: { challenge: 'c' } });
      return json({ success: true });
    });
    startRegistrationMock.mockImplementation(async () => {
      order.push('ceremony');
      return { id: 'cred' };
    });
    const onRegisterGrantMinted = vi.fn(() => order.push('minted'));

    await registerApproverDevice('x', { method: 'sso', ssoReauthGrantId: 'sso-g' }, { onRegisterGrantMinted });

    expect(onRegisterGrantMinted).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      '/authenticator/register-grant',
      'minted',
      '/authenticator/devices/webauthn/options',
      'ceremony',
      '/authenticator/devices/webauthn/verify',
    ]);
  });

  it('does not report a mint when the exchange is refused', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ error: 'x', code: 'enrollment_grant_expired' }, 400));
    const onRegisterGrantMinted = vi.fn();

    await expect(
      registerApproverDevice('x', { method: 'sso', ssoReauthGrantId: 'sso-g' }, { onRegisterGrantMinted }),
    ).rejects.toMatchObject({ status: 400 });
    expect(onRegisterGrantMinted).not.toHaveBeenCalled();
  });
});
