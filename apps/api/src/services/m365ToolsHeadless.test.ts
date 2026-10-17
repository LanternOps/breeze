import { describe, it, expect, vi, beforeEach } from 'vitest';

const execByOrg = vi.fn();
vi.mock('./m365ControlPlane/writeActionService', () => ({
  executeM365WriteActionByOrg: (...a: unknown[]) => execByOrg(...a),
}));
// aiToolsM365.ts <-> aiTools.ts is circular (aiTools.ts registers M365 tools
// at module top-level; aiToolsM365.ts pulls in readActionService.ts, which
// imports resolveWritableToolOrgId from aiTools.ts). Importing m365ToolTiers
// directly (this parity test's whole point) walks straight into that cycle
// and TDZ-throws on aiToolsM365's module-scope orgIdProperty. Stub out
// readActionService the same way aiToolsM365.test.ts already does to break
// the cycle — irrelevant to this test, which only reads m365ToolTiers.
vi.mock('./m365ControlPlane/readActionService', () => ({
  executeM365ReadAction: vi.fn(),
}));

import {
  M365_HEADLESS_ACTIONS,
  isHeadlessM365Tool,
  executeM365ToolHeadless,
  M365ConnectionUnavailableError,
} from './m365ToolsHeadless';
import { m365ToolTiers } from './aiToolsM365';
import { M365_WRITE_ACTION_IDS, M365_PROBE_ACTION_IDS } from '@breeze/shared/m365';

const ORG = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  execByOrg.mockReset();
});

describe('M365 headless parity contract', () => {
  it('maps exactly the Tier-3 m365 tools', () => {
    const tier3 = Object.entries(m365ToolTiers).filter(([, t]) => t === 3).map(([n]) => n).sort();
    expect(Object.keys(M365_HEADLESS_ACTIONS).sort()).toEqual(tier3);
  });

  it('isHeadlessM365Tool agrees with the map', () => {
    for (const name of Object.keys(M365_HEADLESS_ACTIONS)) {
      expect(isHeadlessM365Tool(name)).toBe(true);
    }
    expect(isHeadlessM365Tool('m365_query_users')).toBe(false);
    expect(isHeadlessM365Tool('google_suspend_user')).toBe(false);
  });
});

describe('executeM365ToolHeadless', () => {
  it('throws M365ConnectionUnavailableError on connection refusal (fail closed)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'no conn' });
    await expect(executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'a@b.com', reason: 'x' }, ORG))
      .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
  });

  it('throws for every connection-unavailable refusal code (tools_disabled/write_rate_limited/executor_unavailable)', async () => {
    for (const code of ['tools_disabled', 'write_rate_limited', 'executor_unavailable']) {
      execByOrg.mockResolvedValue({ ok: false, code, message: 'refused' });
      await expect(executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'a@b.com', reason: 'x' }, ORG))
        .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
    }
  });

  it('returns a JSON error body on a Graph-level failure (→ tool_returned_error)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'user_not_found', message: 'not found' });
    const out = await executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'ghost@b.com', reason: 'x' }, ORG);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBeTruthy();
    expect(parsed.success).toBeUndefined();
  });

  it('returns a success body carrying temporaryPassword for reset', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.reset_password', userId: 'u1', temporaryPassword: 'Tmp!23xyz789', forceChangeNextSignIn: true } });
    const out = await executeM365ToolHeadless('m365_reset_password', { userIdentifier: 'a@b.com', reason: 'x' }, ORG);
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.temporaryPassword).toBe('Tmp!23xyz789');
  });

  it('rejects an unknown tool name', async () => {
    await expect(executeM365ToolHeadless('m365_query_users', {}, ORG)).rejects.toThrow();
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('returns a JSON error body (not a throw) for invalid captured arguments', async () => {
    const out = await executeM365ToolHeadless('m365_disable_user', { userIdentifier: '', reason: '' }, ORG);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBeTruthy();
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('threads the idempotencyKey through to executeM365WriteActionByOrg when provided', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.disable', userId: 'u1' } });
    const INTENT_ID = 'intent-123';
    await executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'a@b.com', reason: 'x' }, ORG, INTENT_ID);
    expect(execByOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'm365.user.disable' }),
      expect.objectContaining({ idempotencyKey: INTENT_ID }),
    );
  });
});

const GROUP = '55555555-5555-4555-8555-555555555555';
const SKU = '66666666-6666-4666-8666-666666666666';
const DEVICE = '77777777-7777-4777-8777-777777777777';

describe('M365 headless ten-entry map (Operator Recipe Library M1)', () => {
  it('pins the exact tool -> action id map', () => {
    expect(M365_HEADLESS_ACTIONS).toEqual({
      m365_disable_user: 'm365.user.disable',
      m365_reset_password: 'm365.user.reset_password',
      m365_revoke_sessions: 'm365.user.revoke_sessions',
      m365_remove_license: 'm365.user.license.remove',
      m365_assign_license: 'm365.user.license.assign',
      m365_remove_from_group: 'm365.group.membership.remove',
      m365_add_to_group: 'm365.group.membership.add',
      m365_retire_intune_device: 'm365.intune.device.retire',
      m365_create_user: 'm365.user.create',
      m365_set_auto_reply: 'm365.user.mailbox.auto_reply',
    });
  });

  it('every mapped action is a write id and none is a probe id', () => {
    const writes = new Set<string>(M365_WRITE_ACTION_IDS);
    const probes = new Set<string>(M365_PROBE_ACTION_IDS);
    for (const id of Object.values(M365_HEADLESS_ACTIONS)) {
      expect(writes.has(id)).toBe(true);
      expect(probes.has(id)).toBe(false);
    }
  });

  it('fails closed (throws unavailable) on consent_upgrade_required', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'consent_upgrade_required', message: 'reconsent' });
    await expect(executeM365ToolHeadless('m365_revoke_sessions', { userIdentifier: 'a@b.com', reason: 'x' }, ORG))
      .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
  });

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['m365_revoke_sessions', { userIdentifier: 'a@b.com', reason: 'r' },
      { type: 'm365.user.revoke_sessions', userIdentifier: 'a@b.com', reason: 'r' }],
    ['m365_remove_license', { userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      { type: 'm365.user.license.remove', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' }],
    ['m365_assign_license', { userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      { type: 'm365.user.license.assign', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' }],
    ['m365_remove_from_group', { groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' }],
    ['m365_add_to_group', { groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      { type: 'm365.group.membership.add', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' }],
    ['m365_retire_intune_device', { managedDeviceId: DEVICE, reason: 'r' },
      { type: 'm365.intune.device.retire', managedDeviceId: DEVICE, reason: 'r' }],
    ['m365_create_user',
      { userPrincipalName: 'n@b.com', displayName: 'New U', mailNickname: 'nu', usageLocation: 'US', reason: 'r' },
      { type: 'm365.user.create', userPrincipalName: 'n@b.com', displayName: 'New U', mailNickname: 'nu', usageLocation: 'US', reason: 'r' }],
    ['m365_set_auto_reply', { userIdentifier: 'a@b.com', status: 'alwaysEnabled', internalReplyMessage: 'away', reason: 'r' },
      { type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@b.com', status: 'alwaysEnabled', internalReplyMessage: 'away', reason: 'r' }],
  ];

  it.each(cases)('%s builds the exact typed action from captured arguments', async (tool, args, expected) => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true } });
    await executeM365ToolHeadless(tool, args, ORG, 'intent-1');
    expect(execByOrg).toHaveBeenCalledWith(ORG, expected, expect.objectContaining({ idempotencyKey: 'intent-1' }));
  });

  it.each(cases)('%s with invalid captured arguments returns a JSON error and never calls the service', async (tool) => {
    const out = await executeM365ToolHeadless(tool, { reason: '' }, ORG);
    expect(JSON.parse(out).error).toBeTruthy();
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('does not spread stray keys: an extra captured key is dropped, not forwarded', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true } });
    await executeM365ToolHeadless('m365_revoke_sessions', { userIdentifier: 'a@b.com', reason: 'r', evil: 1 }, ORG);
    expect(execByOrg.mock.calls[0]![1]).not.toHaveProperty('evil');
  });

  it('buildWriteAction is exported', async () => {
    const mod = await import('./m365ToolsHeadless');
    expect(typeof mod.buildWriteAction).toBe('function');
  });
});
