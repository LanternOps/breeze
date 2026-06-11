import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateTicketPage from './CreateTicketPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// Mock authScope so each test can control getJwtClaims behaviour.
const mockGetJwtClaims = vi.fn(() => ({ scope: 'partner' as const, orgId: null, partnerId: 'p-1' }));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: (...args: unknown[]) => mockGetJwtClaims(...args),
  loginPathWithNext: () => '/login?next=%2Ftickets%2Fnew'
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockOptionsApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/orgs/organizations?limit=100') {
      return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] });
    }
    if (url === '/ticket-categories') {
      return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
    }
    if (url.startsWith('/devices?orgId=')) {
      return makeJsonResponse({ data: [{ id: 'dev-1', displayName: 'PC-1' }] });
    }
    if (url === '/tickets' && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 'tk-9', internalNumber: 'T-2026-0009' } });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('CreateTicketPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to partner scope so existing tests behave as before.
    mockGetJwtClaims.mockReturnValue({ scope: 'partner', orgId: null, partnerId: 'p-1' });
  });

  it('omits deviceId, categoryId and description from the payload when left empty', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    await screen.findByTestId('create-ticket-form');

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('create-ticket-subject-input'), { target: { value: 'Printer down' } });
    fireEvent.click(screen.getByTestId('create-ticket-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets', expect.objectContaining({ method: 'POST' }));
    });

    const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/tickets' && init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ orgId: 'org-a', subject: 'Printer down', priority: 'normal' });
    expect(body).not.toHaveProperty('deviceId');
    expect(body).not.toHaveProperty('categoryId');
    expect(body).not.toHaveProperty('description');
  });

  it('loads the device list for the selected organization', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    await screen.findByTestId('create-ticket-form');

    expect(screen.getByTestId('create-ticket-device-input')).toBeDisabled();

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-a' } });

    await screen.findByText('PC-1');
    expect(fetchMock).toHaveBeenCalledWith('/devices?orgId=org-a');
    expect(screen.getByTestId('create-ticket-device-input')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('create-ticket-device-input'), { target: { value: 'dev-1' } });
    expect(screen.getByTestId('create-ticket-device-input')).toHaveValue('dev-1');
  });

  it('resets the selected device when switching organizations (no cross-org deviceId in the payload)', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    await screen.findByTestId('create-ticket-form');

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-a' } });
    await screen.findByText('PC-1');
    fireEvent.change(screen.getByTestId('create-ticket-device-input'), { target: { value: 'dev-1' } });
    expect(screen.getByTestId('create-ticket-device-input')).toHaveValue('dev-1');

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-b' } });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/devices?orgId=org-b');
    });
    expect(screen.getByTestId('create-ticket-device-input')).toHaveValue('');

    fireEvent.change(screen.getByTestId('create-ticket-subject-input'), { target: { value: 'Subj' } });
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets', expect.objectContaining({ method: 'POST' }));
    });
    const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/tickets' && init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('deviceId');
    expect(body.orgId).toBe('org-b');
  });

  it('shows the load-error retry state when the org fetch fails, and recovers on retry', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ error: 'boom' }, false, 500);
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<CreateTicketPage />);

    await screen.findByTestId('create-ticket-load-error');
    expect(screen.queryByTestId('create-ticket-form')).toBeNull();

    mockOptionsApi();
    fireEvent.click(screen.getByTestId('create-ticket-load-retry'));

    await screen.findByTestId('create-ticket-form');
    expect(screen.queryByTestId('create-ticket-load-error')).toBeNull();
    expect(screen.getByText('Org A')).toBeInTheDocument();
  });

  describe('org-scope fixes', () => {
    it('org-scoped session: no /orgs/organizations fetch, no org input, devices fetched for the session org, submit sends correct orgId', async () => {
      mockGetJwtClaims.mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [] });
        if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
        if (url === '/devices?orgId=org-1') return makeJsonResponse({ data: [{ id: 'dev-1', displayName: 'PC-1' }] });
        if (url === '/tickets' && init?.method === 'POST') return makeJsonResponse({ data: { id: 'tk-1', internalNumber: 'T-1' } });
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      render(<CreateTicketPage />);
      await screen.findByTestId('create-ticket-form');

      // Org input hidden (orgLocked = true)
      expect(screen.queryByTestId('create-ticket-org-input')).toBeNull();

      // Device list fetched for org-1 automatically
      await screen.findByText('PC-1');
      expect(fetchMock).toHaveBeenCalledWith('/devices?orgId=org-1');

      // No /orgs/organizations call
      const allUrls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(allUrls.every((u) => !u.includes('/orgs/organizations'))).toBe(true);

      // Fill subject and submit
      fireEvent.change(screen.getByTestId('create-ticket-subject-input'), { target: { value: 'Printer down' } });
      fireEvent.click(screen.getByTestId('create-ticket-submit'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/tickets', expect.objectContaining({ method: 'POST' }));
      });
      const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/tickets' && init?.method === 'POST');
      const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
      expect(body.orgId).toBe('org-1');
    });

    it('orgs fetch 403 + late org-scoped getJwtClaims: no load error, form becomes usable', async () => {
      // First call to getJwtClaims (during loadOptions) returns all-null;
      // second call (late-claims fallback in the 403 branch) returns org claims.
      mockGetJwtClaims
        .mockReturnValueOnce({ scope: null, orgId: null, partnerId: null })
        .mockReturnValue({ scope: 'organization', orgId: 'org-1', partnerId: null });

      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ error: 'Forbidden' }, false, 403);
        if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
        if (url.startsWith('/devices?orgId=')) return makeJsonResponse({ data: [] });
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      render(<CreateTicketPage />);
      await screen.findByTestId('create-ticket-form');

      // No load-error shown — late claims resolved the 403.
      expect(screen.queryByTestId('create-ticket-load-error')).toBeNull();
      // Org input hidden because orgLocked was set via the fallback.
      expect(screen.queryByTestId('create-ticket-org-input')).toBeNull();
    });

    it('categories with parent/child: child option text shows "Parent / Child"', async () => {
      mockOptionsApi();
      // Override categories to include a parent+child pair.
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] });
        if (url === '/ticket-categories') {
          return makeJsonResponse({
            data: [
              { id: 'p', name: 'Hardware', parentId: null, isActive: true },
              { id: 'c', name: 'Printers', parentId: 'p', isActive: true }
            ]
          });
        }
        if (url.startsWith('/devices?orgId=')) return makeJsonResponse({ data: [] });
        if (url === '/tickets' && init?.method === 'POST') return makeJsonResponse({ data: { id: 'tk-1', internalNumber: 'T-1' } });
        return makeJsonResponse({ error: 'unexpected' }, false, 404);
      });

      render(<CreateTicketPage />);
      await screen.findByTestId('create-ticket-form');

      // Wait for categories to load
      await screen.findByRole('option', { name: 'Hardware / Printers' });
      // The parent category itself still shows with just its name
      expect(screen.getByRole('option', { name: 'Hardware' })).toBeInTheDocument();
    });
  });
});
