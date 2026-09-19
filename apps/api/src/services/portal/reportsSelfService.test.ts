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
  getReportBranding: vi.fn(),
  buildReportPdf: vi.fn(),
  rowsToCsv: vi.fn(),
  execute: vi.fn(),
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
    execute: state.execute,
  },
}));

vi.mock('../reportGenerationService', () => ({
  generateReport: state.generateReport,
  previousBaselineFor: state.previousBaselineFor,
}));

vi.mock('./rateLimit', () => ({
  checkRateLimit: state.checkRateLimit,
  PORTAL_USE_REDIS: false,
}));

vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));

vi.mock('../reportBranding', () => ({
  getReportBranding: state.getReportBranding,
}));

vi.mock('@breeze/shared/reportPdf', () => ({
  buildReportPdf: state.buildReportPdf,
}));

vi.mock('@breeze/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@breeze/shared')>(),
  rowsToCsv: state.rowsToCsv,
}));

import {
  PORTAL_REPORT_TYPES,
  generatePortalReport,
  latestPortalHardwareLifecycleRun,
  listPortalRuns,
  portalDefinitionPredicate,
  portalReportDefinitionsInsertQuery,
  portalRunListPredicate,
  portalRunPredicate,
  PortalReportNoTabularDataError,
  PortalReportNotFoundError,
  PortalReportRateLimitError,
  provisionPortalReportDefinitions,
  renderRunCsv,
  renderRunPdf,
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
      { type: 'hardware_lifecycle' },
      { type: 'threat_detection_review' },
      { type: 'endpoint_management_review' },
      { type: 'vulnerability_management' },
      { type: 'identity_access_review' },
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
    state.getReportBranding.mockReset();
    state.buildReportPdf.mockReset();
    state.rowsToCsv.mockReset();
    state.execute.mockReset();
    state.execute.mockResolvedValue([{ prior_ms: 0 }]);
  });

  it('provisions an endpoint management definition for an org enabling portal reports', async () => {
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });
    const inserted = state.inserted.mock.calls[0]?.[0] as Array<{ type: string }>;
    expect(inserted.map((r) => r.type)).toContain('endpoint_management_review');
  });

  it('keeps the provisioned config byte-identical to the managed-evidence registry default', async () => {
    const { MANAGED_EVIDENCE_REGISTRY } = await import('../managedEvidenceRegistry');
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });
    const inserted = state.inserted.mock.calls[0]?.[0] as Array<{ type: string; config: unknown }>;
    const row = inserted.find((r) => r.type === 'endpoint_management_review');
    expect(row?.config).toEqual(MANAGED_EVIDENCE_REGISTRY.endpoint_management_review.defaultConfig);
  });

  it('inserts the fixed customer-safe definitions plus the managed-evidence ones idempotently', async () => {
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
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Customer portal — Hardware Lifecycle',
        type: 'hardware_lifecycle',
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
        name: 'Service evidence — Threat detection review',
        type: 'threat_detection_review',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
      // #5784 W03 — managed evidence: provisioned as a definition so a
      // delivered run is listable, but absent from PORTAL_REPORT_TYPES so the
      // portal offers no generate button.
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Service evidence — Endpoint management review',
        type: 'endpoint_management_review',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
      // #5784 W04 — provisioned, but never portal-generatable.
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Service evidence — Vulnerability management',
        type: 'vulnerability_management',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
      // #5784 W06 — managed evidence, provisioned but never self-service.
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Service evidence — Identity and access review',
        type: 'identity_access_review',
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

  // #5784 W06.
  it('provisions an identity access definition for an org enabling portal reports', async () => {
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });
    const values = vi.mocked(state.inserted).mock.calls[0]?.[0] as Array<{ type: string; portalSelfService: boolean; name: string; config: Record<string, unknown> }>;
    const row = values.find((v) => v.type === 'identity_access_review');
    expect(row).toBeTruthy();
    expect(row?.portalSelfService).toBe(true);
    expect(row?.name).toBe('Service evidence — Identity and access review');
    // No `sites` key: the report is org-wide by construction (OD-8 = A).
    expect(row?.config).toEqual({ dormantDays: 45, homeCountries: [], adminDetail: true });
  });

  it('provisions a threat detection definition for an org enabling portal reports', async () => {
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });
    const values = vi.mocked(state.inserted).mock.calls[0]?.[0] as Array<{ type: string; portalSelfService: boolean; name: string }>;
    const row = values.find((v) => v.type === 'threat_detection_review');
    expect(row).toBeTruthy();
    expect(row?.portalSelfService).toBe(true);
    expect(row?.name).toBe('Service evidence — Threat detection review');
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
      portalRunPredicate(RUN_ID, ORG_ID, true),
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

  it('pins run listing to the session org and portal flag', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunListPredicate(ORG_ID, true),
    );

    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toEqual(expect.arrayContaining([ORG_ID, true]));
  });

  it('gates run listing on delivery (#5784 OD-12): unreferenced runs stay visible, referenced runs need a delivered occurrence', () => {
    const query = new PgDialect().sqlToQuery(portalRunListPredicate(ORG_ID, true));
    expect(query.sql).toMatch(/not exists \(\s*select 1 from service_deliverable_evidence/i);
    expect(query.sql).toMatch(/join service_deliverable_occurrences/i);
    expect(query.sql).toMatch(/status = 'delivered'/i);
  });

  it('gates run rendering on the same delivery rule (#5784 OD-12)', () => {
    const query = new PgDialect().sqlToQuery(portalRunPredicate(RUN_ID, ORG_ID, true));
    expect(query.sql).toMatch(/not exists \(\s*select 1 from service_deliverable_evidence/i);
    expect(query.sql).toMatch(/status = 'delivered'/i);
  });

  it('excludes hardware_lifecycle from run listing when the flag is off', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunListPredicate(ORG_ID, false),
    );

    expect(query.sql).toContain('"reports"."type" <> $');
    expect(query.params).toContain('hardware_lifecycle');
  });

  it('adds no type exclusion to run listing when the flag is on', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunListPredicate(ORG_ID, true),
    );

    expect(query.sql).not.toContain('<>');
    expect(query.params).not.toContain('hardware_lifecycle');
  });

  it('excludes hardware_lifecycle from run rendering when the flag is off', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunPredicate(RUN_ID, ORG_ID, false),
    );

    expect(query.sql).toContain('"reports"."type" <> $');
    expect(query.params).toContain('hardware_lifecycle');
  });

  it('adds no type exclusion to run rendering when the flag is on', () => {
    const query = new PgDialect().sqlToQuery(
      portalRunPredicate(RUN_ID, ORG_ID, true),
    );

    expect(query.sql).not.toContain('<>');
    expect(query.params).not.toContain('hardware_lifecycle');
  });
});

describe('threat_detection_review portal provisioning (#5784 W02)', () => {
  it('keeps threat_detection_review OUT of the portal generate allowlist (OD-10 = A)', () => {
    expect(PORTAL_REPORT_TYPES as readonly string[]).not.toContain('threat_detection_review');
  });
});

describe('identity_access_review portal provisioning (#5784 W06)', () => {
  it('keeps identity_access_review OUT of the portal generate allowlist (OD-10 = A)', () => {
    // A customer generating an identity report on demand would be a new compute
    // surface AND a new PII surface (user principal names, IP addresses).
    expect(PORTAL_REPORT_TYPES as readonly string[]).not.toContain('identity_access_review');
  });
});

describe('PORTAL_REPORT_TYPES', () => {
  it('carries hardware_lifecycle as the third self-service member', () => {
    expect(PORTAL_REPORT_TYPES).toEqual([
      'security_compliance_posture',
      'executive_summary',
      'hardware_lifecycle',
    ]);
  });

  // OD-10 = A (#5784 W03): a managed evidence type is provisioned as a portal
  // DEFINITION so delivered runs can be listed and downloaded, but the portal
  // user may never generate one on demand — the artifact is the MSP's evidence,
  // produced by the sweep on the occurrence's schedule.
  it('keeps endpoint_management_review OUT of the portal generate allowlist', () => {
    expect(PORTAL_REPORT_TYPES).not.toContain('endpoint_management_review');
  });

  // #5784 W04, OD-10 = A. Being provisioned as a definition is NOT being
  // self-servable: a portal user must never be able to run this on demand.
  it('keeps vulnerability_management OUT of the portal generate allowlist', () => {
    expect(PORTAL_REPORT_TYPES).not.toContain('vulnerability_management');
  });
});

describe('hardware_lifecycle MSP config inheritance (decision B2)', () => {
  const PORTAL_DEFINITION_ROW = {
    id: 'report-hw',
    orgId: ORG_ID,
    type: 'hardware_lifecycle',
    name: 'Customer portal \u2014 Hardware Lifecycle',
    config: {
      sites: [],
      replaceAgeYears: 4,
      serverReplaceAgeYears: 5,
      includeManualAssets: true,
      includeOtherEquipment: true,
    },
  };

  const RUNNING_RUN = {
    id: RUN_ID,
    reportId: 'report-hw',
    status: 'running',
    startedAt: new Date('2026-09-02T11:59:00.000Z'),
    completedAt: null,
    rowCount: null,
    createdAt: new Date('2026-09-02T11:59:00.000Z'),
  };

  const COMPLETED_RUN = {
    ...RUNNING_RUN,
    status: 'completed',
    completedAt: new Date('2026-09-02T12:00:00.000Z'),
    rowCount: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.where = undefined;
    state.checkRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    state.previousBaselineFor.mockResolvedValue(undefined);
    state.insertReturning.mockReset().mockResolvedValue([RUNNING_RUN]);
    state.updateReturning.mockReset().mockResolvedValue([COMPLETED_RUN]);
    state.updated.mockReset();
    state.execute.mockReset().mockResolvedValue([{ prior_ms: 0 }]);
    state.generateReport.mockReset().mockResolvedValue({ rows: [], rowCount: 3 });
  });

  it('inherits the four MSP thresholds and never the MSP site scope', async () => {
    state.selected
      .mockReset()
      // 1: the portal definition
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      // 2: the org's enable_lifecycle flag
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      // 3: the org's most recent MSP-side hardware_lifecycle definition
      .mockResolvedValueOnce([{
        config: {
          sites: ['99999999-9999-4999-8999-999999999999'],
          replaceAgeYears: 6,
          serverReplaceAgeYears: 8,
          includeManualAssets: false,
          includeOtherEquipment: false,
        },
      }]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    });

    expect(state.generateReport).toHaveBeenCalledWith(
      'hardware_lifecycle',
      ORG_ID,
      {
        sites: [],
        replaceAgeYears: 6,
        serverReplaceAgeYears: 8,
        includeManualAssets: false,
        includeOtherEquipment: false,
      },
      expect.anything(),
    );
  });

  it('falls back to the portal defaults when the org has no MSP definition', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    });

    expect(state.generateReport).toHaveBeenCalledWith(
      'hardware_lifecycle',
      ORG_ID,
      {
        sites: [],
        replaceAgeYears: 4,
        serverReplaceAgeYears: 5,
        includeManualAssets: true,
        includeOtherEquipment: true,
      },
      expect.anything(),
    );
  });

  it('scopes the MSP lookup to the org, the type, and the non-portal flag', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    });

    // state.where holds the LAST select's predicate, which is the MSP lookup.
    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."type" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toEqual(expect.arrayContaining([
      ORG_ID,
      'hardware_lifecycle',
      false,
    ]));
  });

  it('refuses a hardware_lifecycle run when the org flag is off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      .mockResolvedValueOnce([{ enableLifecycle: false }]);

    await expect(generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    })).rejects.toBeInstanceOf(PortalReportNotFoundError);

    expect(state.generateReport).not.toHaveBeenCalled();
    expect(state.inserted).not.toHaveBeenCalled();
  });

  it('refuses a hardware_lifecycle run when the org has no branding row', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      .mockResolvedValueOnce([]);

    await expect(generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    })).rejects.toBeInstanceOf(PortalReportNotFoundError);

    expect(state.generateReport).not.toHaveBeenCalled();
  });

  it('leaves a partial MSP config to fall back per key', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([PORTAL_DEFINITION_ROW])
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{ config: { replaceAgeYears: 7 } }]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'hardware_lifecycle',
    });

    expect(state.generateReport).toHaveBeenCalledWith(
      'hardware_lifecycle',
      ORG_ID,
      {
        sites: [],
        replaceAgeYears: 7,
        serverReplaceAgeYears: 5,
        includeManualAssets: true,
        includeOtherEquipment: true,
      },
      expect.anything(),
    );
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
    state.insertReturning.mockReset();
    state.updateReturning.mockReset();
    state.updated.mockReset();
    state.execute.mockResolvedValue([{ prior_ms: 0 }]);
  });

  it('tightens the ambient transaction statement timeout before report work', async () => {
    state.insertReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'running',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: null,
      rowCount: null,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);
    state.generateReport.mockResolvedValue({ rows: [], rowCount: 0 });
    state.updateReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'completed',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
      rowCount: 0,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });

    expect(state.execute).toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(state.execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/set_config\(\s*'statement_timeout'/);
    expect(query.sql).toContain('pg_settings');
    expect(query.params).toContain(60000);
    expect(state.execute.mock.invocationCallOrder[0])
      .toBeLessThan(state.checkRateLimit.mock.invocationCallOrder[0]!);
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

  it('keeps rowCount null when the report has no row concept', async () => {
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
      summary: { deviceCount: 12 },
      generatedAt: '2026-09-02T12:00:00.000Z',
    });
    state.updateReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'completed',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
      rowCount: null,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);

    await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });

    expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      rowCount: null,
    }));
    // The MSP Reports list reads reports.last_generated_at (#4562 QA walk).
    expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({
      lastGeneratedAt: expect.any(Date),
    }));
  });

  it('rejects limiter denial with the retry interval', async () => {
    state.checkRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 47,
    });

    const error = await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(PortalReportRateLimitError);
    expect(error.retryAfterSeconds).toBe(47);
    expect(state.generateReport).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent run for the same org and type', async () => {
    let resolveGeneration!: (value: { rows: unknown[]; rowCount: number }) => void;
    const generation = new Promise<{ rows: unknown[]; rowCount: number }>((resolve) => {
      resolveGeneration = resolve;
    });
    state.selected.mockReset().mockResolvedValue([{
      id: 'report-1',
      orgId: ORG_ID,
      type: 'executive_summary',
      name: 'Customer portal — Executive summary',
      config: {},
    }]);
    state.insertReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'running',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: null,
      rowCount: null,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);
    state.generateReport.mockReturnValue(generation);
    state.updateReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'completed',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
      rowCount: 1,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);

    const first = generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });
    await vi.waitFor(() => expect(state.generateReport).toHaveBeenCalledOnce());

    await expect(generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    })).rejects.toBeInstanceOf(PortalReportRateLimitError);

    resolveGeneration({ rows: [{ id: 1 }], rowCount: 1 });
    await first;
  });

  it('releases the in-flight key after generation fails', async () => {
    state.selected.mockReset().mockResolvedValue([{
      id: 'report-1',
      orgId: ORG_ID,
      type: 'executive_summary',
      name: 'Customer portal — Executive summary',
      config: {},
    }]);
    state.insertReturning.mockResolvedValue([{
      id: RUN_ID,
      reportId: 'report-1',
      status: 'running',
      startedAt: new Date('2026-09-02T11:59:00.000Z'),
      completedAt: null,
      rowCount: null,
      createdAt: new Date('2026-09-02T11:59:00.000Z'),
    }]);
    state.generateReport
      .mockRejectedValueOnce(new Error('renderer exploded'))
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    state.updateReturning
      .mockResolvedValueOnce([{
        id: RUN_ID,
        reportId: 'report-1',
        status: 'failed',
        startedAt: new Date('2026-09-02T11:59:00.000Z'),
        completedAt: new Date('2026-09-02T12:00:00.000Z'),
        rowCount: null,
        createdAt: new Date('2026-09-02T11:59:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: RUN_ID,
        reportId: 'report-1',
        status: 'completed',
        startedAt: new Date('2026-09-02T11:59:00.000Z'),
        completedAt: new Date('2026-09-02T12:00:00.000Z'),
        rowCount: 1,
        createdAt: new Date('2026-09-02T11:59:00.000Z'),
      }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });
    const completed = await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });

    expect(failed.status).toBe('failed');
    expect(completed.status).toBe('completed');
    expect(errorSpy).toHaveBeenCalledWith(
      '[portal-reports] Report generation failed',
      expect.objectContaining({
        runId: RUN_ID,
        orgId: ORG_ID,
        type: 'executive_summary',
        error: 'renderer exploded',
      }),
    );
    errorSpy.mockRestore();
  });

  it('rejects a missing portal definition with the typed not-found error', async () => {
    state.selected.mockReset().mockResolvedValue([]);

    await expect(generatePortalReport({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    })).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });
});


describe('latestPortalHardwareLifecycleRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.where = undefined;
    state.getReportBranding.mockReset().mockResolvedValue({});
    state.execute.mockReset().mockResolvedValue([{ prior_ms: 0 }]);
  });

  it.each([
    [{ contactName: 'Sam Lee', contactEmail: 'support@example.test' }, { name: 'Sam Lee', email: 'support@example.test' }],
    [{ contactEmail: 'support@example.test' }, { name: null, email: 'support@example.test' }],
    [{ contactName: 'Sam Lee', contactEmail: null }, null],
    [{}, null],
  ])('returns the PDF branding contact for the session org: %j', async (branding, contact) => {
    state.getReportBranding.mockResolvedValue(branding);
    state.selected.mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');

    expect(dto).toHaveProperty('contact', contact);
    expect(state.getReportBranding).toHaveBeenCalledExactlyOnceWith(ORG_ID);
  });

  it('pins the lookup to the org, the type, the portal flag, and completion', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValue([{
        id: RUN_ID,
        result: { summary: { generatedAt: '1999-01-01T00:00:00.000Z' } },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."type" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.sql).toContain('"report_runs"."status" = $');
    expect(query.params).toEqual(expect.arrayContaining([
      ORG_ID,
      'hardware_lifecycle',
      true,
      'completed',
    ]));
    // OD-12 (#5784): the dedicated reader carries the same delivery gate as
    // portalRunPredicate, or an auto-evidence run leaks through "latest".
    expect(query.sql).toMatch(/not exists \(\s*select 1 from service_deliverable_evidence/i);
    expect(query.sql).toMatch(/status = 'delivered'/i);
  });

  it('formats generatedAt from the run completion time, not the stored summary', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValue([{
        id: RUN_ID,
        // A stale generatedAt inside the stored result must not win: the run
        // row is the authority for when the customer's plan was produced.
        result: { summary: { generatedAt: '1999-01-01T00:00:00.000Z' } },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');

    expect(dto.run.id).toBe(RUN_ID);
    expect(dto.run.generatedAt).not.toContain('1999');
    expect(dto.run.generatedAt).toContain('2026');
    expect(dto.summary).toEqual({ generatedAt: '1999-01-01T00:00:00.000Z' });
  });

  it('formats generatedAt in the caller timezone', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-03T02:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-03T02:00:00.000Z'),
      }]);

    const utc = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');
    const denver = await latestPortalHardwareLifecycleRun(
      ORG_ID,
      'America/Denver',
    );

    expect(denver.run.generatedAt).not.toBe(utc.run.generatedAt);
    expect(denver.run.generatedAt).toContain('Sep 2');
    expect(utc.run.generatedAt).toContain('Sep 3');
  });

  it('uses the typed not-found error when the org has no completed run', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValue([]);

    await expect(
      latestPortalHardwareLifecycleRun(ORG_ID, 'UTC'),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });

  it('returns a null summary rather than throwing when the result has none', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValue([{
        id: RUN_ID,
        result: null,
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');
    expect(dto.summary).toBeNull();
  });

  it('refuses to answer at all when the org flag is off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: false }])
      // Queued but must never be reached: the flag check comes first, so the
      // run row below is not what the rejection is coming from.
      .mockResolvedValue([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    await expect(
      latestPortalHardwareLifecycleRun(ORG_ID, 'UTC'),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
    expect(state.selected).toHaveBeenCalledOnce();
    expect(state.getReportBranding).not.toHaveBeenCalled();
  });

  it('refuses when the org has no portal_branding row at all', async () => {
    state.selected.mockReset().mockResolvedValue([]);

    await expect(
      latestPortalHardwareLifecycleRun(ORG_ID, 'UTC'),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });

  // The legacy DTO field controls device deep-links, so either Devices grant
  // must enable it even when self-service actions are disabled.
  it.each([[true, false], [false, true], [true, true]])(
    'enables device links with enableDevices=%s and enableSelfService=%s',
    async (enableDevices, enableSelfService) => {
      state.selected
        .mockReset()
        .mockResolvedValueOnce([{ enableLifecycle: true, enableDevices, enableSelfService }])
        .mockResolvedValue([{
          id: RUN_ID,
          result: { summary: {} },
          completedAt: new Date('2026-09-02T18:00:00.000Z'),
        }]);

      const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');
      expect(dto.enableSelfService).toBe(true);
    },
  );

  it('disables device links when both Devices grants are off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true, enableDevices: false, enableSelfService: false }])
      .mockResolvedValue([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');
    expect(dto.enableSelfService).toBe(false);
  });

  it('fails closed on enableSelfService when the branding row has no such column value', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValue([{
        id: RUN_ID,
        result: { summary: {} },
        completedAt: new Date('2026-09-02T18:00:00.000Z'),
      }]);

    const dto = await latestPortalHardwareLifecycleRun(ORG_ID, 'UTC');
    expect(dto.enableSelfService).toBe(false);
  });
});

describe('listPortalRuns', () => {
  it('returns completed portal runs with clamped pagination', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{
        id: RUN_ID,
        reportId: 'report-1',
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        status: 'completed',
        startedAt: new Date('2026-09-02T11:59:00.000Z'),
        completedAt: new Date('2026-09-02T12:00:00.000Z'),
        rowCount: null,
        createdAt: new Date('2026-09-02T11:59:00.000Z'),
      }]);

    const result = await listPortalRuns(
      ORG_ID,
      'America/Denver',
      { page: 0, limit: 500 },
    );

    expect(result.pagination).toEqual({ page: 1, limit: 100, total: 1 });
    expect(result.timezone).toBe('America/Denver');
    expect(result.data).toEqual([expect.objectContaining({
      id: RUN_ID,
      rowCount: null,
      status: 'completed',
    })]);
  });

  it('excludes hardware_lifecycle runs when the org flag is off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: false }])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await listPortalRuns(ORG_ID, 'UTC', { page: 1, limit: 25 });

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."type" <> $');
    expect(query.params).toContain('hardware_lifecycle');
  });

  it('keeps hardware_lifecycle runs listed when the org flag is on', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: true }])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await listPortalRuns(ORG_ID, 'UTC', { page: 1, limit: 25 });

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.params).not.toContain('hardware_lifecycle');
  });
});

describe('portal run rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.execute.mockReset();
    state.execute.mockResolvedValue([{ prior_ms: 0 }]);
    state.getReportBranding.mockResolvedValue({
      name: 'Partner',
      logoDataUrl: null,
      logoAspect: null,
    });
  });

  it('excludes a hardware_lifecycle run from PDF rendering when the flag is off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: false }])
      .mockResolvedValueOnce([]);

    await expect(renderRunPdf(
      RUN_ID,
      ORG_ID,
      'America/Denver',
    )).rejects.toBeInstanceOf(PortalReportNotFoundError);

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."type" <> $');
    expect(query.params).toContain('hardware_lifecycle');
  });

  it('excludes a hardware_lifecycle run from CSV rendering when the flag is off', async () => {
    state.selected
      .mockReset()
      .mockResolvedValueOnce([{ enableLifecycle: false }])
      .mockResolvedValueOnce([]);

    await expect(renderRunCsv(RUN_ID, ORG_ID)).rejects.toBeInstanceOf(
      PortalReportNotFoundError,
    );

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.params).toContain('hardware_lifecycle');
  });

  it('renders a stored run as PDF with the requested timezone', async () => {
    state.selected.mockResolvedValue([{
      id: RUN_ID,
      type: 'executive_summary',
      result: { summary: { deviceCount: 12 } },
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
    }]);
    state.buildReportPdf.mockReturnValue({
      output: vi.fn(() => Uint8Array.from([1, 2, 3]).buffer),
    });

    const pdf = await renderRunPdf(RUN_ID, ORG_ID, 'America/Denver');

    expect(pdf).toEqual(Buffer.from([1, 2, 3]));
    expect(state.buildReportPdf).toHaveBeenCalledWith([], expect.objectContaining({
      reportType: 'executive_summary',
      timezone: 'America/Denver',
    }));
    expect(state.execute).toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(state.execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/set_config\(\s*'statement_timeout'/);
    expect(query.sql).toContain('pg_settings');
    expect(query.params).toContain(60000);
    expect(state.execute.mock.invocationCallOrder[0])
      .toBeLessThan(state.buildReportPdf.mock.invocationCallOrder[0]!);
  });

  it('renders tabular stored results as CSV', async () => {
    const rows = [{ hostname: 'device-1' }];
    state.selected.mockResolvedValue([{
      id: RUN_ID,
      type: 'security_compliance_posture',
      result: { rows },
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
    }]);
    state.rowsToCsv.mockReturnValue('hostname\ndevice-1');

    await expect(renderRunCsv(RUN_ID, ORG_ID)).resolves.toBe(
      'hostname\ndevice-1',
    );
    expect(state.rowsToCsv).toHaveBeenCalledWith(rows);
  });

  it('uses a typed conflict error when a run has no tabular result', async () => {
    state.selected.mockResolvedValue([{
      id: RUN_ID,
      type: 'executive_summary',
      result: { summary: { deviceCount: 12 } },
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
    }]);

    await expect(renderRunCsv(RUN_ID, ORG_ID)).rejects.toBeInstanceOf(
      PortalReportNoTabularDataError,
    );
  });

  it('uses the typed not-found error for an inaccessible run', async () => {
    state.selected.mockResolvedValue([]);

    await expect(renderRunPdf(
      RUN_ID,
      ORG_ID,
      'America/Denver',
    )).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });
});
