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
 */

const executeCommand = vi.fn().mockResolvedValue({ ok: true });

vi.mock('./commandQueue', () => ({ executeCommand }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCRIPT_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_B = '22222222-2222-2222-2222-222222222222';

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
 * The handler issues exactly two kinds of select():
 *   1. script: db.select({ ...projection }).from(scripts).where(...).limit(1)
 *   2. device (verifyDeviceAccess): db.select().from(devices).where(...).limit(1)
 * Distinguish by whether a projection arg was passed.
 */
function mockDb(scriptRow: any, deviceRow: any) {
  vi.mocked(db.select).mockImplementation(((projection?: unknown) => {
    const rows = projection === undefined ? [deviceRow].filter(Boolean) : [scriptRow].filter(Boolean);
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    } as any;
  }) as any);
}

beforeEach(() => vi.clearAllMocks());

describe('run_script enforces script-device org equality', () => {
  it('does NOT execute an org-A script on an org-B device (cross-org rejected)', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_A, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth()),
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(out.results[DEVICE_B].error).toMatch(/not found or access denied/i);
  });

  it('executes a same-org script on a same-org device', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: ORG_B, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(DEVICE_B, 'script', expect.objectContaining({ content: 'echo hi' }), expect.anything());
  });

  it('executes a system (null-org) script on any accessible device', async () => {
    mockDb(
      { id: SCRIPT_ID, orgId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' },
      { id: DEVICE_B, orgId: ORG_B, hostname: 'devB', siteId: null, status: 'online' },
    );

    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_B] }, makeAuth());

    expect(executeCommand).toHaveBeenCalledTimes(1);
  });
});
