import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

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

let orgsState: Organization[] = [ORG_A];

interface MockApiOptions {
  archivedOrgs?: Organization[];
  archivedTruncated?: boolean;
  /** Called for every restore POST; defaults to a plain 200 'active' restore. */
  restoreResponse?: () => { body: unknown; status?: number };
}

/** Routes every fetch the page issues, including the Archived section's
 * dedicated `includeArchived=true` GET and the restore POST. */
function mockApi(opts: MockApiOptions = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.includes('includeArchived=true')) {
      return jsonResponse({
        data: [...orgsState, ...(opts.archivedOrgs ?? [])],
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

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
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
  it('on 200, moves the org to the active list under its returned status and surfaces recreateRequired', async () => {
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

    // Moved into the active list under the pre-archive status the API returned.
    expect(screen.getByTestId(`org-row-${ARCHIVED_ORG.id}`)).toBeInTheDocument();
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

  it('respects a suspended pre-archive status and adds the suspended-restore note', async () => {
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

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        message: expect.stringContaining('suspended'),
      }),
    );
  });

  it('on 410, shows the purging-refusal copy and leaves the org archived', async () => {
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
  });

  it('on 409, shows an error toast and leaves the org archived', async () => {
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

    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
    const panel = screen.getByTestId('org-detail-panel');
    expect(within(panel).getByTestId('org-restore')).toBeInTheDocument();
    expect(screen.queryByTestId(`org-row-${ARCHIVED_ORG.id}`)).not.toBeInTheDocument();
  });
});
