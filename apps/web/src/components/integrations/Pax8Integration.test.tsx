import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();
let scope: 'system' | 'partner' | 'organization' | null = 'partner';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({
  loginPathWithNext: () => '/login?next=/integrations',
  getJwtClaims: () => ({ scope, orgId: null, partnerId: 'partner-1' })
}));

import Pax8Integration from './Pax8Integration';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const existingIntegration = {
  id: 'pax8-1',
  partnerId: 'partner-1',
  name: 'Production Pax8',
  apiBaseUrl: 'https://api.pax8.com',
  tokenUrl: 'https://login.pax8.com/oauth/token',
  isActive: true,
  lastSyncAt: '2026-06-18T12:00:00.000Z',
  lastSyncStatus: 'success',
  lastSyncError: null,
  hasClientId: true,
  hasClientSecret: true,
  hasWebhookSecret: false
};

const breezeOrg = { id: '00000000-0000-4000-8000-000000000001', name: 'Acme Corp' };

const company = {
  pax8CompanyId: 'pax8-co-1',
  pax8CompanyName: 'Acme Pax8',
  status: 'active',
  mappedOrgId: null,
  mappedOrgName: null,
  ignored: false,
  lastSeenAt: null,
  updatedAt: null
};

const subscription = {
  id: 'sub-1',
  pax8SubscriptionId: 'pax8-sub-1',
  pax8CompanyId: 'pax8-co-1',
  pax8CompanyName: 'Acme Pax8',
  orgId: null,
  productId: 'prod-1',
  productName: 'Microsoft 365 Business',
  vendorName: 'Microsoft',
  status: 'active',
  billingTerm: 'monthly',
  quantity: 12,
  unitPrice: '20.00',
  unitCost: '15.00',
  currencyCode: 'USD',
  contractLineId: null,
  syncEnabled: null
};

/** Mock the load fan-out: integration + (when configured) companies/subscriptions/orgs. */
function mockLoad(options: { integration?: typeof existingIntegration | null; companies?: unknown[]; subscriptions?: unknown[] } = {}) {
  const integration = options.integration === undefined ? null : options.integration;
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === '/pax8/integration') return jsonResponse({ data: integration });
    if (url === '/pax8/companies') return jsonResponse({ data: options.companies ?? [] });
    if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: options.subscriptions ?? [] });
    if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
    return jsonResponse({}, 404);
  });
}

describe('Pax8Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = 'partner';
  });

  it('renders the connect form (not connected) when no integration exists', async () => {
    mockLoad({ integration: null });
    render(<Pax8Integration />);

    expect(await screen.findByTestId('pax8-panel')).toBeTruthy();
    expect(screen.getByTestId('pax8-status-disconnected')).toBeTruthy();
    expect(screen.getByText('Connect Pax8')).toBeTruthy();
    // Test / Sync only show once configured.
    expect(screen.queryByTestId('pax8-test')).toBeNull();
    expect(screen.queryByTestId('pax8-sync')).toBeNull();
    // Save is disabled until both credentials are entered for a fresh integration.
    expect((screen.getByTestId('pax8-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows configured indicators and sync status when an integration exists', async () => {
    mockLoad({ integration: existingIntegration });
    render(<Pax8Integration />);

    expect(await screen.findByTestId('pax8-status-connected')).toBeTruthy();
    expect(screen.getByTestId('pax8-has-client-id')).toBeTruthy();
    expect(screen.getByTestId('pax8-has-client-secret')).toBeTruthy();
    expect(screen.getByTestId('pax8-sync-status')).toBeTruthy();
    expect(screen.getByTestId('pax8-sync-status-value').textContent).toContain('success');
    // Secrets are never re-populated into the inputs.
    expect((screen.getByTestId('pax8-client-id') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('pax8-client-secret') as HTMLInputElement).value).toBe('');
  });

  it('connects a fresh integration via runAction with both credentials', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/integration' && init?.method === 'POST') {
        return jsonResponse({ ...existingIntegration, lastSyncStatus: null, lastSyncAt: null }, 201);
      }
      if (url === '/pax8/integration') return jsonResponse({ data: null });
      if (url === '/pax8/companies') return jsonResponse({ data: [] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-panel');

    fireEvent.change(screen.getByTestId('pax8-client-id'), { target: { value: 'client-abc' } });
    fireEvent.change(screen.getByTestId('pax8-client-secret'), { target: { value: 'secret-xyz' } });
    fireEvent.click(screen.getByTestId('pax8-save'));

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/pax8/integration' && init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchWithAuth.mock.calls.find(([url, init]) => url === '/pax8/integration' && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ name: 'Pax8', clientId: 'client-abc', clientSecret: 'secret-xyz' });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('updates an existing integration without re-sending secrets when fields are blank', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/integration' && init?.method === 'POST') return jsonResponse(existingIntegration, 200);
      if (url === '/pax8/integration') return jsonResponse({ data: existingIntegration });
      if (url === '/pax8/companies') return jsonResponse({ data: [] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-status-connected');

    const save = screen.getByTestId('pax8-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false); // existing integration may save with blank credentials
    fireEvent.click(save);

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/pax8/integration' && init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchWithAuth.mock.calls.find(([url, init]) => url === '/pax8/integration' && init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body).not.toHaveProperty('clientId');
    expect(body).not.toHaveProperty('clientSecret');
    expect(body).toMatchObject({ name: 'Production Pax8' });
  });

  it('surfaces a successful connection test', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/integration/test' && init?.method === 'POST') return jsonResponse({ success: true, data: {} });
      if (url === '/pax8/integration') return jsonResponse({ data: existingIntegration });
      if (url === '/pax8/companies') return jsonResponse({ data: [] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-status-connected');
    fireEvent.click(screen.getByTestId('pax8-test'));

    expect(await screen.findByTestId('pax8-test-result')).toHaveTextContent('Connection test succeeded.');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a failed connection test (HTTP 502)', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/integration/test' && init?.method === 'POST') {
        return jsonResponse({ success: false, error: 'Invalid Pax8 credentials' }, 502);
      }
      if (url === '/pax8/integration') return jsonResponse({ data: existingIntegration });
      if (url === '/pax8/companies') return jsonResponse({ data: [] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-status-connected');
    fireEvent.click(screen.getByTestId('pax8-test'));

    await waitFor(() => expect(screen.getByTestId('pax8-test-result')).toHaveTextContent('Invalid Pax8 credentials'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('triggers a sync via runAction and surfaces success', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/sync' && init?.method === 'POST') return jsonResponse({ queued: true, jobId: 'job-1' });
      if (url === '/pax8/integration') return jsonResponse({ data: existingIntegration });
      if (url === '/pax8/companies') return jsonResponse({ data: [] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-status-connected');
    fireEvent.click(screen.getByTestId('pax8-sync'));

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/pax8/sync' && init?.method === 'POST')).toBe(true);
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('maps a Pax8 company to a Breeze org and posts the mapping', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/pax8/companies/map' && init?.method === 'POST') {
        return jsonResponse({ data: { ...company, mappedOrgId: breezeOrg.id, mappedOrgName: breezeOrg.name } });
      }
      if (url === '/pax8/integration') return jsonResponse({ data: existingIntegration });
      if (url === '/pax8/companies') return jsonResponse({ data: [company] });
      if (url.startsWith('/pax8/subscriptions')) return jsonResponse({ data: [] });
      if (url === '/orgs/organizations') return jsonResponse({ data: [breezeOrg] });
      return jsonResponse({}, 404);
    });

    render(<Pax8Integration />);
    await screen.findByTestId('pax8-companies-table');

    fireEvent.change(screen.getByTestId('pax8-company-map-pax8-co-1'), { target: { value: breezeOrg.id } });

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/pax8/companies/map' && init?.method === 'POST')).toBe(true);
    });
    const mapCall = fetchWithAuth.mock.calls.find(([url, init]) => url === '/pax8/companies/map' && init?.method === 'POST');
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      integrationId: 'pax8-1',
      pax8CompanyId: 'pax8-co-1',
      orgId: breezeOrg.id
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders the read-only subscriptions list', async () => {
    mockLoad({ integration: existingIntegration, subscriptions: [subscription] });
    render(<Pax8Integration />);

    expect(await screen.findByTestId('pax8-subscriptions-table')).toBeTruthy();
    expect(screen.getByText('Microsoft 365 Business')).toBeTruthy();
    expect(screen.getByText('USD 15.00')).toBeTruthy();
  });

  it('shows a partner-scope-only message for org-scope users and never calls the API', async () => {
    scope = 'organization';
    mockLoad({ integration: existingIntegration });
    render(<Pax8Integration />);

    expect(await screen.findByTestId('pax8-org-scope')).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
