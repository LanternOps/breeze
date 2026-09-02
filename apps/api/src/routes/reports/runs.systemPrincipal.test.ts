/**
 * P2-3 (#4190) — downloading a SYSTEM-authored report run.
 *
 * A weekly AI narrative run carries `execution_scope_principal_kind = 'system'`
 * and a NULL acting user. Unlike every other suite in this directory, the
 * site-scope service is NOT stubbed here: `decodeSiteScope`,
 * `isSiteScopeSubset`, `siteScopeFingerprint` and the SQL predicates all run
 * for real, and only `resolveRequestReportAuthority` (which would otherwise hit
 * Postgres) is replaced. That is deliberate — the bug this file guards is a
 * projection that omits `executionScopePrincipalKind`, which is invisible to a
 * stubbed decoder.
 *
 * The db stub answers each `select(projection)` by projecting the fixture row
 * through the REQUESTED keys, so a column missing from a route's projection is
 * genuinely missing from the row the decoder sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-07-25T12:34:56.000Z');

const state = vi.hoisted(() => ({
  authority: null as unknown,
  rows: [] as Array<Record<string, unknown>>,
  projections: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: USER_ID, email: 'reader@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => {
      state.projections.push(projection ?? {});
      const source = state.rows.shift() ?? {};
      // Project the fixture row through the requested keys ONLY: a column the
      // route forgot to select is absent from the decoded row, exactly as it
      // would be in Postgres.
      const row = projection
        ? Object.fromEntries(
            Object.keys(projection).map((key) => [key, source[key]]),
          )
        : source;
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.limit = vi.fn(() => Promise.resolve([row]));
      return chain;
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../services/reportGenerationService', () => ({
  generateReport: vi.fn(),
  previousBaselineFor: vi.fn(),
  assertReportExecutionPreflight: vi.fn(),
  UnexecutableReportScopeError: class extends Error {},
}));

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

// Real site-scope algebra; only the live-authority DB lookup is replaced.
vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => state.authority),
    resolveRequestReportAuthorityMap: vi.fn(async () => new Map()),
  };
});

import { runsRoutes } from './runs';
import { siteScopeFingerprint } from '../../services/siteScope';

function app(): Hono {
  const instance = new Hono();
  instance.route('/reports', runsRoutes);
  return instance;
}

function authority(kind: 'unrestricted' | 'restricted') {
  const scope =
    kind === 'unrestricted'
      ? { version: 1 as const, kind: 'unrestricted' as const, orgId: ORG_ID }
      : {
          version: 1 as const,
          kind: 'restricted' as const,
          orgId: ORG_ID,
          siteIds: [OTHER_SITE],
        };
  return {
    ok: true,
    authority: {
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

/** A run produced by the platform: unrestricted, no acting user. */
function systemRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    reportId: REPORT_ID,
    orgId: ORG_ID,
    status: 'completed',
    result: { rows: [{ headline: 'Fleet is healthy' }] },
    reportType: 'device_inventory',
    reportName: 'Weekly narrative',
    reportFormat: 'json',
    startedAt: CAPTURED_AT,
    completedAt: CAPTURED_AT,
    outputUrl: null,
    errorMessage: null,
    rowCount: 1,
    createdAt: CAPTURED_AT,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: null,
    executionScopeFingerprint: siteScopeFingerprint({
      version: 1,
      kind: 'unrestricted',
      orgId: ORG_ID,
    }),
    executionScopeCapturedAt: CAPTURED_AT,
    executionScopePrincipalKind: 'system',
    ...overrides,
  };
}

describe('system-authored report run access', () => {
  beforeEach(() => {
    state.rows = [];
    state.projections = [];
    state.authority = authority('unrestricted');
  });

  it('lets an unrestricted requester download a system-authored run', async () => {
    state.rows = [systemRun(), systemRun()];

    const res = await app().request(
      `/reports/runs/${RUN_ID}/download?format=json`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: 'device_inventory',
      format: 'json',
      data: { rows: [{ headline: 'Fleet is healthy' }] },
    });
  });

  it.each([0, 1])(
    'selects the principal kind in projection %i of the download path',
    async (index) => {
      state.rows = [systemRun(), systemRun()];

      await app().request(`/reports/runs/${RUN_ID}/download?format=json`);

      expect(Object.keys(state.projections[index] ?? {})).toContain(
        'executionScopePrincipalKind',
      );
    },
  );

  it('hides a system-authored run from a site-restricted requester', async () => {
    state.authority = authority('restricted');
    state.rows = [systemRun(), systemRun()];

    const res = await app().request(
      `/reports/runs/${RUN_ID}/download?format=json`,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Report run not found' });
  });

  it('still rejects an unrestricted run with a NULL user and no system principal', async () => {
    // The forged shape the widened contract must NOT admit: a NULL acting user
    // is only legal when the principal is explicitly 'system'.
    state.rows = [
      systemRun({ executionScopePrincipalKind: null }),
      systemRun({ executionScopePrincipalKind: null }),
    ];

    const res = await app().request(
      `/reports/runs/${RUN_ID}/download?format=json`,
    );

    expect(res.status).toBe(404);
  });

  it('returns a system-authored run from the run detail route', async () => {
    state.rows = [systemRun(), systemRun()];

    const res = await app().request(`/reports/runs/${RUN_ID}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(RUN_ID);
    expect(Object.keys(state.projections[1] ?? {})).toContain(
      'executionScopePrincipalKind',
    );
  });
});
