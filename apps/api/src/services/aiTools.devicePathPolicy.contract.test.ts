/**
 * Contract: the tenant AI data policy (spec 2026-10-15 §2) is enforced in the
 * `executeTool` gate, after `enforceDeviceArgs`, for every principal.
 *
 * Real tool registry and real schemas; only the DB rows, the ambient DB access
 * context and the policy rows (`resolveAiDataPolicyForEstablishedPartner`)
 * are faked. The handler of each tool is spied so "reached the handler" is
 * observable without contacting a device.
 *
 * The partner-establishment block pins the W01 review requirement on #8854:
 * the gate resolves the level from the DEVICE org's partner, refuses (off
 * semantics, source `unresolved`) when that partner cannot be established or
 * disagrees with the context's own partner, and never falls back to the
 * built-in `no_user_profiles` default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiDeviceFileReadLevel } from '../db/schema/aiDataPolicies';

const DEV = '11111111-1111-1111-1111-111111111111';
const FINDING = '33333333-3333-3333-3333-333333333333';
const PARTNER = 'partner-1';

type Ctx = {
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  accessiblePartnerIds: string[] | null;
  currentPartnerId?: string | null;
};

const state = vi.hoisted(() => ({
  levels: {} as Record<string, AiDeviceFileReadLevel>,
  ctx: undefined as Ctx | undefined,
  device: null as null | { id: string; orgId: string; siteId: null; status: string; hostname: string; osType: string },
  // The device org's partner as read under the caller's RLS; absent = org row invisible.
  orgPartners: {} as Record<string, string>,
}));

vi.mock('./aiDataPolicy', async (orig) => ({
  ...(await orig<typeof import('./aiDataPolicy')>()),
  resolveAiDataPolicy: vi.fn(async () => { throw new Error('the gate must not use the default-falling resolver'); }),
  readOrgPartnerId: vi.fn(async (orgId: string) => state.orgPartners[orgId] ?? null),
  resolveAiDataPolicyForEstablishedPartner: vi.fn(async (orgId: string) => {
    const level = state.levels[orgId] ?? 'no_user_profiles';
    return { deviceFileReadLevel: level, toolOutputRetentionDays: 30, source: { deviceFileReadLevel: 'partner', toolOutputRetentionDays: 'default' } };
  }),
}));

vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  hasDbAccessContext: () => state.ctx !== undefined,
  getCurrentDbAccessContext: () => state.ctx,
  withDbAccessContext: async (_c: unknown, fn: () => Promise<unknown>) => fn(),
  // verifyDeviceAccess: db.select().from(devices).where(...).limit(1).
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => (state.device ? [state.device] : [])) })) })) })) },
}));

import { executeTool, aiTools } from './aiTools';
import { resolveAiDataPolicyForEstablishedPartner } from './aiDataPolicy';
import { PATH_FIELDS } from './aiToolPathFields';
import { OFF_DENIED_TOOLS, resolveDevicePolicyForGate, safePathFieldsFor } from './aiDevicePathPolicy';

const AUTH = {
  user: { id: 'u' }, orgId: 'org-session', partnerId: PARTNER, scope: 'partner',
  orgCondition: () => undefined, allowedDeviceIds: null, canAccessSite: () => true,
} as never;

const PARTNER_CTX: Ctx = { scope: 'partner', orgId: null, accessibleOrgIds: ['org-dev', 'org-dev-2'], accessiblePartnerIds: [PARTNER], currentPartnerId: PARTNER };
// An organization-session JWT carries partnerId = null (middleware/auth.ts).
const ORG_SESSION_CTX: Ctx = { scope: 'organization', orgId: 'org-dev', accessibleOrgIds: ['org-dev'], accessiblePartnerIds: [], currentPartnerId: null };

const PROFILE = 'C:\\Users\\bob\\Documents\\secret.docx';
const SYSTEM = 'C:\\ProgramData\\Vendor\\Logs';

function inputFor(tool: string, path: string): Record<string, unknown> {
  switch (tool) {
    case 'file_operations': return { deviceId: DEV, action: 'read', path };
    case 'analyze_disk_usage': return { deviceId: DEV, path };
    case 'disk_cleanup': return { deviceId: DEV, action: 'preview', path };
    case 'execute_command': return { deviceId: DEV, commandType: 'file_read', payload: { path } };
    case 'remediate_sensitive_data': return { findingIds: [FINDING], action: 'quarantine', quarantineDir: path };
    default: throw new Error(`no fixture for ${tool}`);
  }
}

function offInputFor(tool: string): Record<string, unknown> {
  switch (tool) {
    case 'file_operations': return { deviceId: DEV, action: 'list', path: SYSTEM };
    case 'request_diagnostic_access': return { deviceId: DEV, paths: [{ path: SYSTEM, recursive: false }], purpose: 'read the vendor log' };
    case 'diagnostic_list_directory': return { deviceId: DEV, path: SYSTEM };
    case 'diagnostic_read_file': return { deviceId: DEV, path: `${SYSTEM}\\app.log` };
    default: throw new Error(`no fixture for ${tool}`);
  }
}

const POLICY_TOOLS = [...new Set(Object.entries(PATH_FIELDS).filter(([, c]) => c.kind !== 'exempt').map(([k]) => k.split('.')[0]!))];
const DEVICE_BOUND_POLICY_TOOLS = POLICY_TOOLS.filter((t) => (aiTools.get(t)?.deviceArgs ?? []).length > 0);

function spyHandler(tool: string) {
  return vi.spyOn(aiTools.get(tool)!, 'handler').mockResolvedValue('{"ok":true}');
}

async function call(tool: string, input: Record<string, unknown>) {
  return JSON.parse(await executeTool(tool, input, AUTH)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveAiDataPolicyForEstablishedPartner).mockClear();
  state.levels = {};
  state.ctx = PARTNER_CTX;
  state.device = { id: DEV, orgId: 'org-dev', siteId: null, status: 'online', hostname: 'h', osType: 'windows' };
  state.orgPartners = { 'org-dev': PARTNER, 'org-dev-2': PARTNER };
});

describe('the policy table', () => {
  it('covers every non-exempt PATH_FIELDS tool and nothing else', () => {
    expect(POLICY_TOOLS.sort()).toEqual(['analyze_disk_usage', 'disk_cleanup', 'execute_command', 'file_operations', 'remediate_sensitive_data']);
    expect(safePathFieldsFor('file_operations').sort()).toEqual(['newPath', 'path']);
    expect(safePathFieldsFor('execute_command')).toEqual(['payload.path']);
    expect(safePathFieldsFor('request_diagnostic_access')).toEqual([]);
  });

  it('every off-denied tool is registered and gates its device', () => {
    for (const tool of OFF_DENIED_TOOLS) expect(aiTools.get(tool)?.deviceArgs).toEqual(['deviceId']);
  });
});

describe('device path policy in the executeTool gate', () => {
  it.each(DEVICE_BOUND_POLICY_TOOLS)('%s: profile path refused under no_user_profiles, system path reaches the handler', async (tool) => {
    const handler = spyHandler(tool);
    const refused = await call(tool, inputFor(tool, PROFILE));
    expect(refused.condition).toBe('policy_denied');
    expect(refused.policy).toEqual({ level: 'no_user_profiles', source: 'partner' });
    expect(refused.error).toMatch(/user profile folders.*no_user_profiles.*request_diagnostic_access/s);
    expect(handler).not.toHaveBeenCalled();
    await call(tool, inputFor(tool, SYSTEM));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(DEVICE_BOUND_POLICY_TOOLS)('%s: profile path allowed under any_with_approval', async (tool) => {
    state.levels['org-dev'] = 'any_with_approval';
    const handler = spyHandler(tool);
    await call(tool, inputFor(tool, PROFILE));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(DEVICE_BOUND_POLICY_TOOLS)('%s: profile path refused under off', async (tool) => {
    state.levels['org-dev'] = 'off';
    const handler = spyHandler(tool);
    const out = await call(tool, inputFor(tool, PROFILE));
    expect(out.condition).toBe('policy_denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it('file_operations newPath is checked too (rename into a profile)', async () => {
    const handler = spyHandler('file_operations');
    const out = await call('file_operations', { deviceId: DEV, action: 'rename', path: SYSTEM, newPath: 'C:\\Users\\bob\\Desktop\\x' });
    expect(out.condition).toBe('policy_denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([...OFF_DENIED_TOOLS])('%s: refused under off before the handler', async (tool) => {
    state.levels['org-dev'] = 'off';
    const handler = spyHandler(tool);
    const out = await call(tool, offInputFor(tool));
    expect(out.condition).toBe('policy_denied');
    expect(out.policy).toEqual({ level: 'off', source: 'partner' });
    expect(out.error).toMatch(/turned off/);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([...OFF_DENIED_TOOLS])('%s: reaches the handler under no_user_profiles with a non-profile path', async (tool) => {
    const handler = spyHandler(tool);
    await call(tool, offInputFor(tool));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('diagnostic tools are not path-checked by the level (the approved grant is the exception)', async () => {
    const handler = spyHandler('diagnostic_read_file');
    await call('diagnostic_read_file', { deviceId: DEV, path: PROFILE });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('execute_command file_list / file_read are refused under off; other command types are not', async () => {
    state.levels['org-dev'] = 'off';
    const handler = spyHandler('execute_command');
    for (const commandType of ['file_list', 'file_read']) {
      const out = await call('execute_command', { deviceId: DEV, commandType, payload: { path: SYSTEM } });
      expect(out.condition).toBe('policy_denied');
    }
    expect(handler).not.toHaveBeenCalled();
    await call('execute_command', { deviceId: DEV, commandType: 'list_processes' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('analyze_disk_usage and disk_cleanup stay reachable under off', async () => {
    state.levels['org-dev'] = 'off';
    for (const tool of ['analyze_disk_usage', 'disk_cleanup']) {
      const handler = spyHandler(tool);
      await call(tool, inputFor(tool, SYSTEM));
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it('resolves the level from the DEVICE org, not the session org or an input orgId', async () => {
    spyHandler('file_operations');
    await call('file_operations', { ...inputFor('file_operations', SYSTEM), orgId: 'org-other' });
    expect(vi.mocked(resolveAiDataPolicyForEstablishedPartner).mock.calls).toEqual([['org-dev', PARTNER]]);
  });

  it('takes no policy read for a device tool the policy cannot affect', async () => {
    const handler = spyHandler('execute_command');
    await call('execute_command', { deviceId: DEV, commandType: 'list_services' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(resolveAiDataPolicyForEstablishedPartner).not.toHaveBeenCalled();
  });

  it('the floor is refused at every level', async () => {
    const handler = spyHandler('file_operations');
    for (const level of ['off', 'no_user_profiles', 'any_with_approval'] as const) {
      state.levels['org-dev'] = level;
      const out = await call('file_operations', inputFor('file_operations', 'C:\\Users\\bob\\AppData\\x'));
      expect(out.error).toMatch(/blocked/);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('partner establishment (fail closed, never the built-in default)', () => {
  it('no ambient DB context: refused with off semantics, no policy read', async () => {
    // A self-managed tool would get a dispatch context; file_operations is not
    // one, so a contextless call models a caller that opened none.
    state.ctx = undefined;
    const handler = spyHandler('file_operations');
    const out = await call('file_operations', inputFor('file_operations', SYSTEM));
    expect(out.condition).toBe('policy_denied');
    expect(out.policy).toEqual({ level: 'off', source: 'unresolved' });
    expect(out.error).toMatch(/could not be established/);
    expect(handler).not.toHaveBeenCalled();
    expect(resolveAiDataPolicyForEstablishedPartner).not.toHaveBeenCalled();
  });

  it('context partner differs from the device org partner: refused, no policy read', async () => {
    state.ctx = { ...PARTNER_CTX, currentPartnerId: 'partner-other', accessiblePartnerIds: ['partner-other'] };
    const handler = spyHandler('file_operations');
    const out = await call('file_operations', inputFor('file_operations', SYSTEM));
    expect(out.policy).toEqual({ level: 'off', source: 'unresolved' });
    expect(handler).not.toHaveBeenCalled();
    expect(resolveAiDataPolicyForEstablishedPartner).not.toHaveBeenCalled();
  });

  it('partner scope whose partner grant excludes the device partner: refused', async () => {
    state.ctx = { ...PARTNER_CTX, accessiblePartnerIds: ['partner-other'] };
    const handler = spyHandler('file_operations');
    const out = await call('file_operations', inputFor('file_operations', SYSTEM));
    expect(out.policy).toEqual({ level: 'off', source: 'unresolved' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('device org row invisible (no partner): refused, never the no_user_profiles default', async () => {
    state.ctx = ORG_SESSION_CTX;
    state.orgPartners = {};
    const handler = spyHandler('analyze_disk_usage');
    const profile = await call('analyze_disk_usage', inputFor('analyze_disk_usage', PROFILE));
    expect(profile.policy).toEqual({ level: 'off', source: 'unresolved' });
    // off semantics: a non-profile scan root is still fine for disk usage.
    await call('analyze_disk_usage', inputFor('analyze_disk_usage', SYSTEM));
    expect(handler).toHaveBeenCalledTimes(1);
    const fileRead = await call('file_operations', inputFor('file_operations', SYSTEM));
    expect(fileRead.policy).toEqual({ level: 'off', source: 'unresolved' });
    expect(resolveAiDataPolicyForEstablishedPartner).not.toHaveBeenCalled();
  });

  it('org session (currentPartnerId null) gets the established partner ceiling: off stays off', async () => {
    state.ctx = ORG_SESSION_CTX;
    state.levels['org-dev'] = 'off';
    const handler = spyHandler('file_operations');
    const out = await call('file_operations', inputFor('file_operations', SYSTEM));
    expect(out.policy).toEqual({ level: 'off', source: 'partner' });
    expect(handler).not.toHaveBeenCalled();
    expect(vi.mocked(resolveAiDataPolicyForEstablishedPartner).mock.calls).toEqual([['org-dev', PARTNER]]);
  });

  it('org session (currentPartnerId null) with any_with_approval reaches the handler', async () => {
    state.ctx = ORG_SESSION_CTX;
    state.levels['org-dev'] = 'any_with_approval';
    const handler = spyHandler('file_operations');
    await call('file_operations', inputFor('file_operations', PROFILE));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('system scope trusts the device org partner', async () => {
    state.ctx = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, currentPartnerId: null };
    state.levels['org-dev'] = 'any_with_approval';
    const handler = spyHandler('file_operations');
    await call('file_operations', inputFor('file_operations', PROFILE));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('every fail-closed cause is logged by name (operators can tell why the AI refuses)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spyHandler('file_operations');
    const cases: Array<[() => void, string]> = [
      [() => { state.ctx = undefined; }, 'no_db_context'],
      [() => { state.ctx = ORG_SESSION_CTX; state.orgPartners = {}; }, 'org_unresolved'],
      [() => { state.ctx = { ...PARTNER_CTX, currentPartnerId: 'partner-other' }; }, 'partner_mismatch'],
      [() => { state.ctx = { ...PARTNER_CTX, accessiblePartnerIds: ['partner-other'] }; }, 'partner_not_granted'],
    ];
    for (const [arrange, cause] of cases) {
      state.ctx = PARTNER_CTX;
      state.orgPartners = { 'org-dev': PARTNER };
      arrange();
      warn.mockClear();
      await call('file_operations', inputFor('file_operations', SYSTEM));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('AI data policy unresolved'), expect.objectContaining({ cause, orgId: 'org-dev' }));
    }
  });

  it('a path tool that verifies no device cannot establish the owner: profile path refused at every level', async () => {
    // remediate_sensitive_data reaches devices through finding ids, not
    // deviceArgs, so the gate has no verified device org to resolve from.
    // Fail closed by design: no data owner to resolve from, so even a tenant at
    // any_with_approval cannot quarantine INTO a profile folder via this tool.
    const handler = spyHandler('remediate_sensitive_data');
    for (const level of ['off', 'no_user_profiles', 'any_with_approval'] as const) {
      state.levels['org-dev'] = level;
      const out = await call('remediate_sensitive_data', inputFor('remediate_sensitive_data', PROFILE));
      expect(out.policy).toEqual({ level: 'off', source: 'unresolved' });
      expect(out.error).toMatch(/does not name a device/);
    }
    expect(handler).not.toHaveBeenCalled();
    await call('remediate_sensitive_data', inputFor('remediate_sensitive_data', SYSTEM));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDevicePolicyForGate across several devices', () => {
  it('takes the strictest level across the verified device orgs', async () => {
    state.levels = { 'org-dev': 'any_with_approval', 'org-dev-2': 'off' };
    const policy = await resolveDevicePolicyForGate([{ orgId: 'org-dev' }, { orgId: 'org-dev-2' }, { orgId: 'org-dev' }]);
    expect(policy).toMatchObject({ deviceFileReadLevel: 'off' });
    expect(resolveAiDataPolicyForEstablishedPartner).toHaveBeenCalledTimes(2);
  });

  it('one unresolvable device org makes the whole call unresolved', async () => {
    state.levels = { 'org-dev': 'any_with_approval' };
    state.orgPartners = { 'org-dev': PARTNER };
    const policy = await resolveDevicePolicyForGate([{ orgId: 'org-dev' }, { orgId: 'org-gone' }]);
    expect(policy).toMatchObject({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'unresolved' } });
  });

  it('no verified devices: unresolved', async () => {
    expect(await resolveDevicePolicyForGate([])).toMatchObject({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'unresolved' } });
  });
});

