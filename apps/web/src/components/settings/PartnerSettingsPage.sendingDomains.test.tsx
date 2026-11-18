import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import PartnerSettingsPage from './PartnerSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useFeaturesStore } from '../../stores/featuresStore';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // The header Save gates on partner-wide access (W2).
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: vi.fn(() => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' })),
  loginPathWithNext: () => '/login',
}));
vi.mock('../auth/MfaPolicyOffBanner', () => ({ PARTNER_SETTINGS_SAVED_EVENT: 'breeze:partner-settings-saved', default: () => null }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketingSettingsTabs', () => ({ default: () => <div data-testid="stub-ticketing-settings-tabs" /> }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const PARTNER = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z',
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', contact: {} },
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

// `sendingDomainsFlag` is what GET /config reports for features.sendingDomains:
// true exactly when EMAIL_DOMAINS_PROVIDER is set, which is also exactly when
// the list route answers 200 rather than 404 (#9949).
function route(sendingDomains: unknown, status = 200, sendingDomainsFlag = status !== 404) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/config') return Promise.resolve(json({ features: { sendingDomains: sendingDomainsFlag } }));
    if (url === '/orgs/partners/me') return Promise.resolve(json(PARTNER));
    if (url === '/partner/sending-domains') return Promise.resolve(json(sendingDomains, status));
    if (url === '/ticket-config') {
      return Promise.resolve(json({ data: { inbound: { domainConfigured: true, address: 'acme@tickets.example.com' } } }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

const calls = (url: string) => fetchWithAuthMock.mock.calls.filter(([u]) => u === url).length;

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  window.location.hash = '';
  // The store is a module singleton; every test starts from "not yet read".
  // A failed /config leaves `features` untouched, so reset the flag too.
  useFeaturesStore.setState({ loaded: false, features: { ...useFeaturesStore.getState().features, sendingDomains: false } });
  useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
});

describe('PartnerSettingsPage — sending domains tab', () => {
  it('hides the tab and never requests the list when /config reports the feature off (#9949)', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await screen.findByTestId('partner-settings-tab-company');
    await waitFor(() => expect(calls('/config')).toBeGreaterThan(0));
    // Let the side reads that follow partners/me settle before asserting absence.
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls('/partner/sending-domains')).toBe(0);
    expect(screen.queryByTestId('partner-settings-tab-sendingDomains')).toBeNull();
  });

  it('still hides the tab when the flag is on but the list read 404s', async () => {
    route({ error: 'not_found' }, 404, true);
    render(<PartnerSettingsPage />);

    await waitFor(() => expect(calls('/partner/sending-domains')).toBe(1));
    expect(screen.queryByTestId('partner-settings-tab-sendingDomains')).toBeNull();
  });

  it('reads partners/me and probes the list once while the org store refetches (#9949)', async () => {
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    const view = render(<PartnerSettingsPage />);
    await screen.findByTestId('partner-settings-tab-sendingDomains');

    // The org switcher's partners/orgs/sites fetches flip isLoading while the
    // partner id stays put. None of those flips is a partner switch.
    for (const isLoading of [true, false, true, false]) {
      useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading, adoptPartnerId: vi.fn() } as never);
      view.rerender(<PartnerSettingsPage />);
    }
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(calls('/orgs/partners/me')).toBe(1);
    expect(calls('/partner/sending-domains')).toBe(1);
  });

  it('falls back to the direct list read when /config itself could not be read', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    const base = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) =>
      url === '/config' ? Promise.resolve(json({ error: 'bad gateway' }, 502)) : base(url, init));
    render(<PartnerSettingsPage />);

    // A transient /config failure must not hide a configured feature for the session.
    expect(await screen.findByTestId('partner-settings-tab-sendingDomains')).not.toBeNull();
    expect(calls('/partner/sending-domains')).toBe(1);
    errSpy.mockRestore();
  });

  it('keeps an unsaved edit while the org store refetches (#9949)', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    const view = render(<PartnerSettingsPage />);
    const name = await screen.findByLabelText(/company name/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Acme MSP Renamed' } });

    for (const isLoading of [true, false]) {
      useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading, adoptPartnerId: vi.fn() } as never);
      view.rerender(<PartnerSettingsPage />);
    }
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect((screen.getByLabelText(/company name/i) as HTMLInputElement).value).toBe('Acme MSP Renamed');
    expect((screen.getByTestId('partner-settings-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Retry reloads after a failed partners/me read', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    const base = fetchWithAuthMock.getMockImplementation()!;
    let failFirst = true;
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/orgs/partners/me' && failFirst) {
        failFirst = false;
        return Promise.resolve(json({ error: 'boom' }, 500));
      }
      return base(url, init);
    });
    render(<PartnerSettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText(/company name/i)).not.toBeNull();
    expect(calls('/orgs/partners/me')).toBe(2);
  });

  it('reloads when the partner id clears and comes back', async () => {
    route({ error: 'sending_domains_unsupported' }, 404);
    const view = render(<PartnerSettingsPage />);
    await screen.findByLabelText(/company name/i);

    useOrgStoreMock.mockReturnValue({ currentPartnerId: null, isLoading: true, adoptPartnerId: vi.fn() } as never);
    view.rerender(<PartnerSettingsPage />);
    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-1', isLoading: false, adoptPartnerId: vi.fn() } as never);
    view.rerender(<PartnerSettingsPage />);

    await waitFor(() => expect(calls('/orgs/partners/me')).toBe(2));
  });

  it('reloads when the partner actually changes', async () => {
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    const view = render(<PartnerSettingsPage />);
    await screen.findByTestId('partner-settings-tab-sendingDomains');

    useOrgStoreMock.mockReturnValue({ currentPartnerId: 'partner-2', isLoading: false, adoptPartnerId: vi.fn() } as never);
    view.rerender(<PartnerSettingsPage />);

    await waitFor(() => expect(calls('/orgs/partners/me')).toBe(2));
    await waitFor(() => expect(calls('/partner/sending-domains')).toBe(2));
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

  // W2: the header Save shows on every tab; a list tab leaves it disabled while nothing else is dirty.
  it('a list tab: the header Save stays, disabled while nothing is dirty', async () => {
    window.location.hash = '#sending-domains';
    route({ capability: { supported: true, provider: 'fake', verifiesByDns: true, eligible: true, maxDomains: 3 }, domains: [], identities: [] });
    render(<PartnerSettingsPage />);

    await screen.findByTestId('partner-sending-domains-tab');
    expect((screen.getByTestId('partner-settings-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to the Company tab when the hash names a tab this instance hides', async () => {
    window.location.hash = '#sending-domains';
    route({ error: 'sending_domains_unsupported' }, 404);
    render(<PartnerSettingsPage />);

    await waitFor(() => expect(screen.queryByTestId('partner-sending-domains-tab')).toBeNull());
    expect(await screen.findByRole('button', { name: /save settings/i })).not.toBeNull();
  });
});
