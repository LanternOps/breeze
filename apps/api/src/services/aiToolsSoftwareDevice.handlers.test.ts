import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000f2';
const DEF = '00000000-0000-4000-8000-0000000000b3';
const FINDING = '00000000-0000-4000-8000-0000000000b4';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';

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
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  verify: vi.fn(),
  queue: vi.fn(),
  auditAsync: vi.fn(),
  auditAwaited: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  clear: vi.fn(),
  listInventory: vi.fn(),
  listInventoryDevices: vi.fn(),
  searchNames: vi.fn(),
  isHoldingOrg: vi.fn(),
  lifecycle: vi.fn(),
  getField: vi.fn(),
  ensureOrgAccess: vi.fn(),
  validateMap: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select, insert: h.insert, update: h.update, delete: h.delete },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
  hasDbAccessContext: () => true,
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./aiDispatch', () => ({ aiQueueCommand: h.queue }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync, createAuditLog: h.auditAwaited }));
vi.mock('./softwareInventoryPolicy', () => ({
  approveInventorySoftware: h.approve,
  denyInventorySoftware: h.deny,
  clearInventorySoftware: h.clear,
  listInventory: h.listInventory,
  listInventoryDevices: h.listInventoryDevices,
  searchInventoryNames: h.searchNames,
}));
vi.mock('./unassignedPool/protectedOrg', () => ({ isHoldingOrg: h.isHoldingOrg }));
vi.mock('./fleetFindings/query', () => ({ applyFleetFindingLifecycle: h.lifecycle }));
vi.mock('./customFields/definitionAdmin', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCustomFieldWithAccess: h.getField,
  ensureOrgAccess: h.ensureOrgAccess,
}));
vi.mock('./customFields/validateValueMap', () => ({ validateCustomFieldMap: h.validateMap }));
vi.mock('./customFields/queries', () => ({ persistDeviceCustomFieldValues: h.persist }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { RemoteToolsDisabledByPolicyError } from './aiRemoteToolsPolicy';
import { homebrewBootstrapPayload } from './homebrewBootstrap';
import { registerDeviceSoftwareTools } from './aiToolsDeviceSoftware';
import { registerSoftwareInventoryTools } from './aiToolsSoftwareInventory';
import { registerFleetFindingTools } from './aiToolsFleetFindings';
import { registerCustomFieldTools } from './aiToolsCustomFields';

const tools = new Map<string, AiTool>();
for (const register of [registerDeviceSoftwareTools, registerSoftwareInventoryTools, registerFleetFindingTools, registerCustomFieldTools]) {
  register(tools);
}

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  partnerOrgAccess: undefined,
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
const siteRestricted = () => makeAuth({ allowedSiteIds: [SITE], canAccessSite: (s: string) => s === SITE });
const deviceBound = () => makeAuth({ allowedDeviceIds: [DEV] });
const agentNoMfa = () => makeAuth({
  principal: { kind: 'ai_agent', agentId: 'agent-1' }, token: {}, aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
});
const partnerAuth = (orgAccess: 'all' | 'selected') => makeAuth({
  scope: 'partner', partnerId: PARTNER, partnerOrgAccess: orgAccess, orgId: null,
});

const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, unknown>;

const device = (over: Record<string, unknown> = {}) => ({
  device: { id: DEV, orgId: ORG, hostname: 'host-1', osType: 'windows', status: 'online', customFields: null, ...over },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.queue.mockResolvedValue({ id: 'cmd-1' });
  h.isHoldingOrg.mockResolvedValue(false);
});

describe('manage_device_software', () => {
  it('a write without an MFA claim is refused before the device lookup; an ai_agent principal is exempt', async () => {
    const out = await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox' }, noMfa());
    expect(out.code).toBe('MFA_REQUIRED');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.queue).not.toHaveBeenCalled();

    h.verify.mockResolvedValue(device());
    const agentOut = await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox' }, agentNoMfa());
    expect(agentOut).toMatchObject({ queued: true, commandId: 'cmd-1' });
  });

  it.each(['macos', 'linux'])('a version pin on a %s update is a validation error and queues nothing', async (osType) => {
    h.verify.mockResolvedValue(device({ osType }));
    const out = await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox', version: '120.0' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('a Windows update forwards the version pin and packageId', async () => {
    h.verify.mockResolvedValue(device());
    await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox', version: '120.0', packageId: 'Mozilla.Firefox' });
    expect(h.queue).toHaveBeenCalledWith(expect.anything(), 'manage_device_software', DEV, 'software_update',
      { name: 'Firefox', source: 'ai_tool', version: '120.0', packageId: 'Mozilla.Firefox' }, 'user-1');
  });

  it('a non-Windows update never forwards packageId', async () => {
    h.verify.mockResolvedValue(device({ osType: 'macos' }));
    await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox', packageId: 'Mozilla.Firefox' });
    expect(h.queue.mock.calls[0]![4]).toEqual({ name: 'Firefox', source: 'ai_tool' });
  });

  it('an uninstall payload never carries packageId', async () => {
    h.verify.mockResolvedValue(device());
    await run('manage_device_software', { action: 'uninstall', deviceId: DEV, name: 'Firefox', packageId: 'Mozilla.Firefox' });
    expect(h.queue).toHaveBeenCalledOnce();
    expect(h.queue.mock.calls[0]![3]).toBe('software_uninstall');
    expect(h.queue.mock.calls[0]![4]).not.toHaveProperty('packageId');
  });

  it('a decommissioned device is refused', async () => {
    h.verify.mockResolvedValue(device({ status: 'decommissioned' }));
    const out = await run('manage_device_software', { action: 'uninstall', deviceId: DEV, name: 'Firefox' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('a remote-tools policy denial is POLICY_DENIED and writes no audit row', async () => {
    h.verify.mockResolvedValue(device());
    h.queue.mockRejectedValue(new RemoteToolsDisabledByPolicyError(DEV, 'software_update', 'AI remote tools are disabled'));
    const out = await run('manage_device_software', { action: 'update', deviceId: DEV, name: 'Firefox' });
    expect(out.code).toBe('POLICY_DENIED');
    expect(h.auditAsync).not.toHaveBeenCalled();
  });
});

describe('bootstrap_homebrew', () => {
  it('needs MFA', async () => {
    expect((await run('bootstrap_homebrew', { deviceId: DEV }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each(['windows', 'linux'])('is refused on %s', async (osType) => {
    h.verify.mockResolvedValue(device({ osType }));
    expect((await run('bootstrap_homebrew', { deviceId: DEV })).code).toBe('NOT_SUPPORTED');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('queues the pinned installer payload on macOS', async () => {
    h.verify.mockResolvedValue(device({ osType: 'macos' }));
    const out = await run('bootstrap_homebrew', { deviceId: DEV });
    expect(out).toMatchObject({ queued: true, commandId: 'cmd-1' });
    expect(h.queue).toHaveBeenCalledWith(expect.anything(), 'bootstrap_homebrew', DEV, 'homebrew_bootstrap', homebrewBootstrapPayload(), 'user-1');
  });

  it('a policy denial is POLICY_DENIED', async () => {
    h.verify.mockResolvedValue(device({ osType: 'macos' }));
    h.queue.mockRejectedValue(new RemoteToolsDisabledByPolicyError(DEV, 'homebrew_bootstrap', 'AI remote tools are disabled'));
    expect((await run('bootstrap_homebrew', { deviceId: DEV })).code).toBe('POLICY_DENIED');
  });
});

describe('manage_software_inventory', () => {
  it('reads are refused to a device-bound session', async () => {
    for (const input of [{ action: 'list' }, { action: 'names', query: 'fire' }, { action: 'devices', softwareName: 'Firefox' }]) {
      expect((await run('manage_software_inventory', input, deviceBound())).code, input.action).toBe('ACCESS_DENIED');
    }
    expect(h.listInventory).not.toHaveBeenCalled();
    expect(h.searchNames).not.toHaveBeenCalled();
    expect(h.listInventoryDevices).not.toHaveBeenCalled();
  });

  it('writes are refused to a site-restricted session', async () => {
    for (const action of ['approve', 'deny', 'clear']) {
      expect((await run('manage_software_inventory', { action, softwareName: 'Firefox' }, siteRestricted())).code, action).toBe('ACCESS_DENIED');
    }
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.deny).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('writes need MFA', async () => {
    expect((await run('manage_software_inventory', { action: 'approve', softwareName: 'Firefox' }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('writes pass refuseForeignConfigLink, actor ai and the verified actor id to the service', async () => {
    h.select.mockImplementationOnce(() => chain([{ id: 'user-1' }]));
    h.approve.mockResolvedValue({ status: 200, body: { ok: true } });
    const out = await run('manage_software_inventory', { action: 'approve', softwareName: 'Firefox', vendor: 'Mozilla' });
    expect(out).toEqual({ ok: true });
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, softwareName: 'Firefox', vendor: 'Mozilla', actor: 'ai', refuseForeignConfigLink: true, actorUserId: 'user-1',
    }));

    h.select.mockImplementationOnce(() => chain([]));
    h.deny.mockResolvedValue({ status: 200, body: { ok: true } });
    await run('manage_software_inventory', { action: 'deny', softwareName: 'Firefox' });
    expect(h.deny).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, actor: 'ai', refuseForeignConfigLink: true }));
  });

  it('a service 409 surfaces as CONFLICT', async () => {
    h.select.mockImplementationOnce(() => chain([{ id: 'user-1' }]));
    h.clear.mockResolvedValue({ status: 409, body: { error: 'default policy carries other settings' } });
    const out = await run('manage_software_inventory', { action: 'clear', softwareName: 'Firefox' });
    expect(out.code).toBe('CONFLICT');
  });

  it('the holding org is refused', async () => {
    h.isHoldingOrg.mockResolvedValue(true);
    const out = await run('manage_software_inventory', { action: 'approve', softwareName: 'Firefox' });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.approve).not.toHaveBeenCalled();
  });
});

describe('manage_fleet_findings', () => {
  const finding = { id: FINDING, orgId: ORG, status: 'acknowledged', title: 'Stale AV definitions' };

  it('needs MFA; an ai_agent principal is exempt', async () => {
    expect((await run('manage_fleet_findings', { action: 'acknowledge', findingId: FINDING }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.lifecycle).not.toHaveBeenCalled();
    h.select.mockImplementationOnce(() => chain([]));
    h.lifecycle.mockResolvedValue({ ok: true, finding });
    expect(await run('manage_fleet_findings', { action: 'acknowledge', findingId: FINDING }, agentNoMfa())).toMatchObject({ id: FINDING });
  });

  it('passes null as the acting user when the users lookup misses', async () => {
    h.select.mockImplementationOnce(() => chain([]));
    h.lifecycle.mockResolvedValue({ ok: true, finding });
    await run('manage_fleet_findings', { action: 'acknowledge', findingId: FINDING });
    expect(h.lifecycle).toHaveBeenCalledWith(expect.anything(), FINDING, 'acknowledge', undefined, null);
  });

  it('passes the verified users id when it exists', async () => {
    h.select.mockImplementationOnce(() => chain([{ id: 'user-1' }]));
    h.lifecycle.mockResolvedValue({ ok: true, finding: { ...finding, status: 'dismissed' } });
    await run('manage_fleet_findings', { action: 'dismiss', findingId: FINDING, notes: 'known' });
    expect(h.lifecycle).toHaveBeenCalledWith(expect.anything(), FINDING, 'dismiss', 'known', 'user-1');
  });

  it('a 404 from the service is one opaque not-found', async () => {
    h.select.mockImplementationOnce(() => chain([]));
    h.lifecycle.mockResolvedValue({ ok: false, status: 404, error: 'Finding not found' });
    expect((await run('manage_fleet_findings', { action: 'reopen', findingId: FINDING })).code).toBe('NOT_FOUND');
  });
});

describe('manage_custom_fields', () => {
  const fieldRow = (over: Record<string, unknown> = {}) => ({
    id: DEF, orgId: ORG, partnerId: null, name: 'License', fieldKey: 'license_key', type: 'text', options: null,
    required: false, defaultValue: null, deviceTypes: null, scriptWrite: false, createdAt: new Date(0), updatedAt: new Date(0), ...over,
  });

  it('needs MFA for every action', async () => {
    expect((await run('manage_custom_fields', { action: 'set_values', deviceId: DEV, values: { license_key: 'x' } }, noMfa())).code).toBe('MFA_REQUIRED');
    expect((await run('manage_custom_fields', { action: 'delete_definition', definitionId: DEF }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.getField).not.toHaveBeenCalled();
  });

  it.each(['update_definition', 'delete_definition'])('%s on an existing partner-wide row is refused, even to a full-access partner admin', async (action) => {
    h.getField.mockResolvedValue(fieldRow({ orgId: null, partnerId: PARTNER }));
    h.update.mockImplementation(() => chain([fieldRow({ orgId: null, partnerId: PARTNER, name: 'New' })]));
    h.delete.mockImplementation(() => chain([{ id: DEF }]));
    const out = await run('manage_custom_fields', { action, definitionId: DEF, name: 'New' }, partnerAuth('all'));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(String(out.error)).toMatch(/partner-wide/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
  });

  it('update_definition on an org-owned row is applied (control)', async () => {
    h.getField.mockResolvedValue(fieldRow());
    h.update.mockImplementation(() => chain([fieldRow({ name: 'New' })]));
    const out = await run('manage_custom_fields', { action: 'update_definition', definitionId: DEF, name: 'New' });
    expect(out.definition).toMatchObject({ id: DEF, name: 'New' });
  });

  it('a partner-wide create needs full partner access', async () => {
    const input = { action: 'create_definition', ownerScope: 'partner', name: 'License', fieldKey: 'license_key', type: 'text' };
    const refused = await run('manage_custom_fields', input, partnerAuth('selected'));
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(h.insert).not.toHaveBeenCalled();

    const values: unknown[] = [];
    h.insert.mockImplementation(() => chain([fieldRow({ orgId: null, partnerId: PARTNER })], (m, args) => {
      if (m === 'values') values.push(args[0]);
    }));
    const ok = await run('manage_custom_fields', input, partnerAuth('all'));
    expect(ok.definition).toMatchObject({ partnerId: PARTNER });
    expect(values[0]).toMatchObject({ orgId: null, partnerId: PARTNER });
  });

  it('definition writes are refused to a site-restricted session', async () => {
    const out = await run('manage_custom_fields', { action: 'create_definition', name: 'L', fieldKey: 'l', type: 'text' }, siteRestricted());
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('set_values refuses more than 50 keys before the device lookup', async () => {
    const values = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    const out = await run('manage_custom_fields', { action: 'set_values', deviceId: DEV, values });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('set_values returns previous values and awaits a keys-only audit row', async () => {
    h.verify.mockResolvedValue(device({ customFields: { license_key: 'OLD-SECRET-VALUE', other: 'untouched' } }));
    h.validateMap.mockResolvedValue({ ok: true, writes: { license_key: 'NEW-SECRET-VALUE' } });
    h.select.mockImplementationOnce(() => chain([{ customFields: { license_key: 'NEW-SECRET-VALUE', other: 'untouched' } }]));
    let auditLanded = false;
    h.auditAwaited.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      auditLanded = true;
    });
    const out = await run('manage_custom_fields', { action: 'set_values', deviceId: DEV, values: { license_key: 'NEW-SECRET-VALUE' } });
    expect(auditLanded).toBe(true);
    expect(out).toEqual({ deviceId: DEV, values: { license_key: 'NEW-SECRET-VALUE' }, previous: { license_key: 'OLD-SECRET-VALUE' } });
    expect(h.persist).toHaveBeenCalledWith(DEV, ORG, { license_key: 'NEW-SECRET-VALUE' }, 'manual');
    expect(h.auditAwaited).toHaveBeenCalledOnce();
    const auditRow = h.auditAwaited.mock.calls[0]![0] as { details: Record<string, unknown> };
    expect(auditRow.details.changedFields).toEqual(['license_key']);
    expect(JSON.stringify(auditRow)).not.toMatch(/SECRET-VALUE/);
  });

  it('set_values with invalid values writes nothing', async () => {
    h.verify.mockResolvedValue(device());
    h.validateMap.mockResolvedValue({ ok: false, rejected: [{ key: 'license_key', reason: 'unknown field' }] });
    const out = await run('manage_custom_fields', { action: 'set_values', deviceId: DEV, values: { license_key: 'x' } });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.persist).not.toHaveBeenCalled();
  });
});
