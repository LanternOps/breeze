import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

// The gate is exercised through the real gateway so we prove the "no caching,
// checked every request" contract end-to-end. Auth is mocked exactly as in
// gateway.test.ts so a matched user route reaches its handler and returns 200.
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (
    c: { set(key: string, value: unknown): void },
    next: () => Promise<void>,
  ) => {
    c.set('auth', { user: { id: 'user-1' } });
    await next();
  }),
}));

vi.mock('../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn(async (
    _c: unknown,
    next: () => Promise<void>,
  ) => { await next(); }),
}));

import { createEnabledGate } from './enabledGate';
import { mountExtensionGateway } from './gateway';
import { ExtensionContributionRegistry } from './contributionRegistry';

function makeManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo',
    version: '1.0.0',
    routeNamespace: 'demo',
    requires: {
      breeze: '>=1.0.0',
      serverSdk: '^1.0.0',
      capabilities: ['server.routes.v1'],
    },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
    ...overrides,
  };
}

function makeFixture(isEnabled: (name: string) => Promise<boolean>) {
  const app = new Hono();
  const registry = new ExtensionContributionRegistry();
  const routeApp = new Hono();
  routeApp.get('/ping', (c) => c.json({ ok: true }));
  const session = registry.begin(makeManifest());
  session.registrar.mountRoute(routeApp);
  registry.activate(session.finish());
  mountExtensionGateway(app, registry, isEnabled);
  return app;
}

describe('createEnabledGate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the store and never caches the result', async () => {
    const store = { isEnabled: vi.fn<(name: string) => Promise<boolean>>() };
    const gate = createEnabledGate(store);
    store.isEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await gate('demo')).toBe(true);
    expect(await gate('demo')).toBe(false);
    expect(store.isEnabled).toHaveBeenCalledWith('demo');
    expect(store.isEnabled).toHaveBeenCalledTimes(2);
  });

  it('checks enabled state for every new request', async () => {
    const state = { isEnabled: vi.fn<(name: string) => Promise<boolean>>() };
    state.isEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const app = makeFixture(createEnabledGate(state));

    expect((await app.request('/api/v1/ext/demo/ping')).status).toBe(200);
    expect((await app.request('/api/v1/ext/demo/ping')).status).toBe(503);
    expect(state.isEnabled).toHaveBeenCalledTimes(2);
  });

  // FAIL-CLOSED. This is the single most safety-critical property of the gate:
  // if the DB check errors, the extension must be treated as OFF, never ON. The
  // gate is a trivial pass-through today, so a rejection propagates — but a
  // future `.catch(() => true)` "resilience" wrapper would silently convert the
  // fleet-wide emergency shutoff to fail-OPEN. These two tests would fail if
  // that regression were introduced.
  it('propagates a store error rather than defaulting to enabled', async () => {
    const store = { isEnabled: vi.fn<(name: string) => Promise<boolean>>() };
    store.isEnabled.mockRejectedValue(new Error('db down'));
    const gate = createEnabledGate(store);

    await expect(gate('demo')).rejects.toThrow(/db down/);
  });

  it('does not serve the extension route when the enabled check throws', async () => {
    const state = { isEnabled: vi.fn<(name: string) => Promise<boolean>>() };
    state.isEnabled.mockRejectedValue(new Error('db down'));
    const app = makeFixture(createEnabledGate(state));

    const res = await app.request('/api/v1/ext/demo/ping');
    // The handler returns { ok: true } at 200. A gate-check failure must NOT
    // reach it: fail-closed means the request errors out, not that it serves.
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('"ok":true');
    expect(state.isEnabled).toHaveBeenCalledWith('demo');
  });
});
