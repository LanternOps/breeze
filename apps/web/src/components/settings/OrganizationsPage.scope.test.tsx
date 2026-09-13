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

const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));

const storeFetchOrganizations = vi.fn().mockResolvedValue(undefined);
// The workspace (OrgSwitcher) selection the page reads through the store.
let mockStoreCurrentOrgId: string | null = null;
let mockStoreOrganizations: Array<{ id: string; name: string }> = [];
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

async function select(org: typeof ALPHA) {
  fireEvent.click(screen.getByTestId(`org-row-${org.id}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  applyOrgSwitchMock.mockReset();
  window.location.hash = '';
  mockStoreCurrentOrgId = null;
  mockStoreOrganizations = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — workspace scope is stated, never implied', () => {
  it('shows a scope chip and a Work-in-this-org action when the workspace is a different org', async () => {
    mockStoreCurrentOrgId = BETA.id;
    mockStoreOrganizations = [ALPHA, BETA];
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await select(ALPHA);

    const chip = screen.getByTestId('org-scope-chip');
    expect(chip).toHaveTextContent('Workspace: Beta Ltd');
    expect(chip).toHaveAttribute(
      'title',
      'Your workspace is set to Beta Ltd. Actions on this page apply to the organization selected here.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Work in this org' }));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(ALPHA.id, 'Switched to Alpha Ltd');
  });

  it('shows no chip when the selected org IS the workspace, and marks that org in the list', async () => {
    mockStoreCurrentOrgId = BETA.id;
    mockStoreOrganizations = [ALPHA, BETA];
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const betaRow = screen.getByTestId(`org-row-${BETA.id}`);
    expect(within(betaRow).getByText('Workspace')).toBeInTheDocument();
    expect(within(screen.getByTestId(`org-row-${ALPHA.id}`)).queryByText('Workspace')).not.toBeInTheDocument();

    await select(BETA);
    expect(screen.queryByTestId('org-scope-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Work in this org' })).not.toBeInTheDocument();
  });

  it('shows no chip in the fleet view (no workspace org)', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();
    await select(ALPHA);

    expect(screen.queryByTestId('org-scope-chip')).not.toBeInTheDocument();
  });

  it('the empty detail pane says what selecting an org shows', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    expect(screen.getByText('Select an organization to see its status, sites, and actions.')).toBeInTheDocument();
  });
});
