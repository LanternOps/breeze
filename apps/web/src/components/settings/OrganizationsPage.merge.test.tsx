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

// Mutable per-test knob for the merge launcher's partner-scope gating.
// useJwtClaims is reactive in the real module (subscribes to the auth store),
// but the page only cares about its return shape — a plain stub read fresh on
// every call is simpler than wiring up a fake zustand store, and each test
// sets the scope it needs before rendering.
let mockJwtScope: 'system' | 'partner' | 'organization' | null = 'partner';
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: mockJwtScope, orgId: null, partnerId: 'partner-1' },
  }),
  getJwtClaims: () => ({ scope: mockJwtScope, orgId: null, partnerId: 'partner-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const sessionExpiredMock = vi.mocked(handleSessionExpired);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const LOSER = {
  id: 'loser-1111-1111-1111-111111111111',
  name: 'Acme Legacy',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const SURVIVOR = {
  id: 'survivor-2222-2222-2222-222222222222',
  name: 'Acme Corp',
  status: 'active',
  deviceCount: 40,
  createdAt: '2026-01-01T00:00:00Z',
};

let orgsState: Array<typeof LOSER> = [LOSER, SURVIVOR];

/** Routes every fetch the page (and, once opened, MergeOrgModal) issues.
 * `poll` defaults to an immediate `completed` so tests don't need to model
 * multiple ticks unless they care about that. */
function mockApi(poll?: () => unknown) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: orgsState });
    }
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
    if (method === 'POST' && url.endsWith('/merge-preview')) {
      return jsonResponse({ tables: [{ table: 'devices', policy: 'repoint-dedupe', loserRows: 4, wouldDrop: 0 }], totalMovableRows: 4, verdict: 'ok', warnings: [] });
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/merge$/.test(url)) {
      return jsonResponse({ jobId: 'job-1' }, true, 202);
    }
    if (url.includes('/merge-runs/')) {
      return jsonResponse(
        poll?.() ?? {
          state: 'completed',
          result: { tables: { devices: { moved: 4, dropped: 0 } }, warnings: [], mergeEventId: 'evt-1' },
        },
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

async function selectLoser() {
  fireEvent.click(screen.getByTestId(`org-row-${LOSER.id}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  sessionExpiredMock.mockReset();
  navigateTo.mockReset();
  storeFetchOrganizations.mockClear();
  window.location.hash = '';
  orgsState = [LOSER, SURVIVOR];
  mockJwtScope = 'partner';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — merge launcher partner gating', () => {
  it('hides the merge launcher for a non-partner scope', async () => {
    mockJwtScope = 'organization';
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectLoser();

    expect(screen.getByRole('heading', { level: 2, name: 'Acme Legacy' })).toBeInTheDocument();
    expect(screen.queryByTestId('org-merge-open')).not.toBeInTheDocument();
  });

  it('shows the merge launcher for partner scope', async () => {
    mockJwtScope = 'partner';
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectLoser();

    expect(screen.getByTestId('org-merge-open')).toBeInTheDocument();
  });
});

describe('OrganizationsPage — merge completion stays on the summary until the user closes it', () => {
  it('keeps the modal open on the done summary, drops the loser from the list, and only clears the selection on Close', async () => {
    mockApi();
    render(<OrganizationsPage />);
    await flush();

    await selectLoser();
    fireEvent.click(screen.getByTestId('org-merge-open'));

    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: SURVIVOR.id } });
    await flush();

    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: LOSER.name } });
    fireEvent.click(screen.getByTestId('org-merge-submit'));
    await flush(); // merge POST (202) + the immediate first poll: 'completed'

    // The modal did NOT close and unmount out from under the summary — this
    // is the CRITICAL regression: onMerged used to also close the modal,
    // unmounting `org-merge-done` the instant it appeared.
    expect(screen.getByTestId('org-merge-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-merge-done')).toBeInTheDocument();

    // onMerged's list-state update DID happen — the loser is out of the left
    // list — independent of the modal staying open.
    expect(screen.queryByTestId(`org-row-${LOSER.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`org-row-${SURVIVOR.id}`)).toBeInTheDocument();

    // Closing the summary is what actually tears the modal down AND clears
    // the stale (merged-away) selection.
    fireEvent.click(screen.getByTestId('org-merge-close'));
    await flush();

    expect(screen.queryByTestId('org-merge-modal')).not.toBeInTheDocument();
    expect(screen.getByText('No organization selected')).toBeInTheDocument();
  });
});
