/**
 * #3198 W02 Task 11 — ad-hoc `POST /reports/generate` for the business types.
 *
 *  - ownerScope 'partner' is no longer refused: a full-access partner admin
 *    gets a partner-scope report over the partner's LIVE org list (resolved by
 *    the real `reportScopeFromAuthority` in the request's ambient context).
 *  - Per-type permissions (spec §2, ruling P8): the route middleware's
 *    reports:export grant is necessary but not sufficient — ar_aging also
 *    needs invoices:read, technician_time_billability needs time_entries:read.
 *  - Gate order: a type with no partner-scope generator is a 400
 *    `unsupported_report_scope` BEFORE any authority is resolved.
 *  - W01's two token-gate 403 bodies stay pinned (ruling P12).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const CAPTURED_AT = new Date('2026-09-22T12:00:00.000Z');

const ALL = [{ resource: '*', action: '*' }];

const state = vi.hoisted(() => ({
  auth: null as unknown,
  permissions: null as unknown,
  ambient: undefined as unknown,
  orgRows: [] as Array<{ id: string }>,
  orgAuthority: null as unknown,
  partnerAuthority: null as unknown,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', state.auth);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  // The real requirePermission is what populates `permissions` (auth.ts:919).
  requirePermission: () => async (c: any, next: () => Promise<void>) => {
    c.set('permissions', state.permissions);
    await next();
  },
}));

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(state.orgRows).then(resolve, reject),
    };
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) {
      chain[method] = vi.fn(() => chain);
    }
    return chain;
  });
  return {
    db: { select },
    getCurrentDbAccessContext: () => state.ambient,
    hasDbAccessContext: () => state.ambient !== undefined,
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportGenerationService')>();
  return { ...actual, generateReport: vi.fn(async () => ({ rows: [], summary: {} })) };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => state.orgAuthority),
    resolveRequestPartnerReportAuthority: vi.fn(async () => state.partnerAuthority),
  };
});

import { generateRoutes } from './generate';
import { generateReport } from '../../services/reportGenerationService';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  partnerWideScope,
  resolveRequestPartnerReportAuthority,
  resolveRequestReportAuthority,
  siteScopeFingerprint,
} from '../../services/siteScope';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';

function app(): Hono {
  const instance = new Hono();
  instance.route('/reports', generateRoutes);
  return instance;
}

function post(body: Record<string, unknown>) {
  return app().request('/reports/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function partnerAuth(partnerOrgAccess: 'all' | 'selected' = 'all') {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (orgId: string) => orgId === ORG_A || orgId === ORG_B,
  };
}

function orgAuth() {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'organization',
    orgId: ORG_A,
    partnerId: PARTNER_ID,
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (orgId: string) => orgId === ORG_A,
  };
}

function authorityFor(scope: Parameters<typeof siteScopeFingerprint>[0]) {
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = partnerAuth('all');
  state.permissions = { permissions: ALL };
  // The request's own RLS context (authMiddleware's withDbAccessContext):
  // a partner token sees exactly its partner.
  state.ambient = { scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A, ORG_B], accessiblePartnerIds: [PARTNER_ID] };
  state.orgRows = [{ id: ORG_A }, { id: ORG_B }];
  state.orgAuthority = authorityFor({ version: 1, kind: 'unrestricted', orgId: ORG_A });
  state.partnerAuthority = authorityFor(partnerWideScope(PARTNER_ID));
});

describe('POST /reports/generate — business report scope (#3198 W02)', () => {
  it('1. partner scope + ar_aging → 200, generated over the live partner org list', async () => {
    const res = await post({ ownerScope: 'partner', type: 'ar_aging', config: { groupBy: 'currency' } });

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).toHaveBeenCalledWith(state.auth, PARTNER_ID, 'read');
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    expect(generateReport).toHaveBeenCalledTimes(1);
    const [type, scope, config, authority] = vi.mocked(generateReport).mock.calls[0]!;
    expect(type).toBe('ar_aging');
    expect(scope).toEqual({ kind: 'partner', partnerId: PARTNER_ID, orgIds: [ORG_A, ORG_B] });
    expect(config).toMatchObject({ groupBy: 'currency' });
    expect((authority as { scope: { kind: string } }).scope.kind).toBe('partner_wide');
    // A partner-wide run has no org to attribute and must not borrow one.
    expect(vi.mocked(writeRouteAudit).mock.calls[0]?.[1]).toMatchObject({
      orgId: null,
      action: 'report.generate.adhoc',
      details: { type: 'ar_aging', ownerScope: 'partner', partnerId: PARTNER_ID },
    });
  });

  it('2. partner scope + device_inventory → 400 unsupported_report_scope, before any authority', async () => {
    const res = await post({ ownerScope: 'partner', type: 'device_inventory' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_report_scope', type: 'device_inventory' });
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('3. org-scope token + ar_aging → 403: business types are internal to the MSP (ruling F1)', async () => {
    state.auth = orgAuth();
    const res = await post({ type: 'ar_aging' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('3b. partner caller + ar_aging for one org → 200 with an organization scope', async () => {
    const res = await post({ type: 'ar_aging', orgId: ORG_A });

    expect(res.status).toBe(200);
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
    expect(vi.mocked(generateReport).mock.calls[0]?.[1]).toEqual({ kind: 'organization', orgId: ORG_A });
  });

  it('4. a caller without invoices:read → 403 for ar_aging, and nothing is generated', async () => {
    state.permissions = {
      permissions: [
        { resource: 'reports', action: '*' },
        { resource: 'tickets', action: 'read' },
        { resource: 'time_entries', action: 'read' },
      ],
    };
    for (const body of [{ ownerScope: 'partner', type: 'ar_aging' }, { type: 'ar_aging', orgId: ORG_A }]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    }
    expect(generateReport).not.toHaveBeenCalled();
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('5. a caller without time_entries:read → 403 for technician_time_billability', async () => {
    state.permissions = {
      permissions: [
        { resource: 'reports', action: '*' },
        { resource: 'tickets', action: 'read' },
        { resource: 'invoices', action: 'read' },
      ],
    };
    const res = await post({ ownerScope: 'partner', type: 'technician_time_billability' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(generateReport).not.toHaveBeenCalled();

    // Positive control: the same caller may still run a legacy type, which
    // declares no extra permissions.
    state.auth = orgAuth();
    const legacy = await post({ type: 'device_inventory' });
    expect(legacy.status).toBe(200);
  });

  it('6. ownerScope partner from an ORGANIZATION token → 403 partner_scope_required, never reaching the authority', async () => {
    state.auth = orgAuth();
    const res = await post({ ownerScope: 'partner', type: 'ar_aging' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('6b. ownerScope partner from a selected-access partner token → 403 (W01 body)', async () => {
    state.auth = partnerAuth('selected');
    const res = await post({ ownerScope: 'partner', type: 'ar_aging' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(resolveRequestPartnerReportAuthority).not.toHaveBeenCalled();
  });

  it('7. the live partner authority denies (partner_access_not_all) → 403, nothing generated', async () => {
    state.partnerAuthority = { ok: false, reason: 'partner_access_not_all' };
    const res = await post({ ownerScope: 'partner', type: 'ar_aging' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Report scope is not authorized', reason: 'partner_access_not_all' });
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('7b. an out-of-service partner (#6699) → 403 with the shared tenant_inactive body, nothing generated', async () => {
    state.partnerAuthority = { ok: false, reason: 'tenant_inactive' };
    const res = await post({ ownerScope: 'partner', type: 'ar_aging' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Report owner is not active', reason: 'tenant_inactive' });
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('8. an ambient context that cannot see the partner → 403 (ReportScopeMismatchError), not a zero-row report', async () => {
    state.ambient = { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [] };
    const res = await post({ ownerScope: 'partner', type: 'ar_aging' });

    expect(res.status).toBe(403);
    // Distinct from test 7: authority granted, execution context refused.
    expect(await res.json()).toEqual({ error: 'Access to report scope denied' });
    expect(generateReport).not.toHaveBeenCalled();
  });
});
