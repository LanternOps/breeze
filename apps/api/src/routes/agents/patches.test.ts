import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, patches } from '../../db/schema';
import * as enrichmentModule from '../../services/thirdPartyEnrichment';
import * as wingetWorker from '../../jobs/wingetReleaseTestWorker';
import { patchesRoutes } from './patches';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tables = vi.hoisted(() => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
  },
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    externalId: 'patches.externalId',
    title: 'patches.title',
    description: 'patches.description',
    severity: 'patches.severity',
    category: 'patches.category',
    releaseDate: 'patches.releaseDate',
    requiresReboot: 'patches.requiresReboot',
    downloadSizeMb: 'patches.downloadSizeMb',
    vendor: 'patches.vendor',
    packageId: 'patches.packageId',
    osTypes: 'patches.osTypes',
  },
  devicePatches: {
    deviceId: 'devicePatches.deviceId',
    orgId: 'devicePatches.orgId',
    patchId: 'devicePatches.patchId',
    status: 'devicePatches.status',
    lastCheckedAt: 'devicePatches.lastCheckedAt',
    installedAt: 'devicePatches.installedAt',
    installedVersion: 'devicePatches.installedVersion',
    updatedAt: 'devicePatches.updatedAt',
  },
}));

const sqlMock = vi.hoisted(() => Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: Array.from(strings),
    values,
  }),
  {
    join: (items: unknown[], separator: unknown) => ({ op: 'sql.join', items, separator }),
  },
));

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  sql: sqlMock,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    // tombstone prune (#1004) runs after the scan txn via db.delete(...).where(...)
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: tables.devices,
  patches: tables.patches,
  devicePatches: tables.devicePatches,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../jobs/wingetReleaseTestWorker', () => ({
  enqueueWingetReleaseTest: vi.fn(async () => ({
    testId: 'queued',
    alreadyExisted: false,
  })),
}));

vi.mock('../../services/thirdPartyEnrichment', () => ({
  enrichFromCatalog: vi.fn(async (input: {
    title: string;
    vendor: string | null;
    severity: string | null;
    category?: string | null;
  }) => ({
    title: input.title,
    vendor: input.vendor,
    severity: input.severity,
    category: input.category ?? null,
    matchedCatalogId: null,
  })),
}));

vi.mock('./helpers', () => ({
  inferPatchOsType: vi.fn((_source: string, osType: string | null | undefined) => osType),
  parseDate: vi.fn((value: string | undefined) => (value ? new Date(value) : null)),
  sanitizeDate: vi.fn((value: string | undefined) => value ?? null),
}));

function selectRows(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
  });
}

function mountAgentPatchRoutes(role: 'agent' | 'watchdog' = 'agent') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: DEVICE_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      siteId: 'site-1',
      role,
    } as never);
    return next();
  });
  app.route('/agents', patchesRoutes);
  return app;
}

function mockDeviceLookup(osType = 'linux') {
  vi.mocked(db.select).mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => selectRows([
        { id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, osType },
      ])),
    })),
  }) as never);
}

function mockPatchInsertTx() {
  const insertedRows: Array<Record<string, unknown>> = [];
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    insert: vi.fn((table) => ({
      values: vi.fn((values) => ({
        onConflictDoUpdate: vi.fn(() => {
          if (table === patches) {
            const row = { id: PATCH_ID, ...values };
            insertedRows.push(row);
            return {
              returning: vi.fn().mockResolvedValue([row]),
            };
          }

          return {
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      })),
    })),
  };
  return { tx, insertedRows };
}

describe('PUT /agents/:id/patches - third-party fields', () => {
  let app: Hono;
  let patchRows: Array<Record<string, unknown>>;
  let patchUpsertSet: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichmentModule.enrichFromCatalog).mockImplementation(async (input) => ({
      title: input.title,
      vendor: input.vendor,
      severity: (input.severity as 'critical' | 'important' | 'moderate' | 'low' | 'unknown' | null) ?? null,
      category: input.category ?? null,
      matchedCatalogId: null,
    }));
    patchRows = [];
    patchUpsertSet = undefined;
    app = new Hono();
    // Simulate agentAuthMiddleware setting the main-agent credential so the
    // requireAgentRole guard on patchesRoutes lets these ingest tests through.
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
        role: 'agent',
      } as never);
      return next();
    });
    app.route('/agents', patchesRoutes);

    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn((table) => ({
        where: vi.fn((condition) => {
          if (table === devices) {
            return selectRows([
              {
                id: DEVICE_ID,
                agentId: AGENT_ID,
                orgId: ORG_ID,
                osType: 'windows',
              },
            ]);
          }

          if (table === patches && condition?.left === patches.packageId) {
            return selectRows(patchRows.filter((row) => row.packageId === condition.right));
          }

          return selectRows([]);
        }),
      })),
    }) as never);

    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        insert: vi.fn((table) => ({
          values: vi.fn((values) => ({
            onConflictDoUpdate: vi.fn(({ set }) => {
              if (table === patches) {
                patchUpsertSet = set;
                const row = { id: PATCH_ID, ...values };
                patchRows.push(row);
                return {
                  returning: vi.fn().mockResolvedValue([row]),
                };
              }

              return {
                returning: vi.fn().mockResolvedValue([]),
              };
            }),
          })),
        })),
      };

      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });
  });

  it('persists vendor and packageId for winget patches', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [
          {
            name: 'Mozilla Firefox',
            source: 'third_party',
            packageId: 'Mozilla.Firefox',
            vendor: 'Mozilla',
            version: '121.0',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const [persistedPatch] = await db
      .select()
      .from(patches)
      .where(eq(patches.packageId, 'Mozilla.Firefox'));

    expect(persistedPatch).toEqual(expect.objectContaining({
      vendor: 'Mozilla',
      packageId: 'Mozilla.Firefox',
      source: 'third_party',
    }));
    expect(patchUpsertSet).toEqual(expect.objectContaining({
      vendor: 'Mozilla',
      packageId: 'Mozilla.Firefox',
    }));
  });

  it('uses enriched title/vendor/severity from catalog in the upsert', async () => {
    vi.mocked(enrichmentModule.enrichFromCatalog).mockResolvedValue({
      title: 'Mozilla Firefox',
      vendor: 'Mozilla',
      severity: 'important',
      category: 'application',
      matchedCatalogId: 'cat-1',
    });

    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [
          {
            name: 'firefox',
            source: 'third_party',
            packageId: 'Mozilla.Firefox',
            version: '121.0',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(enrichmentModule.enrichFromCatalog).toHaveBeenCalledWith(expect.objectContaining({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      title: 'firefox',
    }));
    expect(patchUpsertSet).toEqual(expect.objectContaining({
      title: 'Mozilla Firefox',
      vendor: 'Mozilla',
      severity: 'important',
    }));

    vi.mocked(enrichmentModule.enrichFromCatalog).mockRestore();
  });

  it('persists agent-supplied version into patches.version', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [
          {
            name: 'Mozilla Firefox',
            source: 'third_party',
            packageId: 'Mozilla.Firefox',
            vendor: 'Mozilla',
            version: '121.0.1',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(patchUpsertSet).toEqual(expect.objectContaining({
      version: '121.0.1',
    }));
  });
});

describe('PUT /agents/:id/patches - ENABLE_AI_PATCH_TESTING gating', () => {
  let app: Hono;
  const originalEnv = process.env.ENABLE_AI_PATCH_TESTING;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENABLE_AI_PATCH_TESTING;
    vi.mocked(enrichmentModule.enrichFromCatalog).mockResolvedValue({
      title: 'Mozilla Firefox',
      vendor: 'Mozilla',
      severity: 'important',
      category: 'application',
      matchedCatalogId: 'cat-1',
    });
    vi.mocked(wingetWorker.enqueueWingetReleaseTest).mockResolvedValue({
      testId: 'queued',
      alreadyExisted: false,
    });
    app = new Hono();
    // Simulate agentAuthMiddleware setting the main-agent credential so the
    // requireAgentRole guard on patchesRoutes lets these ingest tests through.
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
        role: 'agent',
      } as never);
      return next();
    });
    app.route('/agents', patchesRoutes);

    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([
          { id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, osType: 'windows' },
        ]), {
          limit: vi.fn().mockResolvedValue([
            { id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, osType: 'windows' },
          ]),
        })),
      })),
    }) as never);

    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(undefined),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((values) => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: PATCH_ID, ...values }]),
            })),
          })),
        })),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_AI_PATCH_TESTING;
    } else {
      process.env.ENABLE_AI_PATCH_TESTING = originalEnv;
    }
  });

  const payload = {
    patches: [
      {
        name: 'Mozilla Firefox',
        source: 'third_party',
        packageId: 'Mozilla.Firefox',
        vendor: 'Mozilla',
        version: '121.0',
      },
    ],
  };

  it('does NOT enqueue release test when ENABLE_AI_PATCH_TESTING is unset', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(wingetWorker.enqueueWingetReleaseTest).not.toHaveBeenCalled();
  });

  it('enqueues release test when ENABLE_AI_PATCH_TESTING is set', async () => {
    process.env.ENABLE_AI_PATCH_TESTING = '1';

    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(wingetWorker.enqueueWingetReleaseTest).toHaveBeenCalledWith({
      catalogId: 'cat-1',
      version: '121.0',
    });
  });
});

describe('split patch ingest endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceLookup('linux');
    vi.mocked(enrichmentModule.enrichFromCatalog).mockImplementation(async (input) => ({
      title: input.title,
      vendor: input.vendor,
      severity: (input.severity as 'critical' | 'important' | 'moderate' | 'low' | 'unknown' | null) ?? null,
      category: input.category ?? null,
      matchedCatalogId: null,
    }));
  });

  it('marks only pending rows missing for the submitted pending source', async () => {
    const { tx } = mockPatchInsertTx();
    let updateWhere: unknown;
    tx.update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((condition) => {
          updateWhere = condition;
          return Promise.resolve(undefined);
        }),
      })),
    }));
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'linux',
        patches: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, pending: 0 });
    expect(tx.update).toHaveBeenCalledWith(tables.devicePatches);
    expect(tx.insert).not.toHaveBeenCalled();

    const conditions = (updateWhere as { conds?: unknown[] }).conds ?? [];
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.deviceId, right: DEVICE_ID });
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.status, right: 'pending' });
    expect(JSON.stringify(updateWhere)).toContain('linux');
  });

  it('does not tombstone pending rows for an empty partial pending payload', async () => {
    const { tx } = mockPatchInsertTx();
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, pending: 0 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('upserts non-Linux installed patch batches without tombstoning pending rows', async () => {
    const { tx } = mockPatchInsertTx();
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/installed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installed: [
          {
            name: 'Security Intelligence Update',
            source: 'microsoft',
            packageId: 'KB5000001',
            version: '1.2.3',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, installed: 1, ignored: 0 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalledWith(tables.patches);
    expect(tx.insert).toHaveBeenCalledWith(tables.devicePatches);
  });

  it('ignores Linux installed package inventory without touching patch state', async () => {
    const { tx } = mockPatchInsertTx();
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/installed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installed: [
          {
            name: 'openssl',
            source: 'linux',
            packageId: 'apt:openssl',
            version: '3.0.2-0ubuntu1.20',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, installed: 0, ignored: 1 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

const patchIngestEndpoints = [
  {
    label: 'legacy combined patch ingest',
    path: `/agents/${AGENT_ID}/patches`,
    body: { patches: [] },
  },
  {
    label: 'pending patch ingest',
    path: `/agents/${AGENT_ID}/patches/pending`,
    body: { patches: [] },
  },
  {
    label: 'installed patch ingest',
    path: `/agents/${AGENT_ID}/patches/installed`,
    body: { installed: [] },
  },
] as const;

describe('agent patch ingest - requireAgentRole gate (F3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(patchIngestEndpoints)('rejects a watchdog-role token on $label with 403 and does not touch the DB', async ({ path, body }) => {
    const res = await mountAgentPatchRoutes('watchdog').request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each(patchIngestEndpoints)('rejects $label when no agent credential is present', async ({ path, body }) => {
    const app = new Hono();
    app.route('/agents', patchesRoutes);

    const res = await app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
