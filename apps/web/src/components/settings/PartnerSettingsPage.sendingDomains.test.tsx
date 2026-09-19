import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketingSettingsTabs', () => ({ default: () => <div data-testid="stub-ticketing-settings-tabs" /> }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {} },
};

const DOMAIN = {
  id: 'd-1', domain: 'mail.acme.test', provider: 'fake', status: 'pending', statusReason: null,
  dnsRecords: [{ purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.mail.acme.test', value: 'dkim.example', status: 'pending' }],
  verifiedAt: null, lastCheckedAt: null, lastTestAt: null, lastTestStatus: null, lastTestError: null,
  lastSendError: null, lastSendErrorAt: null, providerManaged: true, createdAt: '2026-09-17T12:00:00.000Z',
  statusChangedAt: '2026-09-17T12:00:00.000Z',
};

const VERIFIED_DOMAIN = { ...DOMAIN, status: 'verified', dnsRecords: [{ ...DOMAIN.dnsRecords[0], status: 'verified' }] };

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function route(sendingDomains: unknown, status = 200) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') return Promise.resolve(json(PARTNER));
    if (url === '/partner/sending-domains') return Promise.resolve(json(sendingDomains, status));
    if (url === '/ticket-config') {
      return Promise.resolve(json({ data: { inbound: { domainConfigured: true, address: 'acme@tickets.example.com' } } }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  window.location.hash = '';
  useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

describe('PartnerSettingsPage — sending domains tab', () => {
  it('hides the tab when this instance has no provider configured', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await screen.findByTestId('partner-settings-tab-company');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/partner/sending-domains', expect.anything()));
    expect(screen.queryByTestId('partner-settings-tab-sendingDomains')).toBeNull();
  });

  it('shows the tab in the communications group when a provider is configured', async () => {
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    render(<PartnerSettingsPage />);

    const link = await screen.findByTestId('partner-settings-tab-sendingDomains');
    expect(link.getAttribute('href')).toBe('#sending-domains');
    // Communications group: it sits with Notifications, Ticketing and the AI tabs.
    const group = link.closest('div')!;
    expect(group.textContent).toContain('Communications');
  });

  it('mounts the tab from the URL hash and renders every child module', async () => {
    window.location.hash = '#sending-domains';
    route({
      capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 },
      domains: [VERIFIED_DOMAIN],
      identities: [],
    });
    render(<PartnerSettingsPage />);

    // The tab itself...
    expect(await screen.findByTestId('partner-sending-domains-tab')).not.toBeNull();
    // ...and one testid from each child module it must compose.
    expect(await screen.findByTestId('sending-domains-add-form')).not.toBeNull();       // AddDomainForm
    expect(screen.getByTestId('sending-domain-row-d-1')).not.toBeNull();                 // DomainStatusPanel
    expect(screen.getByTestId('sending-domains-records')).not.toBeNull();                // DnsRecordsTable
    expect(screen.getByTestId('sending-domain-d-1-test')).not.toBeNull();                // TestSendControl
    expect(screen.getByTestId('sending-domains-identities')).not.toBeNull();             // SenderIdentitiesForm
  });

  it('is self-saving: the page shows no global Save button on this tab', async () => {
    window.location.hash = '#sending-domains';
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    render(<PartnerSettingsPage />);

    await screen.findByTestId('partner-sending-domains-tab');
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });

  it('falls back to the Company tab when the hash names a tab this instance hides', async () => {
    window.location.hash = '#sending-domains';
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await waitFor(() => expect(screen.queryByTestId('partner-sending-domains-tab')).toBeNull());
    expect(await screen.findByRole('button', { name: /save settings/i })).not.toBeNull();
  });
});
