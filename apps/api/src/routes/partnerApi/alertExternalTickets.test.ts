import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL = '66666666-6666-4666-8666-666666666666';
const OTHER_PRINCIPAL = '88888888-8888-4888-8888-888888888888';
const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), audit: vi.fn(), list: vi.fn(), inside: false, predicates: [] as SQL[] }));
vi.mock('../../db', () => ({ db: { select: mocks.select, insert: mocks.insert, update: mocks.update, delete: mocks.delete }, withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => {
  mocks.inside = true;
  try { return await fn(); } finally { mocks.inside = false; }
} }));
vi.mock('../../services', () => ({ getRedis: vi.fn(), rateLimiter: vi.fn() }));
vi.mock('../../middleware/apiKeyAuth', () => ({ enforcePreLookupProbeRateLimit: vi.fn() }));
vi.mock('../../services/partnerServicePrincipalCredential', () => ({ hashPartnerApiKey: vi.fn(), isPartnerServicePrincipalKeyFormat: vi.fn(), loadPartnerServicePrincipalCredential: vi.fn() }));
vi.mock('../../services/alertActions', () => ({ acknowledgeAlert: vi.fn() }));
vi.mock('../../services/alertService', () => ({ resolveAlert: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEventAsync: mocks.audit }));
vi.mock('../../services/alertExternalTickets', () => ({ listAlertExternalTickets: mocks.list }));
import { partnerAlertWriteRoutes } from './alertWrites';

let app: Hono;
let principal: PartnerApiPrincipalContext;
let results: unknown[][];
const timestamp = new Date('2027-01-12T12:00:00Z');
const alert = { id: ID, orgId: ORG, title: 'Private alert' };
const ref = (extra: Record<string, unknown> = {}) => ({ id: ID, alertId: ID, orgId: ORG, partnerId: PARTNER, partnerServicePrincipalId: PRINCIPAL, externalId: 'PSA-1', externalUrl: null, externalNumber: null, createdAt: timestamp, updatedAt: timestamp, ...extra });
let writes: Record<string, unknown>[];
function builder(result: unknown[]) {
  const promise = Promise.resolve(result);
  const query: any = {
    from: () => query, limit: () => query, for: () => query,
    where: (predicate: SQL) => { mocks.predicates.push(predicate); return query; },
    values: (value: Record<string, unknown>) => { writes.push(value); return query; },
    set: (value: Record<string, unknown>) => { writes.push(value); return query; },
    returning: () => promise, then: promise.then.bind(promise),
  };
  return query;
}
const send = (method: string, body?: unknown) => app.request(`/alerts/${ID}/${method === 'GET' ? 'external-tickets' : 'external-ticket'}`, {
  method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
});

describe('partner alert external tickets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    principal = { partnerServicePrincipalId: PRINCIPAL, keyId: ID, partnerId: PARTNER, name: 'PSA', scopes: ['alerts:read', 'alerts:write'], accessibleOrgIds: [ORG], rateLimit: 600 };
    results = [[alert], []]; writes = []; mocks.predicates.length = 0;
    mocks.select.mockImplementation(() => { expect(mocks.inside).toBe(true); return builder(results.shift() ?? []); });
    for (const mutation of [mocks.insert, mocks.update, mocks.delete]) mutation.mockImplementation(() => {
      expect(mocks.inside).toBe(true); return builder([ref()]);
    });
    mocks.audit.mockImplementation(async () => { expect(mocks.inside).toBe(false); });
    mocks.list.mockImplementation(async () => { expect(mocks.inside).toBe(true); return []; });
    app = new Hono();
    app.use('*', async (c, next) => { c.set('partnerApiPrincipal', principal); await next(); });
    app.route('/', partnerAlertWriteRoutes);
  });

  it.each(['PUT', 'DELETE', 'GET'])('requires the correct scope for %s', async (method) => {
    principal.scopes = method === 'GET' ? ['alerts:write'] : ['alerts:read'];
    expect((await send(method, method === 'PUT' ? { externalId: 'PSA-1' } : undefined)).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each(['PUT', 'DELETE', 'GET'])('hides foreign and out-of-reach alerts on %s with explicit org filtering', async (method) => {
    results = [[]];
    const res = await send(method, method === 'PUT' ? { externalId: 'PSA-1' } : undefined);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'partner_alert_not_found' });
    const query = new PgDialect().sqlToQuery(mocks.predicates[0]!);
    expect(query.sql).toContain('"alerts"."org_id" in');
    expect(query.params).toEqual([ID, ORG]);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('rejects http before querying', async () => {
    expect((await send('PUT', { externalId: '1', externalUrl: 'http://psa.example/1' })).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it('creates a principal-owned row and audits without the URL', async () => {
    const res = await send('PUT', { externalId: 'PSA-1', externalUrl: 'https://psa.example/1?private=secret' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ schemaVersion: '1', changed: true, data: { alertId: ID, orgId: ORG, partnerServicePrincipalId: PRINCIPAL } });
    expect(writes[0]).toMatchObject({ alertId: ID, orgId: ORG, partnerId: PARTNER, partnerServicePrincipalId: PRINCIPAL, externalNumber: null });
    expect(mocks.audit.mock.calls[0]![1]).toMatchObject({ actorType: 'api_key', actorId: PRINCIPAL, initiatedBy: 'integration', action: 'alert.external_ticket.set', details: { externalId: 'PSA-1', partnerId: PARTNER, keyId: ID } });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private=secret');
  });
  it('returns an identical PUT without any write or audit', async () => {
    results = [[alert], [ref()]];
    const res = await send('PUT', { externalId: 'PSA-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false });
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('fully replaces optional fields and only updates the caller principal', async () => {
    results = [[alert], [ref({ externalUrl: 'https://psa.example/old', externalNumber: '42' })]];
    const res = await send('PUT', { externalId: 'PSA-2' });
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({ externalId: 'PSA-2', externalUrl: null, externalNumber: null });
    for (const predicate of mocks.predicates.slice(1)) expect(new PgDialect().sqlToQuery(predicate).params).toContain(PRINCIPAL);
  });
  it('principal B creates its own row and the read model lists both', async () => {
    principal.partnerServicePrincipalId = OTHER_PRINCIPAL;
    expect((await send('PUT', { externalId: 'B' })).status).toBe(201);
    expect(writes[0]!.partnerServicePrincipalId).toBe(OTHER_PRINCIPAL);
    const records = [PRINCIPAL, OTHER_PRINCIPAL].map((id) => ({ source: 'partner_api', partnerServicePrincipalId: id, externalId: id, externalUrl: null, externalNumber: null, state: null, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() }));
    mocks.list.mockResolvedValueOnce(records); results = [[alert]];
    const res = await send('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schemaVersion: '1', data: records });
    expect(mocks.list).toHaveBeenCalledWith(ID, PARTNER);
  });
  it('deletes only the caller row and repeating is an unaudited no-op', async () => {
    const first = await send('DELETE');
    expect(await first.json()).toEqual({ schemaVersion: '1', deleted: true });
    expect(new PgDialect().sqlToQuery(mocks.predicates[1]!).params).toEqual([ID, PRINCIPAL]);
    expect(mocks.audit.mock.calls[0]![1].action).toBe('alert.external_ticket.delete');
    results = [[alert]]; mocks.delete.mockImplementationOnce(() => builder([]));
    expect(await (await send('DELETE')).json()).toEqual({ schemaVersion: '1', deleted: false });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});
