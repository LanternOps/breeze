import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuth, authState, authListeners } = vi.hoisted(() => {
  const state = { isAuthenticated: false };
  return {
    fetchWithAuth: vi.fn(),
    authState: state,
    authListeners: new Set<(next: typeof state) => void>(),
  };
});

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: {
    getState: () => authState,
    subscribe: (fn: (state: typeof authState) => void) => {
      authListeners.add(fn);
      return () => authListeners.delete(fn);
    },
  },
}));

function setAuthenticated(value: boolean) {
  authState.isAuthenticated = value;
  authListeners.forEach((fn) => fn(authState));
}

import {
  ExtensionRegistryError,
  UntrustedExtensionModuleUrlError,
  clearExtensionRegistryCache,
  findExtensionPage,
  getExtensionRegistry,
  loadExtensionModule,
  __resetExtensionRegistryForTests,
  __setExtensionModuleImporterForTests,
  type RuntimeWebRegistry,
} from './registry';

function registryDoc(over: Partial<RuntimeWebRegistry> = {}): RuntimeWebRegistry {
  return {
    apiVersion: 'breeze.extensions.web/v1',
    revision: 'rev-1',
    extensions: [
      {
        name: 'demo',
        version: '1.0.0',
        digest: 'abc123',
        moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
        pages: [{ id: 'main', path: '/dashboard', element: 'demo-dashboard' }],
        navigation: [],
        slots: [],
      },
    ],
    ...over,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  // NOTE: do not clear `authListeners` here — registry.ts subscribes exactly
  // once at module-load time (ES modules are singletons within this file),
  // so removing that subscription would break every later auth-change test.
  authState.isAuthenticated = false;
  __resetExtensionRegistryForTests();
});

describe('getExtensionRegistry', () => {
  it('fetches /extensions/registry and returns the validated document', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    const registry = await getExtensionRegistry();
    expect(fetchWithAuth).toHaveBeenCalledWith('/extensions/registry');
    expect(registry.extensions[0]?.name).toBe('demo');
  });

  it('throws ExtensionRegistryError on a 401', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(getExtensionRegistry()).rejects.toBeInstanceOf(ExtensionRegistryError);
  });

  it('rejects a response that does not match the registry shape', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse({ nope: true }));
    await expect(getExtensionRegistry()).rejects.toBeInstanceOf(ExtensionRegistryError);
  });

  it('rejects an extra/unknown field (strict shape)', async () => {
    const doc = registryDoc();
    fetchWithAuth.mockImplementation(async () => jsonResponse({ ...doc, extra: 'nope' }));
    await expect(getExtensionRegistry()).rejects.toBeInstanceOf(ExtensionRegistryError);
  });

  it('coalesces concurrent callers into a single fetch', async () => {
    let resolveResponse!: (r: Response) => void;
    fetchWithAuth.mockReturnValue(new Promise((resolve) => { resolveResponse = resolve; }));

    const first = getExtensionRegistry();
    const second = getExtensionRegistry();
    resolveResponse(jsonResponse(registryDoc()));

    await Promise.all([first, second]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('fetches again (not skip-cache) on a later, separate call', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    await getExtensionRegistry();
    await getExtensionRegistry();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('returns a referentially-stable object when the revision is unchanged across calls', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    const first = await getExtensionRegistry();
    const second = await getExtensionRegistry();
    expect(second).toBe(first);
  });

  it('clears the cached identity on clearExtensionRegistryCache so the next result is a new object', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    const first = await getExtensionRegistry();
    clearExtensionRegistryCache();
    const second = await getExtensionRegistry();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('clears the cache on auth change', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    const first = await getExtensionRegistry();
    setAuthenticated(true);
    const second = await getExtensionRegistry();
    expect(second).not.toBe(first);
  });
});

describe('findExtensionPage', () => {
  it('resolves the extension + page for a matching name/path', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    const found = await findExtensionPage('demo', '/dashboard');
    expect(found?.extension.name).toBe('demo');
    expect(found?.page.element).toBe('demo-dashboard');
  });

  it('returns null when the extension is absent', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    expect(await findExtensionPage('missing', '/dashboard')).toBeNull();
  });

  it('returns null when the page path does not match', async () => {
    fetchWithAuth.mockImplementation(async () => jsonResponse(registryDoc()));
    expect(await findExtensionPage('demo', '/nope')).toBeNull();
  });

  it('reflects disabled-after-navigation: a later fetch omitting the extension 404s', async () => {
    // First navigation: extension is active.
    fetchWithAuth.mockResolvedValueOnce(jsonResponse(registryDoc()));
    const first = await findExtensionPage('demo', '/dashboard');
    expect(first).not.toBeNull();

    // Extension got disabled server-side; the next navigation's fresh fetch
    // (a distinct ExtensionPageHost mount, not a concurrent call) omits it.
    fetchWithAuth.mockResolvedValueOnce(jsonResponse(registryDoc({ revision: 'rev-2', extensions: [] })));
    const second = await findExtensionPage('demo', '/dashboard');
    expect(second).toBeNull();
  });
});

describe('loadExtensionModule — trust boundary', () => {
  it('imports only the exact same-origin asset URL, once', async () => {
    const importer = vi.fn().mockResolvedValue({ ok: true });
    __setExtensionModuleImporterForTests(importer);

    await loadExtensionModule('/api/v1/extensions/assets/demo/abc123/index.js');

    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith('http://localhost:3000/api/v1/extensions/assets/demo/abc123/index.js');
  });

  it('deduplicates concurrent imports of the same URL', async () => {
    let resolveImport!: (v: unknown) => void;
    const importer = vi.fn().mockReturnValue(new Promise((resolve) => { resolveImport = resolve; }));
    __setExtensionModuleImporterForTests(importer);

    const url = '/api/v1/extensions/assets/demo/abc123/index.js';
    const p1 = loadExtensionModule(url);
    const p2 = loadExtensionModule(url);
    resolveImport({ ok: true });
    await Promise.all([p1, p2]);

    expect(importer).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);
  });

  it('propagates a rejected module promise to the caller', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('network error'));
    __setExtensionModuleImporterForTests(importer);

    await expect(
      loadExtensionModule('/api/v1/extensions/assets/demo/abc123/index.js'),
    ).rejects.toThrow('network error');
  });

  // loadExtensionModule REJECTS a forged/untrusted URL by throwing
  // synchronously, before ever calling the importer — "throw, do not
  // import", per the brief. It never returns a promise for these inputs.

  it('SECURITY: refuses a forged remote moduleUrl and never imports it', () => {
    const importer = vi.fn();
    __setExtensionModuleImporterForTests(importer);

    expect(() => loadExtensionModule('https://evil.example/x.js'))
      .toThrow(UntrustedExtensionModuleUrlError);
    expect(importer).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a protocol-relative //host URL', () => {
    const importer = vi.fn();
    __setExtensionModuleImporterForTests(importer);

    expect(() => loadExtensionModule('//evil.example/x.js'))
      .toThrow(UntrustedExtensionModuleUrlError);
    expect(importer).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a blob: URL', () => {
    const importer = vi.fn();
    __setExtensionModuleImporterForTests(importer);

    expect(() => loadExtensionModule('blob:http://localhost:3000/abcd-1234'))
      .toThrow(UntrustedExtensionModuleUrlError);
    expect(importer).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a data: URL', () => {
    const importer = vi.fn();
    __setExtensionModuleImporterForTests(importer);

    expect(() => loadExtensionModule('data:text/javascript,alert(1)'))
      .toThrow(UntrustedExtensionModuleUrlError);
    expect(importer).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a same-origin URL outside the asset prefix', () => {
    const importer = vi.fn();
    __setExtensionModuleImporterForTests(importer);

    expect(() => loadExtensionModule('/some/other/path.js'))
      .toThrow(UntrustedExtensionModuleUrlError);
    expect(importer).not.toHaveBeenCalled();
  });
});
