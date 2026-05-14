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

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: Array.from(strings),
    values,
  }),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
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
