import { beforeEach, describe, expect, it, vi } from 'vitest';

// Installer material refresh inside the inventory run (#8170). The vendor call
// must run at context depth 0 and the write inside the Phase 3 transaction.
const s = vi.hoisted(() => ({
  depth: 0,
  released: false,
  connection: {} as Record<string, unknown>,
  fenceRow: null as Record<string, unknown> | null,
  tenants: [] as Array<Record<string, unknown>>,
  phase3Tenants: null as Array<Record<string, unknown>> | null,
  updates: [] as Array<Record<string, unknown>>,
  inPhase3: false,
  fetchInstallerMaterial: vi.fn(),
  listTenants: vi.fn(),
  listEndpoints: vi.fn(),
  ensureBuiltinPackage: vi.fn(),
  persistInstallerOutcomes: vi.fn(),
  persistInventory: vi.fn(),
  listDetections: vi.fn(),
  installerCapable: true,
}));

vi.mock('../db', async () => {
  const schema = await import('../db/schema');
  const chain = () => {
    let table: unknown;
    let forUpdate = false;
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'limit', 'values', 'onConflictDoUpdate', 'returning']) c[m] = () => c;
    c.from = (t: unknown) => { table = t; return c; };
    c.for = () => { forUpdate = true; s.inPhase3 = true; return c; };
    c.set = (values: Record<string, unknown>) => { s.updates.push(values); return c; };
    c.then = (resolve: (v: unknown) => unknown) => {
      let rows: unknown = [];
      if (forUpdate) rows = [s.fenceRow ?? s.connection];
      else if (table === schema.edrConnections) rows = [s.connection];
      else if (table === schema.edrTenants) rows = s.inPhase3 ? (s.phase3Tenants ?? s.tenants) : s.tenants;
      return Promise.resolve(rows).then(resolve);
    };
    return c;
  };
  return {
    db: {
      select: () => chain(),
      update: () => chain(),
      insert: () => chain(),
      delete: () => chain(),
      execute: async () => [],
    },
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      s.depth += 1;
      s.inPhase3 = false;
      try { return await fn(); } finally { s.depth -= 1; }
    },
    runOutsideDbContext: async (fn: () => unknown) => {
      const saved = s.depth;
      s.depth = 0;
      try { return await fn(); } finally { s.depth = saved; }
    },
  };
});

const { FakeEdrError } = vi.hoisted(() => {
  class FakeEdrError extends Error {
    code: string; reauth: boolean; scope: string;
    constructor(message: string, o: { code: string; reauth: boolean; scope: string }) {
      super(message);
      this.name = 'EdrProviderRequestError';
      this.code = o.code; this.reauth = o.reauth; this.scope = o.scope;
    }
  }
  return { FakeEdrError };
});

vi.mock('../services/edrProviders/types', () => ({ EdrProviderRequestError: FakeEdrError }));
vi.mock('../services/edrProviders/registry', () => ({
  getEdrProvider: (key: string) => ({
    key,
    hostAllowlist: ['.example.test'],
    capabilities: {
      tenantModel: 'partner', detectionDelivery: 'poll', installer: s.installerCapable ? 'api_generated_link' : 'none',
      actions: [], endpointIdentifiers: ['hostname'], requestBudget: { perSecond: 10 }, tenantFetchConcurrency: 2,
      defaultIntervals: { detectionsMinutes: 5, inventoryMinutes: 60 },
    },
    listTenants: s.listTenants,
    listEndpoints: s.listEndpoints,
    listDetections: s.listDetections,
    ...(s.installerCapable ? { fetchInstallerMaterial: s.fetchInstallerMaterial } : {}),
  }),
}));
vi.mock('../services/builtinDeploymentPackages', () => ({
  getBuiltinPackage: () => ({ released: s.released }),
  ensureBuiltinPackage: (...a: unknown[]) => s.ensureBuiltinPackage(...a),
}));
vi.mock('../services/edrProviders/installerMaterial', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/edrProviders/installerMaterial')>()),
  persistInstallerOutcomes: (...a: unknown[]) => s.persistInstallerOutcomes(...a),
}));
vi.mock('../services/edrProviders/credentials', () => ({ decryptEdrSecret: () => ({ apiKey: 'synthetic-key-0000' }) }));
vi.mock('../services/edrProviders/context', () => ({ buildEdrAdapterContext: () => ({ runCache: new Map() }) }));
vi.mock('../services/edrProviders/persist', () => ({
  upsertTenants: async () => ({ total: 2, unmapped: 1, newlyMissing: 0 }),
  persistInventory: (...a: unknown[]) => s.persistInventory(...a),
  persistDetections: async () => ({ upserted: 0, failedTenants: 0, skipped: 0 }),
  pruneMissingTenantEndpoints: async () => 0,
  refreshDetectionDeviceLinks: async () => undefined,
  isDeadlockError: () => false,
  clearExpiredTenantDenials: async () => 0,
  loadOpenDetectionRefs: async () => new Map(),
  applyDetectionStatusUpdates: async () => 0,
}));
vi.mock('../services/edrProviders/actionStatus', () => ({ pollEdrActionStatus: vi.fn(), EDR_ACTION_UNKNOWN_GIVEUP_MS: 1 }));
vi.mock('../services/edrProviders/mapping', () => ({ autoMapEdrTenants: async () => ({ mapped: 0, suggestions: [] }) }));
vi.mock('../services/edrProviders/alerts', () => ({
  evaluateEdrAlerts: async () => ({}), evaluateEdrEndpointHealth: async () => ({}), evaluateEdrStaleTenants: async () => ({}),
}));
vi.mock('../services/edrProviders/deviceMatching', () => ({
  matchEdrEndpoints: async () => ({ linked: 0, ambiguous: 0 }), strictMatchingFor: () => false,
}));
vi.mock('../services/edrProviders/scheduler', () => ({
  isStreamDue: () => false, planCadence: () => ({ detectionsMinutes: 5, inventoryMinutes: 60 }),
}));
vi.mock('../services/edrProviders/hints', () => ({
  readEdrHints: async () => ({ members: [], hints: [], markerAt: null }), ackEdrHints: async () => ({ stillPending: false }),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../services/sentry', () => sentry);
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}), getRedis: () => null }));
vi.mock('../services/bullmqQueue', () => ({ createInstrumentedQueue: () => ({ getRepeatableJobs: async () => [], add: vi.fn() }) }));
vi.mock('../services/bullmqUtils', () => ({ enqueueOrReplaceStale: async () => ({ id: 'job-1' }) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('./syncAttempt', () => ({ isFinalSyncAttempt: () => true, reportTerminalSyncFailure: vi.fn() }));

import { INSTALLER_FETCH_MAX_PER_RUN } from '../services/edrProviders/installerMaterial';
import { syncEdrDetections, syncEdrInventory } from './edrProviderSync';

const CONNECTION = '00000000-0000-4000-8000-0000000000e1';
const PARTNER = '00000000-0000-4000-8000-0000000000e2';
const MAPPED = { id: 't-mapped', vendorTenantId: 'v-mapped', orgId: 'org-1', apiHost: null, detectionCursor: null };
const MAPPED2 = { id: 't-mapped2', vendorTenantId: 'v-mapped2', orgId: 'org-2', apiHost: null, detectionCursor: null };
const UNMAPPED = { id: 't-un', vendorTenantId: 'v-un', orgId: null, apiHost: null, detectionCursor: null };
const FRESH = { installerHasMaterial: true, installerFetchedAt: new Date(), installerExpiresAt: null, installerFetchError: null };
const vt = (id: unknown) => ({ vendorTenantId: id, name: 'x', parentId: null, tenantType: null, externalCode: null, apiHost: null });
const outcomes = () => s.persistInstallerOutcomes.mock.calls[0]![2] as Array<Record<string, unknown>>;
const connectionWrite = () => [...s.updates].reverse().find((u) => 'lastSyncTenants' in u);

beforeEach(() => {
  vi.clearAllMocks();
  s.depth = 0;
  s.released = true;
  s.installerCapable = true;
  s.inPhase3 = false;
  s.fenceRow = null;
  s.phase3Tenants = null;
  s.updates = [];
  s.connection = {
    id: CONNECTION, partnerId: PARTNER, provider: 'bitdefender', baseUrl: null, region: null, credentialsEncrypted: 'enc',
    vendorRootId: 'root', vendorRootType: 'partner', isActive: true, status: 'connected',
    detectionIntervalMinutes: null, inventoryIntervalMinutes: null,
  };
  s.tenants = [MAPPED, UNMAPPED];
  s.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-un')]);
  s.listEndpoints.mockResolvedValue([]);
  s.listDetections.mockResolvedValue({ detections: [], cursor: null, warnings: [] });
  s.persistInventory.mockResolvedValue({ endpoints: 0, failedTenants: 0 });
  s.ensureBuiltinPackage.mockResolvedValue({ catalogId: 'cat-1' });
  s.persistInstallerOutcomes.mockResolvedValue(undefined);
  s.fetchInstallerMaterial.mockResolvedValue({ ok: true, data: { link: 'material' }, expiresAt: null });
});

describe('installer material refresh in the inventory run', () => {
  it('while unreleased: zero vendor calls, no catalog write, nothing persisted', async () => {
    s.released = false;
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).not.toHaveBeenCalled();
    expect(s.ensureBuiltinPackage).not.toHaveBeenCalled();
    expect(s.persistInstallerOutcomes).not.toHaveBeenCalled();
  });

  it('a provider that is not installer-capable: nothing, even with the gate open', async () => {
    s.connection = { ...s.connection, provider: 'emsisoft' };
    s.installerCapable = false;
    await syncEdrInventory(CONNECTION);
    expect(s.ensureBuiltinPackage).not.toHaveBeenCalled();
    expect(s.persistInstallerOutcomes).not.toHaveBeenCalled();
  });

  it('released + one due tenant: ensures the package, fetches outside any db context, persists in Phase 3', async () => {
    const depths: number[] = [];
    s.fetchInstallerMaterial.mockImplementation(async () => {
      depths.push(s.depth);
      return { ok: true, data: { link: 'material' }, expiresAt: null };
    });
    s.persistInstallerOutcomes.mockImplementation(async () => { depths.push(s.depth); });
    await syncEdrInventory(CONNECTION);
    expect(s.ensureBuiltinPackage).toHaveBeenCalledWith({ provider: 'bitdefender', partnerId: PARTNER });
    // Mapped only: the unmapped tenant is never asked about.
    expect(s.fetchInstallerMaterial).toHaveBeenCalledTimes(1);
    expect(s.fetchInstallerMaterial.mock.calls[0]![1]).toEqual({ vendorTenantId: 'v-mapped', apiHost: null });
    expect(s.persistInstallerOutcomes.mock.calls[0]![1]).toBe('bitdefender');
    expect(outcomes()).toEqual([{ tenantId: 't-mapped', ok: true, data: { link: 'material' }, expiresAt: null }]);
    expect(depths).toEqual([0, 1]);
  });

  it('a tenant with fresh material is not fetched', async () => {
    s.tenants = [{ ...MAPPED, ...FRESH }, UNMAPPED];
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).not.toHaveBeenCalled();
    expect(s.persistInstallerOutcomes).not.toHaveBeenCalled();
  });

  it('a tenant the vendor no longer lists is not fetched', async () => {
    s.listTenants.mockResolvedValue([vt('v-un')]);
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).not.toHaveBeenCalled();
  });

  it('a large backlog is capped per run, so installer links cannot hold up inventory', async () => {
    s.tenants = Array.from({ length: INSTALLER_FETCH_MAX_PER_RUN + 5 }, (_, i) => ({ ...MAPPED, id: `t-${i}`, vendorTenantId: `v-${i}` }));
    s.listTenants.mockResolvedValue(s.tenants.map((t) => vt(t.vendorTenantId)));
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).toHaveBeenCalledTimes(INSTALLER_FETCH_MAX_PER_RUN);
  });

  it('a verdict is persisted and leaves inventory and the connection alone', async () => {
    s.fetchInstallerMaterial.mockResolvedValue({ ok: false, code: 'multiple_packages' });
    await syncEdrInventory(CONNECTION);
    expect(outcomes()).toEqual([{ tenantId: 't-mapped', ok: false, code: 'multiple_packages' }]);
    expect(s.persistInventory).toHaveBeenCalled();
    expect(connectionWrite()).toMatchObject({ lastInventorySyncStatus: 'success', status: 'connected' });
  });

  it.each([
    ['a tenant-scope error', new FakeEdrError('x', { code: 'vendor_error', reauth: false, scope: 'tenant' })],
    ['a connection-scope 401', new FakeEdrError('x', { code: 'auth', reauth: true, scope: 'connection' })],
    ['a budget refusal', new FakeEdrError('x', { code: 'rate_budget_exhausted', reauth: false, scope: 'connection' })],
    ['a plain error', new Error('socket hang up')],
  ])('%s from the fetch is vendor_error for that tenant and never touches the connection', async (_label, error) => {
    s.fetchInstallerMaterial.mockRejectedValue(error);
    await expect(syncEdrInventory(CONNECTION)).resolves.toBeUndefined();
    expect(outcomes()).toEqual([{ tenantId: 't-mapped', ok: false, code: 'vendor_error' }]);
    expect(s.persistInventory).toHaveBeenCalled();
    expect(connectionWrite()).toMatchObject({ lastInventorySyncStatus: 'success', status: 'connected' });
  });

  it('an unexpected (non-vendor) throw is reported without its message; a vendor error is not reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.fetchInstallerMaterial.mockRejectedValueOnce(new TypeError('secret-bearing text https://download.example.test/x'));
    await syncEdrInventory(CONNECTION);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const reported = sentry.captureException.mock.calls[0]![0] as Error;
    expect(reported.message).toContain('TypeError');
    expect(JSON.stringify([reported.message, warn.mock.calls])).not.toContain('download.example.test');

    sentry.captureException.mockClear();
    s.fetchInstallerMaterial.mockRejectedValueOnce(new FakeEdrError('x', { code: 'rate_limited', reauth: false, scope: 'connection' }));
    await syncEdrInventory(CONNECTION);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('rate_limited');
    warn.mockRestore();
  });

  it('a failure to provision the package does not stop the run', async () => {
    s.ensureBuiltinPackage.mockRejectedValue(new Error('catalog down'));
    await expect(syncEdrInventory(CONNECTION)).resolves.toBeUndefined();
    expect(s.persistInventory).toHaveBeenCalled();
    expect(s.persistInstallerOutcomes).toHaveBeenCalled();
  });

  it('a tenant remapped since Phase 1 loses its outcome at the per-tenant fence', async () => {
    s.tenants = [MAPPED, MAPPED2];
    s.phase3Tenants = [{ ...MAPPED, orgId: 'org-NEW' }, MAPPED2];
    s.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    await syncEdrInventory(CONNECTION);
    expect(outcomes().map((o) => o.tenantId)).toEqual(['t-mapped2']);
  });

  it.each([
    ['unmapped since Phase 1', { ...MAPPED, orgId: null }],
    ['gone since Phase 1', null],
  ])('a tenant %s loses its outcome: its material was cleared on purpose', async (_label, phase3) => {
    s.tenants = [MAPPED, MAPPED2];
    s.phase3Tenants = phase3 ? [phase3, MAPPED2] : [MAPPED2];
    s.listTenants.mockResolvedValue([vt('v-mapped'), vt('v-mapped2')]);
    await syncEdrInventory(CONNECTION);
    expect(outcomes().map((o) => o.tenantId)).toEqual(['t-mapped2']);
  });

  it.each([
    ['credentials', { credentialsEncrypted: 'rotated' }],
    ['Access URL', { baseUrl: 'https://other.example.test/api' }],
    ['region', { region: 'eu' }],
    ['vendor root', { vendorRootId: 'other-root' }],
  ])('the connection fence (%s changed) drops every outcome', async (_label, change) => {
    s.fenceRow = { ...s.connection, ...change };
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).toHaveBeenCalled();
    expect(s.persistInstallerOutcomes).not.toHaveBeenCalled();
  });

  it('detection runs never fetch installer material', async () => {
    await syncEdrDetections(CONNECTION);
    expect(s.fetchInstallerMaterial).not.toHaveBeenCalled();
    expect(s.ensureBuiltinPackage).not.toHaveBeenCalled();
  });
});

describe('with the shipped package definition', () => {
  it('the real released:false gate makes zero installer calls and provisions nothing', async () => {
    const actual = await vi.importActual<typeof import('../services/builtinDeploymentPackages')>('../services/builtinDeploymentPackages');
    s.released = actual.getBuiltinPackage('bitdefender').released;
    expect(s.released).toBe(false);
    await syncEdrInventory(CONNECTION);
    expect(s.fetchInstallerMaterial).not.toHaveBeenCalled();
    expect(s.ensureBuiltinPackage).not.toHaveBeenCalled();
  });
});
