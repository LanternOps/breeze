import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, patches } from '../../db/schema';
import * as enrichmentModule from '../../services/thirdPartyEnrichment';
import * as auditEvents from '../../services/auditEvents';
import * as wingetWorker from '../../jobs/wingetReleaseTestWorker';
import { patchesRoutes, raiseOnlySeverity } from './patches';

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
    version: 'patches.version',
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
    availableVersion: 'devicePatches.availableVersion',
    scope: 'devicePatches.scope',
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
  const devicePatchValues: Array<Record<string, unknown>> = [];
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
    // No existing device_patches row in these generic fixtures — the
    // installed-path version-aware flip (#2736) falls back to the global
    // patches.version, which these tests don't exercise directly.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
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

          devicePatchValues.push(values as Record<string, unknown>);
          return {
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      })),
    })),
  };
  return { tx, insertedRows, devicePatchValues };
}

type MockSqlFragment = {
  op: 'sql';
  strings: string[];
  values: unknown[];
};

const RAISING_SEVERITY_STRINGS = [
  'CASE\n    WHEN ',
  ' IS NULL THEN ',
  '::patch_severity\n    WHEN COALESCE(array_position(',
  ', ',
  '), 0)\n       > COALESCE(array_position(',
  ', ',
  '::text), 0)\n      THEN ',
  '::patch_severity\n    ELSE ',
  '\n  END',
];

function expectRaisingSeverityFragment(fragment: unknown, incoming: string) {
  const query = fragment as MockSqlFragment;
  expect(query.op).toBe('sql');
  expect(query.strings).toEqual(RAISING_SEVERITY_STRINGS);
  expect(query.values).toHaveLength(8);
  expect(query.values[0]).toBe(tables.patches.severity);
  expect(query.values[1]).toBe(incoming);
  expect(query.values[2]).toEqual({
    op: 'sql',
    strings: ["ARRAY['unknown','low','moderate','important','critical']::text[]"],
    values: [],
  });
  expect(query.values[3]).toBe(incoming);
  expect(query.values[4]).toEqual(query.values[2]);
  expect(query.values[5]).toBe(tables.patches.severity);
  expect(query.values[6]).toBe(incoming);
  // The final CASE value is the stored column: lower/equal reports fall through
  // to it instead of replacing the catalog row.
  expect(query.values[7]).toBe(tables.patches.severity);
}

describe('patch catalog SQL integrity helpers', () => {
  it('renders a ranked CASE whose fallthrough keeps the stored severity', () => {
    expectRaisingSeverityFragment(
      raiseOnlySeverity(tables.patches.severity, 'low'),
      'low',
    );
  });

  it.each(['unknown', null] as const)('keeps the stored severity for %s', (incoming) => {
    expect(raiseOnlySeverity(tables.patches.severity, incoming)).toEqual({
      op: 'sql',
      strings: ['COALESCE(', ", 'unknown'::patch_severity)"],
      values: [tables.patches.severity],
    });
  });

  it('binds critical as a parameter in the raising CASE', () => {
    expectRaisingSeverityFragment(
      raiseOnlySeverity(tables.patches.severity, 'critical'),
      'critical',
    );
  });
});

describe('PUT /agents/:id/patches - third-party fields', () => {
  let app: Hono;
  let patchRows: Array<Record<string, unknown>>;
  let patchUpsertSet: Record<string, unknown> | undefined;
  let devicePatchValues: Record<string, unknown> | undefined;
  let devicePatchUpsertSet: Record<string, unknown> | undefined;

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
    devicePatchValues = undefined;
    devicePatchUpsertSet = undefined;
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

              devicePatchValues = values;
              devicePatchUpsertSet = set;
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
    // `patches` is a global, un-tenanted catalog row, so an uncurated (raw
    // agent) report may only FILL the identity columns, never rewrite them: the
    // conflict update has to render as COALESCE(existing, incoming) rather than
    // a bare assignment. The real SQL semantics are proven against Postgres in
    // patches.integration.test.ts; this only pins the generated shape.
    expect(patchUpsertSet?.packageId).toEqual(expect.objectContaining({
      op: 'sql',
      strings: ['COALESCE(', ', ', ')'],
      values: ['patches.packageId', 'Mozilla.Firefox'],
    }));
    expect(patchUpsertSet?.vendor).toEqual(expect.objectContaining({
      op: 'sql',
      strings: ['COALESCE(', ', ', ')'],
      values: ['patches.vendor', 'Mozilla'],
    }));
    // Title is not rewritten at all without curation — it keeps the stored value.
    expect(patchUpsertSet?.title).toEqual(expect.objectContaining({
      op: 'sql',
      values: ['patches.title'],
    }));
  });

  it('uses enriched title/vendor and a raise-only severity expression in the upsert', async () => {
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
    }));
    expectRaisingSeverityFragment(patchUpsertSet?.severity, 'important');

    vi.mocked(enrichmentModule.enrichFromCatalog).mockRestore();
  });

  it('converts download size to whole MB and clamps it to the integer column ceiling', async () => {
    async function submitSize(size: number | undefined) {
      patchRows = [];
      await app.request(`/agents/${AGENT_ID}/patches`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patches: [{
            name: 'Sized', source: 'third_party', externalId: 'sized-1',
            packageId: 'Sized.Pkg', ...(size === undefined ? {} : { size }),
          }],
        }),
      });
      return patchRows[0]?.downloadSizeMb;
    }

    expect(await submitSize(5 * 1024 * 1024)).toBe(5);
    // Rounds up: a partial megabyte still reports as one.
    expect(await submitSize(1)).toBe(1);
    expect(await submitSize(undefined)).toBeNull();
    expect(await submitSize(0)).toBeNull();
    // `download_size_mb` is a Postgres `integer` and the request schema puts no
    // upper bound on `size`, so an absurd byte count must be clamped rather
    // than overflowing the column and aborting the whole scan transaction.
    expect(await submitSize(Number.MAX_SAFE_INTEGER)).toBe(2147483647);
  });

  it('audits refused rows with a reason histogram summed across both lists', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Both lists refuse a row for the SAME reason. Merging the two
        // histograms by object spread would drop one of the counts.
        patches: [{ name: 'Bad pending', source: 'third_party', externalId: 'bad-p', packageId: 'winget:--all' }],
        installed: [{ name: 'Bad installed', source: 'third_party', externalId: 'bad-i', packageId: 'winget:--all' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ success: true, rejected: 2 }));
    expect(auditEvents.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.patches.submit',
        details: expect.objectContaining({
          rejectedCount: 2,
          rejectedReasons: { package_id_option_like: 2 },
        }),
      }),
    );
  });

  it('only fills patches.version and stores the reported version on device_patches', async () => {
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
    expect(patchUpsertSet?.version).toEqual({
      op: 'sql',
      strings: ['COALESCE(', ', ', ')'],
      values: [tables.patches.version, '121.0.1'],
    });
    expect(devicePatchValues).toEqual(expect.objectContaining({
      availableVersion: '121.0.1',
    }));
    expect(devicePatchUpsertSet?.availableVersion).toBe('121.0.1');
  });

  it('keeps the stored catalog and device versions when the scan omits version', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/patches`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patches: [
          {
            name: 'Mozilla Firefox',
            source: 'third_party',
            packageId: 'Mozilla.Firefox',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(patchUpsertSet?.version).toEqual({
      op: 'sql',
      strings: ['', ''],
      values: [tables.patches.version],
    });
    expect(devicePatchValues).toEqual(expect.objectContaining({
      availableVersion: null,
    }));
    expect(devicePatchUpsertSet?.availableVersion).toEqual({
      op: 'sql',
      strings: ['', ''],
      values: [tables.devicePatches.availableVersion],
    });
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
    expect(body).toEqual({ success: true, pending: 0, rejected: 0 });
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
    expect(body).toEqual({ success: true, pending: 0, rejected: 0 });
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
    expect(body).toEqual({ success: true, installed: 1, ignored: 0, rejected: 0 });
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
    expect(body).toEqual({ success: true, installed: 0, ignored: 1, rejected: 0 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe('PUT /agents/:id/patches/pending - full scan coverage scoping (#2217)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceLookup('windows');
    vi.mocked(enrichmentModule.enrichFromCatalog).mockImplementation(async (input) => ({
      title: input.title,
      vendor: input.vendor,
      severity: (input.severity as 'critical' | 'important' | 'moderate' | 'low' | 'unknown' | null) ?? null,
      category: input.category ?? null,
      matchedCatalogId: null,
    }));
  });

  function captureUpdateWhere(tx: ReturnType<typeof mockPatchInsertTx>['tx']) {
    const calls: unknown[] = [];
    tx.update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((condition) => {
          calls.push(condition);
          return Promise.resolve(undefined);
        }),
      })),
    }));
    return calls;
  }

  it('full scan with coveredSources only tombstones the covered sources and still upserts scanned patches', async () => {
    const { tx } = mockPatchInsertTx();
    const updateWheres = captureUpdateWhere(tx);
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full: true,
        coveredSources: ['microsoft'],
        patches: [
          { name: 'KB5000001', source: 'microsoft', externalId: 'KB5000001' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, pending: 1, rejected: 0 });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(tables.devicePatches);
    const conditions = (updateWheres[0] as { conds?: unknown[] }).conds ?? [];
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.deviceId, right: DEVICE_ID });
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.status, right: 'pending' });
    const serialized = JSON.stringify(updateWheres[0]);
    expect(serialized).toContain('microsoft');
    expect(serialized).not.toContain('third_party');

    // The scanned patch is still re-upserted.
    expect(tx.insert).toHaveBeenCalledWith(tables.patches);
    expect(tx.insert).toHaveBeenCalledWith(tables.devicePatches);
  });

  it('legacy full scan without coveredSources sweeps all sources', async () => {
    const { tx } = mockPatchInsertTx();
    const updateWheres = captureUpdateWhere(tx);
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full: true,
        patches: [
          { name: 'KB5000001', source: 'microsoft', externalId: 'KB5000001' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(tx.update).toHaveBeenCalledTimes(1);
    // No source scoping: deviceId + pending-status, plus the user-scope guard
    // (#2727) — a legacy payload carries no userScopeScanned, so per-user rows
    // are never tombstoned by it.
    const conditions = (updateWheres[0] as { conds?: unknown[] }).conds ?? [];
    expect(conditions).toHaveLength(3);
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.deviceId, right: DEVICE_ID });
    expect(conditions).toContainEqual({ op: 'eq', left: tables.devicePatches.status, right: 'pending' });
    expect(JSON.stringify(updateWheres[0])).toContain('IS DISTINCT FROM');
    expect(tx.insert).toHaveBeenCalledWith(tables.devicePatches);
  });

  // #2727 — per-user winget results are a second coverage axis: the user-context
  // pass only runs when somebody is logged in, so user-scope pending rows must
  // only be swept when the agent explicitly says that pass ran.
  it('spares user-scope rows unless userScopeScanned is explicitly true', async () => {
    for (const [payloadFlag, wantGuard] of [[undefined, true], [false, true], [true, false]] as const) {
      const { tx } = mockPatchInsertTx();
      const updateWheres = captureUpdateWhere(tx);
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

      const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full: true,
          coveredSources: ['third_party'],
          ...(payloadFlag === undefined ? {} : { userScopeScanned: payloadFlag }),
          patches: [{ name: 'Chrome', source: 'third_party', externalId: 'Google.Chrome', scope: 'user' }],
        }),
      });

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(updateWheres[0]);
      if (wantGuard) {
        expect(serialized, `userScopeScanned=${String(payloadFlag)} must spare user-scope rows`).toContain('IS DISTINCT FROM');

        // Assert the OPERAND too, not just the operator: comparing against the
        // wrong literal would leave the substring above intact while sparing
        // the wrong rows.
        expect(serialized).toContain("IS DISTINCT FROM 'user'");
        expect(serialized).toContain('devicePatches.scope');
      } else {
        expect(serialized, 'a scan that covered user scope may sweep user-scope rows').not.toContain('IS DISTINCT FROM');
      }
    }
  });

  it('persists the reported install scope on the device_patches row', async () => {
    const { tx, devicePatchValues } = mockPatchInsertTx();
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'third_party',
        userScopeScanned: true,
        patches: [{ name: 'Chrome', source: 'third_party', externalId: 'Google.Chrome', scope: 'user' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(devicePatchValues[0]).toMatchObject({ scope: 'user' });
  });

  it('full scan with empty coveredSources tombstones nothing', async () => {
    const { tx } = mockPatchInsertTx();
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full: true,
        coveredSources: [],
        patches: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, pending: 0, rejected: 0 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('rejects coveredSources values outside the source enum', async () => {
    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full: true,
        coveredSources: ['not-a-source'],
        patches: [],
      }),
    });

    expect(res.status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('PUT /agents/:id/patches/installed - pending rows survive installed inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceLookup('windows');
  });

  // `patchVersionOverride` simulates the stable, fillIfNull-frozen GLOBAL
  // `patches.version` — the fallback target used only when this device has no
  // `device_patches` row yet. `existingAvailableVersion` simulates THIS
  // device's own `device_patches.available_version`, which takes precedence
  // (see the comment above `installedMeetsTarget` in patches.ts): `patches` is
  // deduped on (source, externalId) with no tenant column, so a DIFFERENT
  // device/org that reported the same package first can freeze
  // `patches.version` at a value that has nothing to do with what THIS device
  // is waiting on. Without decoupling the two, the mock could only ever echo
  // back the current call's own insert values, which can never exercise the
  // version-aware flip/no-flip branches — let alone the per-device-precedence
  // branch.
  function mockTxCapturingDevicePatchUpserts(
    patchVersionOverride?: string | null,
    existingAvailableVersion: string | null = null,
  ) {
    const devicePatchUpserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(
              existingAvailableVersion === null ? [] : [{ availableVersion: existingAvailableVersion }],
            ),
          })),
        })),
      })),
      insert: vi.fn((table) => ({
        values: vi.fn((values) => ({
          onConflictDoUpdate: vi.fn(({ set }) => {
            if (table === patches) {
              const row = {
                id: PATCH_ID,
                ...values,
                ...(patchVersionOverride !== undefined ? { version: patchVersionOverride } : {}),
              };
              return { returning: vi.fn().mockResolvedValue([row]) };
            }
            devicePatchUpserts.push({ values, set });
            return { returning: vi.fn().mockResolvedValue([]) };
          }),
        })),
      })),
    };
    return { tx, devicePatchUpserts };
  }

  async function submitInstalled(version = '2.51.0.2') {
    return mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/installed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installed: [
          {
            name: 'Git',
            source: 'third_party',
            externalId: 'Git.Git',
            packageId: 'Git.Git',
            version,
          },
        ],
      }),
    });
  }

  it('conflict update keeps a pending row pending when the reported version is older than this device\'s own target (#2736)', async () => {
    // winget reports a pending upgrade (this device's real target, 2.52.0.0,
    // recorded on device_patches.available_version by the earlier pending
    // upsert) and the installed package under the same (source, externalId):
    // `winget list` includes every package that `winget upgrade` just
    // reported. Here the currently-installed version (2.51.0.2) has NOT yet
    // reached the target, so the installed upsert must not downgrade the
    // pending row written earlier in the same scan cycle.
    const { tx, devicePatchUpserts } = mockTxCapturingDevicePatchUpserts(undefined, '2.52.0.0');
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await submitInstalled('2.51.0.2');

    expect(res.status).toBe(200);
    expect(devicePatchUpserts).toHaveLength(1);

    const { values, set } = devicePatchUpserts[0]!;
    // New rows (no conflict) are plainly installed.
    expect(values.status).toBe('installed');
    // The conflict update must be status-preserving for pending rows: a CASE
    // expression referencing the existing row's status, not the bare literal.
    expect(set.status).not.toBe('installed');
    const statusSql = JSON.stringify(set.status);
    expect(statusSql).toContain('pending');
    expect(statusSql).toContain('installed');
    expect((set.status as { values: unknown[] }).values).toContain(tables.devicePatches.status);
    // Pin the CASE branch direction (preserve when pending, ELSE installed).
    // These assertions inspect the mocked sql tag's {strings, values}
    // bookkeeping, not drizzle's real SQL object — real execution against the
    // device_patch_status enum is covered by patches.integration.test.ts.
    const statusText = (set.status as { strings: string[] }).strings.join('<col>');
    expect(statusText).toBe("CASE WHEN <col> = 'pending' THEN <col> ELSE 'installed' END");
    // installedAt is likewise preserved for pending rows.
    expect((set.installedAt as { values: unknown[] }).values).toContain(tables.devicePatches.installedAt);
    // installedVersion still updates — it reports the currently-installed
    // version whether or not an upgrade is pending.
    expect(set.installedVersion).toBe('2.51.0.2');
  });

  it('flips a stranded pending row to installed once the reported version meets this device\'s own target, even without a sweep (#2736)', async () => {
    // The source's pending Scan() chronically errors (e.g. winget upgrade
    // flaking), so `markPendingDevicePatchesMissing` never sweeps this source
    // and the row never gets a chance to transition through 'missing'. But
    // `winget list` (installed inventory) keeps succeeding and now reports a
    // version that meets or exceeds this device's own recorded target
    // (device_patches.available_version) — proof the upgrade actually landed,
    // so the row must not stay pending forever just because the sweep never ran.
    const { tx, devicePatchUpserts } = mockTxCapturingDevicePatchUpserts(undefined, '2.51.0.2');
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await submitInstalled('2.51.0.2');

    expect(res.status).toBe(200);
    expect(devicePatchUpserts).toHaveLength(1);

    const { set } = devicePatchUpserts[0]!;
    // The version-aware flip bypasses the pending-preserving CASE entirely:
    // it writes the plain 'installed' literal, not a conditional expression.
    expect(set.status).toBe('installed');
    // ...and installedAt takes the plain installedAtParam value (NULL::timestamp
    // here, since the payload has no installedAt), not the CASE that would
    // otherwise reference the stored column.
    expect(set.installedAt).toEqual({ op: 'sql', strings: ['NULL::timestamp'], values: [] });
    expect(set.installedVersion).toBe('2.51.0.2');
  });

  it('uses this device\'s own available_version, not a stale global patches.version, so a differently-stale catalog row cannot prematurely flip a still-pending row (#2736)', async () => {
    // `patches` is a GLOBAL row deduped on (source, externalId) with no tenant
    // column: some OTHER device (any org) reported this same package earlier
    // and froze patches.version at 2.40.0.0 via fillIfNull — long stale
    // relative to what THIS device is actually waiting on (2.52.0.0, its own
    // available_version). The reported install (2.51.0.2) clears the stale
    // global figure but NOT this device's real target, so it must stay pending.
    // Comparing against the global column directly would prematurely flip it —
    // reintroducing the #2725 downgrade bug this whole guard exists to prevent.
    const { tx, devicePatchUpserts } = mockTxCapturingDevicePatchUpserts('2.40.0.0', '2.52.0.0');
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await submitInstalled('2.51.0.2');

    expect(res.status).toBe(200);
    const { set } = devicePatchUpserts[0]!;
    expect(set.status).not.toBe('installed');
    expect((set.status as { values: unknown[] }).values).toContain(tables.devicePatches.status);
  });

  it('falls back to the global patches.version when this device has no device_patches row yet', async () => {
    // No prior pending upsert ever ran for this device+package, so there is no
    // device_patches row to read an available_version from. Falling back to
    // the global patches.version (the same COALESCE precedence
    // patchApprovalEvaluator.ts already uses for pin targets) is the only
    // target available, and the reported version meets it.
    const { tx, devicePatchUpserts } = mockTxCapturingDevicePatchUpserts('2.51.0.2', null);
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await submitInstalled('2.51.0.2');

    expect(res.status).toBe(200);
    const { set } = devicePatchUpserts[0]!;
    expect(set.status).toBe('installed');
  });

  it('does not force a flip when the installed submit omits version', async () => {
    // `version` is optional on the installed payload schema and normalizes to
    // null (trimToNull/nullIfTooLong) when omitted — a real, reachable state,
    // not just a defensive branch. With nothing to compare, fall back to the
    // pending-preserving CASE rather than treating "no data" as "meets target".
    const { tx, devicePatchUpserts } = mockTxCapturingDevicePatchUpserts(undefined, '2.52.0.0');
    vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as unknown as Parameters<typeof fn>[0]));

    const res = await mountAgentPatchRoutes().request(`/agents/${AGENT_ID}/patches/installed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installed: [
          { name: 'Git', source: 'third_party', externalId: 'Git.Git', packageId: 'Git.Git' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const { set } = devicePatchUpserts[0]!;
    expect(set.status).not.toBe('installed');
    expect((set.status as { values: unknown[] }).values).toContain(tables.devicePatches.status);
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
