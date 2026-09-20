import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiTools', () => ({ resolveWritableToolOrgId: vi.fn(), verifyDeviceAccess: vi.fn() }));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));

import { and, desc, eq, gte, ilike, lte, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { incidents } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerIncidentTools } from './aiToolsIncident';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const tools = new Map<string, AiTool>();
registerIncidentTools(tools);
const orgCondition = vi.fn(() => eq(incidents.orgId, ORG));
const auth = (over = {}) => ({
  scope: 'partner', accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG, orgCondition, ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown> = {}, over = {}) =>
  JSON.parse(await tools.get('list_incidents')!.handler(input, auth(over)));

function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain), where: vi.fn((_condition?: SQL) => chain),
    orderBy: vi.fn(() => chain), limit: vi.fn(() => chain), offset: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}
let page: ReturnType<typeof query>;
let count: ReturnType<typeof query>;
beforeEach(() => {
  vi.clearAllMocks();
  page = query([{ id: OTHER, orgId: ORG, title: 'Incident' }]);
  count = query([{ count: '1' }]);
  vi.mocked(db.select).mockImplementation((projection) =>
    (projection && 'count' in projection ? count : page) as never);
});

describe('list_incidents', () => {
  it('registers a Tier-1 monitoring read', () => {
    expect(tools.get('list_incidents')).toMatchObject({ tier: 1, domain: 'monitoring', deviceArgs: [] });
  });
  it.each(['partner', 'organization'])('denies cross-org access for %s', async (scope) => {
    expect((await run({ orgId: OTHER }, { scope, orgId: ORG })).error).toMatch(/organization/i);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('uses the auth org condition for both queries', async () => {
    await run();
    expect(orgCondition).toHaveBeenCalledWith(incidents.orgId);
    expect(page.where).toHaveBeenCalledWith(and(eq(incidents.orgId, ORG)));
    expect(count.where).toHaveBeenCalledWith(page.where.mock.calls[0]![0]);
  });
  it('allows unrestricted system scope', async () => {
    await run({}, { scope: 'system', accessibleOrgIds: null, orgCondition: () => undefined });
    expect(page.where).toHaveBeenCalledWith(undefined);
    expect(count.where).toHaveBeenCalledWith(undefined);
  });
  it.each([{ allowedSiteIds: [] }, { allowedDeviceIds: [] }])('short-circuits empty device/site scope %j', async (over) => {
    expect(await run({}, over)).toEqual({ incidents: [], total: 0, limit: 25, offset: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([
    { allowedSiteIds: [OTHER] },
    { allowedDeviceIds: [OTHER] },
    { allowedSiteIds: [OTHER], allowedDeviceIds: [ORG] },
  ])('narrows list and count to reachable affected devices %j', async (over) => {
    await run({}, over);
    const condition = page.where.mock.calls[0]![0];
    const compiled = new PgDialect().sqlToQuery(condition!);
    expect(compiled.sql).toContain('exists');
    expect(compiled.sql).toContain('"affected_devices" @> jsonb_build_array');
    expect(compiled.sql).toContain('"devices"."org_id" = "incidents"."org_id"');
    if (over.allowedSiteIds) {
      expect(compiled.sql).toContain('"devices"."site_id" in');
      expect(compiled.params).toContain(OTHER);
    }
    if (over.allowedDeviceIds) {
      expect(compiled.sql).toContain('"devices"."id" in');
      expect(compiled.params).toContain(over.allowedDeviceIds[0]);
    }
    expect(count.where).toHaveBeenCalledWith(condition);
  });
  it.each([{ scope: 'organization', orgId: null }, { scope: 'invalid' }])('rejects missing or invalid scope %j', async (over) => {
    expect((await run({}, over)).error).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([null, [], undefined].map((accessibleOrgIds) => [accessibleOrgIds]))('fails closed for a partner with accessibleOrgIds=%j', async (accessibleOrgIds) => {
    expect(await run({}, { accessibleOrgIds })).toEqual({ incidents: [], total: 0, limit: 25, offset: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('forwards all filters and uses stable descending order', async () => {
    const startDate = '2026-09-01T00:00:00Z';
    const endDate = '2026-09-20T00:00:00Z';
    await run({ orgId: ORG, status: 'analyzing', severity: 'p1', classification: 'mal%', assignedTo: OTHER, startDate, endDate });
    expect(page.where).toHaveBeenCalledWith(and(
      eq(incidents.orgId, ORG), eq(incidents.status, 'analyzing'), eq(incidents.severity, 'p1'),
      ilike(incidents.classification, 'mal%'), eq(incidents.assignedTo, OTHER),
      gte(incidents.detectedAt, new Date(startDate)), lte(incidents.detectedAt, new Date(endDate)),
    ));
    expect(count.where).toHaveBeenCalledWith(page.where.mock.calls[0]![0]);
    expect(page.orderBy).toHaveBeenCalledWith(desc(incidents.detectedAt), desc(incidents.createdAt), desc(incidents.id));
  });
  it('selects only the named safe columns, excluding timeline and all jsonb', async () => {
    await run();
    const projection = vi.mocked(db.select).mock.calls.map(([p]) => p).find((p) => p && 'id' in p)!;
    expect(Object.keys(projection).sort()).toEqual([
      'id', 'orgId', 'title', 'status', 'severity', 'classification', 'assignedTo',
      'detectedAt', 'resolvedAt', 'createdAt', 'updatedAt',
    ].sort());
  });
  it('returns a page with numeric total and clamps pagination', async () => {
    expect(await run({ limit: 999, offset: 7 })).toEqual({
      incidents: [{ id: OTHER, orgId: ORG, title: 'Incident' }], total: 1, limit: 100, offset: 7,
    });
    expect(page.limit).toHaveBeenCalledWith(100);
    expect(page.offset).toHaveBeenCalledWith(7);
  });
  it('returns empty results when no rows match', async () => {
    page = query([]); count = query([]);
    expect(await run()).toEqual({ incidents: [], total: 0, limit: 25, offset: 0 });
  });
  it.each([{ status: 'bad' }, { severity: 'critical' }, { startDate: 'bad' }, { assignedTo: 'bad' }, { orgId: 'bad' }])('rejects invalid filters %j', async (input) => {
    expect((await run(input)).error).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });
  it('sanitizes database failures', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => { throw new Error('private database detail'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await run()).error).toBe('The tool could not complete this request. Details were recorded in the server logs.');
    } finally { log.mockRestore(); }
  });
});
