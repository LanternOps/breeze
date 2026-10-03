import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  rows: [] as unknown[][],
  retire: vi.fn(),
  save: vi.fn(),
  list: vi.fn(async (_i: unknown) => []),
  retireSteps: vi.fn(async (_i: unknown) => true),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => { c.set('auth', h.auth); c.set('permissions', {}); await next(); },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'leftJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  return { db: chain };
});
vi.mock('../services/fixMemory/store', () => ({ retireFixMemory: h.retire }));
vi.mock('../services/fixMemory/instructions', () => ({ saveReviewedInstructions: h.save, listReviewedInstructions: h.list, retireReviewedInstructions: h.retireSteps }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { conditionSql, fixMemoryRoutes } from './fixMemory';

const app = new Hono().route('/fix-memory', fixMemoryRoutes);
const post = (body?: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const partnerAll = { scope: 'partner', partnerId: 'p-1', partnerOrgAccess: 'all', orgId: null, user: { id: 'u-1' }, canAccessOrg: () => true, orgCondition: () => undefined };
const orgTech = { scope: 'organization', partnerId: 'p-1', partnerOrgAccess: null, orgId: 'org-1', user: { id: 'u-2' }, canAccessOrg: (id: string) => id === 'org-1', orgCondition: () => undefined };
const MEM = '11111111-1111-4111-8111-111111111111';

describe('fix memory routes', () => {
  beforeEach(() => { h.rows.length = 0; vi.clearAllMocks(); });

  it('the condition subquery keeps (partner OR org) grouped before the key/identity ANDs', () => {
    const { sql: text } = new PgDialect().sqlToQuery(conditionSql);
    expect(text).toContain('(fo.partner_id');
    expect(text).toMatch(/fo\.org_id = "fix_memory"\."org_id"\)\s+AND fo\.signature_key/);
  });

  it('lists rows with a label and a visible condition, never another org\'s text', async () => {
    h.auth = partnerAll;
    h.rows.push([{ id: MEM, orgId: null, partnerId: 'p-1', fixKind: 'builtin_action', builtinAction: 'restart_service', scriptName: null, instructionsTitle: null, playbookName: null,
      osType: 'windows', attempts: 8, verifiedCount: 7, failedCount: 1, recurredCount: 0, rollingSuccessRate: 0.875, status: 'active', staleSince: null, lastVerifiedAt: new Date('2026-11-01T00:00:00Z'), signatureKey: 'abcdef0123', condition: 'rule:service_stopped' }], [{ total: 1 }]);
    const body = await (await app.request('/fix-memory')).json();
    expect(body.data[0]).toMatchObject({ id: MEM, scope: 'all_clients', label: 'Restart service', successRate: 0.875, condition: 'rule:service_stopped', stale: false });
    expect(body.total).toBe(1);
  });

  it('retiring a partner-wide row needs the partner-wide capability', async () => {
    h.auth = { ...partnerAll, partnerOrgAccess: 'selected' };
    h.rows.push([{ id: MEM, orgId: null, partnerId: 'p-1' }]);
    expect((await app.request(`/fix-memory/${MEM}/retire`, post())).status).toBe(403);
    expect(h.retire).not.toHaveBeenCalled();
  });

  it('an org tech can retire their own org\'s private row, not a partner-wide one', async () => {
    h.auth = orgTech;
    h.rows.push([{ id: MEM, orgId: 'org-1', partnerId: null }]);
    h.retire.mockResolvedValueOnce('retired');
    expect((await app.request(`/fix-memory/${MEM}/retire`, post())).status).toBe(200);
    h.rows.push([{ id: MEM, orgId: null, partnerId: 'p-1' }]);
    expect((await app.request(`/fix-memory/${MEM}/retire`, post())).status).toBe(403);
  });

  it('retire of an unknown row is 404; of a retired row is 200 and says so', async () => {
    h.auth = partnerAll;
    h.rows.push([]);
    expect((await app.request(`/fix-memory/${MEM}/retire`, post())).status).toBe(404);
    h.rows.push([{ id: MEM, orgId: null, partnerId: 'p-1' }]);
    h.retire.mockResolvedValueOnce('already_retired');
    expect(await (await app.request(`/fix-memory/${MEM}/retire`, post())).json()).toEqual({ data: { id: MEM, status: 'retired', changed: false } });
  });

  it('saving reviewed steps is partner-wide only and stores the submitted text', async () => {
    h.auth = orgTech;
    expect((await app.request('/fix-memory/instructions', post({ title: 't', steps: ['a'], osType: 'windows' }))).status).toBe(403);
    h.auth = partnerAll;
    h.save.mockResolvedValueOnce({ id: 'fi-1', title: 't', steps: ['a'], osType: 'windows' });
    const res = await app.request('/fix-memory/instructions', post({ title: 't', steps: ['a'], osType: 'windows', fromSuggestionId: MEM }));
    expect(res.status).toBe(201);
    expect(h.save).toHaveBeenCalledWith({ partnerId: 'p-1', reviewedBy: 'u-1', title: 't', steps: ['a'], osType: 'windows' });
  });

  it('retiring reviewed steps is partner-wide only', async () => {
    h.auth = orgTech;
    expect((await app.request(`/fix-memory/instructions/${MEM}/retire`, post())).status).toBe(403);
    h.auth = partnerAll;
    expect((await app.request(`/fix-memory/instructions/${MEM}/retire`, post())).status).toBe(200);
    h.retireSteps.mockResolvedValueOnce(false);
    expect((await app.request(`/fix-memory/instructions/${MEM}/retire`, post())).status).toBe(404);
  });

  it('an org tech can read their partner\'s reviewed steps for the Done picker', async () => {
    h.auth = orgTech;
    await app.request('/fix-memory/instructions?osType=windows');
    expect(h.list).toHaveBeenCalledWith({ partnerId: 'p-1', osType: 'windows' });
  });
});
