import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

import { ExtensionContributionRegistry } from './contributionRegistry';

const authLifetime = new AsyncLocalStorage<'user' | 'agent' | 'helper'>();

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (
    c: { set(key: string, value: unknown): void },
    next: () => Promise<void>,
  ) => {
    c.set('auth', { user: { id: 'user-1' } });
    await authLifetime.run('user', next);
  }),
}));

vi.mock('../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn(async (
    c: {
      req: {
        header(name: string): string | undefined;
        param(name: string): string | undefined;
      };
      json(body: unknown, status: 400 | 401): Response;
      set(key: string, value: unknown): void;
    },
    next: () => Promise<void>,
  ) => {
    if (!c.req.header('Authorization')) {
      return c.json({ error: 'missing agent auth' }, 401);
    }
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'missing agent id' }, 400);
    c.set('agent', { deviceId: id, orgId: 'org-1' });
    await authLifetime.run('agent', next);
  }),
}));

vi.mock('../middleware/helperAuth', () => ({
  helperAuth: vi.fn(async (
    c: {
      req: { header(name: string): string | undefined };
      json(body: unknown, status: 401): Response;
      set(key: string, value: unknown): void;
    },
    next: () => Promise<void>,
  ) => {
    if (!c.req.header('Authorization')) {
      return c.json({ error: 'missing helper auth' }, 401);
    }
    c.set('helperDevice', { id: 'dev-1', orgId: 'org-1' });
    c.set('auth', { orgId: 'org-1', helperDeviceId: 'dev-1', scope: 'organization' });
    await authLifetime.run('helper', next);
  }),
}));

import {
  EXTENSION_ROUTE_LABEL_OTHER,
  EXTENSION_ROUTE_LABEL_UNAVAILABLE,
  legacyExtensionAgentAuthMiddleware,
  mountExtensionGateway,
} from './gateway';
import { setExtensionMetricsRecorder } from './metrics';
import { authMiddleware } from '../middleware/auth';
import { agentAuthMiddleware } from '../middleware/agentAuth';
import { helperAuth } from '../middleware/helperAuth';

// `helperRoutes` is a legacy-manifest flag carried on the staged manifest for
// the gateway guard; it is not part of the v1 wire schema yet (see the TODO in
// packages/extension-sdk/src/manifest.ts).
type GatewayTestManifest = ExtensionManifestV1 & { helperRoutes?: boolean };

function makeManifest(overrides: Partial<GatewayTestManifest> = {}): GatewayTestManifest {
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

function activateRoute(
  registry: ExtensionContributionRegistry,
  routeApp: Hono,
  manifest = makeManifest(),
): void {
  const session = registry.begin(manifest);
  session.registrar.mountRoute(routeApp);
  registry.activate(session.finish());
}

function makeGatewayFixture(options: {
  manifest?: ExtensionManifestV1;
  isEnabled?: (name: string) => Promise<boolean>;
  routeApp?: Hono;
} = {}) {
  const app = new Hono();
  const registry = new ExtensionContributionRegistry();
  const routeApp = options.routeApp ?? new Hono();
  routeApp.get('/health', (c) => c.json({ ok: true }));
  routeApp.get('/items/:id', (c) => c.json({
    id: c.req.param('id'),
    userId: (c.get('auth') as { user: { id: string } }).user.id,
    authLifetime: authLifetime.getStore(),
  }));
  routeApp.get('/agent/:id/config', (c) => c.json({
    deviceId: (c.get('agent') as { deviceId: string }).deviceId,
    authLifetime: authLifetime.getStore(),
  }));
  activateRoute(registry, routeApp, options.manifest);
  mountExtensionGateway(app, registry, options.isEnabled ?? (async () => true));
  return { app, registry };
}

describe('mountExtensionGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs user auth and the matched handler in the same context and auth lifetime', async () => {
    const { app } = makeGatewayFixture();

    const response = await app.request('/api/v1/ext/demo/items/item-42');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'item-42',
      userId: 'user-1',
      authLifetime: 'user',
    });
    expect(authMiddleware).toHaveBeenCalledTimes(1);
    expect(agentAuthMiddleware).not.toHaveBeenCalled();
  });

  it('dispatches the extension root at the exact stable namespace path', async () => {
    const routeApp = new Hono();
    routeApp.get('/', (c) => c.json({ route: 'root' }));
    const { app } = makeGatewayFixture({ routeApp });

    const response = await app.request('/api/v1/ext/demo');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: 'root' });
  });

  it('dispatches canonical and legacy URLs through the same snapshot when name differs', async () => {
    const manifest = makeManifest({ name: 'demo', routeNamespace: 'legacy-demo' });
    const { app } = makeGatewayFixture({ manifest });

    const canonical = await app.request('/api/v1/ext/demo/items/item-42');
    const legacy = await app.request('/api/v1/legacy-demo/items/item-42');

    expect(canonical.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({
      id: 'item-42',
      userId: 'user-1',
      authLifetime: 'user',
    });
  });

  it('falls through on alias misses so core routes are never shadowed', async () => {
    const { app } = makeGatewayFixture({
      manifest: makeManifest({ routeNamespace: 'legacy-demo' }),
    });
    app.get('/api/v1/devices/health', (c) => c.json({ core: true }));

    expect(await (await app.request('/api/v1/devices/health')).json()).toEqual({ core: true });
    expect((await app.request('/api/v1/not-an-extension/health')).status).toBe(404);
  });

  it('uses agent auth for agent paths and never public-route exemptions', async () => {
    const manifest = makeManifest({ publicRoutes: ['/agent/*'] });
    const { app } = makeGatewayFixture({ manifest });

    const response = await app.request('/api/v1/ext/demo/agent/config');

    expect(response.status).toBe(401);
    expect(agentAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(authMiddleware).not.toHaveBeenCalled();
  });

  it('routes /helper/* through helper auth when the manifest opts in', async () => {
    const routeApp = new Hono();
    routeApp.get('/helper/search', (c) => c.json({
      deviceId: (c.get('helperDevice') as { id: string }).id,
      authLifetime: authLifetime.getStore(),
    }));
    const manifest = makeManifest({ helperRoutes: true });
    const { app } = makeGatewayFixture({ routeApp, manifest });

    expect((await app.request('/api/v1/ext/demo/helper/search?q=x')).status).toBe(401);
    const response = await app.request('/api/v1/ext/demo/helper/search?q=x', {
      headers: { Authorization: 'Bearer brz_helper-test' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: 'dev-1', authLifetime: 'helper' });
    expect(helperAuth).toHaveBeenCalledTimes(2);
    expect(authMiddleware).not.toHaveBeenCalled();
    expect(agentAuthMiddleware).not.toHaveBeenCalled();
  });

  it('keeps /helper/* on user auth when the manifest does not opt in', async () => {
    const routeApp = new Hono();
    routeApp.get('/helper/search', (c) => c.json({ ok: true }));
    const { app } = makeGatewayFixture({ routeApp });

    const response = await app.request('/api/v1/ext/demo/helper/search');

    expect(response.status).toBe(200);
    expect(authMiddleware).toHaveBeenCalledTimes(1);
    expect(helperAuth).not.toHaveBeenCalled();
  });

  it('uses helper auth for helper paths and never public-route exemptions', async () => {
    const routeApp = new Hono();
    routeApp.get('/helper/search', (c) => c.json({ ok: true }));
    const manifest = makeManifest({ helperRoutes: true, publicRoutes: ['/helper/*'] });
    const { app } = makeGatewayFixture({ routeApp, manifest });

    const response = await app.request('/api/v1/ext/demo/helper/search');

    expect(response.status).toBe(401);
    expect(helperAuth).toHaveBeenCalledTimes(1);
    expect(authMiddleware).not.toHaveBeenCalled();
  });

  it('runs an agent handler with agent variables inside the auth lifetime', async () => {
    const { app } = makeGatewayFixture();

    const response = await app.request('/api/v1/ext/demo/agent/device-1/config', {
      headers: { Authorization: 'Bearer agent-test' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: 'device-1', authLifetime: 'agent' });
  });

  it('preserves agent auth and its lifetime through the legacy alias', async () => {
    const { app } = makeGatewayFixture({
      manifest: makeManifest({ routeNamespace: 'legacy-demo' }),
    });

    expect((await app.request('/api/v1/legacy-demo/agent/device-1/config')).status).toBe(401);
    const response = await app.request('/api/v1/legacy-demo/agent/device-1/config', {
      headers: { Authorization: 'Bearer agent-test' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: 'device-1', authLifetime: 'agent' });
  });

  it('skips user auth only for exact and prefix public-route matches', async () => {
    const routeApp = new Hono();
    routeApp.get('/health', (c) => c.json({ route: 'health' }));
    routeApp.get('/public/thing', (c) => c.json({ route: 'public' }));
    routeApp.get('/publicity', (c) => c.json({ route: 'publicity' }));
    const manifest = makeManifest({ publicRoutes: ['/health', '/public/*'] });
    const { app } = makeGatewayFixture({ routeApp, manifest });

    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);
    expect((await app.request('/api/v1/ext/demo/public/thing')).status).toBe(200);
    expect(authMiddleware).not.toHaveBeenCalled();

    expect((await app.request('/api/v1/ext/demo/publicity')).status).toBe(200);
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });

  it('runs mismatched extension-requested auth instead of silently skipping it', async () => {
    const routeApp = new Hono();
    routeApp.use('/telemetry/:id', legacyExtensionAgentAuthMiddleware);
    routeApp.get('/telemetry/:id', (c) => c.json({
      userId: (c.get('auth') as { user: { id: string } }).user.id,
      deviceId: (c.get('agent') as { deviceId: string }).deviceId,
    }));
    const { app } = makeGatewayFixture({ routeApp });

    const response = await app.request('/api/v1/ext/demo/telemetry/device-1', {
      headers: { Authorization: 'Bearer both-test' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user-1', deviceId: 'device-1' });
    expect(authMiddleware).toHaveBeenCalledTimes(1);
    expect(agentAuthMiddleware).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable after withdrawal without remounting Hono routes', async () => {
    const { app, registry } = makeGatewayFixture();
    const routeCount = app.routes.length;
    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);

    registry.withdraw('demo');

    const response = await app.request('/api/v1/ext/demo/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'extension unavailable' });
    expect(app.routes).toHaveLength(routeCount);
  });

  it('keeps withdrawn agent namespaces behind agent auth before returning unavailable', async () => {
    const { app, registry } = makeGatewayFixture();
    registry.withdraw('demo');

    const unauthenticated = await app.request('/api/v1/ext/demo/agent/device-1/config');
    expect(unauthenticated.status).toBe(401);

    const authenticated = await app.request('/api/v1/ext/demo/agent/device-1/config', {
      headers: { Authorization: 'Bearer agent-test' },
    });
    expect(authenticated.status).toBe(503);
    expect(agentAuthMiddleware).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable for unknown and administratively disabled extensions', async () => {
    const isEnabled = vi.fn(async (name: string) => name !== 'demo');
    const { app } = makeGatewayFixture({ isEnabled });

    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(503);
    expect((await app.request('/api/v1/ext/missing/health')).status).toBe(503);
    expect(isEnabled).toHaveBeenCalledOnce();
  });

  it('authenticates before returning not found when an active extension has no route app', async () => {
    const app = new Hono();
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest());
    registry.activate(session.finish());
    mountExtensionGateway(app, registry, async () => true);

    const response = await app.request('/api/v1/ext/demo/missing');

    expect(response.status).toBe(404);
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });

  it('switches active snapshots without adding routes to the outer app', async () => {
    const { app, registry } = makeGatewayFixture();
    const routeCount = app.routes.length;
    const replacement = new Hono();
    replacement.get('/health', (c) => c.json({ version: 2 }));
    activateRoute(registry, replacement, makeManifest({ version: '2.0.0' }));

    const response = await app.request('/api/v1/ext/demo/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 2 });
    expect(app.routes).toHaveLength(routeCount);
  });

  it('atomically switches legacy aliases with the active replacement snapshot', async () => {
    const { app, registry } = makeGatewayFixture({
      manifest: makeManifest({ routeNamespace: 'old-alias' }),
    });
    const replacement = new Hono();
    replacement.get('/health', (c) => c.json({ version: 2 }));

    activateRoute(
      registry,
      replacement,
      makeManifest({ version: '2.0.0', routeNamespace: 'new-alias' }),
    );

    expect((await app.request('/api/v1/old-alias/health')).status).toBe(404);
    expect(await (await app.request('/api/v1/new-alias/health')).json()).toEqual({ version: 2 });
  });

  it('resolves a reused alias to the enabled owner after the prior owner withdraws', async () => {
    const { app, registry } = makeGatewayFixture({
      manifest: makeManifest({ routeNamespace: 'shared-alias' }),
    });
    registry.withdraw('demo');
    const replacementOwner = new Hono();
    replacementOwner.get('/health', (c) => c.json({ owner: 'replacement' }));
    activateRoute(
      registry,
      replacementOwner,
      makeManifest({ name: 'other-demo', routeNamespace: 'shared-alias' }),
    );

    const response = await app.request('/api/v1/shared-alias/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ owner: 'replacement' });
  });

  it('propagates wrapper errors to the outer app error handler', async () => {
    const routeApp = new Hono();
    routeApp.get('/explode', () => {
      throw new Error('extension exploded');
    });
    const app = new Hono();
    const registry = new ExtensionContributionRegistry();
    activateRoute(registry, routeApp);
    mountExtensionGateway(app, registry, async () => true);
    app.onError((error, c) => c.json({ outerError: error.message }, 502));

    const response = await app.request('/api/v1/ext/demo/explode');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ outerError: 'extension exploded' });
  });
});

describe('extension gateway route metric labels', () => {
  function captureRouteLabels() {
    const requests: Array<{ extension: string; route: string; status: number }> = [];
    setExtensionMetricsRecorder({
      onRequest: (extension, route, status) => { requests.push({ extension, route, status }); },
      onJob: () => {},
    });
    return {
      requests,
      routes: () => new Set(requests.map((entry) => entry.route)),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setExtensionMetricsRecorder(null);
  });

  // The point of the bounding fix: the `route` label must be drawn from the
  // extension's registered route patterns, never from the request URL, so an
  // unauthenticated attacker cannot mint one Prometheus series per random path.
  it('collapses arbitrary unmatched paths to a single bounded route label', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture();

    const attackPaths = Array.from(
      { length: 50 },
      (_unused, index) => `/api/v1/ext/demo/aaa${index.toString(36)}${'x'.repeat(index % 7)}`,
    );
    for (const path of attackPaths) {
      expect((await app.request(path)).status).toBe(404);
    }

    expect(metrics.requests).toHaveLength(attackPaths.length);
    // Bounded — NOT one label per distinct path.
    expect(metrics.routes().size).toBeLessThanOrEqual(2);
    expect([...metrics.routes()]).toEqual([EXTENSION_ROUTE_LABEL_OTHER]);
  });

  it('never leaks a raw path segment (PII) into the route label', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture();

    await app.request('/api/v1/ext/demo/customers/todd@lanternops.io/sync');

    expect([...metrics.routes()]).toEqual([EXTENSION_ROUTE_LABEL_OTHER]);
  });

  it('labels matched requests with the registered pattern, not the concrete path', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture();

    expect((await app.request('/api/v1/ext/demo/items/item-42')).status).toBe(200);
    expect((await app.request('/api/v1/ext/demo/items/item-99')).status).toBe(200);
    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);

    expect(metrics.requests.map((entry) => entry.route)).toEqual([
      '/items/:id',
      '/items/:id',
      '/health',
    ]);
  });

  it('bounds the label the same way on the legacy alias mount', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture({
      manifest: makeManifest({ routeNamespace: 'legacy-demo' }),
    });

    expect((await app.request('/api/v1/legacy-demo/items/item-42')).status).toBe(200);
    for (let index = 0; index < 20; index += 1) {
      await app.request(`/api/v1/legacy-demo/zz${index}`);
    }

    expect(metrics.routes()).toEqual(new Set(['/items/:id', EXTENSION_ROUTE_LABEL_OTHER]));
  });

  it('bounds agent-namespace labels including unauthenticated rejections', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture();

    for (let index = 0; index < 20; index += 1) {
      expect((await app.request(`/api/v1/ext/demo/agent/dev-${index}/config`)).status).toBe(401);
    }
    const authed = await app.request('/api/v1/ext/demo/agent/device-1/config', {
      headers: { Authorization: 'Bearer agent-test' },
    });
    expect(authed.status).toBe(200);

    expect(metrics.routes()).toEqual(
      new Set([EXTENSION_ROUTE_LABEL_OTHER, '/agent/:id/config']),
    );
  });

  it('records a 503 with a bounded label when the extension is disabled', async () => {
    const metrics = captureRouteLabels();
    const { app } = makeGatewayFixture({ isEnabled: async () => false });

    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(503);

    expect(metrics.requests).toEqual([
      { extension: 'demo', route: EXTENSION_ROUTE_LABEL_UNAVAILABLE, status: 503 },
    ]);
  });
});
