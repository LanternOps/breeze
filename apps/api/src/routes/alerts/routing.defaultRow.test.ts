import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, insertedRef, existingRowRef, deletedRef, upsertMock } = vi.hoisted(() => ({
  authRef: { current: {} as Record<string, unknown> },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  existingRowRef: { current: undefined as Record<string, unknown> | undefined },
  deletedRef: { current: false },
  upsertMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
}));
vi.mock('../../db', () => {
  const builder: any = {
    values: (vals: Record<string, unknown>) => { insertedRef.current = vals; return builder; },
    returning: () => Promise.resolve([{ id: 'new-rule', ...(insertedRef.current ?? existingRowRef.current ?? {}) }]),
    set: () => builder, from: () => builder, where: () => builder,
    limit: () => Promise.resolve(existingRowRef.current ? [existingRowRef.current] : []),
    orderBy: () => Promise.resolve([]),
  };
  return {
    db: {
      insert: () => builder, update: () => builder, select: () => builder,
      delete: () => ({ where: () => { deletedRef.current = true; return Promise.resolve(undefined); } }),
    },
  };
});
vi.mock('../../db/schema', () => ({
  notificationRoutingRules: { id: { name: 'id' }, orgId: { name: 'org_id' }, partnerId: { name: 'partner_id' }, priority: { name: 'priority' } },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  sites: { id: { name: 'id' }, orgId: { name: 'org_id' } },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/delivery/routingRuleWrites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/delivery/routingRuleWrites')>();
  return { ...actual, escalationPolicyCompatible: vi.fn(async () => true), upsertDefaultRow: upsertMock };
});

import { routingRoutes } from './routing';

const app = () => { const a = new Hono(); a.route('/alerts', routingRoutes); return a; };
const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const CHANNEL = '9a8b7c6d-2222-4333-8444-555566667777';
const POLICY = '7c6d5e4f-3333-4444-8555-666677778888';
const jsonReq = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const partnerAuth = () => ({ scope: 'partner', partnerOrgAccess: 'all', user: { id: 'u-1' }, partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-a'], canAccessOrg: () => true, allowedSiteIds: undefined });
const orgAuth = () => ({ scope: 'organization', user: { id: 'u-1' }, partnerId: 'p-1', orgId: 'org-a', accessibleOrgIds: ['org-a'], canAccessOrg: (id: string) => id === 'org-a', allowedSiteIds: undefined });

beforeEach(() => { vi.clearAllMocks(); insertedRef.current = undefined; existingRowRef.current = undefined; deletedRef.current = false; authRef.current = partnerAuth(); upsertMock.mockResolvedValue({ id: 'default-row' }); });

describe('routing schema (W05b)', () => {
  it('rejects the never-evaluated conditionTypes/deviceTags keys with 400', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { conditionTypes: ['cpu'] }, channelIds: [CHANNEL] }));
    expect(res.status).toBe(400);
  });
  it('accepts monitorKinds and escalationPolicyId and stores them', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { monitorKinds: ['cpu', 'disk'], severities: ['high'] }, channelIds: [CHANNEL], escalationPolicyId: POLICY }));
    expect(res.status).toBe(201);
    expect(insertedRef.current).toMatchObject({ conditions: { monitorKinds: ['cpu', 'disk'], severities: ['high'] }, escalationPolicyId: POLICY, isDefault: false });
  });
  it('rejects an unknown monitor kind', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { monitorKinds: ['nope'] }, channelIds: [CHANNEL] }));
    expect(res.status).toBe(400);
  });
});

describe('Everything else row rules', () => {
  it('PATCH on the default row accepts channelIds [] (inbox only) and escalationPolicyId', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Everything else', isDefault: true, conditions: {} };
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [], escalationPolicyId: POLICY }));
    expect(res.status).toBe(200);
  });
  it('PATCH on the default row rejects name/priority/conditions/enabled', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Everything else', isDefault: true, conditions: {} };
    for (const body of [{ name: 'x' }, { priority: 2 }, { conditions: {} }, { enabled: false }]) {
      const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', body));
      expect(res.status).toBe(400);
    }
  });
  it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['33333333-3333-4333-8333-333333333333'] }, { allowedDeviceIds: [] }])(
    'PATCH on a default row rejects governance ceiling %j, including an empty-channel write', async ceiling => {
      authRef.current = { ...orgAuth(), ...ceiling };
      existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, isDefault: true, conditions: {} };
      expect((await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [] }))).status).toBe(403);
    },
  );
  it('PATCH on a NON-default row rejects an empty channel list', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Crit', isDefault: false, conditions: {} };
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [] }));
    expect(res.status).toBe(400);
  });
  it('DELETE of either Everything else row is 409', async () => {
    for (const owner of [{ orgId: null, partnerId: 'p-1' }, { orgId: 'org-a', partnerId: null }]) {
      existingRowRef.current = { id: RULE_ID, ...owner, name: 'Everything else', isDefault: true, conditions: {} };
      expect((await app().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' })).status).toBe(409);
      expect(deletedRef.current).toBe(false);
    }
  });
  it('PUT /routing-rules/default upserts the org row for an org token and the partner row for ownerScope partner', async () => {
    authRef.current = orgAuth();
    let res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { channelIds: [CHANNEL] }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenLastCalledWith({ orgId: 'org-a', partnerId: null }, { channelIds: [CHANNEL], escalationPolicyId: null }, expect.anything());

    authRef.current = partnerAuth();
    res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { ownerScope: 'partner', channelIds: [] }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenLastCalledWith({ orgId: null, partnerId: 'p-1' }, { channelIds: [], escalationPolicyId: null }, expect.anything());
  });
  it.each([[[]], [['33333333-3333-4333-8333-333333333333']]])('rejects site ceiling %j even for inbox-only defaults', async allowedSiteIds => {
    authRef.current = { ...orgAuth(), allowedSiteIds };
    for (const channelIds of [[], [CHANNEL]]) {
      expect((await app().request('/alerts/routing-rules/default', jsonReq('PUT', { channelIds }))).status).toBe(403);
    }
    expect(upsertMock).not.toHaveBeenCalled();
  });
  it('PUT /routing-rules/default maps DeliveryWriteError to its status', async () => {
    const { DeliveryWriteError } = await import('../../services/delivery/routingRuleWrites');
    upsertMock.mockRejectedValueOnce(new DeliveryWriteError(403, 'denied'));
    const res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { ownerScope: 'partner', channelIds: [] }));
    expect(res.status).toBe(403);
  });
});
