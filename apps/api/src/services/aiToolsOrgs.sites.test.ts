import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn() }));
vi.mock('./tenantLifecycle', () => ({}));
vi.mock('./tenantOffboarding', () => ({}));

import { and, eq, ilike, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations, sites } from '../db/schema';
import { registerOrgTools } from './aiToolsOrgs';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = { id: SITE, orgId: ORG, name: 'Office', timezone: 'UTC', createdAt: '2026-09-17' };
const tools = new Map<string, AiTool>();
registerOrgTools(tools);
const auth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
  ...over,
}) as unknown as AuthContext;
const run = async (name: string, input: Record<string, unknown> = {}, over = {}) =>
  JSON.parse(await tools.get(name)!.handler(input, auth(over)));
function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain), where: vi.fn((_condition?: SQL) => chain),
    orderBy: vi.fn(() => chain), limit: vi.fn(() => chain), offset: vi.fn(() => chain),
    groupBy: vi.fn(() => chain), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}
let page: ReturnType<typeof query>;
let counts: ReturnType<typeof query>;
let total: ReturnType<typeof query>;
beforeEach(() => {
  vi.clearAllMocks();
  page = query([row]); counts = query([{ siteId: SITE, count: '3' }]); total = query([{ count: '1' }]);
  vi.mocked(db.select).mockImplementation((projection) => {
    const keys = Object.keys(projection ?? {});
    return (keys.includes('name') ? page : keys.includes('siteId') ? counts : total) as never;
  });
});
const notQuickSupport = sql`NOT EXISTS (
    SELECT 1 FROM ${organizations} qs_org
    WHERE qs_org.id = ${sites.orgId} AND qs_org.type = 'quick_support'
  )`;

describe('site reads', () => {
  it.each(['list_sites', 'get_site'])('registers %s as a Tier-1 accounts read', (name) => {
    expect(tools.get(name)).toMatchObject({ tier: 1, domain: 'accounts', deviceArgs: [] });
  });
  it.each(['partner', 'organization'])('denies cross-org explicit filters for %s', async (scope) => {
    expect((await run('list_sites', { orgId: OTHER }, { scope, orgId: ORG })).error).toMatch(/organization/);
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([null, undefined, []].map((accessibleOrgIds) => [accessibleOrgIds]))('fails closed for partner org allowlist %j', async (accessibleOrgIds) => {
    expect(await run('list_sites', {}, { accessibleOrgIds })).toEqual({ sites: [], total: 0, limit: 25, offset: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('short-circuits empty site scope', async () => {
    expect(await run('list_sites', {}, { allowedSiteIds: [] })).toEqual({ sites: [], total: 0, limit: 25, offset: 0 });
    expect(await run('get_site', { siteId: SITE }, { allowedSiteIds: [] })).toEqual({ error: 'Site not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('fails closed when allowedSiteIds is null (#6737)', async () => {
    expect(await run('list_sites', {}, { allowedSiteIds: null })).toEqual({ sites: [], total: 0, limit: 25, offset: 0 });
    expect(await run('get_site', { siteId: SITE }, { allowedSiteIds: null })).toEqual({ error: 'Site not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('scopes partner list and count identically and hides quick-support sites', async () => {
    expect(await run('list_sites')).toEqual({ sites: [{ ...row, deviceCount: 3 }], total: 1, limit: 25, offset: 0 });
    const condition = and(inArray(sites.orgId, [ORG]), notQuickSupport, undefined);
    expect(page.where).toHaveBeenCalledWith(condition);
    expect(total.where).toHaveBeenCalledWith(condition);
    expect(counts.where).toHaveBeenCalledWith(and(inArray(devices.siteId, [SITE]), eq(devices.isEphemeral, false), ne(devices.status, 'decommissioned'), undefined));
    expect(counts.groupBy).toHaveBeenCalledWith(devices.siteId);
  });
  it('narrows sites, escapes search, and clamps pagination', async () => {
    await run('list_sites', { orgId: ORG, search: 'a%b_', limit: 999, offset: 4 }, { allowedSiteIds: [SITE] });
    expect(page.where).toHaveBeenCalledWith(and(eq(sites.orgId, ORG), notQuickSupport, inArray(sites.id, [SITE]), ilike(sites.name, '%a\\%b\\_%')));
    expect(page.limit).toHaveBeenCalledWith(100); expect(page.offset).toHaveBeenCalledWith(4);
  });
  it('pins organization scope and allows system-wide reads', async () => {
    await run('list_sites', {}, { scope: 'organization', orgId: ORG });
    expect(page.where).toHaveBeenLastCalledWith(and(eq(sites.orgId, ORG), notQuickSupport, undefined));
    await run('list_sites', {}, { scope: 'system' });
    expect(page.where).toHaveBeenLastCalledWith(and(notQuickSupport, undefined));
  });
  it('narrows device counts to exact-device scope', async () => {
    await run('list_sites', {}, { allowedDeviceIds: [OTHER] });
    expect(counts.where).toHaveBeenCalledWith(and(inArray(devices.siteId, [SITE]), eq(devices.isEphemeral, false), ne(devices.status, 'decommissioned'), inArray(devices.id, [OTHER])));
  });
  it('skips device counting for an empty page', async () => {
    page = query([]); total = query([{ count: 0 }]);
    expect((await run('list_sites')).sites).toEqual([]);
    expect(counts.from).not.toHaveBeenCalled();
  });
  it.each(['list_sites', 'get_site'])('uses safe scalar projection for %s', async (name) => {
    await run(name, { siteId: SITE });
    const projection = vi.mocked(db.select).mock.calls.map(([p]) => p).find((p) => p && 'name' in p)!;
    expect(Object.keys(projection).sort()).toEqual(['id', 'orgId', 'name', 'timezone', 'createdAt'].sort());
  });
  it('returns an accessible site', async () => {
    expect(await run('get_site', { siteId: SITE })).toEqual({ site: row });
    expect(page.where).toHaveBeenCalledWith(eq(sites.id, SITE));
  });
  it.each([[], [{ ...row, orgId: OTHER }], [{ ...row, id: OTHER }]].map((rows) => [rows]))('conceals absent or inaccessible sites %j', async (rows) => {
    page = query(rows);
    expect(await run('get_site', { siteId: SITE }, { allowedSiteIds: [SITE] })).toEqual({ error: 'Site not found' });
  });
  it.each([{}, { siteId: 'bad' }])('requires a UUID: %j', async (input) => {
    expect(await run('get_site', input)).toEqual({ error: 'Site not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('sanitizes database errors', async () => {
    vi.mocked(db.select).mockImplementation(() => { throw new Error('private database detail'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await run('list_sites')).toEqual({ error: 'Operation failed. Check server logs for details.' }); }
    finally { log.mockRestore(); }
  });
});
