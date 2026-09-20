import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendingDomainDto, SendingDomainsCapabilityDto, SendingDomainsListResponse } from '@breeze/shared';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));

const api = vi.hoisted(() => ({
  fetchSendingDomains: vi.fn(),
  createSendingDomain: vi.fn(),
  requestSendingDomainCheck: vi.fn(),
  removeSendingDomain: vi.fn(),
  upsertSenderIdentity: vi.fn(),
  deleteSenderIdentity: vi.fn(),
  sendSendingDomainTest: vi.fn(),
}));
vi.mock('../../lib/api/sendingDomains', () => api);

const trust = vi.hoisted(() => ({ dispatchTrustDenied: vi.fn(() => true) }));
vi.mock('../../lib/trustProbation', () => trust);

import { showToast } from '../shared/Toast';
import PartnerSendingDomainTab from './PartnerSendingDomainTab';

const showToastMock = vi.mocked(showToast);

const CAPABILITY: SendingDomainsCapabilityDto = {
  supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3,
};

function domain(over: Partial<SendingDomainDto> = {}): SendingDomainDto {
  return {
    id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'verified', statusReason: null,
    dnsRecords: [], verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null,
    lastTestError: null, lastSendError: null, lastSendErrorAt: null, providerManaged: true,
    createdAt: new Date().toISOString(), statusChangedAt: new Date().toISOString(),
    ...over,
  };
}

function payload(over: Partial<SendingDomainsListResponse> = {}): SendingDomainsListResponse {
  return { capability: CAPABILITY, domains: [], identities: [], ...over };
}

function primeTicketConfig() {
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: { inbound: { domainConfigured: true, address: 'acme@tickets.example.com' } } }),
  } as unknown as Response);
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockReset();
  trust.dispatchTrustDenied.mockReturnValue(true);
  primeTicketConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PartnerSendingDomainTab — load', () => {
  it('shows a loading state, then the empty state with the add form', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    render(<PartnerSendingDomainTab />);

    expect(screen.getByTestId('sending-domains-loading')).not.toBeNull();
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();
    expect(screen.getByTestId('sending-domains-recommendation')).not.toBeNull();
  });

  it('offers a retry when the read fails', async () => {
    api.fetchSendingDomains.mockRejectedValueOnce(new Error('boom'));
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-error')).textContent)
      .toContain('We could not load your sending domains.');
    await user.click(screen.getByTestId('sending-domains-retry'));
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();
  });

  it('renders nothing when the instance turns out to have no provider', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: false });
    const { container } = render(<PartnerSendingDomainTab />);
    await waitFor(() => expect(screen.queryByTestId('sending-domains-loading')).toBeNull());
    expect(container.querySelector('[data-testid="partner-sending-domains-tab"]')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — not eligible', () => {
  it('locks the card with the reason and hands verification to the trust banner', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({ capability: { ...CAPABILITY, eligible: false, reason: 'probation_default_deny' } }),
    });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-locked-reason')).textContent)
      .toBe('Your account is still being verified. Custom sender addresses unlock once that finishes.');
    expect(screen.queryByTestId('sending-domains-add-form')).toBeNull();

    await user.click(screen.getByTestId('sending-domains-locked-trust'));
    expect(trust.dispatchTrustDenied).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'TRUST_PROBATION', capability: 'custom_sending_domain' }),
    );
  });

  it('explains a send-only provider key and offers no trust handoff', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({ capability: { ...CAPABILITY, supported: false, eligible: false, reason: 'provider_key_send_only' } }),
    });
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-locked-reason')).textContent)
      .toContain('cannot manage domains');
    expect(screen.queryByTestId('sending-domains-locked-trust')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — static mode', () => {
  it('carries the static note and hides the DNS machinery', async () => {
    api.fetchSendingDomains.mockResolvedValue({
      supported: true,
      data: payload({
        capability: { ...CAPABILITY, provider: 'static', verifiesByDns: false },
        domains: [domain({ provider: 'static', status: 'pending' })],
      }),
    });
    render(<PartnerSendingDomainTab />);

    expect((await screen.findByTestId('sending-domains-static-note')).textContent)
      .toContain('set up outside Breeze');
    expect(screen.queryByTestId('sending-domains-records')).toBeNull();
    expect(screen.queryByTestId('sending-domain-d-1-check')).toBeNull();
  });
});

describe('PartnerSendingDomainTab — mutations', () => {
  it('adds a domain and re-reads', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    api.createSendingDomain.mockResolvedValue(domain({ status: 'provisioning' }));
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.type(await screen.findByTestId('sending-domains-add-input'), 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    await waitFor(() => expect(api.createSendingDomain).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'mail.acme.test', maxDomains: 3 }),
    ));
    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2));
  });

  it('surfaces a mutation failure as a toast and stays usable', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload() });
    api.createSendingDomain.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.type(await screen.findByTestId('sending-domains-add-input'), 'mail.acme.test');
    await user.click(screen.getByTestId('sending-domains-add-submit'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Could not add the domain.' }),
    ));
    expect((screen.getByTestId('sending-domains-add-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirms before removing via the app confirm modal (not window.confirm), and says the provider domain is kept when Breeze did not create it', async () => {
    const windowConfirm = vi.spyOn(window, 'confirm');
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ providerManaged: false })] }),
    });
    api.removeSendingDomain.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-remove'));

    // The app's own modal, not the native dialog.
    expect(windowConfirm).not.toHaveBeenCalled();
    const dialogMessage = await screen.findByText(/never deletes a domain it did not create/);
    expect(dialogMessage).toBeInTheDocument();
    expect(api.removeSendingDomain).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('sending-domains-remove-confirm'));

    expect(api.removeSendingDomain).toHaveBeenCalledWith(expect.objectContaining({ domainId: 'd-1' }));
    windowConfirm.mockRestore();
  });

  it('does not remove when the confirmation modal is cancelled', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-remove'));
    await screen.findByText(/goes back to the standard Breeze sender/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.removeSendingDomain).not.toHaveBeenCalled();
  });

  it('saves an identity through the client', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    api.upsertSenderIdentity.mockResolvedValue({ id: 'i-1' });
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-identity-support-save'));

    await waitFor(() => expect(api.upsertSenderIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ stream: 'support', sendingDomainId: 'd-1', localPart: 'support' }),
    ));
  });

  it('sends a test from a verified domain', async () => {
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    api.sendSendingDomainTest.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PartnerSendingDomainTab />);

    await user.click(await screen.findByTestId('sending-domain-d-1-test-submit'));

    await waitFor(() => expect(api.sendSendingDomainTest).toHaveBeenCalledWith(
      expect.objectContaining({ domainId: 'd-1' }),
    ));
  });
});

describe('PartnerSendingDomainTab — polling', () => {
  it('re-reads every 2 seconds while a domain is provisioning', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });

  it('re-reads every 15 seconds while a domain waits for DNS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'pending' })] }),
    });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });

  it('never polls once everything has settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({ supported: true, data: payload({ domains: [domain()] }) });
    render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    const { unmount } = render(<PartnerSendingDomainTab />);

    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);
  });

  it('stops polling while the browser tab is hidden and resumes when it comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.fetchSendingDomains.mockResolvedValue({
      supported: true, data: payload({ domains: [domain({ status: 'provisioning' })] }),
    });
    render(<PartnerSendingDomainTab />);
    await waitFor(() => expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.fetchSendingDomains).toHaveBeenCalledTimes(2);
  });
});
