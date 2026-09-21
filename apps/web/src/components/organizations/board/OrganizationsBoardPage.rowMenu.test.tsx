// apps/web/src/components/organizations/board/OrganizationsBoardPage.rowMenu.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { ALPHA, BETA, GAMMA, flush, mockBoardApi, readinessFor, renderedRowIds } from './boardTestKit';

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
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

function openMenu(id: string) {
  fireEvent.click(desktop().getByTestId(`org-board-more-${id}`));
  return within(screen.getByRole('menu'));
}
const itemIds = (menu: ReturnType<typeof within>) =>
  menu.getAllByRole('menuitem').map((el: HTMLElement) => (el.getAttribute('data-testid') ?? '').replace('org-board-menu-', ''));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  applyOrgSwitchMock.mockReset();
  store.fetchOrganizations.mockClear();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  store.serviceManagementMode = 'native';
  auth.scope = 'partner';
  auth.permissions = [{ resource: '*', action: '*' }];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — row menu', () => {
  it('lists the full inventory for a partner in native mode with tickets:write', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    const menu = openMenu(ALPHA.id);
    expect(itemIds(menu)).toEqual(['open-record', 'contact', 'new-ticket', 'work-here', 'settings', 'archive', 'merge']);
    expect(menu.getAllByRole('separator')).toHaveLength(2);
    expect(menu.getByTestId('org-board-menu-open-record')).toHaveAttribute('href', `/organizations/${ALPHA.id}`);
    const contact = menu.getByTestId('org-board-menu-contact');
    expect(contact).toHaveTextContent('Contact Jane Doe');
    expect(contact).toHaveTextContent('jane@alpha.test · +1 555 0100');
    expect(contact).toHaveAttribute('href', 'mailto:jane@alpha.test');
    expect(menu.getByTestId('org-board-menu-new-ticket')).toHaveAttribute('href', `/tickets/new#orgId=${ALPHA.id}`);
    expect(menu.getByTestId('org-board-menu-merge').className).toContain('text-destructive');
  });

  it('a nameless contact is named by its email; a contact with only a mobile number gets a tel: link', async () => {
    mockBoardApi(fetchMock, {
      readiness: {
        [ALPHA.id]: readinessFor(ALPHA, { account: { primaryContact: { name: null, email: 'ops@alpha.test', phone: null, mobile: null } } }),
        [BETA.id]: readinessFor(BETA, { account: { primaryContact: { name: 'Sam', email: null, phone: null, mobile: '+1 555 0300' } } }),
      },
    });
    render(<OrganizationsBoardPage />);
    await flush();
    const alpha = openMenu(ALPHA.id);
    expect(alpha.getByTestId('org-board-menu-contact')).toHaveTextContent('Contact ops@alpha.test');
    expect(alpha.getByTestId('org-board-menu-contact')).toHaveAttribute('href', 'mailto:ops@alpha.test');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    const beta = openMenu(BETA.id);
    expect(beta.getByTestId('org-board-menu-contact')).toHaveTextContent('Contact Sam');
    expect(beta.getByTestId('org-board-menu-contact')).toHaveAttribute('href', 'tel:+1 555 0300');
  });

  it('hides Contact when there is no primary contact', async () => {
    mockBoardApi(fetchMock, { readiness: { [GAMMA.id]: readinessFor(GAMMA, { account: { primaryContact: null } }) } });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(GAMMA.id))).not.toContain('contact');
  });

  it('hides New ticket outside native mode', async () => {
    mockBoardApi(fetchMock, { mode: 'external' });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(ALPHA.id))).not.toContain('new-ticket');
  });

  it('hides New ticket without tickets:write', async () => {
    auth.permissions = [{ resource: 'organizations', action: 'read' }, { resource: 'tickets', action: 'read' }];
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(ALPHA.id))).not.toContain('new-ticket');
  });

  it('hides Merge outside partner scope', async () => {
    auth.scope = 'organization';
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    const ids = itemIds(openMenu(ALPHA.id));
    expect(ids).toContain('archive');
    expect(ids).not.toContain('merge');
  });

  it('Work in this org switches the workspace; Settings navigates to the org settings page', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-work-here'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(ALPHA.id, 'Switched to Alpha Ltd');
    fireEvent.click(openMenu(BETA.id).getByTestId('org-board-menu-settings'));
    expect(navigateTo).toHaveBeenCalledWith(`/settings/organizations/${BETA.id}`);
  });

  it('marks the workspace org’s row and nothing else', async () => {
    store.currentOrgId = BETA.id;
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(within(desktop().getByTestId(`org-board-row-${BETA.id}`)).getByTestId('org-board-workspace-marker')).toHaveTextContent('Workspace');
    expect(within(desktop().getByTestId(`org-board-row-${ALPHA.id}`)).queryByTestId('org-board-workspace-marker')).not.toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]); // marker only, never pinned to the top
  });
});

describe('OrganizationsBoardPage — archive and merge dialogs', () => {
  it('Archive opens the real ArchiveOrgModal; on 202 the row leaves the list and the modal stays on its done summary until Close', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-archive'));
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-archive-submit'));
    await flush();
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-done')).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([BETA.id, GAMMA.id]);
    fireEvent.click(screen.getByTestId('org-archive-close'));
    await flush();
    expect(screen.queryByTestId('org-archive-modal')).not.toBeInTheDocument();
  });

  it('Merge opens MergeOrgModal; completion drops the loser and the summary stays until Close', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-merge'));
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: BETA.id } });
    await flush();
    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: ALPHA.name } });
    fireEvent.click(screen.getByTestId('org-merge-submit'));
    await flush(); // merge POST (202) + the immediate first poll: 'completed'
    expect(screen.getByTestId('org-merge-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-merge-done')).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([BETA.id, GAMMA.id]);
    fireEvent.click(screen.getByTestId('org-merge-close'));
    await flush();
    expect(screen.queryByTestId('org-merge-modal')).not.toBeInTheDocument();
  });
});
