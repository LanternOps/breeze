import { act, fireEvent, render, screen } from '@testing-library/react';
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
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const BETA = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta Ltd',
  status: 'trial',
  deviceCount: 5,
  createdAt: '2026-01-02T00:00:00Z',
};

function mockApi() {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;
    if (url.startsWith('/orgs/organizations?') && !method) return jsonResponse({ data: [ALPHA, BETA] });
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

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  storeFetchOrganizations.mockClear();
  window.location.hash = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — keyboard operability', () => {
  it('names the list search input', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    expect(screen.getByRole('searchbox', { name: 'Search organizations' })).toBeInTheDocument();
  });

  it('exposes each row as a select button; the first row is the roving tab stop and the selected org is aria-current', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const alpha = screen.getByTestId(`org-select-${ALPHA.id}`);
    const beta = screen.getByTestId(`org-select-${BETA.id}`);
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(beta).toHaveAttribute('tabindex', '-1');
    expect(alpha).not.toHaveAttribute('aria-current');

    fireEvent.click(alpha);
    await flush();

    expect(alpha).toHaveAttribute('aria-current', 'true');
    expect(beta).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { level: 2, name: ALPHA.name })).toBeInTheDocument();
  });

  it('ArrowDown moves focus and the tab stop to the next row without selecting it', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const alpha = screen.getByTestId(`org-select-${ALPHA.id}`);
    const beta = screen.getByTestId(`org-select-${BETA.id}`);
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(beta);
    expect(beta).toHaveAttribute('tabindex', '0');
    expect(alpha).toHaveAttribute('tabindex', '-1');
    // Focus moved, selection did not: the detail pane is still empty.
    expect(screen.getByText('No organization selected')).toBeInTheDocument();

    fireEvent.keyDown(beta, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(alpha);
  });

  it('the reorder handle moves the org with the arrow keys, persists the order, and announces the move', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const handle = screen.getByRole('button', { name: 'Reorder Alpha Ltd' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    await flush();

    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ orderedIds: [BETA.id, ALPHA.id] });

    const rows = screen.getAllByTestId(/^org-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', `org-row-${BETA.id}`);
    expect(screen.getByTestId('org-reorder-announcement')).toHaveTextContent('Alpha Ltd moved to position 2 of 2');
  });

  it('row actions carry accessible names that include the organization', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    expect(screen.getByRole('button', { name: 'Settings for Alpha Ltd' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open record for Alpha Ltd' })).toHaveAttribute(
      'href',
      `/organizations/${ALPHA.id}`,
    );
  });

  it('Add organization opens a real dialog that Escape closes', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Add organization' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // "Slug" is developer vocabulary; the field explains itself.
    expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription(
      'Generated from the name. Unique within your account; used by the API and integrations.',
    );

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
