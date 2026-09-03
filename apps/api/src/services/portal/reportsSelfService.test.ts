import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  inserted: vi.fn(),
  selected: vi.fn(),
  where: undefined as SQL | undefined,
  conflict: vi.fn(),
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  updated: vi.fn(),
  generateReport: vi.fn(),
  previousBaselineFor: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values) => {
        state.inserted(values);
        return {
          onConflictDoNothing: vi.fn((config) => {
            state.conflict(config);
            return Promise.resolve();
          }),
          returning: state.insertReturning,
        };
      }),
    })),
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn((where: SQL) => {
        state.where = where;
        return chain;
      });
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.offset = vi.fn(() => chain);
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => state.selected().then(resolve, reject);
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values) => {
        state.updated(values);
        return {
          where: vi.fn(() => ({ returning: state.updateReturning })),
        };
      }),
    })),
  },
}));

vi.mock('../reportGenerationService', () => ({
  generateReport: state.generateReport,
  previousBaselineFor: state.previousBaselineFor,
}));

vi.mock('../../routes/portal/helpers', () => ({
  checkRateLimit: state.checkRateLimit,
}));

vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));

vi.mock('../reportBranding', () => ({
  getReportBranding: vi.fn(),
}));

vi.mock('@breeze/shared/reportPdf', () => ({
  buildReportPdf: vi.fn(),
}));

vi.mock('@breeze/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@breeze/shared')>(),
  rowsToCsv: vi.fn(),
}));

import {
  generatePortalReport,
  portalDefinitionPredicate,
  portalReportDefinitionsInsertQuery,
  portalRunPredicate,
  provisionPortalReportDefinitions,
} from './reportsSelfService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PORTAL_USER_ID = '44444444-4444-4444-8444-444444444444';

describe('provisionPortalReportDefinitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.where = undefined;
    state.selected.mockResolvedValue([
      { type: 'executive_summary' },
      { type: 'security_compliance_posture' },
    ]);
    state.insertReturning.mockResolvedValue([]);
    state.updateReturning.mockResolvedValue([]);
    state.generateReport.mockReset();
    state.previousBaselineFor.mockReset();
    state.previousBaselineFor.mockResolvedValue(undefined);
    state.checkRateLimit.mockReset();
    state.checkRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('inserts the two fixed customer-safe definitions idempotently', async () => {
    await provisionPortalReportDefinitions({
      orgId: ORG_ID,
      createdBy: USER_ID,
    });

    expect(state.inserted).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Customer portal — Security & compliance posture',
        type: 'security_compliance_posture',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
    ]);
    expect(state.conflict).toHaveBeenCalledOnce();
  });

  it('compiles the partial-index conflict arbiter with a literal true predicate', () => {
    const compileDb = drizzle.mock();
    const query = portalReportDefinitionsInsertQuery(
      compileDb as unknown as Parameters<typeof portalReportDefinitionsInsertQuery>[0],
      { orgId: ORG_ID, createdBy: USER_ID },
    ).toSQL();

    expect(query.sql).toMatch(/on conflict \("org_id","type"\) where/);
    expect(query.sql).toMatch(
      /on conflict \("org_id","type"\) where portal_self_service = true do nothing/,
    );
    expect(query.sql).not.toMatch(
      /on conflict \("org_id","type"\) where[^$]*\$\d+[^]*do nothing/,
    );
  });

  it('re-selects definitions through an organization-scoped predicate', async () => {
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."org_id" = $1');
    expect(query.sql).toContain('"reports"."portal_self_service" = $2');
    expect(query.params).toEqual([ORG_ID, true]);
  });

  it('fails when either canonical definition is still absent after insertion', async () => {
    state.selected.mockResolvedValue([{ type: 'executive_summary' }]);

    await expect(provisionPortalReportDefinitions({
      orgId: ORG_ID,
      createdBy: USER_ID,
    })).rejects.toThrow(
      'Failed to provision portal report definition security_compliance_posture',
    );
  });
});

describe('portal report SQL scope', () => {
  it('pins canonical definitions to the session org and portal flag', () => {
    const query = new PgDialect().sqlToQuery(
      portalDefinitionPredicate(ORG_ID, 'executive_summary'),
    );

    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toContain(ORG_ID);
    expect(query.params).toContain(true);
  });

  it('pins run rendering to run id, org id, and portal flag', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunPredicate(RUN_ID, ORG_ID),
    );

    expect(query.sql).toContain('"report_runs"."id" = $');
    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toEqual(expect.arrayContaining([
      RUN_ID,
      ORG_ID,
      true,
    ]));
  });
});

describe('generatePortalReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.selected.mockResolvedValueOnce([{
      id: 'report-1',
      orgId: ORG_ID,
      type: 'executive_summary',
      name: 'Customer portal — Executive summary',
      config: {},
    }]);
    state.checkRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    state.previousBaselineFor.mockResolvedValue(undefined);
  });

  it('stores portal-user provenance and waits for generation', async () => {
    state.insertReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'running',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: null,
      rowCount: null,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);
    state.generateReport.mockResolvedValue({
      rows: [{ name: 'Device 1' }],
      rowCount: 1,
      generatedAt: '2026-09-02T12:00:00.000Z',
    });
    state.updateReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'completed',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
      rowCount: 1,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);

    const result = await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });

    expect(state.inserted).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByKind: 'portal_user',
        requestedByUserId: null,
        requestedByPortalUserId: PORTAL_USER_ID,
        executionScopePrincipalKind: 'portal_user',
        executionScopeUserId: null,
      }),
    );
    expect(state.generateReport).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });
});
