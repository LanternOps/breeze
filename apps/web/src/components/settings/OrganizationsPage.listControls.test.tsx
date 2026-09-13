import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage, { ORG_LIST_SORT_STORAGE_KEY } from './OrganizationsPage';
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

const org = (id: string, name: string, status: string, deviceCount: number) => ({
  id: `${id}${id}${id}${id}${id}${id}${id}${id}-1111-4111-8111-111111111111`,
  name,
  status,
  deviceCount,
  createdAt: '2026-01-01T00:00:00Z',
});
// Manual (server) order: Delta, Alpha, Gamma, Beta.
const DELTA = org('d', 'Delta Inc', 'active', 9);
const ALPHA = org('a', 'Alpha Ltd', 'active', 3);
const GAMMA = org('g', 'Gamma LLC', 'suspended', 1);
const BETA = org('b', 'Beta Ltd', 'trial', 5);
const MANUAL = [DELTA, ALPHA, GAMMA, BETA];

function mockApi(opts: { orgs?: typeof MANUAL; holdOrgs?: boolean } = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/orgs/organizations?') && !init?.method) {
      if (opts.holdOrgs) return new Promise<Response>(() => {});
      return jsonResponse({ data: opts.orgs ?? MANUAL });
    }
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
    if (url.endsWith('/summary')) return jsonResponse({ orgId: 'x', sites: { count: 0 } });
    return jsonResponse({ data: [] });
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const rowNames = () =>
  screen.getAllByTestId(/^org-row-/).map((row) => within(row).getByTestId(/^org-select-/).textContent?.replace(/\d+ devices|Trial|Suspended/g, '').trim());

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — list controls for a long list', () => {
  it('offers status chips only for statuses present, and a chip narrows the list', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const filters = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(filters).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['All', 'Trial', 'Suspended']);
    expect(within(filters).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(filters).getByRole('button', { name: /^Trial/ }));
    expect(rowNames()).toEqual(['Beta Ltd']);
    // Filtering, like searching, suspends manual reordering.
    expect(screen.queryByTestId('org-drag-handle')).not.toBeInTheDocument();

    fireEvent.click(within(filters).getByRole('button', { name: /^All/ }));
    expect(rowNames()).toEqual(['Delta Inc', 'Alpha Ltd', 'Gamma LLC', 'Beta Ltd']);
  });

  it('sorts by name or by device count, and only manual order offers the reorder handle', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const sort = screen.getByRole('combobox', { name: 'Sort' });
    expect(sort).toHaveValue('manual');
    expect(screen.getAllByTestId('org-drag-handle')).toHaveLength(4);

    fireEvent.change(sort, { target: { value: 'name' } });
    expect(rowNames()).toEqual(['Alpha Ltd', 'Beta Ltd', 'Delta Inc', 'Gamma LLC']);
    expect(screen.queryByTestId('org-drag-handle')).not.toBeInTheDocument();

    fireEvent.change(sort, { target: { value: 'devices' } });
    expect(rowNames()).toEqual(['Delta Inc', 'Beta Ltd', 'Alpha Ltd', 'Gamma LLC']);

    fireEvent.change(sort, { target: { value: 'manual' } });
    expect(rowNames()).toEqual(['Delta Inc', 'Alpha Ltd', 'Gamma LLC', 'Beta Ltd']);
    expect(screen.getAllByTestId('org-drag-handle')).toHaveLength(4);
  });

  it('remembers the sort choice per browser', async () => {
    mockApi();
    const first = render(<OrganizationsPage />);
    await flush();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'name' } });
    expect(window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY)).toBe('name');
    first.unmount();

    render(<OrganizationsPage />);
    await flush();
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('name');
    expect(rowNames()).toEqual(['Alpha Ltd', 'Beta Ltd', 'Delta Inc', 'Gamma LLC']);
  });

  it('keeps the active list and the Archived section in one scroll region', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const scroll = screen.getByTestId('org-list-scroll');
    expect(within(scroll).getByTestId(`org-row-${ALPHA.id}`)).toBeInTheDocument();
    expect(within(scroll).getByTestId('org-archived-toggle')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('org-archived-toggle'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(within(scroll).getByTestId('org-archived-section')).toBeInTheDocument();
    // One scroller, not two stacked ones.
    expect(screen.getByTestId('org-archived-section').className).not.toMatch(/overflow-y-auto/);
  });

  it('renders the page frame and a skeleton list while the first load is in flight', async () => {
    mockApi({ holdOrgs: true });
    render(<OrganizationsPage />);
    await flush();

    expect(screen.getByRole('button', { name: 'Add organization' })).toBeInTheDocument();
    expect(screen.getByTestId('org-list-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading organizations...')).toBeInTheDocument();
    expect(screen.queryByTestId(/^org-row-/)).not.toBeInTheDocument();
  });
});
