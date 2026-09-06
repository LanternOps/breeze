import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AdminSessionManager from './AdminSessionManager';
import {
  apiLogout,
  fetchWithAuth,
  handleSessionExpired,
  restoreAccessTokenFromCookieDetailed,
  useAuthStore
} from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  apiLogout: vi.fn().mockResolvedValue(undefined),
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
  // Default 'transient' mirrors the old default-false mock: no side effects
  // (no stamp, no eviction) unless a test overrides it.
  restoreAccessTokenFromCookieDetailed: vi.fn().mockResolvedValue('transient'),
  useAuthStore: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const apiLogoutMock = vi.mocked(apiLogout);
const useAuthStoreMock = vi.mocked(useAuthStore);
const useOrgStoreMock = vi.mocked(useOrgStore);
const restoreAccessTokenFromCookieDetailedMock = vi.mocked(restoreAccessTokenFromCookieDetailed);
const handleSessionExpiredMock = vi.mocked(handleSessionExpired);

const ORG_ID = 'org-123';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('AdminSessionManager idle timeout source', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
    useOrgStoreMock.mockImplementation((selector: any) => selector({ currentOrgId: ORG_ID }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the idle timeout from the effective-settings endpoint, not the raw org record', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: { sessionTimeout: 120 } }, locked: [] })
    );

    render(<AdminSessionManager />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/effective-settings`
    );
    // It must NOT read the raw org record (that path misses partner defaults).
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(`/orgs/organizations/${ORG_ID}`);
  });

  it('enforces a partner-level effective session timeout for idle logout', async () => {
    // Partner default of 2 minutes, delivered via effective settings only —
    // the org has no local override.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: { sessionTimeout: 2 } }, locked: ['security.sessionTimeout'] })
    );

    render(<AdminSessionManager />);

    // Let the effective-settings fetch resolve and apply the 2-minute timeout.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Just under 2 minutes idle — no logout yet.
    await act(async () => {
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();

    // Cross the 2-minute threshold — the heartbeat must log out.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
  });

  it('keeps the 60-minute default when effective settings omit sessionTimeout', async () => {
    // Neither partner nor org set security.sessionTimeout — the guard must
    // reject the absent/zero value rather than produce a 1-minute timeout.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: {} }, locked: [] })
    );

    render(<AdminSessionManager />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Well past any short timeout but under the 60-minute default — no logout.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();
    });

    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it('falls back to the default timeout when the effective-settings request fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 500));

    render(<AdminSessionManager />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // A 500 must not crash or zero the timer — the default 60 min still applies.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();
    });

    expect(apiLogoutMock).not.toHaveBeenCalled();
  });
});

describe('AdminSessionManager All Organizations mode (#2347)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
    // All Organizations intentionally persists `currentOrgId` as null.
    useOrgStoreMock.mockImplementation((selector: any) => selector({ currentOrgId: null }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the partner-level session timeout instead of the 60-minute default when no org is selected', async () => {
    // Partner configured a 1440-minute (24h) timeout; the idle manager must honor
    // it even though no organization is selected for viewing.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 1440 } } })
    );

    render(<AdminSessionManager />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // It reads the authenticated user's partner record, never an org URL.
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/effective-settings')
    );

    // A background heartbeat crossing the 60-minute frontend fallback must NOT
    // log out while the configured partner timeout (1440 min) is far longer —
    // this is the exact #2347 regression.
    await act(async () => {
      vi.advanceTimersByTime(61 * 60_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it('still logs out once the configured partner timeout elapses in All Organizations mode', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 2 } } })
    );

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Just under 2 minutes — no logout yet.
    await act(async () => {
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();

    // Cross the 2-minute threshold — the heartbeat must log out.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
  });

  it('keeps the default timeout when the partner record cannot be loaded', async () => {
    // e.g. a non-partner scope gets 403 — never silently zero the timer.
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 403));

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });
});

describe('AdminSessionManager scope switching (#2348 / #2429)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Point the mocked org store at a scope; the next render observes it. */
  const setScope = (currentOrgId: string | null) => {
    useOrgStoreMock.mockImplementation((selector: any) => selector({ currentOrgId }));
  };

  it('refetches from the partner endpoint when switching org → All Organizations', async () => {
    setScope(ORG_ID);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: { sessionTimeout: 30 } }, locked: [] })
    );

    const { rerender } = render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG_ID}/effective-settings`
    );

    // Switch to All Organizations. The scope lives in the org store, so the
    // component only sees it on the next render — this is the rerender() the
    // suite previously never exercised.
    setScope(null);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 1440 } } })
    );

    rerender(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('does not enforce the previous org budget while the new scope is still loading', async () => {
    // Org scope has an aggressive 2-minute timeout.
    setScope(ORG_ID);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: { sessionTimeout: 2 } }, locked: [] })
    );

    const { rerender } = render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switch to All Organizations, where the partner allows 24h — but hold the
    // partner response open so we sit inside the async refetch window.
    setScope(null);
    let releasePartnerFetch!: (value: Response) => void;
    fetchWithAuthMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        releasePartnerFetch = resolve;
      })
    );

    rerender(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
    });

    // Mid-switch the new budget is unknown. The stale 2-minute ORG budget must
    // NOT be applied to the partner scope — that would log a partner admin out
    // moments after switching. This is the #2429 stale-value bug.
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();

    // Now let the partner settings land (1440 min) and confirm the session
    // still stands well past the old org budget.
    await act(async () => {
      releasePartnerFetch(
        makeJsonResponse({ settings: { security: { sessionTimeout: 1440 } } })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(30 * 60_000);
      await Promise.resolve();
    });
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it('still idle-logs-out on the default budget when the settings fetch never settles', async () => {
    // Guard against the tempting-but-wrong fix for the stale-budget bug: gating
    // idle logout on "the new scope's budget has resolved" means a settings
    // request that hangs forever silently disables session expiry altogether.
    // Enforcement must always fall back to the frontend default, never park.
    setScope(ORG_ID);
    fetchWithAuthMock.mockReturnValue(new Promise<Response>(() => {})); // never settles

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(61 * 60_000); // past the 60-minute default
      await Promise.resolve();
    });

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
  });

  it('does not RELAX a strict budget to the 60-minute default when the next lookup fails', async () => {
    // Resetting to DEFAULT on scope change must not become a loophole: an org
    // mandating a 5-minute idle timeout whose follow-up settings fetch blips
    // would otherwise silently get a 60-minute window — a 12x loosening of a
    // compliance control. The failure fallback clamps to the shortest budget we
    // have evidence for.
    setScope(ORG_ID);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ effective: { security: { sessionTimeout: 5 } }, locked: [] })
    );

    const { rerender } = render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switch scope; the new lookup fails outright.
    setScope('org-other');
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 500));

    rerender(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 5 minutes of idle must still log out — NOT be stretched to 60.
    await act(async () => {
      vi.advanceTimersByTime(6 * 60_000);
      await Promise.resolve();
    });

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
  });

  it('applies the newly selected org budget after switching All Organizations → org', async () => {
    // Partner scope allows 24h.
    setScope(null);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 1440 } } })
    );

    const { rerender } = render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switch into an org that locks the timeout down to 2 minutes.
    setScope(ORG_ID);
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        effective: { security: { sessionTimeout: 2 } },
        locked: ['security.sessionTimeout']
      })
    );

    rerender(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The org's stricter 2-minute budget now governs — the 1440 carried over
    // from the partner scope must not keep the session alive.
    await act(async () => {
      vi.advanceTimersByTime(3 * 60_000);
      await Promise.resolve();
    });

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
  });
});

// Task 3: the 5-minute keepalive heartbeat now reacts to the detailed
// restore outcome instead of discarding it — a dead refresh cookie must be
// caught proactively instead of surfacing only the next time the user
// clicks something.
describe('AdminSessionManager heartbeat refresh outcomes (Task 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
    // All Organizations mode, long partner timeout — keeps idle-logout well
    // out of range so these tests isolate the refresh-outcome behavior.
    useOrgStoreMock.mockImplementation((selector: any) => selector({ currentOrgId: null }));
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 1440 } } })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // NOTE on call counts below: the heartbeat effect depends on `idleTimeoutMs`
  // (unrelated to Task 3), which flips once the async partner-settings fetch
  // resolves — that remounts the effect and fires a second immediate
  // `runHeartbeat()` in the same settle window. For 'restored'/'auth-failed'
  // that second call is short-circuited (by the freshly-stamped
  // lastRefreshAtRef, and by idleLogoutInFlightRef, respectively) so only one
  // real refresh call lands; 'transient' stamps nothing and isn't guarded, so
  // both immediate calls go through. Assertions below capture the
  // post-settle baseline rather than hardcoding an absolute count, so they
  // assert the Task 3 behavior (retry vs. not) without being coupled to that
  // incidental double-mount.

  it("'restored' stamps lastRefreshAtRef so the next heartbeat inside the interval does not re-fetch", async () => {
    restoreAccessTokenFromCookieDetailedMock.mockResolvedValue('restored');

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterSettle = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThanOrEqual(1);

    // Well within the 5-minute refresh interval — must not re-fetch.
    await act(async () => {
      vi.advanceTimersByTime(4 * 60_000);
      await Promise.resolve();
    });

    expect(restoreAccessTokenFromCookieDetailedMock).toHaveBeenCalledTimes(callsAfterSettle);
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it("'auth-failed' calls handleSessionExpired and stands the heartbeat down permanently", async () => {
    restoreAccessTokenFromCookieDetailedMock.mockResolvedValue('auth-failed');

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('session-expired');
    const callsAfterSettle = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThanOrEqual(1);

    // Further ticks must not retry the refresh or call handleSessionExpired
    // again — idleLogoutInFlightRef stood the heartbeat down permanently,
    // same as the idle-timeout eviction path.
    await act(async () => {
      vi.advanceTimersByTime(30 * 60_000);
      await Promise.resolve();
    });

    expect(restoreAccessTokenFromCookieDetailedMock).toHaveBeenCalledTimes(callsAfterSettle);
    expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    // Distinct from the heartbeat's own idle-logout path (apiLogout) — a dead
    // refresh cookie is handled via handleSessionExpired instead.
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  // Same eviction as 'auth-failed', different reason code: the keepalive is
  // the second way a self-hoster on a rejected origin reaches /login, and it
  // must carry the code that explains the bounce.
  it("'origin-rejected' evicts with the origin-rejected reason", async () => {
    restoreAccessTokenFromCookieDetailedMock.mockResolvedValue('origin-rejected');

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('origin-rejected');
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it("'transient' does nothing — no eviction, no stamp, the next heartbeat retries", async () => {
    restoreAccessTokenFromCookieDetailedMock.mockResolvedValue('transient');

    render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterSettle = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThanOrEqual(1);
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();

    // lastRefreshAtRef was never stamped, so a later 30s heartbeat tick
    // retries rather than waiting out the full 5-minute interval — an
    // offline user (e.g. on a plane) must not be logged out.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(restoreAccessTokenFromCookieDetailedMock.mock.calls.length).toBeGreaterThan(callsAfterSettle);
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });
});

// Task 4: the idle budget now ends with a warning modal instead of a silent
// eviction. Passive signals must not answer it on the user's behalf.
describe('AdminSessionManager idle warning modal (Task 4)', () => {
  const ACTIVITY_EVENT_NAMES = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'focus'];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
    useOrgStoreMock.mockImplementation((selector: any) => selector({ currentOrgId: null }));
    // 10-minute budget → lead = min(2 min, 5 min) = 2 min, so the modal is due
    // at 8 minutes idle.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 10 } } })
    );
    restoreAccessTokenFromCookieDetailedMock.mockResolvedValue('restored');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Render and let the partner-settings fetch apply the 10-minute budget. */
  const renderSettled = async () => {
    const result = render(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  };

  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('raises the warning at idleTimeoutMs minus the lead and counts down in m:ss', async () => {
    await renderSettled();

    await advance(7 * 60_000);
    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();

    await advance(60_000);
    const dialog = screen.getByTestId('idle-warning-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('2:00');

    await advance(30_000);
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('1:30');
  });

  it('does not dismiss or extend the session on passive mousemove while visible', async () => {
    await renderSettled();
    await advance(8 * 60_000);
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseMove(window);
      fireEvent.scroll(window);
    });
    await advance(30_000);

    // Still up, and still counting down from the ORIGINAL deadline — a drifting
    // mouse must not stand in for the user.
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('1:30');
  });

  it('dismisses, marks activity and refreshes the token when "Stay signed in" is clicked', async () => {
    await renderSettled();
    await advance(8 * 60_000);
    const refreshCallsBeforeStay = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByTestId('idle-warning-stay'));
      await Promise.resolve();
    });

    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();
    expect(restoreAccessTokenFromCookieDetailedMock.mock.calls.length).toBeGreaterThan(
      refreshCallsBeforeStay
    );

    // Activity was marked, so the old deadline is gone: no re-warn, no logout.
    await advance(5 * 60_000);
    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();
    expect(apiLogoutMock).not.toHaveBeenCalled();
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
  });

  it('dismisses on deliberate keydown while the warning is visible', async () => {
    await renderSettled();
    await advance(8 * 60_000);
    const refreshCallsBeforeKey = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;

    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' });
      await Promise.resolve();
    });

    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();
    expect(restoreAccessTokenFromCookieDetailedMock.mock.calls.length).toBeGreaterThan(
      refreshCallsBeforeKey
    );
  });

  it('calls apiLogout before handleSessionExpired("idle") when the countdown expires', async () => {
    await renderSettled();
    await advance(8 * 60_000);
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();

    await advance(2 * 60_000);

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
    // apiLogout revokes the refresh-token family and needs the Bearer state
    // that handleSessionExpired's logout() clears — order is load-bearing.
    expect(apiLogoutMock.mock.invocationCallOrder[0]).toBeLessThan(
      handleSessionExpiredMock.mock.invocationCallOrder[0]
    );
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('Signing you out');
  });

  it('never raises the warning while the user keeps interacting', async () => {
    await renderSettled();

    for (let minute = 0; minute < 20; minute += 1) {
      await advance(60_000);
      await act(async () => {
        fireEvent.keyDown(window, { key: 'a' });
      });
      expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();
    }

    expect(apiLogoutMock).not.toHaveBeenCalled();
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
  });

  it('clamps the warning lead to half the budget on a short (2-minute) policy', async () => {
    // lead = min(IDLE_WARNING_LEAD_MS (2 min), budget / 2). With a 2-minute org
    // budget that is 1 minute, so the modal is due at 1:00 idle — NOT at mount.
    // Without the Math.min clamp the lead would be the full 2-minute budget and
    // the warning would be up the instant the session starts.
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ settings: { security: { sessionTimeout: 2 } } })
    );

    await renderSettled();

    // Idle 0 — the immediate heartbeat must not raise it.
    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();

    // Just before the 1:00 crossing (heartbeat ticks at 30s granularity).
    await advance(30_000);
    expect(screen.queryByTestId('idle-warning-dialog')).toBeNull();

    // Cross 1:00 idle — now it's due, with a full minute left on the clock.
    await advance(30_000);
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('1:00');
    expect(apiLogoutMock).not.toHaveBeenCalled();
  });

  it('skips the keepalive refresh on a hidden tab but still idle-evicts when the budget elapses', async () => {
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    try {
      await renderSettled();
      const callsAfterSettle = restoreAccessTokenFromCookieDetailedMock.mock.calls.length;

      // Well past the 5-minute keepalive interval: a visible tab would have
      // refreshed by now. A hidden one must not — the heartbeat returns before
      // reaching refreshAccessToken.
      await advance(8 * 60_000);
      expect(restoreAccessTokenFromCookieDetailedMock).toHaveBeenCalledTimes(callsAfterSettle);
      // Idle enforcement is NOT visibility-gated — the warning still went up
      // at budget minus the 2-minute lead.
      expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();

      // …and the eviction still fires at the end of the 10-minute budget.
      await advance(2 * 60_000);
      expect(apiLogoutMock).toHaveBeenCalledTimes(1);
      expect(handleSessionExpiredMock).toHaveBeenCalledWith('idle');
    } finally {
      visibilitySpy.mockRestore();
    }
  });

  it('does not dismiss the warning on a visibilitychange — tab focus is a passive signal', async () => {
    await renderSettled();
    await advance(8 * 60_000);
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();

    // Returning to the tab is not a person answering the modal.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      fireEvent.focus(window);
    });
    await advance(30_000);

    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();
    // Still counting down from the ORIGINAL deadline.
    expect(screen.getByTestId('idle-warning-body')).toHaveTextContent('1:30');
  });

  it('survives an Astro client-side navigation without duplicating activity listeners', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const activityRegistrations = () =>
      addEventListenerSpy.mock.calls.filter(([name]) =>
        ACTIVITY_EVENT_NAMES.includes(name as string)
      ).length;

    const { rerender } = await renderSettled();
    const registeredAfterMount = activityRegistrations();
    expect(registeredAfterMount).toBe(ACTIVITY_EVENT_NAMES.length);

    // The island is `transition:persist`-mounted, so a navigation re-renders it
    // rather than remounting it: the listener set must not grow.
    rerender(<AdminSessionManager />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(activityRegistrations()).toBe(registeredAfterMount);

    await advance(8 * 60_000);
    expect(screen.getByTestId('idle-warning-dialog')).toBeInTheDocument();
  });
});
