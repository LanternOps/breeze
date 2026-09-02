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

// Archive doesn't gate on scope the way merge does, but OrganizationsPage
// reads useJwtClaims() unconditionally (for the merge launcher), so it needs
// a stub regardless — mirrors OrganizationsPage.merge.test.tsx.
let mockJwtScope: 'system' | 'partner' | 'organization' | null = 'partner';
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: mockJwtScope, orgId: null, partnerId: 'partner-1' },
  }),
  getJwtClaims: () => ({ scope: mockJwtScope, orgId: null, partnerId: 'partner-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_A = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha Ltd',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const ORG_B = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta Ltd',
  status: 'active',
  deviceCount: 5,
  createdAt: '2026-01-02T00:00:00Z',
};

let orgsState: Array<typeof ORG_A> = [ORG_A, ORG_B];

/** Routes every fetch the page (and, once opened, ArchiveOrgModal) issues. */
function mockApi(archiveResponse?: () => unknown) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: orgsState });
    }
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
    if (method === 'POST' && /\/organizations\/[^/]+\/archive$/.test(url)) {
      return jsonResponse(
        archiveResponse?.() ?? { status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' },
        true,
        202,
      );
    }
    return jsonResponse({ data: [] });
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function selectOrg(org: typeof ORG_A) {
  fireEvent.click(screen.getByTestId(`org-row-${org.id}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  storeFetchOrganizations.mockClear();
  window.location.hash = '';
  orgsState = [ORG_A, ORG_B];
  mockJwtScope = 'partner';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — archive entry points open the real ArchiveOrgModal', () => {
  it('opens it from the list-row hover icon, without first selecting the org', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    fireEvent.click(screen.getByTestId(`org-archive-open-row-${ORG_A.id}`));
    await flush();

    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
  });

  it('opens it from the detail header button once an org is selected', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectOrg(ORG_A);
    fireEvent.click(screen.getByTestId('org-archive-open'));
    await flush();

    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
  });
});

describe('OrganizationsPage — archive completion', () => {
  it('drops the archived org from the rendered list on 202, keeps the modal open on the done summary, and Close clears the selection', async () => {
    mockApi(() => ({ status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' }));
    render(<OrganizationsPage />);
    await flush();

    fireEvent.click(screen.getByTestId(`org-archive-open-row-${ORG_A.id}`));
    await flush();

    fireEvent.click(screen.getByTestId('org-archive-submit'));
    await flush(); // archive POST (202)

    // The modal did NOT close and unmount out from under the summary — same
    // regression class as the merge modal's onMerged/onDoneClose split.
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-done')).toBeInTheDocument();

    // The list-state update already happened, independent of the modal
    // staying open: the archived org is out of the left list.
    expect(screen.queryByTestId(`org-row-${ORG_A.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`org-row-${ORG_B.id}`)).toBeInTheDocument();

    // Closing the summary is what tears the modal down AND clears the stale
    // (now-archived) selection.
    fireEvent.click(screen.getByTestId('org-archive-close'));
    await flush();

    expect(screen.queryByTestId('org-archive-modal')).not.toBeInTheDocument();
    expect(screen.getByText('No organization selected')).toBeInTheDocument();
  });

  it('drops the org from the list when archived via the detail header button too', async () => {
    mockApi(() => ({ status: 'archived', purgeAt: null }));
    render(<OrganizationsPage />);
    await flush();

    await selectOrg(ORG_A);
    fireEvent.click(screen.getByTestId('org-archive-open'));
    await flush();

    fireEvent.click(screen.getByTestId('org-archive-submit'));
    await flush();

    expect(screen.queryByTestId(`org-row-${ORG_A.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`org-row-${ORG_B.id}`)).toBeInTheDocument();
  });
});
