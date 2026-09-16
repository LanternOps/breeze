import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/lib/i18n';
import { fetchWithAuth } from '@/stores/auth';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { useEventStream } from '@/hooks/useEventStream';
import { ALPHA, BETA, GAMMA, ALL_CAPS, readinessFor, jsonResponse } from './boardTestKit';

// Same mocking convention as W02's page tests. If W02's boardTestKit.ts exports a
// fetch router (`mockBoardApi` or similar), use it instead of `mockApi` below so
// the org-list and readiness fixtures have one definition.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
// orgStore.ts calls registerOrgIdProvider() from '@/stores/auth' at import time; the
// mock above has no such export, so the real store must never load (same pattern as
// OrganizationsBoardPage.render.test.tsx).
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
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: 'system' as const, orgId: null, partnerId: null } }),
  getJwtClaims: () => ({ scope: 'system' as const, orgId: null, partnerId: null }),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => true,
  usePermissions: () => ({ permissions: [{ resource: '*', action: '*' }], can: () => true }),
}));

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const fetchMock = vi.mocked(fetchWithAuth);
function NotificationStream() {
  useEventStream({ onEvent: () => {} });
  return null;
}
function mockApi(partners: string[]) {
  const orgs = [ALPHA, BETA, GAMMA].slice(0, partners.length).map((org, i) => ({ ...org, partnerId: partners[i] }));
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/orgs/organizations') return jsonResponse({ data: orgs, pagination: { page: 1, limit: 100, total: orgs.length } });
    if (url.pathname === '/events/ws-ticket') return jsonResponse({ ticket: 'test-ticket' });
    const selected = orgs.filter((org) => org.partnerId === url.searchParams.get('partnerId'));
    return jsonResponse({ capabilities: ALL_CAPS, serviceManagementMode: 'native', orgs: selected.map((org) => readinessFor(org)) });
  });
}
function requests(path: string) {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost')).filter((url) => url.pathname === path);
}
beforeEach(() => {
  fetchMock.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    readyState = 0;
    close = vi.fn();
    send = vi.fn();
  });
});
afterEach(() => vi.unstubAllGlobals());
it('derives the only partner for readiness and the shared notification ticket', async () => {
  mockApi([P1, P1]);
  render(<><OrganizationsBoardPage /><NotificationStream /></>);
  await waitFor(() => expect(requests('/orgs/account-readiness')[0]?.searchParams.get('partnerId')).toBe(P1));
  await waitFor(() => expect(requests('/events/ws-ticket').some((url) => url.searchParams.get('partnerId') === P1)).toBe(true));
  expect(requests('/events/ws-ticket').every((url) => url.searchParams.get('partnerId') === P1)).toBe(true);
  expect(screen.queryByTestId('board-partner-select')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId('org-board-chips-complete').length).toBeGreaterThan(0));
});
it('disables manual reordering for a system session with only one partner', async () => {
  mockApi([P1, P1]);
  render(<OrganizationsBoardPage />);
  await screen.findByTestId('org-board-table');
  expect(screen.getByTestId('org-board-sort')).toHaveValue('manual');
  expect(screen.queryAllByTestId('org-board-drag-handle')).toHaveLength(0);
});
it('labels partner options with shortened ids and organization counts and explains the totals', async () => {
  mockApi([P1, P1, P2]);
  render(<OrganizationsBoardPage />);
  const select = await screen.findByTestId('board-partner-select') as HTMLSelectElement;
  expect(Array.from(select.options, (option) => option.textContent)).toEqual([
    '11111111… (2 orgs)',
    '22222222… (1 org)',
  ]);
  expect(screen.getByTestId('board-partner-scope-hint')).toHaveTextContent(
    "Showing one partner's accounts; totals below are for this partner only",
  );
});
it('selects the first partner and refetches only the selected partner organizations on change', async () => {
  mockApi([P1, P2]);
  render(<><OrganizationsBoardPage /><NotificationStream /></>);
  const select = await screen.findByTestId('board-partner-select');
  expect(select).toHaveValue(P1);
  await waitFor(() => expect(requests('/orgs/account-readiness')[0]?.searchParams.get('orgIds')).toBe(ALPHA.id));
  fireEvent.change(select, { target: { value: P2 } });
  await waitFor(() => expect(requests('/orgs/account-readiness').at(-1)?.searchParams.get('partnerId')).toBe(P2));
  expect(requests('/orgs/account-readiness').at(-1)?.searchParams.get('orgIds')).toBe(BETA.id);
  await waitFor(() => expect(requests('/events/ws-ticket').at(-1)?.searchParams.get('partnerId')).toBe(P2));
  expect(screen.queryAllByTestId(`org-board-row-${ALPHA.id}`)).toHaveLength(0);
  expect(screen.getAllByTestId(`org-board-row-${BETA.id}`).length).toBeGreaterThan(0);
});
