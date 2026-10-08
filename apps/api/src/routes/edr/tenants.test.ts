import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, dbState, ctxState, remapState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
  },
  gates: { mfa: false },
  dbState: {
    connection: null as null | Record<string, unknown>,
    tenant: null as null | Record<string, unknown>,
    tenantRows: [] as Array<Record<string, unknown>>,
    executed: [] as string[],
    txOpened: 0,
  },
  ctxState: { enqueueInContext: [] as boolean[], inTx: false, remapInTx: null as boolean | null },
  remapState: {
    error: null as null | { code: string; message: string },
    result: {
      tenantId: 'x', previousOrgId: null as string | null, orgId: null as string | null,
      endpointsDeleted: 0, detectionsDetached: 0, actionsDetached: 0,
    },
  },
}));

const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function flatten(node: unknown): string {
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  const c = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(c.queryChunks)) return c.queryChunks.map(flatten).join('');
  if (Array.isArray(c.value)) return (c.value as unknown[]).map(String).join('');
  return '';
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: vi.fn(() => {
        const finish = (rows: unknown[]) => Object.assign(Promise.resolve(rows), {
          limit: vi.fn(async () => rows),
          orderBy: vi.fn(async () => rows),
        });
        return {
          where: vi.fn(() => {
            if (cols && 'connectionId' in cols && Object.keys(cols).length === 1) {
              return finish(dbState.tenant ? [dbState.tenant] : []);
            }
            return finish(dbState.connection ? [dbState.connection] : []);
          }),
          leftJoin: vi.fn(() => ({ where: vi.fn(() => finish(dbState.tenantRows)) })),
        };
      }),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      dbState.txOpened += 1;
      ctxState.inTx = true;
      try {
        return await cb({
          execute: vi.fn(async (q: unknown) => { dbState.executed.push(flatten(q)); return []; }),
        });
      } finally {
        ctxState.inTx = false;
      }
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    ctxState.enqueueInContext.push(ctxState.inTx);
    return fn();
  }),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => (gates.mfa ? c.json({ error: 'MFA required' }, 403) : next())),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../../services/edrProviders/mapping', () => {
  class RemapEdrTenantError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  }
  return {
    RemapEdrTenantError,
    listNameSuggestions: vi.fn(async () => [{ tenantId: TENANT_ID, orgId: ORG_B, orgName: 'Acme' }]),
    remapEdrTenant: vi.fn(async () => {
      ctxState.remapInTx = ctxState.inTx;
      if (remapState.error) throw new RemapEdrTenantError(remapState.error.code, remapState.error.message);
      return remapState.result;
    }),
  };
});

const enqueueMock = vi.fn(async (_id: string, _s: string) => 'job-1');
vi.mock('../../jobs/edrProviderSync', () => ({
  enqueueEdrSync: (id: string, s: string) => enqueueMock(id, s),
}));

import { writeRouteAudit } from '../../services/auditEvents';
import { remapEdrTenant } from '../../services/edrProviders/mapping';
import { edrTenantRoutes } from './tenants';

const JSON_HEADERS = { 'content-type': 'application/json' };
const put = (app: Hono, body: unknown) =>
  app.request(`/edr/tenants/${TENANT_ID}/mapping`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });

describe('EDR tenant routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.mfa = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.partnerId = PARTNER_ID;
    authState.partnerOrgAccess = 'all';
    dbState.connection = { id: CONNECTION_ID };
    dbState.tenant = { connectionId: CONNECTION_ID };
    dbState.tenantRows = [];
    dbState.executed = [];
    dbState.txOpened = 0;
    ctxState.enqueueInContext = [];
    ctxState.inTx = false;
    ctxState.remapInTx = null;
    remapState.error = null;
    remapState.result = {
      tenantId: TENANT_ID, previousOrgId: ORG_A, orgId: ORG_B,
      endpointsDeleted: 5, detectionsDetached: 2, actionsDetached: 0,
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, {
        scope: authState.scope,
        orgId: authState.orgId,
        partnerId: authState.partnerId,
        partnerOrgAccess: authState.partnerOrgAccess,
        user: { id: '99999999-9999-4999-8999-999999999999', email: 'tech@example.com' },
      } as never);
      return next();
    });
    app.route('/edr', edrTenantRoutes);
  });

  describe('GET /edr/connections/:id/tenants', () => {
    it('never includes installer_secret_encrypted, only hasInstallerSecret, and returns suggestions + summary', async () => {
      dbState.tenantRows = [
        { id: TENANT_ID, vendorTenantName: 'Acme', orgId: null, endpointCount: 7, vendorMissingSince: null, hasInstallerSecret: true },
      ];
      const res = await app.request(`/edr/connections/${CONNECTION_ID}/tenants`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].hasInstallerSecret).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/installer_?secret_?encrypted|installerSecretEncrypted/i);
      expect(body.suggestions).toHaveLength(1);
      expect(body.summary).toEqual({ tenants: 1, unmappedTenants: 1, unmappedEndpointCount: 7 });
    });

    it('a selected-org partner user can read; an org token cannot', async () => {
      authState.partnerOrgAccess = 'selected';
      expect((await app.request(`/edr/connections/${CONNECTION_ID}/tenants`)).status).toBe(200);
      authState.scope = 'organization';
      authState.partnerOrgAccess = null;
      expect((await app.request(`/edr/connections/${CONNECTION_ID}/tenants`)).status).toBe(403);
    });

    it('404 for a connection the partner does not own', async () => {
      dbState.connection = null;
      expect((await app.request(`/edr/connections/${CONNECTION_ID}/tenants`)).status).toBe(404);
    });
  });

  describe('PUT /edr/tenants/:id/mapping', () => {
    it('selected-org partner user -> 403; org token -> 403 (Review Focus 5)', async () => {
      authState.partnerOrgAccess = 'selected';
      expect((await put(app, { orgId: ORG_B })).status).toBe(403);
      authState.scope = 'organization';
      authState.partnerOrgAccess = null;
      authState.orgId = ORG_B;
      expect((await put(app, { orgId: ORG_B })).status).toBe(403);
      expect(remapEdrTenant).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('requires MFA and a present orgId key', async () => {
      gates.mfa = true;
      expect((await put(app, { orgId: ORG_B })).status).toBe(403);
      gates.mfa = false;
      expect((await put(app, {})).status).toBe(400);
      expect(remapEdrTenant).not.toHaveBeenCalled();
    });

    it('takes the sync advisory lock in the same tx as the remap, audits, then enqueues both streams outside the tx', async () => {
      const res = await put(app, { orgId: ORG_B });
      expect(res.status).toBe(200);
      expect(dbState.executed[0]).toContain("pg_advisory_xact_lock(hashtext('edr-provider-sync')");
      expect(dbState.executed[0]).toContain(CONNECTION_ID);
      expect(ctxState.remapInTx).toBe(true);
      expect(vi.mocked(remapEdrTenant).mock.calls[0]!.slice(1)).toEqual([
        { partnerId: PARTNER_ID, userId: '99999999-9999-4999-8999-999999999999' }, TENANT_ID, ORG_B,
      ]);
      const audit = vi.mocked(writeRouteAudit).mock.calls[0]![1];
      expect(audit).toMatchObject({
        action: 'edr.tenant.map',
        details: { previousOrgId: ORG_A, orgId: ORG_B, endpointsDeleted: 5, detectionsDetached: 2 },
      });
      expect(enqueueMock.mock.calls.map((c) => c[1])).toEqual(['inventory', 'detections']);
      expect(ctxState.enqueueInContext).toEqual([false]);
    });

    it('unmap (orgId null) audits edr.tenant.unmap against the previous org', async () => {
      remapState.result = { ...remapState.result, orgId: null };
      expect((await put(app, { orgId: null })).status).toBe(200);
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({ action: 'edr.tenant.unmap', orgId: ORG_A });
    });

    it('holding org -> 422 and nothing audited or enqueued', async () => {
      remapState.error = { code: 'HOLDING_ORG', message: 'holding area' };
      const res = await put(app, { orgId: ORG_B });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('HOLDING_ORG');
      expect(writeRouteAudit).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('org of another partner -> 422', async () => {
      remapState.error = { code: 'ORG_NOT_IN_PARTNER', message: 'not yours' };
      expect((await put(app, { orgId: ORG_B })).status).toBe(422);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('service NOT_FOUND and unknown tenant -> 404', async () => {
      remapState.error = { code: 'NOT_FOUND', message: 'nf' };
      expect((await put(app, { orgId: ORG_B })).status).toBe(404);
      remapState.error = null;
      dbState.tenant = null;
      expect((await put(app, { orgId: ORG_B })).status).toBe(404);
    });

    it('a queue failure does not fail the mapping', async () => {
      enqueueMock.mockRejectedValueOnce(new Error('redis down'));
      const res = await put(app, { orgId: ORG_B });
      expect(res.status).toBe(200);
      expect((await res.json()).syncWarning).toBeTruthy();
    });
  });
});
