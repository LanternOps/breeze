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
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ fetchOrganizations: storeFetchOrganizations }) },
}));

let mockJwtScope: 'system' | 'partner' | 'organization' | null = 'partner';
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

const ORG_ACTIVE = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha Ltd',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const ORG_TRIAL = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta Ltd',
  status: 'trial',
  deviceCount: 5,
  createdAt: '2026-01-02T00:00:00Z',
};

let orgsState: Array<typeof ORG_ACTIVE> = [ORG_ACTIVE, ORG_TRIAL];

function mockApi() {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: orgsState });
    }
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

async function selectOrg(org: typeof ORG_ACTIVE) {
  fireEvent.click(screen.getByTestId(`org-row-${org.id}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  storeFetchOrganizations.mockClear();
  window.location.hash = '';
  orgsState = [ORG_ACTIVE, ORG_TRIAL];
  mockJwtScope = 'partner';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — list rows link to the organization record page', () => {
  it('renders a persistent org-open-record link with the record href', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const link = screen.getByTestId(`org-open-record-${ORG_ACTIVE.id}`);
    expect(link).toHaveAttribute('href', `/organizations/${ORG_ACTIVE.id}`);
  });

  it('clicking the org name link opens the record without selecting/expanding the row', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const nameLink = screen.getByRole('link', { name: ORG_ACTIVE.name });
    fireEvent.click(nameLink);
    await flush();

    // Selecting the row would render the detail pane header with the org name
    // as an <h2>; clicking the name link must not trigger that row selection.
    expect(screen.queryByRole('heading', { level: 2, name: ORG_ACTIVE.name })).not.toBeInTheDocument();
    expect(screen.getByText('No organization selected')).toBeInTheDocument();
  });
});

describe('OrganizationsPage — status pill is exception-only in the main list', () => {
  it('renders NO status pill for an active org row', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const row = screen.getByTestId(`org-row-${ORG_ACTIVE.id}`);
    expect(row).not.toHaveTextContent('Active');
  });

  it('renders the status pill for a trial org row', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    const row = screen.getByTestId(`org-row-${ORG_TRIAL.id}`);
    expect(row).toHaveTextContent('Trial');
  });
});

describe('OrganizationsPage — detail-pane header exposes Open record', () => {
  it('renders org-open-record in the detail header once an org is selected', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectOrg(ORG_ACTIVE);

    expect(screen.getByTestId('org-open-record')).toBeInTheDocument();
  });

  it('clicking the detail-pane Open record button navigates to the record page', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectOrg(ORG_ACTIVE);
    fireEvent.click(screen.getByTestId('org-open-record'));

    expect(navigateTo).toHaveBeenCalledWith(`/organizations/${ORG_ACTIVE.id}`);
  });
});
