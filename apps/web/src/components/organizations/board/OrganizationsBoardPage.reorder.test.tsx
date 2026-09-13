// apps/web/src/components/organizations/board/OrganizationsBoardPage.reorder.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
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
const toastMock = vi.mocked(showToast);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const listGets = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/orgs/organizations?') && init?.method === undefined).length;

/** Drag the desktop row with `sourceId` onto the row with `targetId`. */
function drag(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn(), dropEffect: '' };
  fireEvent.dragStart(desktop().getByTestId(`org-board-row-${sourceId}`), { dataTransfer });
  fireEvent.dragOver(desktop().getByTestId(`org-board-row-${targetId}`), { dataTransfer });
  fireEvent.drop(desktop().getByTestId(`org-board-row-${targetId}`), { dataTransfer });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  toastMock.mockReset();
  sessionExpiredMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — the list GET is not a second, poorer redirect', () => {
  it('routes a 401 through handleSessionExpired instead of a bare /login navigation', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized' }, false, 401));
    render(<OrganizationsBoardPage />);
    await flush();
    expect(sessionExpiredMock).toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalledWith('/login', expect.anything());
  });
});

describe('OrganizationsBoardPage — a failed reorder reconciles with the server', () => {
  it('a drag PATCHes the new order and keeps it on success', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ orderedIds: [BETA.id, ALPHA.id, GAMMA.id] });
  });

  it('adopts the server order after an ambiguous transport failure that actually committed', async () => {
    const api = mockBoardApi(fetchMock, {
      onOrder: () => {
        api.state.orgs = [BETA, ALPHA, GAMMA]; // the write landed; only the ack was lost
        throw new Error('connection reset');
      },
    });
    render(<OrganizationsBoardPage />);
    await flush();
    const before = listGets();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(listGets()).toBeGreaterThan(before);
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('restores the server order when the PATCH is rejected with 403, surfacing the server’s message as a toast', async () => {
    mockBoardApi(fetchMock, { onOrder: () => jsonResponse({ error: 'Forbidden' }, false, 403) });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]); // optimistic
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]); // reconciled
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
  });

  it('refuses a second reorder while the first is still in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    mockBoardApi(fetchMock, { onOrder: () => new Promise<Response>((resolve) => { release = resolve; }) });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    const afterFirst = renderedRowIds();
    drag(GAMMA.id, BETA.id); // attempted mid-flight
    expect(renderedRowIds()).toEqual(afterFirst);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/orgs/organizations/order')).toHaveLength(1);
    release!(jsonResponse({ ok: true }));
    await flush();
  });

  it('reconciles without blanking the table to the skeleton', async () => {
    let releaseGet: (() => void) | undefined;
    let gets = 0;
    const api = mockBoardApi(fetchMock, { onOrder: () => jsonResponse({ error: 'nope' }, false, 500) });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations?') && init?.method === undefined) {
        gets += 1;
        if (gets > 1) return new Promise<Response>((resolve) => { releaseGet = () => resolve(jsonResponse({ data: api.state.orgs })); });
      }
      return base(input, init);
    });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(releaseGet).toBeDefined();
    expect(renderedRowIds()).toHaveLength(3);
    expect(screen.queryByTestId('org-board-skeleton')).not.toBeInTheDocument();
    releaseGet!();
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
  });
});
