import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn()
}));

// OrganizationsPage reads useJwtClaims() to gate the merge-org launcher button
// (partner-scope only). It subscribes to useAuthStore directly, which the
// mock above does not export — stub the module's own public surface instead
// of wiring up a fake zustand store. 'unresolved' just hides the button,
// which is irrelevant to these reorder/redirect assertions.
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'unresolved' as const }),
  getJwtClaims: () => ({ scope: null, orgId: null, partnerId: null }),
}));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const storeFetchOrganizations = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ fetchOrganizations: storeFetchOrganizations }) }
}));

const fetchMock = vi.mocked(fetchWithAuth);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const toastMock = vi.mocked(showToast);

const ORG_A = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', deviceCount: 0, createdAt: '2026-01-01T00:00:00Z' };
const ORG_B = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Beta Ltd', status: 'active', deviceCount: 0, createdAt: '2026-01-02T00:00:00Z' };
const ORG_C = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma Ltd', status: 'active', deviceCount: 0, createdAt: '2026-01-03T00:00:00Z' };

/** Drag the row with `sourceId` onto the row with `targetId`. */
function drag(sourceId: string, targetId: string) {
  const source = screen.getByTestId(`org-row-${sourceId}`);
  const target = screen.getByTestId(`org-row-${targetId}`);
  const dataTransfer = { effectAllowed: '', setData: vi.fn(), dropEffect: '' };
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Rendered order of the org rows, top to bottom. */
function renderedOrgIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="org-row-"]')).map(
    el => (el.getAttribute('data-testid') ?? '').replace('org-row-', '')
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  navigateTo.mockReset();
  sessionExpiredMock.mockReset();
  toastMock.mockReset();
  storeFetchOrganizations.mockClear();
  window.location.hash = '';
});

describe('OrganizationsPage — the list GET is not a second, poorer redirect', () => {
  it('routes a 401 through handleSessionExpired instead of a bare /login navigation', async () => {
    // fetchWithAuth funnels a real session expiry through handleSessionExpired,
    // which redirects carrying `next` and `reason`. A bare navigateTo('/login')
    // here would race that and replace it with a destination-less /login.
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized' }, false, 401));

    render(<OrganizationsPage />);

    await waitFor(() => expect(sessionExpiredMock).toHaveBeenCalled());
    expect(navigateTo).not.toHaveBeenCalledWith('/login', expect.anything());
  });
});

describe('OrganizationsPage — a failed reorder reconciles with the server', () => {
  /** The order the mock server reports; tests set what it should be believed to hold. */
  let serverOrgs = [ORG_A, ORG_B, ORG_C];
  let listGets = 0;
  let patchCount = 0;

  function mockApi(onPatch: (n: number) => Promise<Response>) {
    serverOrgs = [ORG_A, ORG_B, ORG_C];
    listGets = 0;
    patchCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations/order')) {
        patchCount += 1;
        return onPatch(patchCount);
      }
      if (url.startsWith('/orgs/organizations') && init?.method === undefined) {
        listGets += 1;
        return jsonResponse({ data: serverOrgs });
      }
      return jsonResponse({ data: [] });
    });
  }

  async function renderAndSettle() {
    render(<OrganizationsPage />);
    expect(await screen.findByText('Alpha Ltd')).toBeInTheDocument();
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_A.id, ORG_B.id, ORG_C.id]));
  }

  /**
   * runAction collapses ANY request-side throw to status 0, so the client cannot
   * tell "never reached the server" from "committed, response lost". That is why
   * reconciliation asks the server instead of restoring a local snapshot: here
   * the PATCH DID commit, and the correct final state is the server's new order.
   */
  it('adopts the server order after an ambiguous transport failure that actually committed', async () => {
    mockApi(async () => {
      serverOrgs = [ORG_B, ORG_A, ORG_C]; // the write landed; only the ack was lost
      throw new TypeError('Failed to fetch');
    });
    await renderAndSettle();
    const getsBefore = listGets;

    drag(ORG_B.id, ORG_A.id);
    // Optimistic order first — rules out a regression where dragging is a no-op.
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_B.id, ORG_A.id, ORG_C.id]));

    await waitFor(() => expect(patchCount).toBe(1));
    await waitFor(() => expect(listGets).toBeGreaterThan(getsBefore));
    // A local rollback would show [A,B,C] here and contradict the server.
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_B.id, ORG_A.id, ORG_C.id]));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  /** The distinguishing case: the server order DIFFERS from what the drag produced. */
  it('restores the server order when the PATCH is genuinely rejected', async () => {
    mockApi(async () => jsonResponse({ error: 'Could not save order' }, false, 500));
    await renderAndSettle();
    const getsBefore = listGets;

    drag(ORG_B.id, ORG_A.id);
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_B.id, ORG_A.id, ORG_C.id]));

    await waitFor(() => expect(patchCount).toBe(1));
    await waitFor(() => expect(listGets).toBeGreaterThan(getsBefore));
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_A.id, ORG_B.id, ORG_C.id]));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  /**
   * Every stale-order race on this page needs a SECOND drag to start while the
   * first request or its reconciling GET is still in flight. Dragging is
   * disabled for that whole window, which removes the class rather than
   * guarding each instance.
   */
  it('refuses a second reorder while the first is still in flight', async () => {
    let releasePatch: ((r: Response) => void) | undefined;
    mockApi(async () => new Promise<Response>((resolve) => { releasePatch = resolve; }));
    await renderAndSettle();

    drag(ORG_B.id, ORG_A.id);
    await waitFor(() => expect(patchCount).toBe(1));
    const afterFirst = renderedOrgIds();

    drag(ORG_C.id, ORG_B.id); // attempted mid-flight

    expect(patchCount).toBe(1);
    expect(renderedOrgIds()).toEqual(afterFirst);

    releasePatch!(jsonResponse({ ok: true }));
    await waitFor(() => expect(patchCount).toBe(1));
  });

  /**
   * `loading` is an early return that swaps the whole page for a spinner. The
   * assertions must run WHILE the reconciling GET is in flight — an earlier
   * version asserted after it resolved and passed with the fix reverted.
   */
  it('reconciles without blanking the page to the loading spinner', async () => {
    let releaseGet: (() => void) | undefined;
    let getHeld = false;

    serverOrgs = [ORG_A, ORG_B, ORG_C];
    listGets = 0;
    patchCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations/order')) {
        patchCount += 1;
        return jsonResponse({ error: 'nope' }, false, 500);
      }
      if (url.startsWith('/orgs/organizations') && init?.method === undefined) {
        listGets += 1;
        if (listGets > 1) {
          getHeld = true;
          return new Promise<Response>((resolve) => {
            releaseGet = () => resolve(jsonResponse({ data: serverOrgs }));
          });
        }
        return jsonResponse({ data: serverOrgs });
      }
      return jsonResponse({ data: [] });
    });

    await renderAndSettle();
    drag(ORG_B.id, ORG_A.id);
    await waitFor(() => expect(getHeld).toBe(true));

    expect(renderedOrgIds().length).toBe(3);
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();

    releaseGet!();
    await waitFor(() => expect(renderedOrgIds()).toEqual([ORG_A.id, ORG_B.id, ORG_C.id]));
  });
});
