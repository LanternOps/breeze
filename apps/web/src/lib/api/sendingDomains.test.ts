import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { showToast } from '../../components/shared/Toast';
import {
  SENDING_DOMAINS_PATH,
  createSendingDomain,
  deleteSenderIdentity,
  fetchSendingDomains,
  removeSendingDomain,
  requestSendingDomainCheck,
  sendSendingDomainTest,
  sendingDomainFriendlyError,
  upsertSenderIdentity,
} from './sendingDomains';

const showToastMock = vi.mocked(showToast);

function res(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const onUnauthorized = vi.fn();
const base = { maxDomains: 3, onUnauthorized };

beforeEach(() => {
  fetchWithAuth.mockReset();
  onUnauthorized.mockReset();
});

describe('fetchSendingDomains', () => {
  it('never lets fetchWithAuth inject the ambient orgId — this is a partner-axis surface', async () => {
    fetchWithAuth.mockResolvedValue(res({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] }));
    await fetchSendingDomains();
    expect(fetchWithAuth).toHaveBeenCalledWith(SENDING_DOMAINS_PATH, { skipOrgIdInjection: true });
  });

  it('reports an unconfigured instance as unsupported rather than throwing', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'sending_domains_unsupported' }, 404));
    expect(await fetchSendingDomains()).toEqual({ supported: false });
  });

  it('throws on any other non-ok status so the tab can show its load-failed state', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'boom' }, 500));
    await expect(fetchSendingDomains()).rejects.toThrow();
  });
});

describe('sendingDomainFriendlyError', () => {
  it.each([
    ['domain_unavailable', 'This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.'],
    ['rate_limited', 'Too many attempts. Wait a moment and try again.'],
    ['not_found', 'That domain is no longer there. Refresh the page.'],
    ['domain_not_sendable', 'That domain is not verified yet, so it cannot be a sender address.'],
    ['sending_domains_unsupported', 'Custom sender addresses are not switched on for this server.'],
  ])('maps %s', (code, copy) => {
    expect(sendingDomainFriendlyError(3)(code)).toBe(copy);
  });

  it('interpolates the cap into domain_limit_reached', () => {
    expect(sendingDomainFriendlyError(5)('domain_limit_reached')).toBe(
      'You can hold at most 5 sending domains. Remove one first.',
    );
  });

  it('returns undefined for an unknown code so runAction keeps the server prose', () => {
    expect(sendingDomainFriendlyError(3)('something_else')).toBeUndefined();
  });
});

describe('mutations', () => {
  it('POSTs the domain and toasts success', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: DOMAIN_ID, domain: 'mail.acme.test', status: 'provisioning' }, 201));
    const created = await createSendingDomain({ ...base, domain: 'mail.acme.test' });
    expect(created.id).toBe(DOMAIN_ID);
    expect(fetchWithAuth).toHaveBeenCalledWith(SENDING_DOMAINS_PATH, {
      method: 'POST',
      body: JSON.stringify({ domain: 'mail.acme.test' }),
      skipOrgIdInjection: true,
    });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Domain added. Preparing DNS records.' }),
    );
  });

  it('surfaces a 409 domain_unavailable as our copy, not the raw token', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'domain_unavailable', message: 'server prose' }, 409));
    await expect(createSendingDomain({ ...base, domain: 'acme.test' })).rejects.toThrow();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'This domain may already be registered with Breeze or with our email provider. Use a dedicated subdomain, or contact support.',
      }),
    );
  });

  it('calls onUnauthorized and shows no toast on 401', async () => {
    fetchWithAuth.mockResolvedValue(res({}, 401));
    await expect(createSendingDomain({ ...base, domain: 'acme.test' })).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('POSTs a check to /:id/check', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: DOMAIN_ID, status: 'pending' }, 202));
    await requestSendingDomainCheck({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}/check`, {
      method: 'POST',
      skipOrgIdInjection: true,
    });
  });

  it('DELETEs the domain', async () => {
    fetchWithAuth.mockResolvedValue(res({ status: 'removing' }, 202));
    await removeSendingDomain({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}`, {
      method: 'DELETE',
      skipOrgIdInjection: true,
    });
  });

  it('PUTs an identity with the stream in the path and never in the body', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: 'i-1', stream: 'support', localPart: 'support' }));
    await upsertSenderIdentity({
      ...base, stream: 'support', sendingDomainId: DOMAIN_ID,
      localPart: 'support', displayName: 'Acme Support', replyTo: null,
    });
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(`${SENDING_DOMAINS_PATH}/identities/support`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      sendingDomainId: DOMAIN_ID, localPart: 'support', displayName: 'Acme Support', replyTo: null,
    });
  });

  it('treats the 204 from a cleared identity as success, not a failure', async () => {
    fetchWithAuth.mockResolvedValue({
      ok: true, status: 204, json: async () => { throw new Error('no body'); },
    } as unknown as Response);
    await expect(deleteSenderIdentity({ ...base, stream: 'billing' })).resolves.toBeUndefined();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Back on the standard Breeze sender.' }),
    );
  });

  it('POSTs a test send', async () => {
    fetchWithAuth.mockResolvedValue(res({ status: 'queued' }, 202));
    await sendSendingDomainTest({ ...base, domainId: DOMAIN_ID });
    expect(fetchWithAuth).toHaveBeenCalledWith(`${SENDING_DOMAINS_PATH}/${DOMAIN_ID}/test`, {
      method: 'POST',
      skipOrgIdInjection: true,
    });
  });

  it('maps the test-send 429 to the rate-limit copy', async () => {
    fetchWithAuth.mockResolvedValue(res({ error: 'rate_limited', message: 'Too many test sends.' }, 429));
    await expect(sendSendingDomainTest({ ...base, domainId: DOMAIN_ID })).rejects.toThrow();
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Too many attempts. Wait a moment and try again.' }),
    );
  });
});
