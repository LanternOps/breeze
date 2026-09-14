// apps/web/src/components/organizations/board/OrganizationsBoardPage.archived.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ARCHIVED_ORG, DRAINING_ORG, ALPHA, BETA, GAMMA, flush, mockBoardApi, renderedRowIds } from './boardTestKit';
import { ARCHIVED_SEARCH_DEBOUNCE_MS } from './useArchivedOrganizations';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo }));
const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));
// The workspace (OrgSwitcher) selection and the partner's Service Management
// mode, read through store selectors; mutate per test before rendering.
const store = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  serviceManagementMode: 'native' as 'native' | 'external' | 'off',
  fetchOrganizations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : undefined), {
    getState: () => store,
  }),
}));
// Partner-scope gating (merge) and the tickets:write gate (New ticket).
const auth = vi.hoisted(() => ({
  scope: 'partner' as 'system' | 'partner' | 'organization' | null,
  permissions: [{ resource: '*', action: '*' }] as Array<{ resource: string; action: string }>,
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: auth.scope, orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: auth.scope, orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => true,
  usePermissions: () => ({
    permissions: auth.permissions,
    can: (resource: string, action: string) =>
      auth.permissions.some((p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*')),
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const row = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`));
const archivedFetches = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('includeArchived=true'));
const settle = () => flush(ARCHIVED_SEARCH_DEBOUNCE_MS + 50);

async function openArchived() {
  fireEvent.click(screen.getByTestId('org-board-filter-archived'));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z')); // ARCHIVED_ORG purges exactly 30 days later
  fetchMock.mockReset();
  toastMock.mockReset();
  navigateTo.mockReset();
  store.fetchOrganizations.mockClear();
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — Archived filter', () => {
  it('is always offered, fetches only when applied, and then shows its count', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    expect(screen.getByTestId('org-board-filter-archived')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-archived-count')).not.toBeInTheDocument();
    expect(archivedFetches()).toHaveLength(0);
    await openArchived();
    expect(archivedFetches()).toHaveLength(1);
    expect(renderedRowIds()).toEqual([ARCHIVED_ORG.id]);
    expect(screen.getByTestId('org-board-filter-archived-count')).toHaveTextContent('1');
    expect(window.location.hash).toBe('#lens=both&filter=archived');
  });

  it('renders the badge and purge countdown; a draining org reads Archiving…', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG, DRAINING_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(row(ARCHIVED_ORG.id).getByTestId('org-board-archived-badge')).toHaveTextContent('Archived');
    expect(row(ARCHIVED_ORG.id).getByTestId('org-board-archived-purge')).toHaveTextContent('Purges in 30 days');
    expect(row(DRAINING_ORG.id).getByTestId('org-board-archived-badge')).toHaveTextContent('Archiving…');
    expect(row(DRAINING_ORG.id).getByTestId('org-board-archived-purge')).toHaveTextContent('Kept indefinitely');
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('the row menu of an archived row offers Open record and Restore only', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    fireEvent.click(desktop().getByTestId(`org-board-more-${ARCHIVED_ORG.id}`));
    const ids = within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['org-board-menu-open-record', 'org-board-menu-restore']);
  });

  it('forwards the search term server-side and narrows the rows; no-match copy differs from empty copy', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG, { ...DRAINING_ORG, name: 'Zeta Archived', status: 'archived' }] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    fireEvent.change(screen.getByTestId('org-board-search'), { target: { value: 'zeta' } });
    await settle();
    expect(String(archivedFetches().at(-1)![0])).toContain('search=zeta');
    expect(renderedRowIds()).toEqual([DRAINING_ORG.id]);
    fireEvent.change(screen.getByTestId('org-board-search'), { target: { value: 'nothing' } });
    await settle();
    expect(screen.getByTestId('org-board-archived-empty')).toHaveTextContent('No archived organizations match your search.');
  });

  it('shows the empty copy when there are truly no archived organizations', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(screen.getByTestId('org-board-archived-empty')).toHaveTextContent('No archived organizations.');
  });

  it('surfaces archivedTruncated as the note it is today', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG], archivedTruncated: true });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(screen.getByTestId('org-board-archived-truncated-note')).toHaveTextContent('Showing the first 1 archived organizations.');
  });
});

describe('OrganizationsBoardPage — restore', () => {
  async function restore(id: string) {
    fireEvent.click(desktop().getByTestId(`org-board-more-${id}`));
    fireEvent.click(screen.getByTestId('org-board-menu-restore'));
    await settle();
  }

  it('on 200, POSTs the specific org, moves it to the live list under its returned status, surfaces recreateRequired and refreshes the store', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { status: 'trial', recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'] } }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });
    expect(desktop().queryByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).not.toBeInTheDocument(); // gone from Archived
    fireEvent.click(screen.getByTestId('org-board-filter-all'));
    await settle();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id, ARCHIVED_ORG.id]);
    expect(row(ARCHIVED_ORG.id).getByText('Trial')).toBeInTheDocument();
    expect(store.fetchOrganizations).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('re-enrolled') }));
  });

  it('a suspended pre-archive status restores as suspended, with the suspended note', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG], onRestore: () => ({ body: { status: 'suspended', recreateRequired: [] } }) });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('suspended') }));
  });

  it('on 410, shows the exact purging-refusal copy and leaves the org archived', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { error: 'Organization is already purging and can no longer be restored' }, status: 410 }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'This organization is already being permanently deleted and can no longer be restored.' }),
    );
    expect(desktop().getByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).toBeInTheDocument();
    expect(store.fetchOrganizations).not.toHaveBeenCalled();
  });

  it('on 409, surfaces the raw backend message verbatim and leaves the org archived', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { error: 'Organization cannot be restored from its current status' }, status: 409 }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Organization cannot be restored from its current status' }));
    expect(desktop().getByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).toBeInTheDocument();
  });
});
