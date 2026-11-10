import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { ActionError } from '@/lib/runAction';
import { confirmRequiredImpact, sendSsoInvites, withAcknowledge } from './ssoOnlyActions';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

const ORG = '11111111-1111-4111-8111-111111111111';
const URL_ = `/orgs/organizations/${ORG}/portal-users/sso-invite`;
const t = i18n.getFixedT('en', 'settings');

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
const invitedAll = (init: RequestInit) => {
  const { portalUserIds } = JSON.parse(init.body as string) as { portalUserIds: string[] };
  return json({ data: portalUserIds.map((portalUserId) => ({ portalUserId, result: 'invited', emailSent: true })) });
};

describe('sendSsoInvites', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
  });

  it('de-duplicates ids and sends one success toast', async () => {
    fetchWithAuthMock.mockImplementation((_url: string, init: RequestInit) => invitedAll(init));
    const result = await sendSsoInvites(ORG, ['a', 'b', 'a'], t, vi.fn());
    expect(result).toEqual({ invited: 2, total: 2, emailFailed: 0 });
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body)).toEqual({ portalUserIds: ['a', 'b'] });
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'Sent 2 Microsoft sign-in invite(s).' });
  });

  it('rows not invited give a partial warning, never success', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: [
      { portalUserId: 'a', result: 'invited', emailSent: true },
      { portalUserId: 'b', result: 'not_stranded' },
    ] }));
    expect(await sendSsoInvites(ORG, ['a', 'b'], t, vi.fn())).toEqual({ invited: 1, total: 2, emailFailed: 0 });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('Sent 1 of 2') }));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('an invite whose email was not sent is not reported as sent', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ data: [
      { portalUserId: 'a', result: 'invited', emailSent: true },
      { portalUserId: 'b', result: 'invited', emailSent: false },
    ] }));
    expect(await sendSsoInvites(ORG, ['a', 'b'], t, vi.fn())).toEqual({ invited: 1, total: 2, emailFailed: 1 });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', message: expect.stringContaining("their invite email couldn't be sent"),
    }));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a failed batch stops the run, warns with the partial count and rethrows', async () => {
    let call = 0;
    fetchWithAuthMock.mockImplementation((_url: string, init: RequestInit) => {
      call += 1;
      return call === 2 ? json({ error: 'boom' }, 500) : invitedAll(init);
    });
    await expect(sendSsoInvites(ORG, ids(250), t, vi.fn())).rejects.toBeInstanceOf(ActionError);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2); // batch 3 never sent
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('Sent 100 of 250') }));
  });

  it('PORTAL_SSO_INVITE_UNAVAILABLE shows its own message', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'x', code: 'PORTAL_SSO_INVITE_UNAVAILABLE' }, 409));
    await expect(sendSsoInvites(ORG, ['a'], t, vi.fn())).rejects.toBeInstanceOf(ActionError);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining("Microsoft sign-in isn't available for this organization"),
    }));
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe(URL_);
  });
});

describe('confirmRequiredImpact / withAcknowledge', () => {
  it('reads the impact only from a 409 SSO_ONLY_CONFIRM_REQUIRED with a valid body', () => {
    const impact = { flips: [{ orgId: ORG, orgName: 'Acme', passwordsToClear: 1, strandedTotal: 0 }], impactDigest: 'd1' };
    const err = (status: number, code: string, body: unknown) => new ActionError('x', status, code, body);
    expect(confirmRequiredImpact(err(409, 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED', { impact }))).toEqual(impact);
    expect(confirmRequiredImpact(err(409, 'OTHER', { impact }))).toBeNull();
    expect(confirmRequiredImpact(err(400, 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED', { impact }))).toBeNull();
    expect(confirmRequiredImpact(err(409, 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED', { impact: { flips: [] } }))).toBeNull();
    expect(confirmRequiredImpact(new Error('x'))).toBeNull();
  });

  it('encodes the digest into the query', () => {
    expect(withAcknowledge('/p', null)).toBe('/p');
    expect(withAcknowledge('/p', 'a b&c')).toBe('/p?acknowledge=a%20b%26c');
  });
});
