import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddDnsIntegrationModal from './AddDnsIntegrationModal';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load; the component now
  // pulls in orgStore via useFleetOrgOwner, so this export must exist.
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const orgA: Organization = {
  id: 'org-aaaa',
  partnerId: 'p-1',
  name: 'Acme Corp',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};
const orgB: Organization = {
  id: 'org-bbbb',
  partnerId: 'p-1',
  name: 'Beta Inc',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('AddDnsIntegrationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to a concrete-org (non-fleet) scope so the picker stays hidden
    // unless a test explicitly opts into the All-orgs view.
    useOrgStore.setState({
      currentOrgId: 'org-aaaa',
      allOrgs: false,
      organizations: [orgA, orgB],
      organizationsLoaded: true,
      error: null,
    });
  });

  it('only lists the 5 supported providers (opendns + quad9 hidden)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    const select = screen.getByLabelText('Provider') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual([
      'umbrella',
      'cloudflare',
      'dnsfilter',
      'pihole',
      'adguard_home',
    ]);
    expect(options).not.toContain('opendns');
    expect(options).not.toContain('quad9');
  });

  it('renders Cloudflare-specific fields (Account ID, no apiSecret)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    // Default selection is cloudflare
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
    expect(screen.getByLabelText('Account ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('API secret')).toBeNull();
    expect(screen.queryByLabelText('HTTP Basic password')).toBeNull();
  });

  it('switches to Umbrella-specific fields when provider changes', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'umbrella' } });
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByLabelText('API secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization ID')).toBeInTheDocument();
  });

  it('switches to AdGuard Home fields (HTTP Basic username + password + endpoint)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'adguard_home' } });
    expect(screen.getByLabelText('HTTP Basic username')).toBeInTheDocument();
    expect(screen.getByLabelText('HTTP Basic password')).toBeInTheDocument();
    expect(screen.getByLabelText('API endpoint')).toBeInTheDocument();
  });

  // #12699 — DNSFilter takes a numeric organization id and a policy id; its
  // API has no account ids, so the old "Account ID" field is gone.
  it('sends DNSFilter organizationId and policyId, not accountId', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-dnsf' } }));
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'dnsfilter' } });

    expect(screen.queryByLabelText(/Account ID/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'DNSFilter' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'dnsf-key' } });
    fireEvent.change(screen.getByLabelText('Organization ID (optional)'), { target: { value: ' 1001 ' } });
    fireEvent.change(screen.getByLabelText('Policy ID (optional)'), { target: { value: '7' } });
    fireEvent.submit(screen.getByLabelText('Display name').closest('form')!);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchWithAuthMock.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ provider: 'dnsfilter', config: { organizationId: '1001', policyId: '7' } });
    expect(body.config).not.toHaveProperty('accountId');
  });

  describe('credential field masking (#12555)', () => {
    const typeOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).type;
    const pick = (provider: string) =>
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: provider } });

    it('masks the Pi-hole API key (v5) and App password (v6)', () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      pick('pihole');
      expect(typeOf('API key')).toBe('password');
      expect((screen.getByLabelText('API key') as HTMLInputElement).autocomplete).toBe('new-password');
      fireEvent.change(screen.getByLabelText('Pi-hole version'), { target: { value: 'v6' } });
      expect(typeOf('App password')).toBe('password');
      expect((screen.getByLabelText('App password') as HTMLInputElement).autocomplete).toBe('new-password');
    });

    it('masks the Cloudflare API token and the DNSFilter API key', () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      expect(typeOf('API token')).toBe('password');
      pick('dnsfilter');
      expect(typeOf('API key')).toBe('password');
    });

    it('leaves identifier fields (Umbrella API key, AdGuard username) readable', () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      pick('umbrella');
      expect(typeOf('API key')).toBe('text');
      expect(typeOf('API secret')).toBe('password');
      pick('adguard_home');
      expect(typeOf('HTTP Basic username')).toBe('text');
      expect(typeOf('HTTP Basic password')).toBe('password');
    });
  });

  it('shows the Pi-hole version select only for Pi-hole and sends config.piholeVersion (#12507)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-2' } }));
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    expect(screen.queryByLabelText('Pi-hole version')).toBeNull();

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'pihole' } });
    const version = screen.getByLabelText('Pi-hole version') as HTMLSelectElement;
    expect(Array.from(version.options).map((o) => o.value)).toEqual(['v5', 'v6']);
    expect(version.value).toBe('v5');
    fireEvent.change(version, { target: { value: 'v6' } });
    expect(screen.getByLabelText('App password')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Office Pi-hole' } });
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'app-pw' } });
    fireEvent.change(screen.getByLabelText('API endpoint'), { target: { value: 'http://pihole.local' } });
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({
      provider: 'pihole',
      apiKey: 'app-pw',
      config: { apiEndpoint: 'http://pihole.local', piholeVersion: 'v6' },
    });
  });

  it('sends piholeVersion v5 explicitly when the Pi-hole select is left alone', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-4' } }));
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'pihole' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Pi' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.config).toEqual({ piholeVersion: 'v5' });
  });

  it('does not leak piholeVersion into other providers after switching away', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-3' } }));
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'pihole' } });
    fireEvent.change(screen.getByLabelText('Pi-hole version'), { target: { value: 'v6' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'cloudflare' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'CF' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 't' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.config).toEqual({ accountId: 'abc' });
  });

  it('submits a Cloudflare integration via POST /dns-security/integrations with the right shape', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-1' } }));
    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(<AddDnsIntegrationModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme HQ' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cf-token-abc' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '0123456789abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/dns-security/integrations',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      provider: 'cloudflare',
      name: 'Acme HQ',
      apiKey: 'cf-token-abc',
      config: { accountId: '0123456789abcdef' },
      isActive: true,
    });
    expect(body.apiSecret).toBeUndefined();
    // Focused scope must still send the concrete org in the body — the DNS
    // route reads only body.orgId, never the injected query (#3505).
    expect(body.orgId).toBe('org-aaaa');
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/Cloudflare/) }),
      );
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders inline error and keeps modal open when API rejects (does NOT close on failure)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Cisco Umbrella rejected the supplied credentials' }, false, 400),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();

    render(<AddDnsIntegrationModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'umbrella' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Umbrella Prod' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('API secret'), { target: { value: 's' } });
    // Organization ID stays blank on purpose: it is optional since #4597, so
    // the rejection here is the server's, not a client-side validation gate.
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/rejected the supplied credentials/);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  describe('All-organizations (fleet) scope', () => {
    beforeEach(() => {
      // Explicit All-orgs view: no injected ?orgId=, so the picker is required.
      useOrgStore.setState({
        currentOrgId: null,
        allOrgs: true,
        organizations: [orgA, orgB],
        organizationsLoaded: true,
        error: null,
      });
    });

    it('renders an Organization picker listing the accessible orgs', () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      const select = screen.getByLabelText('Organization') as HTMLSelectElement;
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels).toContain('Acme Corp');
      expect(labels).toContain('Beta Inc');
    });

    it('keeps the submit button disabled until an org is chosen', () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme HQ' } });
      fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cf-token-abc' } });
      const submit = screen.getByRole('button', { name: /Add integration/i });
      expect(submit).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-bbbb' } });
      expect(submit).toBeEnabled();
    });

    it('guards a programmatic submit with an in-form error and no request', async () => {
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme HQ' } });
      fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cf-token-abc' } });
      // Bypass the disabled button (Enter-key / programmatic path) by dispatching
      // submit straight to the form — the JS guard must still stop it.
      const form = screen.getByLabelText('Organization').closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/Select an organization/i);
      });
      expect(fetchWithAuthMock).not.toHaveBeenCalled();
    });

    it('includes the chosen orgId in the POST body once an org is selected', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-1' } }));
      render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-bbbb' } });
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme HQ' } });
      fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cf-token-abc' } });
      fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '0123456789abcdef' } });
      fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

      await waitFor(() => {
        expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
      });
      const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.orgId).toBe('org-bbbb');
    });
  });
});
