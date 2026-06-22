import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => 'https://us.2breeze.app')
}));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

import SecurityIntegration from './SecurityIntegration';
import { useOrgStore } from '../../stores/orgStore';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const existingIntegration = {
  id: 's1-1',
  partnerId: 'partner-1',
  name: 'Production S1',
  managementUrl: 'https://acme.sentinelone.net',
  isActive: true,
  lastSyncAt: '2026-06-18T12:00:00.000Z',
  lastSyncStatus: 'success',
  lastSyncError: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

const breezeOrg = { id: '00000000-0000-4000-8000-000000000001', name: 'Acme Corp' };

const summary = {
  totalAgents: 10,
  mappedDevices: 8,
  infectedAgents: 0,
  activeThreats: 0,
  highOrCriticalThreats: 0,
  pendingActions: 0,
  reportedThreatCount: 0
};

const discoveredSite = {
  s1SiteId: 's1-site-1',
  s1SiteName: 'Acme Site',
  agentsCount: 5,
  mappedOrgId: null,
  mappedOrgName: null,
  provisional: false
};

/** Mock the partner-scope load fan-out: integration + status + sites + orgs. */
function mockPartnerLoad(
  options: { integration?: typeof existingIntegration | null; sites?: unknown[] } = {}
) {
  const integration = options.integration === undefined ? null : options.integration;
  const sites = options.sites ?? [];
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/s1/integration' && init?.method === 'POST') {
      return jsonResponse({ data: { ...existingIntegration } }, integration ? 200 : 201);
    }
    if (url === '/s1/organizations/map' && init?.method === 'POST') {
      return jsonResponse({ data: { ...discoveredSite, mappedOrgId: breezeOrg.id, mappedOrgName: breezeOrg.name } });
    }
    if (url === '/s1/sync' && init?.method === 'POST') return jsonResponse({ queued: true });
    if (url === '/s1/integration') return jsonResponse({ data: integration });
    if (url === '/s1/status') return jsonResponse({ summary, mapped: true });
    if (url === '/s1/sites') return jsonResponse({ data: sites, integrationId: integration?.id ?? null });
    if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
    return jsonResponse({}, 404);
  });
}

describe('SecurityIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: breezeOrg.id });
  });

  it('renders the credential form and a mapping row in partner view', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration, sites: [discoveredSite] });

    render(<SecurityIntegration />);

    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());
    // Credential form
    expect(screen.getByTestId('s1-name')).toBeInTheDocument();
    expect(screen.getByTestId('s1-management-url')).toBeInTheDocument();
    expect(screen.getByTestId('s1-api-token')).toBeInTheDocument();
    // Mapping table + discovered site row
    expect(screen.getByText('Site mapping')).toBeInTheDocument();
    expect(screen.getByText('Acme Site')).toBeInTheDocument();
    expect(screen.getByTestId('s1-site-s1-site-1')).toBeInTheDocument();

    expect(fetchWithAuth).toHaveBeenCalledWith('/s1/integration');
    expect(fetchWithAuth).toHaveBeenCalledWith('/s1/sites');
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/organizations');
  });

  it('shows a "pending sync" hint for provisional sites', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: existingIntegration,
      sites: [{ ...discoveredSite, s1SiteId: 'name:Legacy', s1SiteName: 'Legacy', provisional: true }]
    });

    render(<SecurityIntegration />);
    await waitFor(() => expect(screen.getByText('Site mapping')).toBeInTheDocument());
    expect(screen.getByText(/pending sync/i)).toBeInTheDocument();
  });

  it('maps a discovered site to a Breeze org and posts the right body', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration, sites: [discoveredSite] });

    render(<SecurityIntegration />);
    await waitFor(() => expect(screen.getByText('Site mapping')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('s1-site-map-s1-site-1'), { target: { value: breezeOrg.id } });

    await waitFor(() => {
      expect(
        fetchWithAuth.mock.calls.some(([url, init]) => url === '/s1/organizations/map' && init?.method === 'POST')
      ).toBe(true);
    });
    const mapCall = fetchWithAuth.mock.calls.find(
      ([url, init]) => url === '/s1/organizations/map' && init?.method === 'POST'
    );
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      integrationId: 's1-1',
      s1SiteId: 's1-site-1',
      orgId: breezeOrg.id
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders read-only status in org view when the org is mapped', async () => {
    // org scope (currentOrgId set in beforeEach)
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/s1/integration') return jsonResponse({ data: existingIntegration, mapped: true });
      if (url === '/s1/status') return jsonResponse({ summary, mapped: true });
      return jsonResponse({}, 404);
    });

    render(<SecurityIntegration />);

    await waitFor(() => expect(screen.getByTestId('s1-sync-status')).toBeInTheDocument());
    // No credential form / mapping table in org scope.
    expect(screen.queryByText('Partner connection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('s1-name')).not.toBeInTheDocument();
    expect(screen.queryByText('Site mapping')).not.toBeInTheDocument();
    // Coverage is shown read-only.
    expect(screen.getByTestId('s1-coverage')).toBeInTheDocument();
    // Partner-only endpoints are not called in org scope.
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/s1/sites');
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/orgs/organizations');
  });

  it('renders the amber "not mapped" notice in org view when unmapped (not a switch-scope prompt)', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/s1/integration') return jsonResponse({ data: existingIntegration, mapped: false });
      if (url === '/s1/status') return jsonResponse({ summary: null, mapped: false });
      return jsonResponse({}, 404);
    });

    render(<SecurityIntegration />);

    await waitFor(() => expect(screen.getByTestId('s1-org-unmapped')).toBeInTheDocument());
    expect(screen.getByText(/isn't mapped to a SentinelOne site yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Partner connection')).not.toBeInTheDocument();
    expect(screen.queryByTestId('s1-name')).not.toBeInTheDocument();
  });

  it('saves credentials via runAction with the right body', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: null });

    render(<SecurityIntegration />);
    await screen.findByTestId('s1-panel');
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('s1-name'), { target: { value: 'My Tenant' } });
    fireEvent.change(screen.getByTestId('s1-management-url'), { target: { value: 'https://t.sentinelone.net' } });
    fireEvent.change(screen.getByTestId('s1-api-token'), { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByTestId('s1-save'));

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/s1/integration' && init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchWithAuth.mock.calls.find(([url, init]) => url === '/s1/integration' && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: 'My Tenant',
      managementUrl: 'https://t.sentinelone.net',
      apiToken: 'tok-123',
      isActive: true
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a failed save to the user via an error toast', async () => {
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/s1/integration' && init?.method === 'POST') {
        return jsonResponse({ error: 'Invalid SentinelOne credentials' }, 400);
      }
      if (url === '/s1/integration') return jsonResponse({ data: null });
      if (url === '/s1/status') return jsonResponse({ summary: null });
      if (url === '/s1/sites') return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<SecurityIntegration />);
    await waitFor(() => expect(screen.getByText('Partner connection')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('s1-name'), { target: { value: 'My Tenant' } });
    fireEvent.change(screen.getByTestId('s1-management-url'), { target: { value: 'https://t.sentinelone.net' } });
    fireEvent.change(screen.getByTestId('s1-api-token'), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByTestId('s1-save'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Invalid SentinelOne credentials' }))
    );
    expect(screen.getByTestId('s1-save-message')).toHaveTextContent('Invalid SentinelOne credentials');
  });
});
