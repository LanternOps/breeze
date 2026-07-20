// Stub authMiddleware so the suite can inject its own auth context, exactly as
// admin/abuse.test.ts does. platformAdminMiddleware still runs for real on top
// of the stub, so the `isPlatformAdmin === true` gate is genuinely exercised.
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  requireMfa: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  hasSatisfiedMfa: vi.fn(() => true),
  requirePermission: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
  createAuditLog: vi.fn(),
}));

import { Hono } from 'hono';
import { createExtensionsAdminRoutes, type ExtensionsAdminDeps } from './extensionsAdmin';
import { ExtensionContributionRegistry, type StagedExtensionContributions } from '../extensions/contributionRegistry';
import { ExtensionJobHost, extensionJobId, type JobHostQueue } from '../extensions/jobHost';
import type { ExtensionStateRecord } from '../extensions/stateStore';
import type { ExtensionHostDescriptor } from '../extensions/compatibility';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};

const nonAdmin: FakeAuth = {
  user: { id: 'user-1', email: 'user@partner.test', name: 'U', isPlatformAdmin: false },
  token: { mfa: true },
};

const HOST: ExtensionHostDescriptor = {
  apiVersions: ['1'],
  breezeVersion: '1.2.3',
  serverSdkVersion: '1.0.0',
  webSdkVersion: '1.0.0',
  capabilities: ['devices.read'] as never,
  slots: { 'device.detail.tab': [1] },
};

function record(over: Partial<ExtensionStateRecord> = {}): ExtensionStateRecord {
  return {
    name: 'demo',
    configuredVersion: '1.0.0',
    activeVersion: '1.0.0',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    publisherId: 'lanternops',
    manifestApiVersion: '1',
    serverSdkVersion: '^1.0.0',
    webSdkVersion: null,
    enabled: true,
    lifecycleState: 'active',
    lastErrorCategory: null,
    lastErrorMessage: null,
    migratedAt: null,
    activatedAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  };
}

/** A minimal manifest good enough for the compatibility checker. */
function manifest(over: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    version: '1.0.0',
    apiVersion: '1',
    routeNamespace: 'demo',
    requires: {
      breeze: '^1.0.0',
      serverSdk: '^1.0.0',
      capabilities: [] as string[],
    },
    tenancy: {},
    server: { entry: 'server.js' },
    ...over,
  } as never;
}

function snapshot(over: Partial<StagedExtensionContributions> = {}): StagedExtensionContributions {
  return {
    name: 'demo',
    version: '1.0.0',
    manifest: manifest(),
    routeApp: null,
    jobs: new Map([['nightly', { name: 'nightly', cron: '0 3 * * *', handler: async () => {} }]]),
    aiTools: new Map(),
    enabled: true,
    ...over,
  } as StagedExtensionContributions;
}

type ResyncMock = Mock<() => Promise<void>>;

interface Harness {
  app: Hono;
  setEnabled: Mock<(name: string, enabled: boolean) => Promise<void>>;
  resync: ResyncMock;
  storeCalls: string[];
  registry: ExtensionContributionRegistry;
}

function buildHarness(opts: {
  auth?: FakeAuth | null;
  rows?: ExtensionStateRecord[];
  registrySnapshots?: StagedExtensionContributions[];
  roots?: Map<string, string>;
  resync?: ResyncMock;
} = {}): Harness {
  const rows = opts.rows ?? [record()];
  const storeCalls: string[] = [];
  const setEnabled = vi.fn(async (name: string, enabled: boolean) => {
    storeCalls.push('setEnabled');
    const row = rows.find((r) => r.name === name);
    if (row) row.enabled = enabled;
  });

  const registry = new ExtensionContributionRegistry();
  for (const staged of opts.registrySnapshots ?? []) registry.activate(staged);

  const resync: ResyncMock = opts.resync ?? vi.fn(async () => {});

  const deps: ExtensionsAdminDeps = {
    stateStore: {
      listAll: async () => {
        storeCalls.push('listAll');
        return rows.map((r) => ({ ...r }));
      },
      get: async (name: string) => {
        storeCalls.push('get');
        const row = rows.find((r) => r.name === name);
        return row ? { ...row } : null;
      },
      setEnabled,
    },
    registry,
    resyncSchedules: resync,
    hostDescriptor: HOST,
    extensionRoots: () => opts.roots ?? new Map(),
  };

  const app = new Hono();
  const auth = opts.auth === undefined ? platformAdmin : opts.auth;
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/api/v1/admin/extensions', createExtensionsAdminRoutes(deps));
  return { app, setEnabled, resync, storeCalls, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extensions admin authorization', () => {
  it('requires platform admin for enable and disable', async () => {
    const { app } = buildHarness({ auth: nonAdmin });
    const res = await app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    const { app } = buildHarness({ auth: null });
    expect((await app.request('/api/v1/admin/extensions')).status).toBe(403);
    expect(
      (await app.request('/api/v1/admin/extensions/demo/enable', { method: 'POST' })).status,
    ).toBe(403);
  });

  it('does not mutate state when a non-admin attempts a disable', async () => {
    const { app, setEnabled } = buildHarness({ auth: nonAdmin });
    await app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe('GET / (list)', () => {
  it('returns sanitized observed and config state', async () => {
    const { app } = buildHarness({
      rows: [
        record({
          name: 'demo',
          lifecycleState: 'failed',
          lastErrorCategory: 'verify',
          lastErrorMessage: 'ENOENT /srv/keys/lanternops.pem token=s3cr3t-value',
        }),
      ],
    });
    const res = await app.request('/api/v1/admin/extensions');
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = JSON.stringify(body);

    expect(body.extensions).toHaveLength(1);
    const entry = body.extensions[0];
    expect(entry.name).toBe('demo');
    expect(entry.lifecycleState).toBe('failed');
    expect(entry.errorCategory).toBe('verify');
    // The persisted raw message must NEVER reach the operator surface.
    expect(text).not.toContain('s3cr3t-value');
    expect(text).not.toContain('/srv/keys');
    expect(text).not.toContain('lastErrorMessage');
    // A fixed, category-derived explanation is served instead.
    expect(entry.errorSummary).toBe('extension bundle verification failed');
  });

  it('reports whether each extension is live in this replica', async () => {
    const { app } = buildHarness({ registrySnapshots: [snapshot()] });
    const res = await app.request('/api/v1/admin/extensions');
    const body = await res.json();
    expect(body.extensions[0].loadedInThisReplica).toBe(true);
  });
});

describe('GET /:name/doctor', () => {
  it('composes lifecycle, digest, compatibility and fault attribution', async () => {
    const { app } = buildHarness({
      rows: [record({ lifecycleState: 'incompatible', lastErrorCategory: 'incompatible' })],
      registrySnapshots: [
        snapshot({
          manifest: manifest({
            requires: { breeze: '^9.0.0', serverSdk: '^1.0.0', capabilities: ['nope'] },
          }),
        }),
      ],
      roots: new Map([['demo', '/var/lib/breeze/extensions/extracted/sha256-abc']]),
    });
    const res = await app.request('/api/v1/admin/extensions/demo/doctor');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.name).toBe('demo');
    expect(body.lifecycleState).toBe('incompatible');
    expect(body.artifactDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(body.errorCategory).toBe('incompatible');
    expect(body.compatibility.compatible).toBe(false);
    expect(body.compatibility.reasons.join(' ')).toMatch(/unsupported Breeze range/);
    expect(body.compatibility.reasons.join(' ')).toMatch(/missing capability nope/);
    // Fault attribution is reported as a BOOLEAN — never the on-disk path.
    expect(body.faultAttribution.codeLoaded).toBe(true);
    expect(JSON.stringify(body)).not.toContain('/var/lib/breeze');
  });

  it('reports compatibility as unresolvable when the bundle is not loaded here', async () => {
    const { app } = buildHarness({ rows: [record()], registrySnapshots: [] });
    const body = await (await app.request('/api/v1/admin/extensions/demo/doctor')).json();
    expect(body.compatibility).toBeNull();
    expect(body.faultAttribution.codeLoaded).toBe(false);
  });

  it('404s an unknown extension', async () => {
    const { app } = buildHarness();
    expect((await app.request('/api/v1/admin/extensions/nope/doctor')).status).toBe(404);
  });
});

describe('POST enable / disable', () => {
  it('flips only the database enabled flag', async () => {
    const { app, setEnabled, storeCalls } = buildHarness({
      registrySnapshots: [snapshot()],
    });
    const res = await app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'demo', enabled: false });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('demo', false);
    // No observed/desired state (version, digest, uri, trust) is ever written.
    expect(storeCalls.filter((c) => c === 'setEnabled')).toHaveLength(1);
    expect(storeCalls).not.toContain('upsertObserved');
    expect(storeCalls).not.toContain('recordActive');
  });

  it('withdraws from and restores the in-process registry', async () => {
    const { app, registry } = buildHarness({ registrySnapshots: [snapshot()] });

    await app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });
    expect(registry.get('demo')?.enabled).toBe(false);
    expect(registry.listActive()).toHaveLength(0);

    await app.request('/api/v1/admin/extensions/demo/enable', { method: 'POST' });
    expect(registry.get('demo')?.enabled).toBe(true);
    expect(registry.listActive()).toHaveLength(1);
  });

  it('404s an unknown extension', async () => {
    const { app, setEnabled } = buildHarness();
    expect(
      (await app.request('/api/v1/admin/extensions/nope/disable', { method: 'POST' })).status,
    ).toBe(404);
    expect(setEnabled).not.toHaveBeenCalled();
  });
});

describe('disable removes future repeat schedules without a restart', () => {
  /** A fake BullMQ queue that remembers the repeatables it was asked to hold. */
  function fakeQueue() {
    const repeatables = new Map<
      string,
      { key: string; name: string; id: string; pattern: string }
    >();
    const removed: string[] = [];
    const queue: JobHostQueue = {
      getRepeatableJobs: async () => [...repeatables.values()],
      removeRepeatableByKey: async (key: string) => {
        removed.push(key);
        for (const [k, v] of repeatables) if (v.key === key) repeatables.delete(k);
        return true;
      },
      add: async (name: string, _data: unknown, opts: unknown) => {
        const o = opts as { jobId: string; repeat: { pattern: string } };
        repeatables.set(o.jobId, {
          key: `${name}:${o.jobId}:::${o.repeat.pattern}`,
          name,
          id: o.jobId,
          pattern: o.repeat.pattern,
        });
        return null;
      },
    };
    return { queue, repeatables, removed };
  }

  it('drops the disabled extension repeatable on the next sync', async () => {
    const { queue, repeatables, removed } = fakeQueue();
    const staged = snapshot();

    // Wire the route's resync to a REAL job host over the REAL registry, so the
    // test proves the end-to-end effect rather than that a spy was called.
    let harness: Harness;
    const resync: ResyncMock = vi.fn(async () => {
      const host = new ExtensionJobHost({
        registry: harness.registry,
        store: { isEnabled: async () => true },
      });
      await host.sync(queue);
    });
    harness = buildHarness({ registrySnapshots: [staged], resync });

    // Boot-equivalent sync: the schedule exists while the extension is enabled.
    await resync();
    const jobKey = extensionJobId('demo', 'nightly');
    expect(repeatables.has(jobKey)).toBe(true);

    await harness.app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });

    expect(resync).toHaveBeenCalledTimes(2);
    expect(repeatables.has(jobKey)).toBe(false);
    expect(removed).toHaveLength(1);

    // Re-enabling brings the schedule back, still without a restart.
    await harness.app.request('/api/v1/admin/extensions/demo/enable', { method: 'POST' });
    expect(repeatables.has(jobKey)).toBe(true);
  });

  it('still flips the flag when the schedule resync fails (Redis unavailable)', async () => {
    const resync: ResyncMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED redis:6379');
    });
    const { app, setEnabled } = buildHarness({ registrySnapshots: [snapshot()], resync });

    const res = await app.request('/api/v1/admin/extensions/demo/disable', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('demo', false);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.scheduleSyncDeferred).toBe(true);
    // The raw Redis error must not be echoed to the operator surface.
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });
});
