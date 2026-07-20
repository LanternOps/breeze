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
