import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const storeFetchOrganizations = vi.fn().mockResolvedValue(undefined);
const mockStoreCurrentOrgId: string | null = null;
const mockStoreOrganizations: Array<{ id: string; name: string }> = [];
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: { currentOrgId: string | null; organizations: Array<{ id: string; name: string }> }) => unknown) =>
      selector ? selector({ currentOrgId: mockStoreCurrentOrgId, organizations: mockStoreOrganizations }) : undefined,
    { getState: () => ({ fetchOrganizations: storeFetchOrganizations }) },
  ),
}));

vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' },
  }),
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
void handleSessionExpired;

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ALPHA = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha Ltd',
  status: 'active',
  deviceCount: 15,
  createdAt: '2026-01-01T00:00:00Z',
};

const FULL_SUMMARY = {
  orgId: ALPHA.id,
  devices: { total: 15, online: 12, offline: 3 },
  alerts: { open: 2, critical: 1, high: 0 },
  contracts: { active: 1, nextRenewalAt: '2026-12-01T00:00:00Z' },
  sites: { count: 2 },
  lastActivityAt: '2026-09-10T12:00:00Z',
};

const site = (n: number) => ({ id: `s${n}`, name: `Site ${n}`, timezone: 'UTC', deviceCount: 1 });

interface ApiOptions {
  summary?: unknown | null;
  summaryStatus?: number;
  sites?: ReturnType<typeof site>[];
}

function mockApi(opts: ApiOptions = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/orgs/organizations?') && !init?.method) return jsonResponse({ data: [ALPHA] });
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: opts.sites ?? [site(1)] });
    if (url.endsWith('/summary')) {
      const status = opts.summaryStatus ?? 200;
      return jsonResponse(opts.summary === undefined ? FULL_SUMMARY : opts.summary, status < 400, status);
    }
    return jsonResponse({ data: [] });
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function selectAlpha() {
  fireEvent.click(screen.getByTestId(`org-row-${ALPHA.id}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — the detail panel says something about the customer', () => {
  it('renders a facts strip from the org summary: devices, open alerts, contracts, sites, last activity', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    const facts = screen.getByTestId('org-facts');
    expect(within(facts).getByText('Devices')).toBeInTheDocument();
    expect(within(facts).getByText('12 of 15 online')).toBeInTheDocument();
    expect(within(facts).getByText('Open alerts')).toBeInTheDocument();
    expect(within(facts).getByText('1 critical · 0 high')).toBeInTheDocument();
    expect(within(facts).getByText('Active contracts')).toBeInTheDocument();
    expect(within(facts).getByText(/^Next renewal /)).toBeInTheDocument();
    expect(within(facts).getByText('Sites')).toBeInTheDocument();
    expect(within(facts).getByText(/^Last activity /)).toBeInTheDocument();

    // The summary was requested for the selected org, pinned to it.
    expect(fetchMock).toHaveBeenCalledWith(
      `/orgs/organizations/${ALPHA.id}/summary`,
      expect.objectContaining({ orgIdOverride: ALPHA.id }),
    );
  });

  it('hides sections the summary omits (permission-trimmed) instead of showing zeros', async () => {
    mockApi({ summary: { orgId: ALPHA.id, devices: { total: 3, online: 3, offline: 0 }, sites: { count: 1 } } });
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    const facts = screen.getByTestId('org-facts');
    expect(within(facts).getByText('Devices')).toBeInTheDocument();
    expect(within(facts).queryByText('Open alerts')).not.toBeInTheDocument();
    expect(within(facts).queryByText('Active contracts')).not.toBeInTheDocument();
    expect(within(facts).queryByText(/^Last activity /)).not.toBeInTheDocument();
  });

  it('says so when the summary cannot be loaded, and Try again refetches it', async () => {
    mockApi({ summary: { error: 'boom' }, summaryStatus: 500 });
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    expect(screen.getByText('Summary counts are unavailable right now.')).toBeInTheDocument();
    const before = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/summary')).length;

    mockApi();
    fireEvent.click(screen.getByTestId('org-facts-retry'));
    await flush();

    const after = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/summary')).length;
    expect(after).toBe(before + 1);
    expect(screen.getByTestId('org-facts')).toBeInTheDocument();
  });

  it('Sites is a flat section (h3) with no count or search for a short list', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByRole('heading', { level: 3, name: 'Sites' })).toBeInTheDocument();
    expect(within(panel).queryByText(/of \d+ sites/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('searchbox', { name: 'Search sites' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Add site' })).toBeInTheDocument();
  });

  it('Sites shows its count and search once the list is long enough to need them', async () => {
    mockApi({ sites: Array.from({ length: 6 }, (_, i) => site(i + 1)) });
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByText('6 of 6 sites')).toBeInTheDocument();
    expect(within(panel).getByRole('searchbox', { name: 'Search sites' })).toBeInTheDocument();
  });
});
