import { beforeEach, describe, expect, it, vi } from 'vitest';

const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
  claimRows: [{ id: '33333333-3333-4333-8333-333333333333' }],
  statusRows: [{ status: 'installed', count: 2 }, { status: 'pending', count: 1 }],
  live: {} as any,
  inArrayCalls: [] as Array<{ left: unknown; right: unknown }>,
  updateSets: [] as Array<Record<string, unknown>>,
  redisAvailable: false,
  queueAdds: [] as Array<{ name: string; data: unknown }>,
  queueAddError: null as Error | null,
  updateScopes: [] as Array<string | undefined>,
}));

/**
 * Faithful stand-in for the real DB-context helpers (#5566): the system helper
 * EARLY-RETURNS into whatever context is already open instead of opening a
 * fresh one, and `setImmediate` propagates the AsyncLocalStorage store out of
 * the request handler. Modelling both with a real AsyncLocalStorage is what
 * makes the difference between "joined the request transaction" and "opened a
 * genuine system context" observable in a unit test.
 */
const dbCtx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  return {
    storage: new AsyncLocalStorage<string>(),
    calls: [] as string[],
  };
});

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: class {
    async add(name: string, data: unknown) {
      if (state.queueAddError) throw state.queueAddError;
      state.queueAdds.push({ name, data });
      return { id: 'synthetic-job-id' };
    }
  },
  Worker: class {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  or: (...conditions: unknown[]) => ({ op: 'or', conditions }),
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  lt: (left: unknown, right: unknown) => ({ op: 'lt', left, right }),
  isNull: (value: unknown) => ({ op: 'isNull', value }),
  inArray: (left: unknown, right: unknown) => {
    state.inArrayCalls.push({ left, right });
    return { op: 'inArray', left, right };
  },
  sql: () => ({ op: 'sql' }),
}));

vi.mock('../db/schema', () => ({
  patchSourceEnum: { enumValues: ['apple', 'microsoft', 'third_party'] },
  patchSeverityEnum: { enumValues: ['critical', 'important', 'moderate', 'low'] },
  patchComplianceReports: {
    id: 'reports.id', orgId: 'reports.orgId', format: 'reports.format',
    source: 'reports.source', severity: 'reports.severity', status: 'reports.status',
    requestedBy: 'reports.requestedBy', executionScopeVersion: 'reports.scopeVersion',
    executionScopeKind: 'reports.scopeKind', executionScopeSiteIds: 'reports.siteIds',
    executionScopeUserId: 'reports.scopeUserId', executionScopeFingerprint: 'reports.fingerprint',
    executionScopeCapturedAt: 'reports.capturedAt', executionScopePrincipalKind: 'reports.principalKind',
  },
  devicePatches: {
    orgId: 'devicePatches.orgId', deviceId: 'devicePatches.deviceId',
    patchId: 'devicePatches.patchId', status: 'devicePatches.status',
  },
  devices: {
    id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId',
    isEphemeral: 'devices.isEphemeral',
  },
  patches: { id: 'patches.id', source: 'patches.source', severity: 'patches.severity' },
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbCtx.calls.push('withSystemDbAccessContext');
    return dbCtx.storage.getStore() ? fn() : dbCtx.storage.run('system', fn);
  }),
  runOutsideDbContext: vi.fn(<T>(fn: () => T): T => {
    dbCtx.calls.push('runOutsideDbContext');
    return dbCtx.storage.exit(fn);
  }),
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => table === 'reports.id' ? undefined : undefined),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updateSets.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => state.claimRows),
          })),
        };
      }),
    })),
  },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(),
  isRedisAvailable: vi.fn(() => state.redisAvailable),
}));

vi.mock('../services/siteScope', () => ({
  decodeSiteScope: vi.fn((row: any, orgId: string) => {
    if (row.executionScopeFingerprint === 'malformed') throw new Error('malformed');
    if (row.executionScopeKind === 'legacy_unscoped') {
      return { version: 1, kind: 'legacy_unscoped', orgId };
    }
    return row.executionScopeKind === 'restricted'
      ? { version: 1, kind: 'restricted', orgId, siteIds: row.executionScopeSiteIds }
      : { version: 1, kind: 'unrestricted', orgId };
  }),
  resolveLiveReportAuthority: vi.fn(async () => state.live),
  intersectSiteScopes: vi.fn((stored: any, live: any) => {
    if (stored.orgId !== live.orgId || stored.kind === 'legacy_unscoped') return null;
    if (stored.kind === 'unrestricted') return live;
    if (live.kind === 'unrestricted') return stored;
    const siteIds = stored.siteIds.filter((id: string) => live.siteIds.includes(id));
    return siteIds.length ? { ...stored, siteIds } : null;
  }),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { db, withSystemDbAccessContext } from '../db';
import { writeFile } from 'node:fs/promises';
import {
  enqueuePatchComplianceReport,
  processPatchComplianceReportJob,
} from './patchComplianceReportWorker';

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    orgId: ORG_ID,
    format: 'csv',
    source: null,
    severity: null,
    status: 'pending',
    requestedBy: USER_ID,
    executionScopeVersion: 1,
    executionScopeKind: 'restricted',
    executionScopeSiteIds: [SITE_A],
    executionScopeUserId: USER_ID,
    executionScopeFingerprint: 'a'.repeat(64),
    executionScopeCapturedAt: new Date('2026-09-06T12:00:00Z'),
    executionScopePrincipalKind: 'user',
    ...overrides,
  };
}

function installSelects() {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([state.report]),
        }),
      }),
    } as never)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue(state.statusRows),
            }),
          }),
        }),
      }),
    } as never);
}

/** Drain microtask/immediate turns until the deferred inline work has settled. */
async function flushUntil(done: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('patch compliance report worker authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    state.report = report();
    state.claimRows = [{ id: REPORT_ID }];
    state.statusRows = [{ status: 'installed', count: 2 }, { status: 'pending', count: 1 }];
    state.live = {
      ok: true,
      authority: {
        scope: { version: 1, kind: 'restricted', orgId: ORG_ID, siteIds: [SITE_A, SITE_B] },
      },
    };
    state.inArrayCalls = [];
    state.updateSets = [];
    state.redisAvailable = false;
    state.queueAdds = [];
    state.queueAddError = null;
    state.updateScopes = [];
    dbCtx.calls.length = 0;
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updateSets.push(values);
        state.updateScopes.push(dbCtx.storage.getStore());
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => state.claimRows),
          })),
        };
      }),
    }) as never);
  });

  it('intersects stored and live site scope before the single set-based aggregate', async () => {
    installSelects();

    const result = await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: REPORT_ID,
    });

    expect(result?.rowCount).toBe(3);
    expect(state.inArrayCalls).toContainEqual({ left: 'devices.siteId', right: [SITE_A] });
    expect(writeFile).toHaveBeenCalledOnce();
    expect(state.updateSets.at(-1)).toEqual(expect.objectContaining({
      status: 'completed',
      rowCount: 3,
    }));
  });

  it('preserves unrestricted authority without adding a site predicate', async () => {
    state.report = report({
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
    });
    state.live.authority.scope = {
      version: 1,
      kind: 'unrestricted',
      orgId: ORG_ID,
    };
    installSelects();

    await expect(processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: REPORT_ID,
    })).resolves.toEqual(expect.objectContaining({ rowCount: 3 }));

    expect(state.inArrayCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ left: 'devices.siteId' }),
    ]));
  });

  it('fails closed without an aggregate or output for disjoint current scope', async () => {
    state.live.authority.scope.siteIds = [SITE_B];
    installSelects();

    await expect(processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: REPORT_ID,
    })).rejects.toThrow('no current site scope');

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(state.updateSets.at(-1)).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['legacy authority', { executionScopeKind: 'legacy_unscoped' }],
    ['malformed authority', { executionScopeFingerprint: 'malformed' }],
    ['principal mismatch', { executionScopeUserId: SITE_A }],
  ])('fails closed for %s before reading patch rows', async (_label, override) => {
    state.report = report(override);
    installSelects();

    await expect(processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: REPORT_ID,
    })).rejects.toThrow('invalid or legacy');

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not duplicate output when another worker already claimed the report', async () => {
    state.claimRows = [];
    installSelects();

    await expect(processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: REPORT_ID,
    })).resolves.toBeNull();

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('runs the Redis-down inline fallback in a fresh system context, not the request transaction', async () => {
    state.redisAvailable = false;
    installSelects();

    await expect(
      dbCtx.storage.run('request-org-scoped', () => enqueuePatchComplianceReport(REPORT_ID)),
    ).resolves.toEqual({ enqueued: false });

    await flushUntil(() => state.updateSets.some((v) => v.status === 'completed'));

    expect(dbCtx.calls).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext']);
    expect(state.updateScopes.length).toBeGreaterThan(0);
    expect(state.updateScopes).not.toContain('request-org-scoped');
    expect([...new Set(state.updateScopes)]).toEqual(['system']);
  });

  it('surfaces an inline fallback failure to the caller log instead of swallowing it', async () => {
    state.redisAvailable = false;
    state.report = report({ executionScopeFingerprint: 'malformed' });
    installSelects();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(enqueuePatchComplianceReport(REPORT_ID)).resolves.toEqual({ enqueued: false });
      await flushUntil(() => consoleError.mock.calls.length > 0);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(`Inline report processing failed for ${REPORT_ID}`),
        expect.any(Error),
      );
      expect(state.updateSets.at(-1)).toEqual(expect.objectContaining({ status: 'failed' }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('falls back inline in a fresh system context when the enqueue itself throws', async () => {
    state.redisAvailable = true;
    state.queueAddError = new Error('queue.add exploded');
    installSelects();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        dbCtx.storage.run('request-org-scoped', () => enqueuePatchComplianceReport(REPORT_ID)),
      ).resolves.toEqual({ enqueued: false });

      await flushUntil(() => state.updateSets.some((v) => v.status === 'completed'));

      expect(state.queueAdds).toEqual([]);
      expect(dbCtx.calls).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext']);
      expect(state.updateScopes.length).toBeGreaterThan(0);
      expect([...new Set(state.updateScopes)]).toEqual(['system']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('places only the report locator on Redis rather than serialized authority', async () => {
    state.redisAvailable = true;

    await expect(enqueuePatchComplianceReport(REPORT_ID)).resolves.toEqual({
      enqueued: true,
      jobId: 'synthetic-job-id',
    });

    expect(state.queueAdds).toEqual([{
      name: 'generate-compliance-report',
      data: { type: 'generate-compliance-report', reportId: REPORT_ID },
    }]);
  });
});
