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
});
