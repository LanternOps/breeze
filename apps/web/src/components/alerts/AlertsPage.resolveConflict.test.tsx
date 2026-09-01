import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

/**
 * Losing the resolve compare-and-swap from AlertsPage's detail panel (#4094).
 *
 * The API's single-alert resolve is winner-takes-all: when another technician
 * (or the auto-resolve sweep) transitions the alert first, this request gets a
 * 409 and the server publishes nothing on its behalf. `runAction` already
 * toasts the server's reason for that before `handleResolve`'s catch even runs.
 * What the catch's `err.status === 409` branch (AlertsPage.tsx ~288-302) adds on
 * top is: close the now-stale detail panel and refetch the list, so the row
 * stops offering Resolve on an alert that is already finished. A plain 500 must
 * NOT take that extra refetch/close path — the alert is not actually resolved,
 * so there is nothing to refresh.
 *
 * Reuses the mocking approach from the sibling AlertsPage.test.tsx and the
 * narrative style of AlertDetailPage.resolveConflict.test.tsx.
 */

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// The device filter bar issues its own fetches; stub it out so the page's
// alert/device fetches are the only traffic under test.
vi.mock('../filters/DeviceFilterBar', () => ({
  DeviceFilterBar: () => null
}));

// Pin the org-scope selector so the page doesn't try to read a real store.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { orgScope: string; currentOrgId: string | null }) => unknown) =>
    selector({ orgScope: 'current', currentOrgId: 'org-1' })
}));

// AlertDetails renders this panel, which fires its own remediation-suggestions
// fetch. Stub it so that traffic doesn't have to be mocked here — the resolve
// flow doesn't depend on it (mirrors AlertDetailPage.resolveConflict.test.tsx).
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const activeAlert = {
  id: ALERT_ID,
  title: 'High CPU on SRV-01',
  message: 'CPU above 95% for 5 minutes',
  severity: 'critical',
  status: 'active',
  deviceId: 'device-1',
  deviceName: 'SRV-01',
  triggeredAt: new Date().toISOString()
};

/**
 * The row's Resolve button does NOT call handleResolve directly — AlertsPage
 * wires the row's onResolve to `setSelectedAlert; setDetailOpen(true)` (see
 * AlertsPage.tsx ~617), and it's AlertDetails' own two-step confirm (Resolve ->
 * reveal note form -> Resolve Alert) that invokes the real onResolve prop,
 * i.e. the real handleResolve under test here.
 */
async function openDetailAndSubmitResolve() {
  fireEvent.click(await screen.findByRole('button', { name: /Resolve: High CPU on SRV-01/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Resolve$/i }));
  fireEvent.click(await within(dialog).findByRole('button', { name: /^Resolve Alert$/i }));
  return dialog;
}

/** Mocks the list/device/resolve traffic and returns a getter for how many
 *  times the alert LIST endpoint (not the single-alert resolve POST) was hit,
 *  so tests can assert on the extra post-409 refetch precisely. */
function mockAlerts(resolveResponse: () => Promise<Response>) {
  let listCalls = 0;
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/alerts?') && method === 'GET') {
      listCalls += 1;
      return Promise.resolve(makeJsonResponse({ data: [activeAlert] }));
    }
    // The device filter reads the options endpoint, not the old `/devices`
    // list — a `url === '/devices'` arm never matched and left this suite
    // falling through to the 404 branch.
    if (url.startsWith('/devices/options?') && method === 'GET') {
      return Promise.resolve(makeJsonResponse({
        data: [],
        page: { nextCursor: null, returned: 0, total: 0, hasMore: false, observedAt: '2026-08-31T00:00:00.000Z' },
      }));
    }
    if (url === `/alerts/${ALERT_ID}/resolve` && method === 'POST') {
      return resolveResponse();
    }
    return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
  });
  return () => listCalls;
}

describe('AlertsPage — resolve compare-and-swap (#4094)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refetches the list and closes the panel, while still toasting an error, when resolve loses the race (409)', async () => {
    const getListCalls = mockAlerts(() =>
      Promise.resolve(
        makeJsonResponse({ error: 'Alert was already resolved or dismissed by another request' }, false, 409)
      )
    );

    render(<AlertsPage />);
    await openDetailAndSubmitResolve();

    // runAction toasts the server's 409 reason before handleResolve's catch even
    // runs — suppressing the stale-status banner must not become suppressing
    // this feedback. This alone doesn't need the `err.status === 409` block (it
    // would pass even if that block were deleted); it's the guard for the
    // refetch/close assertions below.
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    // Mutation target: deleting the `if (err.status === 409) { handleCloseDetail();
    // fetchAlerts(); }` block leaves exactly ONE list call (the initial mount
    // fetch) and the dialog still open — this assertion catches that.
    await waitFor(() => {
      expect(getListCalls()).toBeGreaterThanOrEqual(2); // mount fetch + post-409 refetch
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('does NOT trigger the extra refetch/close on a plain 500 (the branch keys on the 409 status, not "any error")', async () => {
    const getListCalls = mockAlerts(() => Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500)));

    render(<AlertsPage />);
    await openDetailAndSubmitResolve();

    // Still gets an error toast — runAction toasts every non-401 ActionError
    // regardless of status. What must differ from the 409 case is everything
    // after that: a 500 means the alert was NOT actually resolved, so there is
    // nothing to refresh or close for.
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(getListCalls()).toBe(1); // only the mount-time list fetch
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // panel stays open
  });
});
