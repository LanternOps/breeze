import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000f2';
const DEV2 = '00000000-0000-4000-8000-0000000000f3';
const ASSET = '00000000-0000-4000-8000-0000000000b3';
const GROUP = '00000000-0000-4000-8000-0000000000b4';

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[], capture?: (method: string, args: unknown[]) => void): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return (...args: unknown[]) => { capture?.(String(prop), args); return proxy; };
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  verify: vi.fn(),
  auditAsync: vi.fn(),
  feed: vi.fn(),
  getFunction: vi.fn(),
  upsertFunction: vi.fn(),
  clearFunction: vi.fn(),
  queueWarranty: vi.fn(),
  postureSummary: vi.fn(),
  postureDevices: vi.fn(),
  listManual: vi.fn(),
  createManual: vi.fn(),
  deleteManual: vi.fn(),
  listLinks: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  dissolveLink: vi.fn(),
  getLink: vi.fn(),
  getDeviceLink: vi.fn(),
  updateManual: vi.fn(),
  linkManual: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync }));
vi.mock('./deviceEventFeed', () => ({ queryDeviceEventFeed: h.feed }));
vi.mock('./deviceFunction', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDeviceFunction: h.getFunction,
  upsertDeviceFunction: h.upsertFunction,
  clearDeviceFunction: h.clearFunction,
}));
vi.mock('./warrantyWorker', () => ({ queueWarrantySyncForDevice: h.queueWarranty }));
vi.mock('./managementPostureReport', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getManagementPostureSummary: h.postureSummary,
  getPostureDevices: h.postureDevices,
}));
vi.mock('./manualAssetOps', () => ({
  listManualAssets: h.listManual, createManualAsset: h.createManual, deleteManualAsset: h.deleteManual,
  updateManualAsset: h.updateManual, linkManualAsset: h.linkManual, unlinkManualAsset: vi.fn(),
}));
vi.mock('./deviceLinkGroupOps', () => ({
  listLinkGroups: h.listLinks, createLinkGroup: h.createLink, updateLinkGroup: h.updateLink,
  dissolveLinkGroup: h.dissolveLink, getLinkGroup: h.getLink, getDeviceLinkGroup: h.getDeviceLink,
}));
vi.mock('./sentry', () => ({ captureException: h.capture }));
vi.mock('../routes/devices/helpers', () => ({ ensureOrgAccess: async (orgId: string) => orgId === ORG }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerDeviceInventoryTools, postureScope } from './aiToolsDeviceInventory';
import { registerDeviceLinkTools } from './aiToolsDeviceLinks';
import { registerManualAssetTools } from './aiToolsManualAssets';

const tools = new Map<string, AiTool>();
for (const register of [registerDeviceInventoryTools, registerDeviceLinkTools, registerManualAssetTools]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  canAccessSite: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const noMfa = () => makeAuth({ token: {} });
const deviceBound = () => makeAuth({ allowedDeviceIds: [DEV] });
const siteRestricted = () => makeAuth({ allowedSiteIds: [SITE], canAccessSite: (s: string) => s === SITE });

const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, unknown>;

const device = { id: DEV, orgId: ORG, siteId: SITE, hostname: 'host-1', displayName: null, osType: 'windows', status: 'online' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.verify.mockResolvedValue({ device });
  // verifiedUserIdOrNull: the caller is a users row.
  h.select.mockImplementation(() => chain([{ id: 'user-1' }]));
});

describe('get_device_events (W13-D4)', () => {
  const row = {
    id: 'e1', timestamp: '2026-10-27T00:00:00.000Z', action: 'script.execute', message: 'Script executed', category: 'script',
    result: 'success', actor: { type: 'user', name: 'tech@example.test', email: 'tech@example.test' },
    resource: { type: 'device', id: DEV, name: 'host-1' }, initiatedBy: 'manual',
    details: { secretish: 'x', deviceId: DEV }, errorMessage: null, ipAddress: '192.0.2.10',
  };

  it('never returns the actor email (not even as the name fallback), the IP address or details', async () => {
    h.feed.mockResolvedValue({ data: [row, { ...row, id: 'e2', actor: { type: 'user', name: 'Pat Tech', email: 'pat@example.test' } }], pagination: { page: 1, limit: 25, total: null } });
    const raw = await tools.get('get_device_events')!.handler({ deviceId: DEV }, makeAuth());
    expect(raw).not.toContain('tech@example.test');
    expect(raw).not.toContain('pat@example.test');
    expect(raw).not.toContain('192.0.2.10');
    expect(raw).not.toContain('secretish');
    const out = JSON.parse(raw) as { events: Array<{ actor: { name: string } }> };
    expect(out.events.map((e) => e.actor.name)).toEqual(['User', 'Pat Tech']);
  });

  it('an unreachable device is "not found" and the feed is never queried', async () => {
    h.verify.mockResolvedValue({ error: 'Device not found or access denied' });
    const out = await run('get_device_events', { deviceId: DEV });
    expect(out.code).toBe('NOT_FOUND');
    expect(h.feed).not.toHaveBeenCalled();
  });

  it('queries the feed for the device\'s own org with clamped paging and no automated / total arms', async () => {
    h.feed.mockResolvedValue({ data: [], pagination: { page: 1, limit: 100, total: null } });
    await run('get_device_events', { deviceId: DEV, limit: 5000, category: 'script' });
    expect(h.feed).toHaveBeenCalledWith({ id: DEV, orgId: ORG }, expect.objectContaining({
      limit: 100, page: 1, category: 'script', includeAutomated: false, withTotal: false,
    }));
  });
});

describe('manage_device_function', () => {
  it('set without an MFA claim is refused before any lookup; get needs none', async () => {
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: 'file_server' }, noMfa());
    expect(out.code).toBe('MFA_REQUIRED');
    expect(h.verify).not.toHaveBeenCalled();
    h.getFunction.mockResolvedValue({ deviceId: DEV, functionKey: null });
    expect((await run('manage_device_function', { action: 'get', deviceId: DEV }, noMfa())).functionKey).toBeNull();
  });

  it('a null functionKey clears through the service; a key writes a manual row with the verified user', async () => {
    h.clearFunction.mockResolvedValue({ outcome: 'cleared' });
    h.getFunction.mockResolvedValue({ deviceId: DEV, functionKey: null });
    await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: null });
    expect(h.clearFunction).toHaveBeenCalledWith({ deviceId: DEV, orgId: ORG, userId: 'user-1' });
    expect(h.upsertFunction).not.toHaveBeenCalled();

    h.upsertFunction.mockResolvedValue({ outcome: 'written', assessmentId: 'a1' });
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: 'file_server' });
    expect(h.upsertFunction).toHaveBeenCalledWith(expect.objectContaining({ functionKey: 'file_server', source: 'manual', userId: 'user-1' }));
    expect(out.outcome).toBe('written');
  });

  it('an unknown function key is refused by the route\'s own schema', async () => {
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: 'nonsense' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.upsertFunction).not.toHaveBeenCalled();
  });

  it('set omitting functionKey is refused (the route requires it)', async () => {
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.clearFunction).not.toHaveBeenCalled();
  });
});

describe('manage_device_warranty', () => {
  it('refresh refuses an agent-collected (HP) device and queues nothing', async () => {
    h.select.mockImplementation(() => chain([{ manufacturer: 'HP Inc.', dataSource: null }]));
    const out = await run('manage_device_warranty', { action: 'refresh', deviceId: DEV });
    expect(out.code).toBe('WARRANTY_REFRESH_NOT_AVAILABLE');
    expect(h.queueWarranty).not.toHaveBeenCalled();
  });

  it('refresh refuses imported data with no vendor lookup, saying the data was kept (#9862)', async () => {
    h.select.mockImplementation(() => chain([{ manufacturer: 'Acme Whitebox', dataSource: 'import' }]));
    const out = await run('manage_device_warranty', { action: 'refresh', deviceId: DEV });
    expect(out.code).toBe('WARRANTY_REFRESH_NOT_AVAILABLE');
    expect(out.error).toMatch(/existing warranty data was kept/i);
    expect(h.queueWarranty).not.toHaveBeenCalled();
  });

  it('refresh queues a forced sync for a vendor-looked-up device and audits it', async () => {
    h.select.mockImplementation(() => chain([{ manufacturer: 'Dell Inc.', dataSource: 'provider' }]));
    const out = await run('manage_device_warranty', { action: 'refresh', deviceId: DEV });
    expect(out).toMatchObject({ queued: true, deviceId: DEV });
    expect(h.queueWarranty).toHaveBeenCalledWith(DEV, { force: true });
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'device.warranty.refresh' }));
  });

  it('refresh without an MFA claim is refused; get and expiring need none', async () => {
    expect((await run('manage_device_warranty', { action: 'refresh', deviceId: DEV }, noMfa())).code).toBe('MFA_REQUIRED');
    h.select.mockImplementation(() => chain([]));
    expect((await run('manage_device_warranty', { action: 'expiring' }, noMfa())).devices).toEqual([]);
  });
});

describe('get_management_posture scope (W13-D12)', () => {
  it('an inaccessible orgId is "not found" and no aggregate runs', async () => {
    const out = await run('get_management_posture', { orgId: OTHER_ORG });
    expect(out.code).toBe('NOT_FOUND');
    expect(h.postureSummary).not.toHaveBeenCalled();
  });

  it('the exact-device axis is inside the SQL scope handed to the aggregate', () => {
    const unrestricted = postureScope(makeAuth(), undefined);
    const bound = postureScope(deviceBound(), undefined);
    const site = postureScope(siteRestricted(), undefined);
    expect(unrestricted).not.toBe('forbidden');
    const params = (s: unknown) => new PgDialect().sqlToQuery(s as SQL).params;
    expect(params(unrestricted)).not.toContain(DEV);
    expect(params(bound)).toContain(DEV);
    expect(params(site)).toContain(SITE);
  });

  it('product switches to the drill-down', async () => {
    h.postureDevices.mockResolvedValue({ devices: [], total: 0 });
    await run('get_management_posture', { product: 'OtherRMM', limit: 999 });
    expect(h.postureDevices).toHaveBeenCalledWith(expect.objectContaining({ product: 'OtherRMM', limit: 200, offset: 0, category: 'rmm' }));
    expect(h.postureSummary).not.toHaveBeenCalled();
  });
});

describe('manage_manual_assets', () => {
  it('a device-bound session is refused every action, before the service', async () => {
    for (const action of ['list', 'create', 'delete']) {
      const out = await run('manage_manual_assets', { action, assetId: ASSET }, deviceBound());
      expect(out.code, action).toBe('ACCESS_DENIED');
    }
    expect(h.listManual).not.toHaveBeenCalled();
    expect(h.deleteManual).not.toHaveBeenCalled();
  });

  it('a write without an MFA claim is refused; list needs none', async () => {
    expect((await run('manage_manual_assets', { action: 'delete', assetId: ASSET }, noMfa())).code).toBe('MFA_REQUIRED');
    h.listManual.mockResolvedValue({ status: 200, body: { data: [], pagination: {} } });
    expect((await run('manage_manual_assets', { action: 'list' }, noMfa())).assets).toEqual([]);
  });

  it('list passes the caller\'s site allowlist and projects away the device-only nulls', async () => {
    h.listManual.mockResolvedValue({
      status: 200,
      body: { data: [{ id: ASSET, displayName: 'Desk phone', siteId: SITE, agentVersion: null, osType: null }], pagination: { page: 1 } },
    });
    const out = await run('manage_manual_assets', { action: 'list' }, siteRestricted());
    const call = h.listManual.mock.calls[0]![0] as { allowedSiteIds: string[] | null; siteAllowed: (s: string) => boolean };
    expect(call.allowedSiteIds).toEqual([SITE]);
    expect(call.siteAllowed(SITE)).toBe(true);
    expect(call.siteAllowed('00000000-0000-4000-8000-0000000000a9')).toBe(false);
    expect(out.assets).toEqual([{ id: ASSET, name: 'Desk phone', siteId: SITE }]);
  });

  it('create defaults orgId to an org-scoped caller and records the verified user', async () => {
    h.createManual.mockResolvedValue({ status: 201, body: { id: ASSET, displayName: 'Spare laptop' } });
    await run('manage_manual_assets', { action: 'create', siteId: SITE, name: 'Spare laptop' });
    expect(h.createManual).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-1', data: expect.objectContaining({ orgId: ORG, siteId: SITE, name: 'Spare laptop' }),
    }));
  });

  it('an agent principal that is not a users row is recorded as NULL (W13-D5)', async () => {
    h.select.mockImplementation(() => chain([]));
    h.createManual.mockResolvedValue({ status: 201, body: { id: ASSET } });
    await run('manage_manual_assets', { action: 'create', siteId: SITE, name: 'x' }, makeAuth({
      principal: { kind: 'ai_agent', agentId: 'agent-1' }, user: { id: 'agent-1' }, aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
    }));
    expect(h.createManual).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }));
  });

  it('a service 404 becomes NOT_FOUND', async () => {
    h.deleteManual.mockResolvedValue({ status: 404, body: { error: 'Manual asset not found' } });
    expect((await run('manage_manual_assets', { action: 'delete', assetId: ASSET })).code).toBe('NOT_FOUND');
  });
});

describe('manage_device_links (W13-D12)', () => {
  const group = {
    id: GROUP, orgId: ORG, kind: 'multiboot', name: 'Dual boot', createdBy: 'user-9',
    members: [{ deviceId: DEV, hostname: 'a', agentVersion: '1.0' }, { deviceId: DEV2, hostname: 'b', agentVersion: '1.0' }],
  };

  it('a device-bound session may not create, update or dissolve', async () => {
    for (const action of ['create', 'update', 'dissolve']) {
      const out = await run('manage_device_links', { action, groupId: GROUP, deviceIds: [DEV, DEV2] }, deviceBound());
      expect(out.code, action).toBe('ACCESS_DENIED');
    }
    expect(h.createLink).not.toHaveBeenCalled();
    expect(h.updateLink).not.toHaveBeenCalled();
    expect(h.dissolveLink).not.toHaveBeenCalled();
  });

  it('a device-bound session sees only allowlisted members, and no group with none', async () => {
    h.listLinks.mockResolvedValue({
      status: 200,
      body: { data: [group, { ...group, id: 'g2', members: [{ deviceId: DEV2, hostname: 'b' }] }] },
    });
    const out = await run('manage_device_links', { action: 'list' }, deviceBound()) as { groups: Array<{ members: unknown[] }>; total: number };
    expect(out.total).toBe(1);
    expect(out.groups[0]!.members).toEqual([{ deviceId: DEV, hostname: 'a' }]);
  });

  it('create validates with the route schema and records the verified user', async () => {
    expect((await run('manage_device_links', { action: 'create', deviceIds: [DEV] })).code).toBe('VALIDATION_ERROR');
    h.createLink.mockResolvedValue({ status: 200, body: group });
    await run('manage_device_links', { action: 'create', deviceIds: [DEV, DEV2] });
    expect(h.createLink).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'user-1' }), expect.objectContaining({ kind: 'multiboot', deviceIds: [DEV, DEV2] }));
  });

  it('dissolve without an MFA claim is refused', async () => {
    expect((await run('manage_device_links', { action: 'dissolve', groupId: GROUP }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.dissolveLink).not.toHaveBeenCalled();
  });

  it('a group in another org is NOT_FOUND through the route\'s own org check', async () => {
    h.getLink.mockImplementation(async (deps: { hasOrgAccess: (o: string) => Promise<boolean> }) =>
      (await deps.hasOrgAccess(OTHER_ORG)) ? { status: 200, body: group } : { status: 404, body: { error: 'Link group not found' } });
    expect((await run('manage_device_links', { action: 'get', groupId: GROUP })).code).toBe('NOT_FOUND');
  });
});

describe('review fixes (#10343)', () => {
  it('get_device_events never lets search match the hidden details JSON (no oracle over email / IP / details)', async () => {
    h.feed.mockResolvedValue({ data: [], pagination: { page: 1, limit: 25, total: null } });
    await run('get_device_events', { deviceId: DEV, search: '@example.test' });
    expect(h.feed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ search: '@example.test', searchDetails: false }));
  });

  it('an unparseable time is refused, never silently dropped', async () => {
    expect((await run('get_device_events', { deviceId: DEV, from: 'yesterday' })).code).toBe('VALIDATION_ERROR');
    expect((await run('get_process_samples', { deviceId: DEV, at: 'yesterday' })).code).toBe('VALIDATION_ERROR');
    expect(h.feed).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('a committed function set whose read-back fails still reports the outcome', async () => {
    h.upsertFunction.mockResolvedValue({ outcome: 'written', assessmentId: 'a1' });
    h.getFunction.mockRejectedValue(new Error('connection reset'));
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: 'file_server' });
    expect(out).toMatchObject({ outcome: 'written', function: null });
    expect(out.error).toBeUndefined();
  });

  it('a function-key service refusal gets an actionable message', async () => {
    const { DeviceFunctionError } = await import('./deviceFunction');
    h.upsertFunction.mockRejectedValue(new DeviceFunctionError('label_required'));
    const out = await run('manage_device_function', { action: 'set', deviceId: DEV, functionKey: 'file_server' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(String(out.error)).toMatch(/needs a label/);
  });

  it('manual-asset create passes the duplicate-serial warnings through', async () => {
    h.createManual.mockResolvedValue({ status: 201, body: { id: ASSET, displayName: 'x', warnings: [{ code: 'DUPLICATE_SERIAL', message: 'dupe' }] } });
    const out = await run('manage_manual_assets', { action: 'create', siteId: SITE, name: 'x', serialNumber: 'S1' });
    expect(out.warnings).toEqual([{ code: 'DUPLICATE_SERIAL', message: 'dupe' }]);
  });

  it('an update that dissolves the group says so', async () => {
    h.updateLink.mockResolvedValue({ status: 200, body: { id: GROUP, dissolved: true, members: [] } });
    const out = await run('manage_device_links', { action: 'update', groupId: GROUP, removeDeviceIds: [DEV] });
    expect(out).toEqual({ dissolved: true, groupId: GROUP });
  });

  it('a dangling link-group reference is a DATA_INTEGRITY error reported to Sentry, never "not linked"', async () => {
    h.getDeviceLink.mockImplementation(async (deps: { reportDanglingReference: (e: Error) => void }) => {
      deps.reportDanglingReference(new Error('dangling'));
      return { status: 200, body: { group: null, members: [] } };
    });
    const out = await run('manage_device_links', { action: 'for_device', deviceId: DEV });
    expect(out.code).toBe('DATA_INTEGRITY');
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['manage_device_links', { action: 'create', deviceIds: [DEV, DEV2] }],
    ['manage_device_links', { action: 'update', groupId: GROUP, name: 'x' }],
    ['manage_manual_assets', { action: 'create', siteId: SITE, name: 'x' }],
    ['manage_manual_assets', { action: 'update', assetId: ASSET, name: 'x' }],
    ['manage_manual_assets', { action: 'link', assetId: ASSET, deviceId: DEV }],
    ['manage_manual_assets', { action: 'unlink', assetId: ASSET }],
    ['manage_device_function', { action: 'set', deviceId: DEV, functionKey: null }],
  ] as const)('%s %j without an MFA claim is refused before any service call', async (tool, input) => {
    expect((await run(tool, input, noMfa())).code).toBe('MFA_REQUIRED');
    for (const fn of [h.createLink, h.updateLink, h.createManual, h.updateManual, h.linkManual, h.clearFunction, h.verify]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('warranty get returns the row, or null when there is none', async () => {
    h.select.mockImplementation(() => chain([{ manufacturer: 'Dell Inc.', status: 'active', lastSyncError: null }]));
    expect((await run('manage_device_warranty', { action: 'get', deviceId: DEV })).warranty).toMatchObject({ manufacturer: 'Dell Inc.' });
    h.select.mockImplementation(() => chain([]));
    expect((await run('manage_device_warranty', { action: 'get', deviceId: DEV })).warranty).toBeNull();
  });

  it('agent health: a non-v1 or missing observation is "unknown"', async () => {
    h.select.mockImplementation(() => chain([{ schemaVersion: 2, observedAt: new Date(), receivedAt: new Date() }]));
    expect(await run('get_device_health', { deviceId: DEV })).toMatchObject({ status: 'unknown', observation: null });
    h.select.mockImplementation(() => chain([]));
    expect(await run('get_device_health', { deviceId: DEV })).toMatchObject({ status: 'unknown', observation: null });
  });

  it('process samples: an unreachable device is NOT_FOUND before any query', async () => {
    h.verify.mockResolvedValue({ error: 'Device not found or access denied' });
    expect((await run('get_process_samples', { deviceId: DEV })).code).toBe('NOT_FOUND');
    expect(h.select).not.toHaveBeenCalled();
  });
});

