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
      makeJsonResponse({ error: 'organizationId is required for Cisco Umbrella' }, false, 400),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();

    render(<AddDnsIntegrationModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'umbrella' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Umbrella Prod' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('API secret'), { target: { value: 's' } });
    // Intentionally leave Organization ID blank to trigger server-side validation
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/organizationId is required/);
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
