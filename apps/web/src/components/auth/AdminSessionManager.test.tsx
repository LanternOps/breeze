import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AdminSessionManager from './AdminSessionManager';
import {
  apiLogout,
  fetchWithAuth,
  restoreAccessTokenFromCookie,
  useAuthStore
} from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '../../lib/navigation';

vi.mock('../../stores/auth', () => ({
  apiLogout: vi.fn().mockResolvedValue(undefined),
  fetchWithAuth: vi.fn(),
  restoreAccessTokenFromCookie: vi.fn().mockResolvedValue(false),
  useAuthStore: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn()
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn().mockResolvedValue(undefined)
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const apiLogoutMock = vi.mocked(apiLogout);
const navigateToMock = vi.mocked(navigateTo);
const useAuthStoreMock = vi.mocked(useAuthStore);
const useOrgStoreMock = vi.mocked(useOrgStore);

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
    expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
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
    expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
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
