import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #4010. PatchesPage.test.tsx mocks `lib/authScope` with a scope that is already
// known on the first render, which is exactly the state a cold page load does NOT
// start in: access tokens are never persisted (`partialize` in stores/auth.ts
// keeps only `user` + `isAuthenticated`), so at first paint the store is empty and
// EVERY user decodes as `scope: null`. This suite therefore mocks neither
// authScope nor the auth store — it drives the real `useJwtClaims` against the
// real store so the token genuinely arrives after mount, which is the only way to
// pin the bug: the mount-time guard used to downgrade #rings AND clear the hash,
// destroying the deep link before the scope it depends on existed.

vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

// Real auth store (the subject), stubbed network helper.
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: vi.fn(),
}));

const orgState = vi.hoisted(() => ({ currentOrgId: null as string | null }));

vi.mock('../../stores/orgStore', () => {
  const organizations = [{ id: 'org-1', name: 'Acme Corp' }];
  const read = () => ({ currentOrgId: orgState.currentOrgId, organizations });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});

import PatchesPage from './PatchesPage';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const emptyDataFetch = async (input: unknown): Promise<Response> => {
  const url = String(input);
  if (url === '/update-rings') return makeJsonResponse({ data: [] });
  if (url === '/patches?limit=200') return makeJsonResponse({ data: [] });
  if (url === '/patches/compliance') {
    return makeJsonResponse({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [] } });
  }
  if (url === '/devices?limit=200') return makeJsonResponse({ devices: [] });
  return makeJsonResponse({}, false, 404);
};

function makeToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.sig`;
}

/** Simulate /auth/refresh returning an access token some time after first paint. */
function tokenArrives(payload: Record<string, unknown>) {
  act(() => {
    useAuthStore.setState({ tokens: { accessToken: makeToken(payload), expiresInSeconds: 900 } });
  });
}

// Tab nav buttons are the only buttons carrying `border-b-2`, which disambiguates
// them from same-named buttons inside the tab bodies.
const navTab = (name: string | RegExp) =>
  screen.getAllByRole('button', { name }).find(b => b.className.includes('border-b-2'));

describe('PatchesPage #rings deep link vs. late-arriving JWT scope (#4010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = null;
    useAuthStore.setState({ tokens: null });
    window.history.replaceState({}, '', '/#rings');
    fetchMock.mockImplementation(emptyDataFetch);
  });

  afterEach(() => {
    useAuthStore.setState({ tokens: null });
    window.history.replaceState({}, '', '/');
  });

  it.each(['partner', 'system'] as const)(
    '%s scope: keeps #rings through the unresolved window and selects Update Rings once the token lands',
    async (scope) => {
      render(<PatchesPage />);

      // First paint: no token yet, so the scope is unknown. The view falls back to
      // Compliance (rings chrome and body stay hidden — an unknown scope is never
      // treated as a grant), but the hash MUST survive: this assertion is the
      // regression. Before the fix the mount-time downgrade routed through
      // setTabInHash and left the URL at a bare `/`.
      expect(await screen.findByRole('button', { name: /Compliance/i })).toBeInTheDocument();
      expect(window.location.hash).toBe('#rings');
      expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();
      expect(screen.queryByRole('button', { name: /New Ring/i })).toBeNull();

      tokenArrives({ scope, partnerId: 'p-1' });

      // Scope resolved and permitted: the guard re-runs, re-reads the hash it did
      // not destroy, and lands on Update Rings.
      await waitFor(() => expect(navTab('Update Rings')).toHaveClass('border-primary'));
      expect(navTab(/Compliance/i)).not.toHaveClass('border-primary');
      expect(window.location.hash).toBe('#rings');
    },
  );

  it('org scope: still downgrades to Compliance and clears the stale #rings once the token lands', async () => {
    orgState.currentOrgId = 'org-1';

    render(<PatchesPage />);

    expect(await screen.findByRole('button', { name: /Compliance/i })).toBeInTheDocument();
    // Deferred, not granted: the rings tab is not offered while the scope is unknown.
    expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();
    // ...and the hash is still intact at this point. The guard cannot know in
    // advance which way an unresolved user will go, so it must defer for
    // EVERYONE — including the ones who will turn out to be denied. Without this
    // assertion the test passes against the buggy code too, since the old
    // premature clear and the new deferred-then-real clear reach the same final
    // state for an org user.
    expect(window.location.hash).toBe('#rings');

    tokenArrives({ scope: 'organization', orgId: 'org-1' });

    // Known-denied: now the downgrade is real, so the stale hash is wiped.
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(navTab(/Compliance/i)).toHaveClass('border-primary');
    expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();
    expect(screen.queryByRole('button', { name: /New Ring/i })).toBeNull();
  });

  it('undecodable token: treated as resolved-and-denied, so the stale #rings is cleared', async () => {
    // A present-but-garbage token means we DID look and got no claims. Failing
    // closed (clear the hash, stay on Compliance) matches what the server would
    // do with the same token, and stops the deferral from becoming a permanent
    // "scope pending" state that never clears a bookmark an org user can't use.
    render(<PatchesPage />);
    expect(await screen.findByRole('button', { name: /Compliance/i })).toBeInTheDocument();
    // Same discriminating assertion as above: intact until the token exists.
    expect(window.location.hash).toBe('#rings');

    act(() => {
      useAuthStore.setState({ tokens: { accessToken: 'not-a-jwt', expiresInSeconds: 900 } });
    });

    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();
  });

  it('a token going away again (throttled refresh / logout) hides rings but does NOT wipe the hash', async () => {
    // The resolved -> unresolved transition is a real sequence: while
    // /auth/refresh is rate limited the session is valid and yet tokenless for
    // up to 90s (#3696). Wiping the deep link there would be #4010 in slow
    // motion, so the guard defers exactly as it does before the first token.
    render(<PatchesPage />);
    tokenArrives({ scope: 'partner', partnerId: 'p-1' });
    await waitFor(() => expect(navTab('Update Rings')).toHaveClass('border-primary'));

    act(() => {
      useAuthStore.setState({ tokens: null });
    });

    // Falls closed on the view...
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull());
    expect(screen.queryByRole('button', { name: /New Ring/i })).toBeNull();
    // ...but the deep link survives, so the same session recovers on re-auth.
    expect(window.location.hash).toBe('#rings');

    tokenArrives({ scope: 'partner', partnerId: 'p-1' });
    await waitFor(() => expect(navTab('Update Rings')).toHaveClass('border-primary'));
  });

  it('a token landing while the user is on #patches reveals the Update Rings tab without moving them', async () => {
    // The nav chrome is gated on `mounted && canManageRings`, a separate path
    // from the hash guard: a partner browsing Patches during the unresolved
    // window must gain the tab when the token lands, and must not be yanked off
    // the tab they are on.
    window.history.replaceState({}, '', '/#patches');

    render(<PatchesPage />);
    await waitFor(() => expect(navTab('Patches')).toHaveClass('border-primary'));
    expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();

    tokenArrives({ scope: 'partner', partnerId: 'p-1' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Rings' })).toBeInTheDocument());
    expect(navTab('Patches')).toHaveClass('border-primary');
    expect(window.location.hash).toBe('#patches');
  });

  it('a hashchange back to #rings while the scope is still unknown does not wipe the hash', async () => {
    // Browser back/forward can land on #rings before the refresh round trip has
    // finished. The listener runs the same guard as mount, so it must defer too.
    window.history.replaceState({}, '', '/');
    render(<PatchesPage />);
    await screen.findByRole('button', { name: /Compliance/i });

    act(() => {
      window.location.hash = '#rings';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(window.location.hash).toBe('#rings');
    expect(screen.queryByRole('button', { name: 'Update Rings' })).toBeNull();

    tokenArrives({ scope: 'partner', partnerId: 'p-1' });

    await waitFor(() => expect(navTab('Update Rings')).toHaveClass('border-primary'));
    expect(window.location.hash).toBe('#rings');
  });
});

// PatchesPage renders <PatchApprovalModal> UNCONDITIONALLY — it sits in the page
// body, not behind `{modalOpen && ...}`, and nothing returns early in front of
// it. So the modal's own hooks run during this cold load, with `patch={null}`,
// long before anyone opens it. That is what made #4013's second site genuinely
// reachable rather than merely fragile: its
// `useMemo(() => getJwtClaims().scope === 'organization', [])` captured the
// empty-store answer HERE and kept it for the life of the page, so the org user
// who eventually opened the modal was offered an Approve button the API refuses.
describe('PatchApprovalModal opened after a cold load of PatchesPage (#4013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = 'org-1';
    useAuthStore.setState({ tokens: null });
    window.history.replaceState({}, '', '/#patches');
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === '/patches?limit=200') {
        return makeJsonResponse({
          data: [
            {
              id: 'patch-1',
              title: 'Security Update',
              severity: 'critical',
              source: 'Microsoft',
              os: 'Windows',
              releaseDate: '2026-04-01T00:00:00.000Z',
              approvalStatus: 'pending',
            },
          ],
        });
      }
      return emptyDataFetch(input);
    });
  });

  afterEach(() => {
    useAuthStore.setState({ tokens: null });
    window.history.replaceState({}, '', '/');
  });

  it('org scope arriving after the page mounted: the modal still explains the partner-level denial', async () => {
    render(<PatchesPage />);
    // The modal has already mounted (and, before the fix, already frozen its
    // scope) by the time this row is on screen.
    await waitFor(() => expect(navTab('Patches')).toHaveClass('border-primary'));

    tokenArrives({ scope: 'organization', orgId: 'org-1' });

    // ResponsiveTable renders a table row AND a card for the same patch; either
    // affordance opens the same modal.
    fireEvent.click((await screen.findAllByTestId('patch-row-patch-1-review'))[0]);

    expect(await screen.findByText(/patch approvals are managed at the partner level/i)).toBeInTheDocument();
    expect(screen.getByTestId('patch-approval-submit')).toBeDisabled();
  });

  it('partner scope arriving after the page mounted: the modal offers Approve', async () => {
    orgState.currentOrgId = null;
    render(<PatchesPage />);
    await waitFor(() => expect(navTab('Patches')).toHaveClass('border-primary'));

    tokenArrives({ scope: 'partner', partnerId: 'p-1' });

    // ResponsiveTable renders a table row AND a card for the same patch; either
    // affordance opens the same modal.
    fireEvent.click((await screen.findAllByTestId('patch-row-patch-1-review'))[0]);

    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).not.toBeDisabled());
    expect(screen.queryByText(/patch approvals are managed at the partner level/i)).toBeNull();
  });
});
