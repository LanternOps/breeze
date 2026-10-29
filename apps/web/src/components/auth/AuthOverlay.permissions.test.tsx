import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn(async () => {}),
}));

import AuthOverlay from './AuthOverlay';
import { useAuthStore, type User } from '../../stores/auth';

// #9927 / #9586: the dashboard shell must repair a session whose stored user
// has no `permissions` (signup auto-login, forced-MFA hand-off, or a blob
// persisted before /users/me answered) — otherwise every permission-gated
// sidebar item stays hidden until the next login-page sign-in.

const BARE_USER: User = { id: 'user-1', email: 'new@example.com', name: 'New Partner', mfaEnabled: false };
const GRANTS = [{ resource: 'devices', action: 'read' }, { resource: 'organizations', action: 'read' }];

const originalFetch = global.fetch;
let meCalls = 0;

function stubMe(body: unknown, status = 200) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/users/me')) {
      meCalls += 1;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe('AuthOverlay permission self-heal (#9927)', () => {
  beforeEach(() => {
    meCalls = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    useAuthStore.setState({ user: null, tokens: null, isAuthenticated: false, sessionExpiredReason: null });
  });

  it('loads permissions from /users/me when the signed-in user has none', async () => {
    stubMe({ id: 'user-1', permissions: GRANTS, preferences: {} });
    useAuthStore.getState().login(BARE_USER, { accessToken: 'access-token', expiresInSeconds: 900 });

    render(<AuthOverlay />);

    await waitFor(() => expect(useAuthStore.getState().user?.permissions).toEqual(GRANTS));
    expect(meCalls).toBe(1);
  });

  it('does not refetch when the stored user already carries permissions', async () => {
    stubMe({ id: 'user-1', permissions: GRANTS, preferences: {} });
    useAuthStore.getState().login({ ...BARE_USER, permissions: [] }, { accessToken: 'access-token', expiresInSeconds: 900 });

    render(<AuthOverlay />);
    // Let the mount effects run.
    await waitFor(() => expect(useAuthStore.getState().isLoading).toBe(false));
    await new Promise((r) => setTimeout(r, 80));

    expect(meCalls).toBe(0);
    expect(useAuthStore.getState().user?.permissions).toEqual([]);
  });

  it('keeps permissions unknown (nav hidden) when /users/me fails', async () => {
    stubMe({ error: 'boom' }, 500);
    useAuthStore.getState().login(BARE_USER, { accessToken: 'access-token', expiresInSeconds: 900 });

    render(<AuthOverlay />);

    await waitFor(() => expect(meCalls).toBe(1));
    expect(useAuthStore.getState().user?.permissions).toBeUndefined();
  });
});
