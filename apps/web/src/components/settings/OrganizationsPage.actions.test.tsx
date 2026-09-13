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
// Workspace scope the page reads through the store selector; the scope tests
// set these, everything else leaves the workspace unset (fleet view).
const mockStoreCurrentOrgId: string | null = null;
const mockStoreOrganizations: Array<{ id: string; name: string }> = [];
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: { currentOrgId: string | null; organizations: Array<{ id: string; name: string }> }) => unknown) =>
      selector ? selector({ currentOrgId: mockStoreCurrentOrgId, organizations: mockStoreOrganizations }) : undefined,
    { getState: () => ({ fetchOrganizations: storeFetchOrganizations }) },
  ),
}));

let mockJwtScope: 'system' | 'partner' | 'organization' = 'partner';
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: mockJwtScope, orgId: null, partnerId: 'partner-1' },
  }),
  getJwtClaims: () => ({ scope: mockJwtScope, orgId: null, partnerId: 'partner-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
void handleSessionExpired;

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ALPHA = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha Ltd',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const BETA = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta Ltd',
  status: 'active',
  deviceCount: 5,
  createdAt: '2026-01-02T00:00:00Z',
};

function mockApi() {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/orgs/organizations?') && !init?.method) return jsonResponse({ data: [ALPHA, BETA] });
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
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
  mockJwtScope = 'partner';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — distilled detail-header actions', () => {
  it('shows one primary (Open record), one secondary (Settings) and a More menu; archive and merge are not standalone buttons', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByTestId('org-open-record')).toHaveTextContent('Open record');
    expect(within(panel).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(panel).queryByTestId('org-archive-open')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('org-merge-open')).not.toBeInTheDocument();
    // The panel's whole button inventory: primary, secondary, overflow, and
    // the Sites section's own add action. Nothing else competes.
    expect(
      within(panel)
        .getAllByRole('button')
        .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim()),
    ).toEqual(['Open record', 'Settings', 'More actions', 'Add site']);
  });

  it('the More menu holds Archive and Merge for partner scope and opens the archive dialog', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Archive organization', 'Merge into another organization']);

    fireEvent.click(screen.getByTestId('org-archive-open'));
    await flush();
    expect(screen.getByRole('dialog', { name: 'Archive organization' })).toBeInTheDocument();
  });

  it('the More menu omits Merge outside partner scope', async () => {
    mockJwtScope = 'organization';
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await selectAlpha();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Archive organization']);
  });

  it('list rows expose Settings and Open record only; archive lives in the header menu', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const row = screen.getByTestId(`org-row-${ALPHA.id}`);
    expect(within(row).getByRole('button', { name: 'Settings for Alpha Ltd' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open record for Alpha Ltd' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });
});
