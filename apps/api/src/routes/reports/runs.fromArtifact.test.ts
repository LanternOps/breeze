import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Execution plane W05 (#5716, spec §6.3) — POST
 * /reports/runs/:id/attachments/from-artifact links an AI run artifact to a
 * report run by reference.
 *
 * Modelled on runs.audit.test.ts's harness: the site-scope authority layer is
 * stubbed permissive (its own coverage is data.sitescope.test.ts), so what this
 * suite proves is the route's own contract — the guard is consulted for the
 * `write` action, the handle is resolved against the RUN's org, and nothing is
 * written when either refuses.
 */
const {
  getReportRunMock,
  resolveArtifactMock,
  writeRouteAuditMock,
  updateSets,
  updateWheres,
} = vi.hoisted(() => ({
  getReportRunMock: vi.fn(),
  resolveArtifactMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  updateSets: [] as unknown[],
  updateWheres: [] as unknown[],
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'tech@example.com' },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.limit = vi.fn(() => Promise.resolve([]));
      return chain;
    }),
    insert: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updateSets.push(values);
        return {
          where: vi.fn((predicate: unknown) => {
            updateWheres.push(predicate);
            return Promise.resolve();
          }),
        };
      }),
    })),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  reports: { id: 'reports.id', orgId: 'reports.orgId' },
  reportRuns: { id: 'reportRuns.id', reportId: 'reportRuns.reportId', artifactId: 'reportRuns.artifactId' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
  },
}));

vi.mock('../../services/reportGenerationService', () => ({
  generateReport: vi.fn(),
  previousBaselineFor: vi.fn(),
  assertReportExecutionPreflight: vi.fn(),
  UnexecutableReportScopeError: class extends Error {},
  StoredArtifactOnlyReportError: class extends Error {},
}));

vi.mock('../../services/siteScope', () => ({
  decodeSiteScope: vi.fn(() => ({ kind: 'unrestricted' })),
  intersectSiteScopes: vi.fn((a: unknown) => a),
  isSiteScopeSubset: vi.fn(() => true),
  persistedSiteScopeValues: vi.fn(() => ({})),
  reportRunMultiOrgScopeSqlPredicate: vi.fn(() => ({})),
  reportRunScopeSqlPredicate: vi.fn(() => ({})),
  resolveRequestReportAuthority: vi.fn(),
  resolveRequestReportAuthorityMap: vi.fn(),
  siteScopeFingerprint: vi.fn(() => 'fp'),
  unrestrictedReportRunScopeSqlPredicate: vi.fn(() => ({})),
}));

vi.mock('./helpers', () => ({
  getReportRunWithOrgCheck: getReportRunMock,
  getReportWithOrgCheck: vi.fn(),
  ensureOrgAccess: vi.fn(),
  getPagination: vi.fn(),
  isPortalSelfServiceLocked: vi.fn(() => false),
  isSystemManagedReportDefinition: vi.fn(() => false),
  PORTAL_SELF_SERVICE_REPORT: 'portal_self_service',
}));

vi.mock('@breeze/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared')>()),
  rowsToCsv: vi.fn(),
  rowsToTsv: vi.fn(),
}));

vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/artifacts/artifactService', () => ({
  resolveArtifact: resolveArtifactMock,
  openArtifactStream: vi.fn(),
}));

import { runsRoutes } from './runs';

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ART = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AI_RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function app() {
  const instance = new Hono();
  instance.route('/reports', runsRoutes);
  return instance;
}

function attach(handle: string = ART, runId = RUN_ID) {
  return app().request(`/reports/runs/${runId}/attachments/from-artifact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSets.length = 0;
  updateWheres.length = 0;
  getReportRunMock.mockResolvedValue({
    metadata: { id: RUN_ID, reportId: '44444444-4444-4444-8444-444444444444', orgId: ORG_ID },
    // #3198 W01: the guard now also returns the run's owner axis.
    owner: { orgId: ORG_ID },
    authority: { scope: { kind: 'unrestricted' } },
  });
  resolveArtifactMock.mockResolvedValue({
    id: ART, orgId: ORG_ID, runId: AI_RUN, name: 'findings.csv',
    contentType: 'text/csv', bytes: 40_112, sha256: 'f'.repeat(64),
  });
});

describe('POST /reports/runs/:id/attachments/from-artifact (spec §6.3)', () => {
  it('links the artifact to the run and audits it', async () => {
    const res = await attach();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { runId: RUN_ID, artifactId: ART } });
    expect(updateSets).toEqual([{ artifactId: ART }]);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'report_run.artifact.attach',
        resourceType: 'report_run',
        resourceId: RUN_ID,
        details: { artifactId: ART, runId: AI_RUN, byteSize: 40_112 },
      }),
    );
  });

  it('resolves the handle against the RUN org, never the caller org', async () => {
    await attach();
    expect(resolveArtifactMock).toHaveBeenCalledWith(ART, { orgId: ORG_ID });
  });

  it('asks the shared guard for the WRITE action — attaching changes what the report shows', async () => {
    // The org axis AND the run's persisted site scope both live in that helper.
    // An ad-hoc join here would have reproduced the first and dropped the second.
    await attach();
    expect(getReportRunMock).toHaveBeenCalledWith(RUN_ID, expect.anything(), 'write');
  });

  it('404s a run the caller cannot reach, without touching the artifact service', async () => {
    getReportRunMock.mockResolvedValue(null);
    const res = await attach();
    expect(res.status).toBe(404);
    expect(resolveArtifactMock).not.toHaveBeenCalled();
    expect(updateSets).toHaveLength(0);
  });

  it('404s a handle that does not resolve in the run org, and writes nothing', async () => {
    resolveArtifactMock.mockResolvedValue(null);
    const res = await attach();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ARTIFACT_NOT_FOUND');
    expect(updateSets).toHaveLength(0);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid handle before any lookup', async () => {
    const res = await attach('not-a-uuid');
    expect(res.status).toBe(400);
    expect(getReportRunMock).not.toHaveBeenCalled();
    expect(resolveArtifactMock).not.toHaveBeenCalled();
  });
});
