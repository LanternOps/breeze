import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #4888 — `run_script` lets an assistant choose the run context (`runAs` /
 * `targetSessionId`) that gets dispatched to the device. That is a privilege
 * decision, not wiring, so this file pins three things the implementation
 * must get right at the tool boundary:
 *
 *   1. An assistant-chosen `runAs`/`targetSessionId` actually reaches
 *      `dispatchScriptToDevice` — not merely "dispatch was called", but the
 *      ARGUMENT OBJECT dispatch received.
 *   2. `executeScriptSchema` (the same gate `POST /scripts/:id/execute` uses)
 *      is what enforces the rules, so 'elevated' and the two cross-field
 *      combinations it refuses for a human caller are refused for an
 *      assistant caller too, and dispatch is never reached on a refusal.
 *   3. The per-device result echoes dispatch's RESOLVED `runAs`, not
 *      whatever the caller happened to ask for — so the model can tell
 *      "ran as SYSTEM because I asked" from "ran as SYSTEM because that is
 *      the script's default" (the #4882 debugging shape).
 *
 * Modeled directly on aiToolsScripts.runScript.orgEquality.test.ts's harness
 * (same mocks, same helpers) — that file's own coverage (org equality,
 * partner-wide visibility, the C1 transaction escape, payload projection) is
 * not re-asserted here.
 */

const mocks = vi.hoisted(() => {
  const dispatchScriptToDevice = vi.fn();
  // Default: behaves like the real dispatch's `input.runAs ?? script.runAs`
  // fallback — the script fixture below saves 'system', so an omitted
  // `runAs` resolves to 'system' here too. Individual tests override this
  // with `mockResolvedValueOnce` where they need a specific resolved value.
  dispatchScriptToDevice.mockImplementation(async (input: { runAs?: string; targetSessionId?: number }) => ({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    executedAt: new Date('2026-08-11T00:00:00Z'),
    runAs: input.runAs ?? 'system',
    targetSessionId: input.targetSessionId ?? null,
  }));
  return { dispatchScriptToDevice };
});
const { dispatchScriptToDevice } = mocks;

vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: mocks.dispatchScriptToDevice }));
vi.mock('./commandQueue', () => ({
  waitForCommandResult: vi.fn().mockResolvedValue({
    id: 'cmd-1',
    status: 'completed',
    payload: { scriptId: 'script-x' },
    result: { status: 'completed', exitCode: 0, stdout: 'hi' },
  }),
}));
vi.mock('./tenantVariableResolution', () => ({
  loadTenantVariableScope: vi.fn().mockResolvedValue({ orgIds: new Set() }),
}));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { devices, scripts } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SCRIPT_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_A = '22222222-2222-2222-2222-222222222222';
const DEVICE_C = '33333333-3333-3333-3333-333333333333';

function runScriptTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('run_script')!;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_A,
    scope: 'organization',
    accessibleOrgIds: [ORG_A],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as any;
}

// Same table-dispatched select mock as the orgEquality suite: a script row
// (saved default runAs 'system') and a device row, both single-org, so
// nothing here trips the org-equality / partner-wide guards this file isn't
// testing.
function mockDb(scriptRow: any, deviceRow: any) {
  vi.mocked(db.select).mockImplementation((() => {
    return {
      from: vi.fn((table: unknown) => {
        let rows: any[];
        if (table === scripts) rows = [scriptRow].filter(Boolean);
        else if (table === devices) rows = [deviceRow].filter(Boolean);
        else rows = [];
        return {
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        };
      }),
    } as any;
  }) as any);
}

const scriptRow = { id: SCRIPT_ID, orgId: ORG_A, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
const deviceRow = { id: DEVICE_A, orgId: ORG_A, hostname: 'devA', siteId: null, status: 'online' };

beforeEach(() => {
  vi.clearAllMocks();
  dispatchScriptToDevice.mockImplementation(async (input: { runAs?: string; targetSessionId?: number }) => ({
    ok: true,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: true,
    executedAt: new Date('2026-08-11T00:00:00Z'),
    runAs: input.runAs ?? 'system',
    targetSessionId: input.targetSessionId ?? null,
  }));
  mockDb(scriptRow, deviceRow);
});

describe('run_script forwards an assistant-chosen run context to dispatchScriptToDevice (#4888)', () => {
  it('forwards runAs: "user" to dispatchScriptToDevice', async () => {
    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], runAs: 'user' }, makeAuth());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ runAs: 'user' }),
    );
  });

  it('with no runAs supplied, calls dispatchScriptToDevice with runAs: undefined — the tool must not invent one', async () => {
    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A] }, makeAuth());

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    const call = dispatchScriptToDevice.mock.calls[0]![0];
    expect(call).toHaveProperty('runAs', undefined);
  });

  it('rejects runAs: "elevated" — elevation is a property of the saved script, not a launch-time choice', async () => {
    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], runAs: 'elevated' }, makeAuth()),
    );

    expect(out.error).toEqual(expect.any(String));
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('rejects a targetSessionId without runAs: "user"', async () => {
    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], targetSessionId: 3 }, makeAuth()),
    );

    expect(out.error).toEqual(expect.any(String));
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('rejects a targetSessionId targeting two devices (session ids are per-device)', async () => {
    mockDb(scriptRow, deviceRow); // the mocked devices select ignores WHERE and always returns one row, fine here
    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_A, DEVICE_C], runAs: 'user', targetSessionId: 3 },
        makeAuth(),
      ),
    );

    expect(out.error).toEqual(expect.any(String));
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('accepts runAs: "user" + targetSessionId: 3 for a single device and forwards both', async () => {
    await runScriptTool().handler(
      { scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], runAs: 'user', targetSessionId: 3 },
      makeAuth(),
    );

    expect(dispatchScriptToDevice).toHaveBeenCalledTimes(1);
    expect(dispatchScriptToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ runAs: 'user', targetSessionId: 3 }),
    );
  });

  it('rejects a garbage runAs value ("root")', async () => {
    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], runAs: 'root' }, makeAuth()),
    );

    expect(out.error).toEqual(expect.any(String));
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });
});

describe('run_script echoes the RESOLVED run context from dispatch, not the caller\'s request', () => {
  it('echoes dispatch\'s resolved runAs on the per-device result when the caller asked for nothing', async () => {
    // The caller supplies no runAs at all; dispatch resolves it to 'system'
    // (the script's saved default, per the mock's own `?? script.runAs`
    // fallback behavior). The tool must report what dispatch actually
    // resolved, not merely omit the field or recompute its own guess.
    dispatchScriptToDevice.mockResolvedValueOnce({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      executedAt: new Date('2026-08-11T00:00:00Z'),
      runAs: 'system',
      targetSessionId: null,
    });

    const out = JSON.parse(
      await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A] }, makeAuth()),
    );

    expect(out.results[DEVICE_A].runAs).toBe('system');
  });

  it('echoes dispatch\'s resolved targetSessionId alongside runAs when present', async () => {
    dispatchScriptToDevice.mockResolvedValueOnce({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      delivered: true,
      executedAt: new Date('2026-08-11T00:00:00Z'),
      runAs: 'user',
      targetSessionId: 3,
    });

    const out = JSON.parse(
      await runScriptTool().handler(
        { scriptId: SCRIPT_ID, deviceIds: [DEVICE_A], runAs: 'user', targetSessionId: 3 },
        makeAuth(),
      ),
    );

    expect(out.results[DEVICE_A]).toMatchObject({ runAs: 'user', targetSessionId: 3 });
  });
});
