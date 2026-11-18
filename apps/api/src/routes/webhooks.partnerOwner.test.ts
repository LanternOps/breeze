import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
vi.mock('../services/unassignedPool/protectedOrg', () => ({ isHoldingOrg: vi.fn(async () => false) }));
vi.mock('../jobs/webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: vi.fn(async () => undefined) }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/notificationSenders/webhookSender', () => ({ validateWebhookUrlSafetyWithDns: vi.fn(async () => []), redactUrlForLogs: (value: string) => value }));
vi.mock('../db', () => ({ runAfterDbContextCommit: vi.fn((_label, work) => work()), runOutsideDbContext: vi.fn((work) => work()), withSystemDbAccessContext: vi.fn((work) => work()), db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('../middleware/auth', () => ({ authMiddleware: vi.fn(), requireScope: vi.fn(() => async (_c: unknown, next: () => unknown) => next()), requirePermission: vi.fn(() => async (_c: unknown, next: () => unknown) => next()), requireMfa: vi.fn(() => async (_c: unknown, next: () => unknown) => next()) }));
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { webhooks } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { decryptSecret } from '../services/secretCrypto';
import { webhookRoutes } from './webhooks';
const ORG = '11111111-1111-1111-1111-111111111111';
const PARTNER = '22222222-2222-2222-2222-222222222222';
const HOOK = '33333333-3333-3333-3333-333333333333';
const DELIVERY = '44444444-4444-4444-4444-444444444444';
const OTHER = '55555555-5555-5555-5555-555555555555';
const row = (overrides: Record<string, unknown> = {}) => ({ id: HOOK, orgId: null, partnerId: PARTNER, name: 'Partner hook', url: 'https://hooks.example.com/in', secret: 'signing-secret', events: ['alert.triggered'], headers: [], status: 'active', approvalGeneration: 1, payloadVersion: 2, createdAt: new Date(), updatedAt: new Date(), ...overrides });
const body = { name: 'Partner hook', url: 'https://hooks.example.com/in', secret: 'signing-secret', events: ['alert.triggered'], ownerScope: 'partner' };
const dialect = new PgDialect();
let app: Hono;
let auth: any;
function request(method: string, path = '', data?: unknown) { return app.request(`/webhooks${path}`, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) }); }
function selectOne(rows: unknown[]) { vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => rows }) }) } as any); }
function insertEcho(delivery = false) {
  const values = vi.fn((data: Record<string, unknown>) => ({ returning: vi.fn(async () => [delivery ? { id: DELIVERY, ...data } : row(data)]) }));
  vi.mocked(db.insert).mockReturnValueOnce({ values } as any); return values;
}
function listRows(rows: unknown[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const where = (query?: SQL) => { queries.push(query ? dialect.sqlToQuery(query) : { sql: '', params: [] }); return Object.assign(Promise.resolve([{ count: rows.length }]), { orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }); };
  vi.mocked(db.select).mockImplementation(() => ({ from: () => ({ where }) }) as any); return queries;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(db.select).mockReset(); vi.mocked(db.insert).mockReset();
  auth = { scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', orgId: null, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
  vi.mocked(authMiddleware).mockImplementation((async (c: any, next: any) => { c.set('auth', auth); return next(); }) as any);
  app = new Hono(); app.route('/webhooks', webhookRoutes);
});
describe('partner webhook ownership', () => {
  it.each(['selected', undefined])('refuses partner creation without full org access (%s)', async (access) => {
    auth.partnerOrgAccess = access; insertEcho(); const response = await request('POST', '', body);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }); expect(db.insert).not.toHaveBeenCalled();
  });
  it('refuses partner creation by an org user', async () => {
    auth.scope = 'organization'; auth.orgId = ORG; insertEcho(); const response = await request('POST', '', body);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  });
  it('creates an encrypted partner-owned v2 webhook and records the owner in audit details', async () => {
    const values = insertEcho(); const response = await request('POST', '', { ...body, partnerId: OTHER });
    expect(webhooks.payloadVersion.default).toBe(2);
    expect(response.status).toBe(201); expect(values.mock.calls[0]![0]).toMatchObject({ orgId: null, partnerId: PARTNER });
    expect(decryptSecret(values.mock.calls[0]![0].secret as string)).toBe('signing-secret');
    expect(await response.json()).toMatchObject({ orgId: null, partnerId: PARTNER, ownerScope: 'partner', payloadVersion: 2 });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: null, details: expect.objectContaining({ ownerScope: 'partner', partnerId: PARTNER }) }));
  });
  it('rejects an orgId on a partner-owned create', async () => {
    insertEcho();
    expect((await request('POST', '', { ...body, orgId: ORG })).status).toBe(400); expect(db.insert).not.toHaveBeenCalled();
  });
  it('requires an explicit partner for a system create', async () => {
    auth.scope = 'system'; expect((await request('POST', '', body)).status).toBe(400); const values = insertEcho();
    expect((await request('POST', '', { ...body, partnerId: OTHER })).status).toBe(201); expect(values.mock.calls[0]![0]).toMatchObject({ orgId: null, partnerId: OTHER });
  });
  it.each(['ownerScope', 'partnerId', 'orgId'])('rejects ownership field %s on PATCH', async (field) => {
    selectOne([row({ orgId: ORG, partnerId: null })]);
    const response = await request('PATCH', `/${HOOK}`, { name: 'Rename', [field]: field === 'ownerScope' ? 'organization' : OTHER });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Webhook ownership cannot be changed after creation');
    expect(db.update).not.toHaveBeenCalled();
  });
  it('strips unknown PATCH fields while accepting supported updates', async () => {
    selectOne([row()]);
    const set = vi.fn((_values: Record<string, unknown>) => ({ where: () => ({ returning: async () => [row({ name: 'Rename' })] }) }));
    vi.mocked(db.update).mockReturnValueOnce({ set } as any);
    const response = await request('PATCH', `/${HOOK}`, { name: 'Rename', enabled: true });
    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rename' }));
    expect(set.mock.calls[0]![0]).not.toHaveProperty('enabled');
  });
  for (const scope of ['organization', 'restricted-partner', 'other-partner']) {
    it.each([['GET', ''], ['GET', '/deliveries'], ['POST', '/test'], ['POST', `/retry/${DELIVERY}`], ['PATCH', ''], ['DELETE', '']])(`${scope} cannot access a partner webhook via %s %s`, async (method, suffix) => {
      if (scope === 'organization') { auth.scope = 'organization'; auth.orgId = ORG; } else if (scope === 'restricted-partner') auth.partnerOrgAccess = 'selected'; else auth.partnerId = OTHER;
      auth.canAccessOrg = () => true; // Ownership must not depend on an org accessor accepting null.
      selectOne([row()]); const response = await request(method!, `/${HOOK}${suffix}`, method === 'PATCH' ? { name: 'Renamed' } : method === 'POST' ? {} : undefined);
      expect(response.status).toBe(404); expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    });
  }
  it.each(['organization', 'restricted-partner'])('omits partner rows from the %s list predicate', async (scope) => {
    if (scope === 'organization') { auth.scope = scope; auth.orgId = ORG; } else auth.partnerOrgAccess = 'selected';
    const queries = listRows([]); const response = await request('GET'); expect(response.status).toBe(200); expect((await response.json()).data).toEqual([]);
    expect(queries[0]!.sql).not.toContain('partner_id'); expect(queries[0]!.params).toContain(ORG);
  });
  it('includes the partner branch for a full partner admin, even with no orgs', async () => {
    auth.accessibleOrgIds = []; const queries = listRows([row()]); const response = await request('GET');
    expect((await response.json()).data).toEqual([expect.objectContaining({ partnerId: PARTNER, ownerScope: 'partner' })]); expect(queries[0]!.sql).toContain('partner_id'); expect(queries[0]!.params).toContain(PARTNER);
  });
  it.each([undefined, 'organization', 'partner'])('includes applicable partner webhooks in the selected org view, narrowed by ownerScope=%s', async (ownerScope) => {
    const queries = listRows([]);
    const response = await request('GET', `?orgId=${ORG}${ownerScope ? `&ownerScope=${ownerScope}` : ''}`);
    expect(response.status).toBe(200);
    const owners = or(
      eq(webhooks.orgId, ORG),
      and(isNull(webhooks.orgId), eq(webhooks.partnerId, PARTNER)),
    );
    const expected = ownerScope
      ? and(owners, isNull(ownerScope === 'partner' ? webhooks.orgId : webhooks.partnerId))
      : owners;
    expect(queries).toEqual([dialect.sqlToQuery(expected!), dialect.sqlToQuery(expected!)]);
  });
  it('keeps a restricted partner selected-org view org-owned only', async () => {
    auth.partnerOrgAccess = 'selected';
    const queries = listRows([]);
    expect((await request('GET', `?orgId=${ORG}`)).status).toBe(200);
    expect(queries[0]).toEqual(dialect.sqlToQuery(eq(webhooks.orgId, ORG)));
  });
  it('pins org-scope listing to the authenticated org regardless of a query org', async () => {
    auth.scope = 'organization'; auth.orgId = ORG;
    const queries = listRows([]);
    expect((await request('GET', `?orgId=${OTHER}`)).status).toBe(200);
    expect(queries[0]).toEqual(dialect.sqlToQuery(eq(webhooks.orgId, ORG)));
  });
  it('rejects an inaccessible selected org before looking up partner webhooks', async () => {
    expect((await request('GET', `?orgId=${OTHER}`)).status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each(['organization', 'partner'])('filters by ownerScope=%s', async (scope) => {
    const queries = listRows([]); expect((await request('GET', `?ownerScope=${scope}`)).status).toBe(200); expect(queries[0]!.sql).toContain(scope === 'partner' ? '"org_id" is null' : '"partner_id" is null');
  });
  it.each(['partner', 'system'])('allows %s scope to read an owned partner webhook', async (scope) => {
    auth.scope = scope;
    selectOne([row()]);
    vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: () => ({ groupBy: async () => [] }) }) } as any);
    vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) } as any);
    const response = await request('GET', `/${HOOK}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ orgId: null, partnerId: PARTNER, ownerScope: 'partner' });
  });
  it('a partner admin can update and delete its webhook with partner audit attribution', async () => {
    selectOne([row()]);
    vi.mocked(db.update).mockReturnValueOnce({ set: () => ({ where: () => ({ returning: async () => [row({ name: 'Updated' })] }) }) } as any);
    expect((await request('PATCH', `/${HOOK}`, { name: 'Updated' })).status).toBe(200);
    selectOne([row()]);
    vi.mocked(db.delete).mockReturnValueOnce({ where: async () => undefined } as any);
    expect((await request('DELETE', `/${HOOK}`)).status).toBe(200);
    for (const action of ['webhook.update', 'webhook.delete']) {
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: null, action, details: expect.objectContaining({ ownerScope: 'partner', partnerId: PARTNER }),
      }));
    }
  });
  it.each(['create', 'update', 'delete', 'test', 'retry'] as const)('attributes system-scope %s audit events to the webhook owner partner', async (action) => {
    auth.scope = 'system';
    auth.partnerId = null;
    let response: Response;
    if (action === 'create') {
      insertEcho();
      response = await request('POST', '', { ...body, partnerId: PARTNER });
    } else {
      selectOne([row()]);
      if (action === 'update') {
        vi.mocked(db.update).mockReturnValueOnce({ set: () => ({ where: () => ({ returning: async () => [row({ name: 'Updated' })] }) }) } as any);
        response = await request('PATCH', `/${HOOK}`, { name: 'Updated' });
      } else if (action === 'delete') {
        vi.mocked(db.delete).mockReturnValueOnce({ where: async () => undefined } as any);
        response = await request('DELETE', `/${HOOK}`);
      } else {
        if (action === 'retry') selectOne([{ id: DELIVERY, orgId: null, eventId: 'test-original', eventType: 'test', status: 'failed', payload: {}, payloadVersion: 2 }]);
        insertEcho(true);
        response = await request('POST', `/${HOOK}/${action === 'retry' ? `retry/${DELIVERY}` : 'test'}`, {});
      }
    }
    expect(response.status).toBe(action === 'create' ? 201 : action === 'test' || action === 'retry' ? 202 : 200);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: `webhook.${action}`, orgId: null, partnerId: PARTNER,
    }));
  });
  it('records a partner test with null event org and a test UUID marker for any event type', async () => {
    selectOne([row()]); const values = insertEcho(true); const response = await request('POST', `/${HOOK}/test`, { event: 'alert.triggered' });
    expect(response.status).toBe(202); expect(values.mock.calls[0]![0]).toMatchObject({ orgId: null, eventType: 'alert.triggered', eventId: expect.stringMatching(/^test-[0-9a-f-]{36}$/) }); expect((await response.json()).delivery.orgId).toBeNull();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: null, details: expect.objectContaining({ partnerId: PARTNER, ownerScope: 'partner' }) }));
  });
  it('records an org test with its owner org and the existing UUID event id', async () => {
    selectOne([row({ orgId: ORG, partnerId: null })]); const values = insertEcho(true); expect((await request('POST', `/${HOOK}/test`, {})).status).toBe(202);
    expect(values.mock.calls[0]![0]).toMatchObject({ orgId: ORG, eventId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
  it.each([ORG, null])('copies the source delivery org (%s) when replaying', async (orgId) => {
    selectOne([row()]); selectOne([{ id: DELIVERY, orgId, eventId: orgId ? 'event-original' : 'test-original', eventType: 'alert.triggered', status: 'failed', payload: {}, payloadVersion: 2 }]); if (orgId) selectOne([{ partnerId: PARTNER, live: true }]);
    const values = insertEcho(true); const response = await request('POST', `/${HOOK}/retry/${DELIVERY}`); expect(response.status).toBe(202); expect(values.mock.calls[0]![0]).toMatchObject({ orgId }); expect((await response.json()).delivery.orgId).toBe(orgId); if (orgId === null) expect(values.mock.calls[0]![0].eventId).toMatch(/^test-[0-9a-f-]{36}$/);
    if (orgId !== null) {
      expect(runOutsideDbContext).toHaveBeenCalledOnce();
      expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
    }
  });
  it.each([
    { label: 'missing', orgs: [], error: 'Cannot retry: organization moved to another partner' },
    { label: 'moved', orgs: [{ partnerId: OTHER, live: true }], error: 'Cannot retry: organization moved to another partner' },
    { label: 'inactive', orgs: [{ partnerId: PARTNER, live: false }], error: 'Cannot retry: organization is not currently active; retry after it is reactivated' },
  ])('refuses a replay whose org is $label with the matching reason', async ({ orgs, error }) => {
    selectOne([row()]); selectOne([{ id: DELIVERY, orgId: ORG, eventId: 'original', eventType: 'alert.triggered', status: 'failed' }]); selectOne(orgs);
    insertEcho(true);
    const response = await request('POST', `/${HOOK}/retry/${DELIVERY}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('delivery summaries expose the event org, not the partner webhook null owner', async () => {
    selectOne([row()]); vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: async () => [{ count: 1 }] }) } as any);
    vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => [{ id: DELIVERY, webhookId: HOOK, orgId: ORG, status: 'delivered' }] }) }) }) }) } as any);
    const response = await request('GET', `/${HOOK}/deliveries`); expect(response.status).toBe(200); expect((await response.json()).data[0].orgId).toBe(ORG);
  });
});
