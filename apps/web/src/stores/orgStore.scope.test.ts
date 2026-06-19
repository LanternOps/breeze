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

describe('orgStore — page-aware orgId provider', () => {
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

  it('on a global route (/scripts) the provider returns null regardless of currentOrgId', async () => {
    // Stub the pathname to a global catalog route before importing so the
    // provider reads it at call-time.
    Object.defineProperty(globalThis.window, 'location', {
      value: { pathname: '/scripts' },
      writable: true,
      configurable: true,
    });

    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: 'org-123' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/scripts');
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('orgId=');
    fetchSpy.mockRestore();
  });

  it('on /patches (now org-scoped) the provider injects the selected org so single-org actions resolve', async () => {
    // /patches honours the org switcher now — with a specific org selected, the
    // orgId is auto-injected so approve/decline/defer/export/create-ring attach
    // it (previously /patches was global → orgId stripped → 400 for partners).
    Object.defineProperty(globalThis.window, 'location', {
      value: { pathname: '/patches' },
      writable: true,
      configurable: true,
    });

    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: 'org-abc' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/patches/some-id/approve', { method: 'POST', body: '{}' });
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('orgId=org-abc');
    fetchSpy.mockRestore();
  });

  it('on /patches in All-orgs mode (currentOrgId null) no orgId is injected — list/compliance READ still works', async () => {
    Object.defineProperty(globalThis.window, 'location', {
      value: { pathname: '/patches' },
      writable: true,
      configurable: true,
    });

    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: null });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/patches?limit=200');
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('orgId=');
    fetchSpy.mockRestore();
  });

  it('on a scoped route (/devices) the provider returns currentOrgId', async () => {
    Object.defineProperty(globalThis.window, 'location', {
      value: { pathname: '/devices' },
      writable: true,
      configurable: true,
    });

    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: 'org-current-1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    auth.useAuthStore.setState({ tokens: { accessToken: 't', expiresAt: Date.now() + 60_000 } as any, user: { id: 'u', email: 'e' } as any, isAuthenticated: true });

    await auth.fetchWithAuth('/devices');
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('orgId=org-current-1');
    fetchSpy.mockRestore();
  });

  it('on a scoped route with currentOrgId null, no orgId is injected', async () => {
    Object.defineProperty(globalThis.window, 'location', {
      value: { pathname: '/devices' },
      writable: true,
      configurable: true,
    });

    const { useOrgStore } = await import('./orgStore');
    const auth = await import('./auth');

    useOrgStore.setState({ currentOrgId: null });

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
