import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { ORGANIZATIONS_PAGE_SIZE } from '../../lib/fetchAllOrganizations';

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

// OrganizationsPage reads useJwtClaims() unconditionally (for the merge
// launcher's gating) regardless of what this suite exercises — mirrors
// OrganizationsPage.archive.test.tsx / .merge.test.tsx.
let mockJwtScope: 'system' | 'partner' | 'organization' | null = 'partner';
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: mockJwtScope, orgId: null, partnerId: 'partner-1' },
  }),
  getJwtClaims: () => ({ scope: mockJwtScope, orgId: null, partnerId: 'partner-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_A: Organization = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha Ltd',
  status: 'active',
  deviceCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
};

const ARCHIVED_ORG: Organization = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  name: 'Gamma LLC',
  status: 'archived',
  deviceCount: 0,
  createdAt: '2026-01-03T00:00:00Z',
  archived: true,
  purgeAt: '2026-09-26T00:00:00.000Z', // 30 days after the fixed "now" below
};

const DELTA_ARCHIVED_ORG: Organization = {
  id: 'dddddddd-4444-4444-8444-444444444444',
  name: 'Delta Inc',
  status: 'archived',
  deviceCount: 0,
  createdAt: '2026-01-04T00:00:00Z',
  archived: true,
  purgeAt: null,
};

let orgsState: Organization[] = [ORG_A];

interface MockApiOptions {
  archivedOrgs?: Organization[];
  archivedTruncated?: boolean;
  /** Called for every restore POST; defaults to a plain 200 'active' restore. */
  restoreResponse?: () => { body: unknown; status?: number };
}

/** Routes every fetch the page issues, including the Archived section's
 * dedicated `includeArchived=true` GET and the restore POST. The archived
 * branch mimics the real API's server-side `search` filtering (orgs.ts /
 * archivedOrgReads.ts both apply the same `search` param to the archived
 * rows) so tests can prove the param actually narrows what comes back, not
 * just that it's present on the URL. */
function mockApi(opts: MockApiOptions = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.includes('includeArchived=true')) {
      const search = new URL(url, 'http://localhost').searchParams.get('search')?.toLowerCase();
      const archived = (opts.archivedOrgs ?? []).filter((org) =>
        search ? org.name.toLowerCase().includes(search) : true,
      );
      return jsonResponse({
        data: [...orgsState, ...archived],
        pagination: { page: 1, limit: 100, total: orgsState.length },
        archivedTruncated: opts.archivedTruncated ?? false,
      });
    }
    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: orgsState });
    }
    if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
    if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
    if (method === 'POST' && /\/organizations\/[^/]+\/restore$/.test(url)) {
      const result = opts.restoreResponse?.() ?? {
        body: { status: 'active', recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'] },
      };
      const status = result.status ?? 200;
      return jsonResponse(result.body, status < 400, status);
    }
    return jsonResponse({ data: [] });
  });
}

// Default advance covers the archived section's search debounce
// (ARCHIVED_SEARCH_DEBOUNCE_MS = 300ms) plus whatever microtask chain a
// resolved (non-held) mock fetch needs to settle. Tests that manually hold a
// fetch open (the race test below) advance by smaller, explicit amounts of
// their own instead of relying on this default.
async function flush(ms = 350) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function expandArchivedSection() {
  fireEvent.click(screen.getByTestId('org-archived-toggle'));
  await flush();
}

/** Whether any fetch issued so far carried `includeArchived=true` — checked by
 * scanning the mock's own call args rather than `toHaveBeenCalledWith`, which
 * compares full argument LISTS: `fetchWithAuth` is called with a single
 * positional arg here, so a 2-arg matcher (e.g. `..., expect.anything()`)
 * would never match any real call and silently pass for the wrong reason. */
function archivedFetchWasIssued(): boolean {
  return fetchMock.mock.calls.some((call) => String(call[0]).includes('includeArchived=true'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
  fetchMock.mockReset();
  navigateTo.mockReset();
  storeFetchOrganizations.mockClear();
  showToastMock.mockClear();
  window.location.hash = '';
  orgsState = [ORG_A];
  mockJwtScope = 'partner';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsPage — Archived section', () => {
  it('starts collapsed and does not fetch archived orgs until expanded', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();

    expect(screen.queryByTestId('org-archived-section')).not.toBeInTheDocument();
    expect(archivedFetchWasIssued()).toBe(false);

    await expandArchivedSection();

    expect(archivedFetchWasIssued()).toBe(true);
    expect(screen.getByTestId('org-archived-section')).toBeInTheDocument();
    expect(screen.getByTestId('org-archived-row')).toBeInTheDocument();
    expect(within(screen.getByTestId('org-archived-row')).getByText('Gamma LLC')).toBeInTheDocument();
  });

  it('renders a purge countdown computed from purgeAt against the current fixed time', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    // purgeAt is exactly 30 days after the fixed "now" set in beforeEach.
    expect(within(screen.getByTestId('org-archived-row')).getByText('Purges in 30 days')).toBeInTheDocument();
  });

  it('renders "kept indefinitely" when purgeAt is null', async () => {
    mockApi({ archivedOrgs: [{ ...ARCHIVED_ORG, purgeAt: null }] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    expect(within(screen.getByTestId('org-archived-row')).getByText('Kept indefinitely')).toBeInTheDocument();
  });

  it('renders a truncation note when the API reports archivedTruncated', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG], archivedTruncated: true });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    expect(screen.getByTestId('org-archived-truncated-note')).toBeInTheDocument();
  });

  it('does not render a truncation note when archivedTruncated is false', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG], archivedTruncated: false });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    expect(screen.queryByTestId('org-archived-truncated-note')).not.toBeInTheDocument();
  });

  it('only appends archived rows from the final page of a multi-page live-org walk', async () => {
    // A full first page of live orgs (== the page size) so fetchAllOrganizations
    // continues to a second page instead of stopping after page 1 — proving the
    // archived section still finds rows that ride along on the LAST page only
    // (isFinalOrganizationsPage, orgs.ts), not just the trivial one-page case
    // every other test here exercises.
    const page1LiveOrgs: Organization[] = Array.from({ length: ORGANIZATIONS_PAGE_SIZE }, (_, i) => ({
      id: `page1-org-${i}`,
      name: `Page1 Org ${i}`,
      status: 'active',
      deviceCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
    }));

    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;

      if (url.includes('includeArchived=true')) {
        const page = new URL(url, 'http://localhost').searchParams.get('page');
        if (page === '1') return jsonResponse({ data: page1LiveOrgs });
        // Second (final) page: short (< page size) so the walk stops here,
        // carrying the archived block per the real API's contract.
        return jsonResponse({ data: [ARCHIVED_ORG], archivedTruncated: false });
      }
      if (url.startsWith('/orgs/organizations?') && !method) return jsonResponse({ data: orgsState });
      if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
      if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
      return jsonResponse({ data: [] });
    });

    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();
    await flush();

    expect(screen.getByTestId('org-archived-row')).toBeInTheDocument();
    expect(within(screen.getByTestId('org-archived-row')).getByText('Gamma LLC')).toBeInTheDocument();
  });
});

describe('OrganizationsPage — Archived section search reachability', () => {
  it('filters already-loaded archived rows by the page search box and forwards the term as the API search param', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG, DELTA_ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    expect(screen.getAllByTestId('org-archived-row')).toHaveLength(2);

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Gamma' } });
    await flush();

    // Forwarded as the API's own `search` query param (routes/orgs.ts /
    // archivedOrgReads.ts both filter archived rows by it server-side).
    expect(
      fetchMock.mock.calls.some(
        (call) => String(call[0]).includes('includeArchived=true') && String(call[0]).includes('search=Gamma'),
      ),
    ).toBe(true);

    const rows = screen.getAllByTestId('org-archived-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Gamma LLC')).toBeInTheDocument();
  });

  it('shows the no-matches copy (not the empty-section copy) when a search matches no archived org', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Nonexistent Org' } });
    await flush();

    expect(screen.getByText('No archived organizations match your search.')).toBeInTheDocument();
    expect(screen.queryByText('No archived organizations.')).not.toBeInTheDocument();
  });

  it('does not fetch archived orgs at all while the section stays collapsed, even if the search box changes', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Gamma' } });
    await flush();

    expect(archivedFetchWasIssued()).toBe(false);
  });

  it('does not issue a search fetch before the debounce window elapses', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();
    fetchMock.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Gamma' } });
    // Well under the 300ms debounce — nothing should have gone out yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(archivedFetchWasIssued()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(archivedFetchWasIssued()).toBe(true);
  });
});

describe('OrganizationsPage — Archived section search race safety', () => {
  it('drops a stale search response that resolves after a newer one, even though it started first (older-resolves-last)', async () => {
    // Each distinct `search` value gets its own held-open promise, released
    // explicitly by the test — same technique as
    // MergeOrgModal.test.tsx's "stale preview race" suite.
    const held: Record<string, (body: unknown) => void> = {};
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;

      if (url.includes('includeArchived=true')) {
        const search = new URL(url, 'http://localhost').searchParams.get('search') ?? '';
        if (!search) {
          // The initial (no-search) expand load resolves immediately.
          return jsonResponse({ data: [...orgsState, ARCHIVED_ORG, DELTA_ARCHIVED_ORG], archivedTruncated: false });
        }
        return new Promise<Response>((resolve) => {
          held[search] = (body: unknown) => resolve(jsonResponse(body));
        });
      }
      if (url.startsWith('/orgs/organizations?') && !method) return jsonResponse({ data: orgsState });
      if (url === '/orgs/partners/me') return jsonResponse({ settings: {} });
      if (url.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [] });
      return jsonResponse({ data: [] });
    });

    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();
    expect(screen.getAllByTestId('org-archived-row')).toHaveLength(2);

    // Type "Gamma" — the OLDER request. Advance past the debounce so its
    // fetch actually fires and hangs open (held, not yet resolved).
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Gamma' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(held.Gamma).toBeDefined();

    // Before it resolves, change the search again — the NEWER request. Its
    // own debounced fetch fires and is ALSO held open.
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'Delta' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(held.Delta).toBeDefined();

    // Release the NEWER request first.
    await act(async () => {
      held.Delta({ data: [...orgsState, DELTA_ARCHIVED_ORG], archivedTruncated: false });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByTestId('org-archived-row')).toHaveLength(1);
    expect(screen.getByText('Delta Inc')).toBeInTheDocument();

    // Now release the OLDER ("Gamma") request — it resolves LAST. It must be
    // dropped by the request-token guard rather than clobbering the newer
    // (Delta) results already on screen.
    await act(async () => {
      held.Gamma({ data: [...orgsState, ARCHIVED_ORG], archivedTruncated: false });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByTestId('org-archived-row')).toHaveLength(1);
    expect(screen.getByText('Delta Inc')).toBeInTheDocument();
    expect(screen.queryByText('Gamma LLC')).not.toBeInTheDocument();
  });
});

describe('OrganizationsPage — archived org detail pane is read-only', () => {
  it('selecting an archived row hides every mutation button and shows only Restore', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();

    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByTestId('org-restore')).toBeInTheDocument();
    expect(within(panel).getByTestId('org-archived-readonly-notice')).toBeInTheDocument();
    expect(within(panel).getByTestId('org-archived-detail-badge')).toBeInTheDocument();
    expect(within(panel).getByTestId('org-archived-detail-purge')).toBeInTheDocument();

    // No edit/merge/archive affordances — only the Restore button.
    expect(within(panel).queryByTestId('org-archive-open')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('org-merge-open')).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('button')).toHaveLength(1);
  });
});

describe('OrganizationsPage — restore', () => {
  it('on 200, POSTs the specific org, moves it to the active list under its returned status, and surfaces recreateRequired', async () => {
    mockApi({
      archivedOrgs: [ARCHIVED_ORG],
      restoreResponse: () => ({
        body: { status: 'trial', recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'] },
      }),
    });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();
    fireEvent.click(screen.getByTestId('org-restore'));
    await flush();

    // Pinned to the specific archived org's id — not just "some" restore URL.
    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });

    // Moved into the active list under the pre-archive status the API
    // returned, and the row itself renders that status (not just present).
    const row = screen.getByTestId(`org-row-${ARCHIVED_ORG.id}`);
    expect(within(row).getByText('Trial')).toBeInTheDocument();

    // The detail pane switched out of read-only for the now-restored org.
    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).queryByTestId('org-restore')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('org-archive-open')).toBeInTheDocument();

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        message: expect.stringContaining('re-enrolled'),
      }),
    );
  });

  it('reconciles the global org store (fire-and-forget) after a successful restore', async () => {
    mockApi({ archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();
    expect(storeFetchOrganizations).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('org-restore'));
    await flush();

    // The org switcher/sidebar reads this store, not this page's own state —
    // without this it would keep showing the restored org as archived/absent
    // until a full reload.
    expect(storeFetchOrganizations).toHaveBeenCalledTimes(1);
  });

  it('respects a suspended pre-archive status: the row renders Suspended and the toast adds the suspended-restore note', async () => {
    mockApi({
      archivedOrgs: [ARCHIVED_ORG],
      restoreResponse: () => ({
        body: { status: 'suspended', recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'] },
      }),
    });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();
    fireEvent.click(screen.getByTestId('org-restore'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });

    // The list itself reflects the suspended status, not just the toast copy.
    const row = screen.getByTestId(`org-row-${ARCHIVED_ORG.id}`);
    expect(within(row).getByText('Suspended')).toBeInTheDocument();

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        message: expect.stringContaining('suspended'),
      }),
    );
  });

  it('on 410, shows the exact purging-refusal copy and leaves the org archived', async () => {
    mockApi({
      archivedOrgs: [ARCHIVED_ORG],
      restoreResponse: () => ({
        body: { error: 'Organization is already purging and can no longer be restored' },
        status: 410,
      }),
    });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();
    fireEvent.click(screen.getByTestId('org-restore'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'This organization is already being permanently deleted and can no longer be restored.',
      }),
    );
    // Still archived and read-only — the restore never applied.
    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByTestId('org-restore')).toBeInTheDocument();
    expect(screen.queryByTestId(`org-row-${ARCHIVED_ORG.id}`)).not.toBeInTheDocument();
    expect(storeFetchOrganizations).not.toHaveBeenCalled();
  });

  it('on 409, surfaces the raw backend message verbatim and leaves the org archived', async () => {
    mockApi({
      archivedOrgs: [ARCHIVED_ORG],
      restoreResponse: () => ({
        body: { error: 'Organization cannot be restored from its current status' },
        status: 409,
      }),
    });
    render(<OrganizationsPage />);
    await flush();
    await expandArchivedSection();

    fireEvent.click(screen.getByTestId('org-archived-row'));
    await flush();
    fireEvent.click(screen.getByTestId('org-restore'));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });
    // No special-cased copy for a plain 409 — the backend's own message
    // surfaces verbatim (only MFA and the 410 purging text get localized copy).
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Organization cannot be restored from its current status',
      }),
    );
    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByTestId('org-restore')).toBeInTheDocument();
    expect(screen.queryByTestId(`org-row-${ARCHIVED_ORG.id}`)).not.toBeInTheDocument();
    expect(storeFetchOrganizations).not.toHaveBeenCalled();
  });
});
