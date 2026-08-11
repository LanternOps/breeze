import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Sibling to the scriptExecution.ts / mobile.ts cross-org-script fix (#1674):
 * the AI `run_script` tool resolves a script by `orgCondition` and each device
 * by org+site `verifyDeviceAccess`, but neither check ties the script's org to
 * the device's org. For a multi-org caller, `orgCondition` is
 * `inArray(orgId, accessibleOrgIds)`, so an org-A script resolves AND an org-B
 * device passes verifyDeviceAccess — org A's script content would land on an
 * org-B device. This asserts the per-device org-equality invariant: a non-null
 * script org must match the device org, while a system (null-org) script stays
 * universally runnable.
 *
 * PR0 (#3409 Task 4): run_script now dispatches through the shared
 * scriptDispatch core (dispatchScriptToDevice + waitForCommandResult) instead
 * of the bare executeCommand call, gaining a script_executions row and
 * partner-wide script visibility. These tests mock dispatchScriptToDevice /
 * waitForCommandResult directly — the dispatch core's own execution-row and
 * queueCommand behavior is covered by Task 1's tests, not re-asserted here.
 */

const mocks = vi.hoisted(() => ({
  dispatchScriptToDevice: vi.fn().mockResolvedValue({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    executedAt: new Date('2026-08-11T00:00:00Z'),
  }),
  waitForCommandResult: vi.fn().mockResolvedValue({ id: 'cmd-1', status: 'completed' }),
}));
const { dispatchScriptToDevice, waitForCommandResult } = mocks;

vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: mocks.dispatchScriptToDevice }));
vi.mock('./commandQueue', () => ({ waitForCommandResult: mocks.waitForCommandResult }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { devices, organizations, scripts } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCRIPT_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_B = '22222222-2222-2222-2222-222222222222';
const PARTNER_1 = 'partner-1';
const PARTNER_2 = 'partner-2';

function runScriptTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('run_script')!;
}

// A multi-org caller (org A and org B both accessible). orgCondition is a no-op
// in the mock so the script select returns whatever the mock yields; the access
// breadth is modeled by what the mocked queries return, matching production
// where inArray(orgId, accessibleOrgIds) would resolve both.
function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_A,
    scope: 'organization',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as any;
}

/**
 * The handler issues up to three kinds of select(), distinguished by the
 * table passed to .from(): scripts (full-row), devices (verifyDeviceAccess),
 * and organizations (the partner guard, only reached for partner-wide
 * scripts). `orgRow` is only consulted when the handler actually queries
 * organizations.
 */
function mockDb(scriptRow: any, deviceRow: any, orgRow?: any) {
  vi.mocked(db.select).mockImplementation((() => {
    return {
      from: vi.fn((table: unknown) => {
        let rows: any[];
        if (table === scripts) rows = [scriptRow].filter(Boolean);
        else if (table === devices) rows = [deviceRow].filter(Boolean);
        else if (table === organizations) rows = orgRow !== undefined ? [orgRow].filter(Boolean) : [];
        else rows = [];
        return {
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        };
      }),
    } as any;
  }) as any);
}

beforeEach(() => vi.clearAllMocks());

describe('run_script enforces script-device org equality', () => {
  it('does NOT execute an org-A script on an org-B device (cross-org rejected)', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_A, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('executes a same-org script on a same-org device', async () => {
    const scriptRow = { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
    const deviceRow = { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' };
    mockDb(scriptRow, deviceRow);

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        device: expect.objectContaining({ id: DEVICE_B }),
        source: { kind: 'saved', script: scriptRow },
        triggerType: 'manual',
        triggeredBy: 'user-1',
        createdBy: 'user-1',
        requireOnline: true,
      }),
    );

    // Result comes from waitForCommandResult, not the dispatch return value.
    expect(waitForCommandResult).toHaveBeenCalledWith('cmd-1', 60000);
    expect(out.results[DEVICE_B]).toEqual({ id: 'cmd-1', status: 'completed' });
  });

  it('executes a system (null-org) script on any accessible device', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
  });
});

describe('run_script partner-wide script visibility (#3409 PR0)', () => {
  it('runs a partner-wide script (org_id NULL) on a device whose org belongs to the matching partner', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      { partnerId: PARTNER_1 },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(out.results[DEVICE_B]).toEqual({ id: 'cmd-1', status: 'completed' });
  });

  it('rejects a partner-wide script when the device org belongs to a different partner', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      { partnerId: PARTNER_2 },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('rejects a partner-wide script when the device org cannot be resolved', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, partnerId: PARTNER_1, language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
      undefined,
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });
});

describe('run_script surfaces dispatch failures without calling waitForCommandResult', () => {
  it('returns the dispatch error and does not poll when dispatch fails', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_B, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );
    dispatchScriptToDevice.mockResolvedValueOnce({ ok: false, code: 'device_offline', error: 'Device is offline, cannot execute command' });

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(out.results[DEVICE_B].error).toBe('Device is offline, cannot execute command');
    expect(waitForCommandResult).not.toHaveBeenCalled();
  });
});
