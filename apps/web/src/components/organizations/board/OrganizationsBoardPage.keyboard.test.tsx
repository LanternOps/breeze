// apps/web/src/components/organizations/board/OrganizationsBoardPage.keyboard.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { ALPHA, BETA, GAMMA, flush, jsonResponse, mockBoardApi, renderedRowIds } from './boardTestKit';

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
const name = (id: string) => desktop().getByTestId(`org-board-name-${id}`);
const handle = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`)).getByTestId('org-board-drag-handle');
const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  auth.scope = 'partner';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — keyboard operability', () => {
  it('names the search input', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByRole('searchbox', { name: 'Search organizations, contacts and emails' })).toBeInTheDocument();
  });

  it('the first row’s name link is the roving tab stop; rows never carry aria-current', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(name(ALPHA.id)).toHaveAttribute('tabindex', '0');
    expect(name(BETA.id)).toHaveAttribute('tabindex', '-1');
    expect(name(ALPHA.id)).not.toHaveAttribute('aria-current');
    expect(desktop().getByTestId(`org-board-row-${ALPHA.id}`)).not.toHaveAttribute('aria-current');
  });

  it('Arrow/Home/End move focus and the tab stop without opening a record', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    name(ALPHA.id).focus();
    fireEvent.keyDown(name(ALPHA.id), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(name(BETA.id));
    expect(name(BETA.id)).toHaveAttribute('tabindex', '0');
    expect(name(ALPHA.id)).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(name(BETA.id), { key: 'End' });
    expect(document.activeElement).toBe(name(GAMMA.id));
    fireEvent.keyDown(name(GAMMA.id), { key: 'Home' });
    expect(document.activeElement).toBe(name(ALPHA.id));
    fireEvent.keyDown(name(ALPHA.id), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(name(ALPHA.id));
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('the handle and the row menu trigger share the row’s tab stop', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(handle(ALPHA.id)).toHaveAttribute('tabindex', '0');
    expect(handle(BETA.id)).toHaveAttribute('tabindex', '-1');
    expect(desktop().getByTestId(`org-board-more-${ALPHA.id}`)).toHaveAttribute('tabindex', '0');
    expect(desktop().getByTestId(`org-board-more-${BETA.id}`)).toHaveAttribute('tabindex', '-1');
  });

  it('the reorder handle moves the org with the arrow keys, persists the order, and announces the move', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha Ltd' }), { key: 'ArrowDown' });
    await flush();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(String(patches()[0][1]!.body))).toEqual({ orderedIds: [BETA.id, ALPHA.id, GAMMA.id] });
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(screen.getByTestId('org-board-reorder-announcement')).toHaveTextContent('Alpha Ltd moved to position 2 of 3');
  });

  it('a held arrow key keeps walking the row: the handle stays mounted and focused while the PATCH is in flight', async () => {
    const holds: Array<(r: Response) => void> = [];
    mockBoardApi(fetchMock, { onOrder: () => new Promise<Response>((resolve) => { holds.push(resolve); }) });
    render(<OrganizationsBoardPage />);
    await flush();
    const alphaHandle = screen.getByRole('button', { name: 'Reorder Alpha Ltd' });
    alphaHandle.focus();
    fireEvent.keyDown(alphaHandle, { key: 'ArrowDown' });
    // Synchronously after the move, before the PATCH settles: same element, still focused, marked busy.
    expect(screen.getByRole('button', { name: 'Reorder Alpha Ltd' })).toBe(alphaHandle);
    expect(document.activeElement).toBe(alphaHandle);
    expect(alphaHandle).toHaveAttribute('aria-busy', 'true');
    holds[0](jsonResponse({ ok: true }));
    await flush();
    fireEvent.keyDown(alphaHandle, { key: 'ArrowUp' });
    holds[1](jsonResponse({ ok: true }));
    await flush();
    expect(patches().map(([, init]) => JSON.parse(String(init!.body)).orderedIds)).toEqual([
      [BETA.id, ALPHA.id, GAMMA.id],
      [ALPHA.id, BETA.id, GAMMA.id],
    ]);
    expect(document.activeElement).toBe(alphaHandle);
  });

  it('Add organization opens a real dialog that Escape closes', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(screen.getByTestId('org-board-add'));
    const dialog = screen.getByRole('dialog', { name: 'Add organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
