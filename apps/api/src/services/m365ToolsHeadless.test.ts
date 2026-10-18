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

// Caller verification W05: the two protected tools resolve their pinned intent
// through aiToolsM365 (lazy-imported by the headless module). The loader and
// the two session handlers are mocked; m365ToolTiers stays real for parity.
const { loadMutation, disableHandler, resetHandler, buildAuth } = vi.hoisted(() => ({
  loadMutation: vi.fn(),
  disableHandler: vi.fn(),
  resetHandler: vi.fn(),
  buildAuth: vi.fn(),
}));
vi.mock('./aiToolsM365', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    loadM365MutationContext: loadMutation,
    m365DisableUserHandler: disableHandler,
    m365ResetPasswordHandler: resetHandler,
  };
});
vi.mock('./actionIntents/actorContext', () => ({ buildAuthContextForIntent: buildAuth }));

import {
  M365_HEADLESS_ACTIONS,
  isHeadlessM365Tool,
  executeM365ToolHeadless,
  M365ConnectionUnavailableError,
} from './m365ToolsHeadless';
import { m365ToolTiers } from './aiToolsM365';
import { M365_WRITE_ACTION_IDS, M365_PROBE_ACTION_IDS } from '@breeze/shared/m365';
import { CallerVerificationRequiredError, CallerVerificationValidationError } from './callerVerification/errors';

const ORG = '44444444-4444-4444-8444-444444444444';

const OID = '88888888-8888-4888-8888-888888888888';
const PINNED_INTENT = 'intent-123';

/** A released protected intent pinned to `backend`. */
function pinned(backend: 'controlPlane' | 'direct' | 'delegant') {
  return {
    intent: { id: PINNED_INTENT, requestedByUserId: 'user-1' },
    ctx: { backend, orgId: ORG, connectionId: 'conn-1' },
    userId: OID,
  };
}

beforeEach(() => {
  execByOrg.mockReset();
  loadMutation.mockReset();
  loadMutation.mockImplementation(async () => pinned('controlPlane'));
  disableHandler.mockReset();
  resetHandler.mockReset();
  buildAuth.mockReset();
  buildAuth.mockResolvedValue({ user: { id: 'user-1' }, orgId: ORG });
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
  const DISABLE_INPUT = { userIdentifier: 'a@b.com', reason: 'x' };

  it('throws M365ConnectionUnavailableError on connection refusal (fail closed)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'no conn' });
    await expect(executeM365ToolHeadless('m365_disable_user', DISABLE_INPUT, ORG, PINNED_INTENT))
      .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
  });

  it('throws M365ConnectionUnavailableError for pre-dispatch refusal codes (tools_disabled/write_rate_limited)', async () => {
    for (const code of ['tools_disabled', 'write_rate_limited']) {
      execByOrg.mockResolvedValue({ ok: false, code, message: 'refused' });
      await expect(executeM365ToolHeadless('m365_disable_user', DISABLE_INPUT, ORG, PINNED_INTENT))
        .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
    }
  });

  it('executor_unavailable after the caller-verified dispatch marker is an attempted execution, not "nothing sent"', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'executor_unavailable', message: 'refused' });
    const outcome = executeM365ToolHeadless('m365_disable_user', DISABLE_INPUT, ORG, PINNED_INTENT);
    await expect(outcome).rejects.toThrow('confirm the outcome in Entra');
    await expect(outcome).rejects.not.toBeInstanceOf(M365ConnectionUnavailableError);
  });

  it('returns a JSON error body on a Graph-level failure (→ tool_returned_error)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'user_not_found', message: 'not found' });
    const out = await executeM365ToolHeadless('m365_disable_user', DISABLE_INPUT, ORG, PINNED_INTENT);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBeTruthy();
    expect(parsed.success).toBeUndefined();
  });

  it('returns a success body carrying temporaryPassword for reset', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.reset_password', userId: 'u1', temporaryPassword: 'Tmp!23xyz789', forceChangeNextSignIn: true } });
    const out = await executeM365ToolHeadless('m365_reset_password', DISABLE_INPUT, ORG, PINNED_INTENT);
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.temporaryPassword).toBe('Tmp!23xyz789');
  });

  it('rejects an unknown tool name', async () => {
    await expect(executeM365ToolHeadless('m365_query_users', {}, ORG)).rejects.toThrow();
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('returns a JSON error body (not a throw) for invalid captured arguments', async () => {
    const out = await executeM365ToolHeadless('m365_disable_user', { userIdentifier: '', reason: '' }, ORG, PINNED_INTENT);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBeTruthy();
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('threads the intent id through as BOTH actionIntentId and idempotencyKey for a control-plane pin', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.disable', userId: 'u1' } });
    await executeM365ToolHeadless('m365_disable_user', DISABLE_INPUT, ORG, PINNED_INTENT);
    expect(execByOrg).toHaveBeenCalledTimes(1);
    expect(execByOrg).toHaveBeenCalledWith(
      ORG,
      { type: 'm365.user.disable', oid: OID, reason: 'x' },
      { actionIntentId: PINNED_INTENT, idempotencyKey: PINNED_INTENT, actorId: 'user-1' },
    );
  });
});

describe('protected M365 headless release (#6354 W05)', () => {
  const INPUT = { userIdentifier: 'a@b.com', reason: 'x' };

  it('control-plane pin: the action is oid-only (no userIdentifier) and the handlers are never used', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true } });
    await executeM365ToolHeadless('m365_reset_password', INPUT, ORG, PINNED_INTENT);
    const sent = execByOrg.mock.calls[0]![1];
    expect(sent).toEqual({ type: 'm365.user.reset_password', oid: OID, reason: 'x' });
    expect(sent).not.toHaveProperty('userIdentifier');
    expect(disableHandler).not.toHaveBeenCalled();
    expect(resetHandler).not.toHaveBeenCalled();
    expect(loadMutation).toHaveBeenCalledWith(ORG, 'reset_password', PINNED_INTENT);
  });

  it.each(['direct', 'delegant'] as const)('%s pin goes through the handler with the intent context and never the control plane', async (backend) => {
    loadMutation.mockImplementation(async () => pinned(backend));
    disableHandler.mockResolvedValue(JSON.stringify({ success: true }));
    const out = await executeM365ToolHeadless('m365_disable_user', INPUT, ORG, PINNED_INTENT);
    expect(out).toBe(JSON.stringify({ success: true }));
    expect(execByOrg).not.toHaveBeenCalled();
    expect(disableHandler).toHaveBeenCalledTimes(1);
    expect(disableHandler).toHaveBeenCalledWith(INPUT, expect.anything(), PINNED_INTENT, { actionIntentId: PINNED_INTENT });
    expect(buildAuth).toHaveBeenCalledWith(expect.objectContaining({ id: PINNED_INTENT }));
  });

  it('direct/delegant reset: a spoofed action key in the secrets cannot override the reset action (set after the spread)', async () => {
    loadMutation.mockImplementation(async () => pinned('delegant'));
    resetHandler.mockResolvedValue({
      kind: 'success', llmText: 'ok',
      secrets: { temporaryPassword: 'PW-1', action: 'spoofed', success: false },
    });
    const out = await executeM365ToolHeadless('m365_reset_password', INPUT, ORG, PINNED_INTENT);
    const parsed = JSON.parse(out);
    expect(parsed.action).toBe('m365.user.reset_password');
    expect(parsed.temporaryPassword).toBe('PW-1');
    expect(parsed.success).toBe(true);
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('a handler error carrier is returned as its llmText', async () => {
    loadMutation.mockImplementation(async () => pinned('direct'));
    resetHandler.mockResolvedValue({ kind: 'error', llmText: '{"error":"x"}' });
    expect(await executeM365ToolHeadless('m365_reset_password', INPUT, ORG, PINNED_INTENT)).toBe('{"error":"x"}');
  });

  it('a missing intent id propagates the typed refusal and calls nothing', async () => {
    loadMutation.mockRejectedValue(new CallerVerificationRequiredError({
      orgId: ORG, contactId: null, action: 'disable_user', requiredTier: 2, reason: 'no_fresh_verification', latest: null,
    }));
    await expect(executeM365ToolHeadless('m365_disable_user', INPUT, ORG)).rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(loadMutation).toHaveBeenCalledWith(ORG, 'disable_user', undefined);
    expect(execByOrg).not.toHaveBeenCalled();
    expect(disableHandler).not.toHaveBeenCalled();
  });

  it('a pinned connection_not_ready becomes M365ConnectionUnavailableError', async () => {
    loadMutation.mockRejectedValue(new CallerVerificationValidationError('connection_not_ready', 'gone'));
    await expect(executeM365ToolHeadless('m365_disable_user', INPUT, ORG, PINNED_INTENT))
      .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
    expect(execByOrg).not.toHaveBeenCalled();
  });

  it('other validation errors from the loader are not swallowed', async () => {
    loadMutation.mockRejectedValue(new CallerVerificationValidationError('tenant_mismatch', 'x'));
    await expect(executeM365ToolHeadless('m365_disable_user', INPUT, ORG, PINNED_INTENT))
      .rejects.toBeInstanceOf(CallerVerificationValidationError);
  });

  it('a guard refusal thrown by the control-plane service propagates (not folded into a result)', async () => {
    execByOrg.mockRejectedValue(new CallerVerificationRequiredError({
      orgId: ORG, contactId: null, action: 'disable_user', requiredTier: 2, reason: 'contact_fenced', latest: null,
    }));
    await expect(executeM365ToolHeadless('m365_disable_user', INPUT, ORG, PINNED_INTENT))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
  });

  it('non-protected tools never touch the pinned-intent loader or the handlers', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true } });
    await executeM365ToolHeadless('m365_revoke_sessions', INPUT, ORG, 'intent-9');
    expect(loadMutation).not.toHaveBeenCalled();
    expect(disableHandler).not.toHaveBeenCalled();
    expect(execByOrg).toHaveBeenCalledWith(ORG, expect.objectContaining({ userIdentifier: 'a@b.com' }), { idempotencyKey: 'intent-9' });
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
