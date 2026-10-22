import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9642: Astro islands hydrate independently. A page island that imports only
 * `@/stores/auth` (SecurityDashboard, RecommendationsPage, ...) can fire its
 * mount fetch before the header island has imported `orgStore`, which is what
 * registers the org-id provider. With no provider the request carried no
 * `orgId` and the page showed every organization's data under a header that
 * read a single client. `fetchWithAuth` must resolve the persisted selection
 * itself when no provider has registered yet.
 */
async function freshAuth() {
  const mod = await import('./auth');
  mod.useAuthStore.setState({
    tokens: { accessToken: 'token', expiresAt: Date.now() + 60_000 } as never,
    user: { id: 'u1', email: 'u@example.com' } as never,
    isAuthenticated: true,
  });
  return mod;
}

describe('fetchWithAuth cold load (no orgStore imported yet)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.setItem(
      'breeze-org',
      JSON.stringify({ state: { currentOrgId: 'org-persisted', allOrgs: false }, version: 0 }),
    );
    window.history.pushState({}, '', '/security');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends the persisted orgId on the first request without the header island', async () => {
    const { fetchWithAuth } = await freshAuth();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await fetchWithAuth('/security/dashboard');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('orgId=org-persisted');
  });

  it('sends no orgId when nothing is persisted', async () => {
    localStorage.clear();
    const { fetchWithAuth } = await freshAuth();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await fetchWithAuth('/security/dashboard');

    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('orgId=');
  });

  it('sends no orgId on a global-scope (catalog) route even with a persisted org', async () => {
    window.history.pushState({}, '', '/scripts');
    const { fetchWithAuth } = await freshAuth();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await fetchWithAuth('/scripts');

    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain('orgId=');
  });
});
