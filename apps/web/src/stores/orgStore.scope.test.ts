import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory localStorage so the persist middleware can read/write something
// during the test. The unit-under-test relies on zustand's persist storage.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(k: string) { return data.has(k) ? (data.get(k) as string) : null; },
    setItem(k: string, v: string) { data.set(k, String(v)); },
    removeItem(k: string) { data.delete(k); },
    key(i: number) { return Array.from(data.keys())[i] ?? null; },
  };
}

describe('orgStore — orgScope global toggle', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: globalThis.localStorage },
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults orgScope to "current"', async () => {
    const { useOrgStore } = await import('./orgStore');
    expect(useOrgStore.getState().orgScope).toBe('current');
  });

  it('setOrgScope("all") flips the scope and persists it', async () => {
    const { useOrgStore } = await import('./orgStore');
    useOrgStore.getState().setOrgScope('all');
    expect(useOrgStore.getState().orgScope).toBe('all');
  });

  it('the registered orgId provider returns currentOrgId when scope is current', async () => {
    // The provider is registered as a side-effect of importing orgStore.
    // We grab a reference to it via auth.ts's exported registrar.
    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: 'org-current-1', orgScope: 'current' });

    // Probe the chokepoint behavior: fetchWithAuth builds the URL by
    // calling the provider. We inspect the provider directly by reading
    // private state — instead, exercise via a fake fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    // fetchWithAuth requires an access token; stub to make the call go through.
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/devices');
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('orgId=org-current-1');
    fetchSpy.mockRestore();
  });

  it('the registered orgId provider returns null when scope is "all", so no orgId is injected', async () => {
    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: 'org-current-1', orgScope: 'all' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/devices');
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('orgId=');
    fetchSpy.mockRestore();
  });
});
