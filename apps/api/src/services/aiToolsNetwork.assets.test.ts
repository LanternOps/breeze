import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));
vi.mock('./networkBaselineAuthority', () => ({
  BaselineAuthorityUnsupportedError: class extends Error {}, buildBaselineAuthorityEnvelope: vi.fn(),
}));

import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerNetworkTools } from './aiToolsNetwork';
import { SITE_SCOPE_EMPTY_NOTE } from './aiToolsSiteScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const ASSET = '44444444-4444-4444-8444-444444444444';
const tools = new Map<string, AiTool>();
registerNetworkTools(tools);
const orgCondition = vi.fn(() => eq(discoveredAssets.orgId, ORG));
const auth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', accessibleOrgIds: [ORG], orgId: null,
  canAccessOrg: (id: string) => id === ORG, orgCondition,
  canAccessSite: (id: string) => id === SITE, ...over,
}) as unknown as AuthContext;
const run = async (name: string, input: Record<string, unknown> = {}, over = {}) =>
  JSON.parse(await tools.get(name)!.handler(input, auth(over)));
function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain), where: vi.fn((_condition?: SQL) => chain),
    orderBy: vi.fn(() => chain), limit: vi.fn(async () => rows),
  };
  return chain;
}
let page: ReturnType<typeof query>;
const row = { id: ASSET, orgId: ORG, siteId: SITE, linkedDeviceId: OTHER, macAddress: null, model: 'Printer' };
beforeEach(() => {
  vi.clearAllMocks();
  page = query([row]);
  vi.mocked(db.select).mockImplementation(() => page as never);
});

describe('network asset reads', () => {
  it.each(['list_network_assets', 'get_network_asset'])('registers %s as a Tier-1 network read', (name) => {
    expect(tools.get(name)).toMatchObject({ tier: 1, domain: 'network' });
    expect(tools.get(name)!.searchHint.length).toBeLessThanOrEqual(120);
  });
  it('requires orgId for a partner with multiple organizations', async () => {
    expect((await run('list_network_assets', {}, { accessibleOrgIds: [ORG, OTHER] })).error).toMatch(/orgId is required/);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('auto-resolves the sole partner organization and defaults the limit', async () => {
    const out = await run('list_network_assets');
    expect(out).toEqual({ assets: [{ ...row, nicVendor: null }], showing: 1 });
    expect(page.where).toHaveBeenCalledWith(and(eq(discoveredAssets.orgId, ORG)));
    expect(page.limit).toHaveBeenCalledWith(50);
    expect(page.orderBy).toHaveBeenCalledWith(desc(discoveredAssets.lastSeenAt));
  });
  it.each([null, [], undefined].map((accessibleOrgIds) => [accessibleOrgIds]))('fails closed for partner orgs %j', async (accessibleOrgIds) => {
    expect((await run('list_network_assets', {}, { accessibleOrgIds })).error).toBeTruthy();
    expect(await run('get_network_asset', { assetId: ASSET }, { accessibleOrgIds })).toEqual({ error: 'Asset not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each(['organization', 'partner'])('denies cross-org requests for %s', async (scope) => {
    expect((await run('list_network_assets', { orgId: OTHER }, { scope, orgId: ORG })).error).toMatch(/organization/);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('requires an org for system scope and accepts an explicit accessible org', async () => {
    expect((await run('list_network_assets', {}, { scope: 'system' })).error).toMatch(/orgId is required/);
    expect((await run('list_network_assets', { orgId: ORG }, { scope: 'system' })).showing).toBe(1);
  });
  it('short-circuits empty site access', async () => {
    expect(await run('list_network_assets', {}, { allowedSiteIds: [] })).toEqual({ assets: [], showing: 0, note: SITE_SCOPE_EMPTY_NOTE });
    expect(await run('get_network_asset', { assetId: ASSET }, { allowedSiteIds: [] })).toEqual({ error: 'Asset not found' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('denies an explicit site outside the allowlist', async () => {
    expect((await run('list_network_assets', { siteId: OTHER }, { allowedSiteIds: [SITE] })).error).toBe('Access to this site denied');
    expect(db.select).not.toHaveBeenCalled();
  });
  it('narrows by site and device independently and forwards filters', async () => {
    await run('list_network_assets', { approvalStatus: 'approved', assetType: 'printer', linkedDeviceId: OTHER, limit: 999 }, {
      allowedSiteIds: [SITE], allowedDeviceIds: [OTHER],
    });
    expect(page.where).toHaveBeenCalledWith(and(
      eq(discoveredAssets.orgId, ORG), inArray(discoveredAssets.siteId, [SITE]),
      inArray(discoveredAssets.linkedDeviceId, [OTHER]), eq(discoveredAssets.approvalStatus, 'approved'),
      eq(discoveredAssets.assetType, 'printer'), eq(discoveredAssets.linkedDeviceId, OTHER),
    ));
    expect(page.limit).toHaveBeenCalledWith(200);
  });
  it('applies device scope without site scope', async () => {
    await run('list_network_assets', {}, { allowedDeviceIds: [OTHER] });
    expect(page.where).toHaveBeenCalledWith(and(eq(discoveredAssets.orgId, ORG), inArray(discoveredAssets.linkedDeviceId, [OTHER])));
  });
  it.each(['list_network_assets', 'get_network_asset'])('uses only safe scalar projections in %s', async (name) => {
    await run(name, { assetId: ASSET });
    expect(Object.keys(vi.mocked(db.select).mock.calls[0]![0]!).sort()).toEqual([
      'id', 'orgId', 'siteId', 'assetType', 'approvalStatus', 'hostname', 'label', 'ipAddress', 'macAddress',
      'manufacturer', 'model', 'linkedDeviceId', 'detectedAssetType', 'isOnline', 'firstSeenAt', 'lastSeenAt',
    ].sort());
  });
  it('scopes detail by id and org and returns a safe asset', async () => {
    expect(await run('get_network_asset', { assetId: ASSET })).toEqual({ asset: { ...row, nicVendor: null } });
    expect(orgCondition).toHaveBeenCalledWith(discoveredAssets.orgId);
    expect(page.where).toHaveBeenCalledWith(and(eq(discoveredAssets.id, ASSET), eq(discoveredAssets.orgId, ORG)));
  });
  it.each([
    [], [{ ...row, orgId: OTHER }], [{ ...row, siteId: OTHER }],
  ].map((rows) => [rows]))('uses the same not-found response for missing, cross-org and cross-site rows %j', async (rows) => {
    page = query(rows);
    expect(await run('get_network_asset', { assetId: ASSET }, { allowedSiteIds: [SITE] })).toEqual({ error: 'Asset not found' });
  });
  it.each([null, ORG])('denies detail outside the exact-device scope: %j', async (linkedDeviceId) => {
    page = query([{ ...row, linkedDeviceId }]);
    expect(await run('get_network_asset', { assetId: ASSET }, { allowedDeviceIds: [OTHER] })).toEqual({ error: 'Asset not found' });
  });
  it.each([{ assetId: 'bad' }, {}])('rejects invalid detail ids %j', async (input) => {
    expect((await run('get_network_asset', input)).error).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });
});
