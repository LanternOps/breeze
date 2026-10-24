import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serviceMocks, authRef, permCalls, writeRouteAuditMock } = vi.hoisted(() => ({
  serviceMocks: {
    listRoutingRules: vi.fn(),
    createRoutingRule: vi.fn(),
    updateRoutingRule: vi.fn(),
    deleteRoutingRule: vi.fn(),
    reorderRoutingRules: vi.fn(),
    testRoutingRules: vi.fn(),
  },
  authRef: { current: null as Record<string, unknown> | null },
  permCalls: [] as Array<[string, string]>,
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../services/ticketRouting/service', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketRouting/service')>('../../services/ticketRouting/service');
  return { ...actual, ...serviceMocks };
});
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    permCalls.push([`${c.req.method} ${new URL(c.req.url).pathname}`, `${resource}:${action}`].join(' ') as never);
    await next();
  },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { ticketRoutingRuleRoutes } from './routingRules';
import { TicketRoutingError } from '../../services/ticketRouting/service';
import { PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';

const RULE = '11111111-1111-4111-8111-111111111111';
const RULE2 = '33333333-3333-4333-8333-333333333333';
const ORG = '22222222-2222-4222-8222-222222222222';

const partnerAuth = () => ({
  scope: 'partner', partnerId: 'p-1', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
  canAccessOrg: () => true, user: { id: 'u-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
});
const orgAuth = () => ({ ...partnerAuth(), scope: 'organization', orgId: ORG, partnerOrgAccess: undefined });

const req = (method: string, path: string, body?: unknown) =>
  ticketRoutingRuleRoutes.request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const dto = { id: RULE, name: 'Printers', orgId: null, partnerId: 'p-1' };

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  writeRouteAuditMock.mockReset();
  permCalls.length = 0;
  authRef.current = partnerAuth();
});

const WRITES: Array<[string, string, unknown]> = [
  ['POST', '/', { name: 'Printers', ownerScope: 'partner', setPriority: 'high' }],
  ['PATCH', `/${RULE}`, { enabled: false }],
  ['DELETE', `/${RULE}`, undefined],
  ['POST', '/reorder', { ids: [RULE, RULE2] }],
];

describe('ticket routing rule routes', () => {
  it('an organization-scope caller gets 403 on every write and never reaches the service', async () => {
    authRef.current = orgAuth();
    for (const [method, path, body] of WRITES) {
      const res = await req(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    for (const m of [serviceMocks.createRoutingRule, serviceMocks.updateRoutingRule, serviceMocks.deleteRoutingRule, serviceMocks.reorderRoutingRules]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it('an organization-scope caller may read and dry-run', async () => {
    authRef.current = orgAuth();
    serviceMocks.listRoutingRules.mockResolvedValue([dto]);
    serviceMocks.testRoutingRules.mockResolvedValue({ ruleId: null, ruleName: null, applied: {}, skipped: [] });
    expect((await req('GET', '/')).status).toBe(200);
    expect((await req('POST', '/test', { orgId: ORG, source: 'email', subject: 'x', requesterEmail: null })).status).toBe(200);
  });

  it('every write carries tickets:write; reads and the dry run carry tickets:read', async () => {
    serviceMocks.createRoutingRule.mockResolvedValue(dto);
    serviceMocks.updateRoutingRule.mockResolvedValue(dto);
    serviceMocks.deleteRoutingRule.mockResolvedValue(dto);
    serviceMocks.reorderRoutingRules.mockResolvedValue({ updated: 2 });
    serviceMocks.listRoutingRules.mockResolvedValue([]);
    serviceMocks.testRoutingRules.mockResolvedValue({ ruleId: null, ruleName: null, applied: {}, skipped: [] });
    for (const [method, path, body] of WRITES) await req(method, path, body);
    await req('GET', '/');
    await req('POST', '/test', { orgId: ORG, source: 'email', subject: 'x', requesterEmail: null });
    const perms = permCalls as unknown as string[];
    expect(perms.filter((p) => p.endsWith('tickets:write'))).toHaveLength(4);
    expect(perms.filter((p) => p.endsWith('tickets:read'))).toHaveLength(2);
  });

  it('a partner-wide write refused in the service is 403', async () => {
    serviceMocks.createRoutingRule.mockRejectedValue(new PartnerWideWriteDeniedError());
    const res = await req('POST', '/', { name: 'Printers', ownerScope: 'partner', setPriority: 'high' });
    expect(res.status).toBe(403);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('a rule with no action is 400 ROUTING_RULE_NO_ACTION (service error passes through)', async () => {
    serviceMocks.createRoutingRule.mockRejectedValue(new TicketRoutingError('A routing rule must set at least one action', 400, 'ROUTING_RULE_NO_ACTION'));
    const res = await req('POST', '/', { name: 'Printers', ownerScope: 'partner' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ROUTING_RULE_NO_ACTION' });
  });

  it('validation runs before the service: bad keywords, bad domain, missing orgId for an org rule', async () => {
    for (const body of [
      { name: 'x', ownerScope: 'partner', setPriority: 'high', matchSubjectKeywords: ['a'] },
      { name: 'x', ownerScope: 'partner', setPriority: 'high', matchRequesterDomains: ['not a host'] },
      { name: 'x', ownerScope: 'organization', setPriority: 'high' },
    ]) {
      expect((await req('POST', '/', body)).status).toBe(400);
    }
    expect(serviceMocks.createRoutingRule).not.toHaveBeenCalled();
  });

  it('create normalises keywords/domains before the service and audits', async () => {
    serviceMocks.createRoutingRule.mockResolvedValue(dto);
    const res = await req('POST', '/', {
      name: 'Printers', ownerScope: 'partner', setPriority: 'high',
      matchSubjectKeywords: [' Printer ', 'PRINTER'], matchRequesterDomains: ['*.Example.com'],
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.createRoutingRule.mock.calls[0]![1]).toMatchObject({
      matchSubjectKeywords: ['printer'], matchRequesterDomains: ['*.example.com'],
    });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ticket_routing_rule.create', resourceId: RULE }));
  });

  it('PATCH never forwards ownerScope or orgId (ownership is create-only)', async () => {
    serviceMocks.updateRoutingRule.mockResolvedValue(dto);
    await req('PATCH', `/${RULE}`, { enabled: false, ownerScope: 'organization', orgId: ORG });
    const body = serviceMocks.updateRoutingRule.mock.calls[0]![2];
    expect(body).toEqual({ enabled: false });
  });

  it('reorder with duplicate ids is 400; /test is a read (no audit)', async () => {
    expect((await req('POST', '/reorder', { ids: [RULE, RULE] })).status).toBe(400);
    serviceMocks.testRoutingRules.mockResolvedValue({ ruleId: RULE, ruleName: 'Printers', applied: { priority: 'high' }, skipped: [] });
    const res = await req('POST', '/test', { orgId: ORG, source: 'email', subject: 'Printer', requesterEmail: 'a@b.com' });
    expect(await res.json()).toEqual({ data: { ruleId: RULE, ruleName: 'Printers', applied: { priority: 'high' }, skipped: [] } });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('GET passes the orgId filter', async () => {
    serviceMocks.listRoutingRules.mockResolvedValue([dto]);
    const res = await req('GET', `/?orgId=${ORG}`);
    expect(await res.json()).toEqual({ data: [dto] });
    expect(serviceMocks.listRoutingRules.mock.calls[0]![1]).toEqual({ orgId: ORG });
  });
});
