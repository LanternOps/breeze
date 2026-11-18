import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';

const ORG = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL = '66666666-6666-4666-8666-666666666666';
const KEY = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  ack: vi.fn(),
  resolve: vi.fn(),
  audit: vi.fn(),
  contexts: [] as unknown[],
  predicates: [] as SQL[],
  inside: false
}));
vi.mock('../../db', () => ({
  db: { select: mocks.select }, withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
    mocks.contexts.push(ctx);
    mocks.inside = true;
    try {
      return await fn();
    } finally {
      mocks.inside = false;
    }
  }
}));
vi.mock('../../services', () => ({ getRedis: vi.fn(), rateLimiter: vi.fn() }));
vi.mock('../../middleware/apiKeyAuth', () => ({ enforcePreLookupProbeRateLimit: vi.fn() }));
vi.mock('../../services/partnerServicePrincipalCredential', () => ({
  hashPartnerApiKey: vi.fn(),
  isPartnerServicePrincipalKeyFormat: vi.fn(),
  loadPartnerServicePrincipalCredential: vi.fn()
}));
vi.mock('../../services/alertActions', () => ({ acknowledgeAlert: mocks.ack }));
vi.mock('../../services/alertService', () => ({ resolveAlert: mocks.resolve }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEventAsync: mocks.audit }));

import { partnerAlertWriteRoutes } from './alertWrites';
import { partnerApiWriteLimitFor } from '../../middleware/partnerApiAuth';

let principal: PartnerApiPrincipalContext;
let rows: Record<string, unknown>[][];
let app: Hono;
const row = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  orgId: ORG,
  title: 'Private title',
  status: 'active',
  acknowledgedAt: null,
  resolvedAt: null,
  resolutionReason: null,
  acknowledgedByPrincipalId: null,
  resolvedByPrincipalId: null,
  ...extra
});
const send = (action: string, body?: unknown, id = ID) => app.request(`/alerts/${id}/${action}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
function untouched() {
  expect(mocks.ack).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

describe('partner alert writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contexts.length = 0;
    mocks.predicates.length = 0;
    mocks.inside = false;
    principal = {
      partnerServicePrincipalId: PRINCIPAL,
      keyId: KEY,
      partnerId: PARTNER,
      name: 'Write-back',
      scopes: ['alerts:write'],
      accessibleOrgIds: [ORG],
      rateLimit: 600
    };
    rows = [[row()]];
    mocks.select.mockImplementation(() => {
      expect(mocks.inside).toBe(true);
      const result = rows.shift() ?? [];
      const query = {
        from: vi.fn(() => query),
        where: vi.fn((predicate: SQL) => {
          mocks.predicates.push(predicate);
          return query;
        }),
        limit: vi.fn(async () => result)
      };
      return query;
    });
    mocks.ack.mockImplementation(async () => {
      expect(mocks.inside).toBe(true);
      return {
        changed: true, alert: row({
          status: 'acknowledged',
          acknowledgedAt: new Date('2027-01-12T12:00:00Z'),
          acknowledgedByPrincipalId: PRINCIPAL
        })
      };
    });
    mocks.resolve.mockImplementation(async () => {
      expect(mocks.inside).toBe(true);
      return true;
    });
    mocks.audit.mockImplementation(() => {
      expect(mocks.inside).toBe(false);
      return Promise.resolve();
    });
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('partnerApiPrincipal', principal);
      await next();
    });
    app.route('/', partnerAlertWriteRoutes);
  });

  it.each(['acknowledge', 'resolve'])('requires alerts:write for %s using the real gate', async (action) => {
    principal.scopes = ['alerts:read'];
    expect((await send(action)).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.contexts).toHaveLength(0);
    untouched();
  });

  it.each(['acknowledge', 'resolve'])('returns 404 for missing/out-of-set alerts on %s with an org predicate', async (action) => {
    rows = [[], []];
    for (const id of [ID, FOREIGN]) {
      const res = await send(action, undefined, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Alert not found.', code: 'partner_alert_not_found' });
    }
    for (const [index, predicate] of mocks.predicates.entries()) {
      const compiled = new PgDialect().sqlToQuery(predicate);
      expect(compiled.sql).toContain('"alerts"."org_id" in');
      expect(compiled.params).toEqual([index === 0 ? ID : FOREIGN, ORG]);
    }
    untouched();
  });

  it.each(['acknowledge', 'resolve'])('avoids SELECT for an empty org set on %s', async (action) => {
    principal.accessibleOrgIds = [];
    expect((await send(action)).status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
    untouched();
  });

  it('acknowledges as the principal, audits after the context, and returns exactly state keys', async () => {
    const res = await send('acknowledge', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schemaVersion: '1',
      changed: true,
      data: {
        id: ID,
        orgId: ORG,
        status: 'acknowledged',
        acknowledgedAt: '2027-01-12T12:00:00.000Z',
        resolvedAt: null,
        resolutionReason: null,
        acknowledgedByPrincipalId: PRINCIPAL,
        resolvedByPrincipalId: null
      }
    });
    expect(mocks.ack).toHaveBeenCalledWith(ID, { kind: 'partner_service_principal', principalId: PRINCIPAL });
    expect(mocks.contexts).toEqual([{
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG],
      accessiblePartnerIds: [PARTNER],
      currentPartnerId: PARTNER,
      userId: null
    }]);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      actorType: 'api_key',
      actorId: PRINCIPAL,
      initiatedBy: 'integration',
      action: 'alert.acknowledge',
      resourceType: 'alert',
      resourceId: ID,
      resourceName: 'Private title',
      result: 'success',
      details: {
        principalType: 'partner_service_principal',
        partnerServicePrincipalId: PRINCIPAL,
        partnerServicePrincipalName: 'Write-back',
        keyId: KEY,
        partnerId: PARTNER,
        previousStatus: 'active',
        nextStatus: 'acknowledged'
      }
    });
  });

  it('ack repeat is a no-op', async () => {
    rows = [[row({ status: 'acknowledged' })]];
    expect(await (await send('acknowledge')).json()).toMatchObject({ changed: false });
    untouched();
  });

  it('ack lost CAS re-reads acknowledged as a no-op', async () => {
    rows.push([row({ status: 'acknowledged' })]);
    mocks.ack.mockResolvedValueOnce({ changed: false, alert: null });
    expect(await (await send('acknowledge')).json()).toMatchObject({ changed: false });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'dismissed', 'suppressed'])('rejects acknowledging %s', async (status) => {
    rows = [[row({ status })]];
    const res = await send('acknowledge');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Alert cannot be acknowledged from its current status.',
      code: 'partner_alert_not_acknowledgeable',
      details: { status }
    });
    untouched();
  });

  it('ack lost CAS returns the current conflicting status', async () => {
    rows.push([row({ status: 'resolved' })]);
    mocks.ack.mockResolvedValueOnce({ changed: false, alert: null });
    const res = await send('acknowledge');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: { status: 'resolved' } });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['active', 'acknowledged', 'suppressed'])('resolves %s with trimmed note and principal attribution', async (status) => {
    rows = [[row({ status })], [row({
      status: 'resolved',
      resolvedAt: new Date('2027-01-12T12:01:00Z'),
      resolutionReason: 'manual',
      resolvedByPrincipalId: PRINCIPAL
    })]];
    const res = await send('resolve', { note: '  done\n\tchecked  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schemaVersion: '1',
      changed: true,
      data: {
        id: ID,
        orgId: ORG,
        status: 'resolved',
        acknowledgedAt: null,
        resolvedAt: '2027-01-12T12:01:00.000Z',
        resolutionReason: 'manual',
        acknowledgedByPrincipalId: null,
        resolvedByPrincipalId: PRINCIPAL
      }
    });
    expect(mocks.resolve).toHaveBeenCalledWith(ID, 'done\n\tchecked', undefined, false, 'manual', PRINCIPAL);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]![1]).toMatchObject({
      actorType: 'api_key',
      actorId: PRINCIPAL,
      initiatedBy: 'integration',
      action: 'alert.resolve',
      details: {
        previousStatus: status,
        nextStatus: 'resolved',
        hasResolutionNote: true
      }
    });
  });

  it('resolve repeat is a no-op', async () => {
    rows = [[row({ status: 'resolved' })]];
    expect(await (await send('resolve')).json()).toMatchObject({ changed: false });
    untouched();
  });

  it('rejects resolving dismissed alerts', async () => {
    rows = [[row({ status: 'dismissed' })]];
    const res = await send('resolve');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Alert cannot be resolved from its current status.',
      code: 'partner_alert_not_resolvable',
      details: { status: 'dismissed' }
    });
    untouched();
  });

  it.each(['resolved', 'dismissed'])('resolve lost CAS re-reads %s', async (status) => {
    mocks.resolve.mockResolvedValueOnce(false);
    rows.push([row({ status })]);
    const res = await send('resolve');
    expect(res.status).toBe(status === 'resolved' ? 200 : 409);
    expect(await res.json()).toMatchObject(status === 'resolved' ? { changed: false } : { code: 'partner_alert_not_resolvable', details: { status } });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['acknowledge', 'resolve'])('answers 404 when %s loses the CAS and the alert has left reach', async (action) => {
    // Pre-read sees an actionable alert; the re-read after the lost CAS finds
    // nothing (deleted, or its org left the principal's set).
    rows = [[row()], []];
    if (action === 'acknowledge') mocks.ack.mockResolvedValueOnce({ changed: false, alert: null });
    else mocks.resolve.mockResolvedValueOnce(false);
    const res = await send(action);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Alert not found.', code: 'partner_alert_not_found' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([['acknowledge', { note: 'x' }], ['resolve', { note: 'x'.repeat(2001) }], ['resolve', { note: '\u0007' }], ['resolve', { unexpected: true }]])('rejects invalid %s bodies', async (action, body) => {
    expect((await send(action as string, body)).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
    untouched();
  });

  it.each([undefined, {}, { note: ' \t\n ' }])('accepts resolve without a note (%j)', async (body) => {
    rows.push([row({ status: 'resolved' })]);
    expect((await send('resolve', body)).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(ID, undefined, undefined, false, 'manual', PRINCIPAL);
    expect(mocks.audit.mock.calls[0]![1].details.hasResolutionNote).toBe(false);
  });

  it('rejects invalid ids before querying', async () => {
    expect((await send('resolve', {}, 'not-a-uuid')).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
    untouched();
  });

  it('lets service failures reach Hono as 500s', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('write failed'));
    expect((await send('resolve')).status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('uses the default 120/hour write bucket', () => {
    expect(partnerApiWriteLimitFor(`/api/v1/partner-api/alerts/${ID}/resolve`, 600)).toEqual({ bucket: 'default', limit: 120 });
  });
});
