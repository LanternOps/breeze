import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

/**
 * #8600 (device-group targets W03): AI `run_script` accepts `groupId`.
 *
 * The group is resolved to concrete device ids when the action intent is
 * created (`actionIntents/runScriptGroupTarget.ts`, which has its own test).
 * This file pins the tool boundary:
 *
 *   1. All four declarations accept an optional `groupId` (UUID). The zod
 *      schema that `validateToolInput` enforces requires exactly one of
 *      `deviceIds` / `groupId`. No `z.undefined()` anywhere.
 *   2. The handler never resolves a group itself. A `groupId` call runs only
 *      as the release of an approved intent, and it executes that intent's
 *      frozen `arguments.deviceIds`. Membership changes after approval do not
 *      reach the executed set, and the resolver is never called here.
 *
 * Harness modeled on aiToolsScripts.runScript.runContext.test.ts.
 */

const mocks = vi.hoisted(() => {
  const dispatchScriptToDevice = vi.fn();
  return { dispatchScriptToDevice, resolveScriptRunTargets: vi.fn() };
});
const { dispatchScriptToDevice } = mocks;

vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: mocks.dispatchScriptToDevice }));
vi.mock('./scriptRunTargets', () => ({ resolveScriptRunTargets: mocks.resolveScriptRunTargets }));
vi.mock('./commandQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./commandQueue')>()),
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
  hasDbAccessContext: vi.fn(() => true),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { actionIntents, devices, scripts } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import { toolInputSchemas } from './aiToolSchemas';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { buildScriptBuilderTools } from './scriptBuilderTools';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_1 = '22222222-2222-4222-8222-222222222222';
const DEVICE_2 = '33333333-3333-4333-8333-333333333333';
const DEVICE_3 = '66666666-6666-4666-8666-666666666666';

function runScriptTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('run_script')!;
}

function makeAuth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_A,
    scope: 'organization',
    accessibleOrgIds: [ORG_A],
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG_A,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
    ...overrides,
  } as any;
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    orgId: ORG_A,
    actionName: 'run_script',
    status: 'executing',
    arguments: { scriptId: SCRIPT_ID, deviceIds: [DEVICE_1, DEVICE_2] },
    ...overrides,
  };
}

const scriptRow = { id: SCRIPT_ID, orgId: ORG_A, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
const deviceRows: Record<string, unknown> = {
  [DEVICE_1]: { id: DEVICE_1, orgId: ORG_A, hostname: 'dev1', siteId: null, status: 'online' },
  [DEVICE_2]: { id: DEVICE_2, orgId: ORG_A, hostname: 'dev2', siteId: null, status: 'online' },
  [DEVICE_3]: { id: DEVICE_3, orgId: ORG_A, hostname: 'dev3', siteId: null, status: 'online' },
};

let currentIntent: Record<string, unknown> | null = intentRow();
let deviceLookupOrder: string[] = [];

function mockDb() {
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => {
          if (table === scripts) return [scriptRow];
          if (table === actionIntents) return currentIntent ? [currentIntent] : [];
          if (table === devices) {
            const id = deviceLookupOrder.shift();
            return id && deviceRows[id] ? [deviceRows[id]] : [];
          }
          return [];
        }),
      }),
    })),
  })) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentIntent = intentRow();
  deviceLookupOrder = [DEVICE_1, DEVICE_2, DEVICE_3];
  dispatchScriptToDevice.mockImplementation(async (input: { device: { id: string } }) => ({
    ok: true,
    commandId: `cmd-${input.device.id}`,
    executionId: `exec-${input.device.id}`,
    delivered: true,
    executedAt: new Date('2026-10-13T00:00:00Z'),
    runAs: 'system',
    targetSessionId: null,
  }));
  mockDb();
});

function dispatchedDeviceIds(): string[] {
  return dispatchScriptToDevice.mock.calls.map((call) => (call[0] as { device: { id: string } }).device.id);
}

// ---------------------------------------------------------------------------
// 1. Declarations
// ---------------------------------------------------------------------------

describe('run_script declarations accept groupId (exactly one of deviceIds / groupId)', () => {
  const schema = toolInputSchemas.run_script!;

  it('zod: accepts scriptId + groupId', () => {
    expect(schema.safeParse({ scriptId: SCRIPT_ID, groupId: GROUP_ID }).success).toBe(true);
  });
  it('zod: accepts proposalId + groupId', () => {
    expect(schema.safeParse({ proposalId: SCRIPT_ID, groupId: GROUP_ID }).success).toBe(true);
  });
  it('zod: still accepts scriptId + deviceIds', () => {
    expect(schema.safeParse({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_1] }).success).toBe(true);
  });
  it('zod: rejects both deviceIds and groupId', () => {
    expect(schema.safeParse({ scriptId: SCRIPT_ID, groupId: GROUP_ID, deviceIds: [DEVICE_1] }).success).toBe(false);
  });
  it('zod: rejects neither deviceIds nor groupId', () => {
    expect(schema.safeParse({ scriptId: SCRIPT_ID }).success).toBe(false);
  });
  it('zod: rejects a non-UUID groupId', () => {
    expect(schema.safeParse({ scriptId: SCRIPT_ID, groupId: 'servers' }).success).toBe(false);
  });
  it('zod: keeps the 10-device cap on explicit deviceIds', () => {
    const many = Array.from({ length: 11 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(schema.safeParse({ scriptId: SCRIPT_ID, deviceIds: many }).success).toBe(false);
  });

  it('native JSON schema: declares groupId and no longer requires deviceIds', () => {
    const def = runScriptTool().definition;
    const props = def.input_schema.properties as Record<string, { type?: string }>;
    expect(props.groupId?.type).toBe('string');
    expect(props.deviceIds).toBeDefined();
    expect(def.input_schema.required ?? []).not.toContain('deviceIds');
  });

  function sdkShape(tools: Array<{ name: string; inputSchema: unknown }>, name: string) {
    const found = tools.find((t) => t.name === name);
    expect(found, `${name} is registered`).toBeDefined();
    return z.object(found!.inputSchema as z.ZodRawShape);
  }

  it('SDK run_script shape accepts groupId alone and deviceIds alone', () => {
    const shape = sdkShape(buildBreezeSdkTools(() => makeAuth()) as any, 'run_script');
    expect(shape.safeParse({ scriptId: SCRIPT_ID, groupId: GROUP_ID }).success).toBe(true);
    expect(shape.safeParse({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_1] }).success).toBe(true);
    expect(shape.safeParse({ scriptId: SCRIPT_ID, groupId: 'servers' }).success).toBe(false);
  });

  it('Script Builder execute_script_on_device shape accepts groupId alone and deviceIds alone', () => {
    const shape = sdkShape(buildScriptBuilderTools(() => makeAuth()) as any, 'execute_script_on_device');
    expect(shape.safeParse({ scriptId: SCRIPT_ID, groupId: GROUP_ID }).success).toBe(true);
    expect(shape.safeParse({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_1] }).success).toBe(true);
    expect(shape.safeParse({ scriptId: SCRIPT_ID, groupId: 'servers' }).success).toBe(false);
  });

  it('no declaration uses z.undefined() (it would empty the model tool list)', () => {
    const shapes = [
      sdkShape(buildBreezeSdkTools(() => makeAuth()) as any, 'run_script').shape,
      sdkShape(buildScriptBuilderTools(() => makeAuth()) as any, 'execute_script_on_device').shape,
    ];
    for (const shape of shapes) {
      for (const field of Object.values(shape)) {
        expect(field).not.toBeInstanceOf(z.ZodUndefined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Handler — frozen release
// ---------------------------------------------------------------------------

describe('run_script { groupId } executes the approved intent\'s frozen device ids', () => {
  it('refuses a groupId call that is not an approved release, without resolving or dispatching', async () => {
    const out = JSON.parse(await runScriptTool().handler({ scriptId: SCRIPT_ID, groupId: GROUP_ID }, makeAuth()));
    expect(out.error).toMatch(/group_target_not_released/);
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
    expect(mocks.resolveScriptRunTargets).not.toHaveBeenCalled();
  });

  it('dispatches exactly the intent\'s frozen deviceIds and never calls the resolver', async () => {
    await runScriptTool().handler(
      { scriptId: SCRIPT_ID, groupId: GROUP_ID },
      makeAuth(),
      { actionIntentId: INTENT_ID },
    );
    expect(dispatchedDeviceIds()).toEqual([DEVICE_1, DEVICE_2]);
    expect(mocks.resolveScriptRunTargets).not.toHaveBeenCalled();
  });

  it('a membership change after approval does not change the executed set', async () => {
    // The group gained DEVICE_3 after the intent froze [DEVICE_1, DEVICE_2].
    mocks.resolveScriptRunTargets.mockResolvedValue({
      ok: true,
      deviceIds: [DEVICE_1, DEVICE_2, DEVICE_3],
      warnings: [],
      resolvedGroups: [{ id: GROUP_ID, orgId: ORG_A, memberCount: 3, refused: false }],
    });
    await runScriptTool().handler(
      { scriptId: SCRIPT_ID, groupId: GROUP_ID },
      makeAuth(),
      { actionIntentId: INTENT_ID },
    );
    expect(dispatchedDeviceIds()).toEqual([DEVICE_1, DEVICE_2]);
    expect(dispatchedDeviceIds()).not.toContain(DEVICE_3);
    expect(mocks.resolveScriptRunTargets).not.toHaveBeenCalled();
  });

  it.each([
    ['the intent is missing', null],
    ['the intent is for another tool', intentRow({ actionName: 'execute_command' })],
    ['the intent is not executing', intentRow({ status: 'pending_approval' })],
    ['the intent names another script', intentRow({ arguments: { scriptId: '77777777-7777-4777-8777-777777777777', deviceIds: [DEVICE_1] } })],
    ['the intent still carries a groupId', intentRow({ arguments: { scriptId: SCRIPT_ID, groupId: GROUP_ID } })],
    ['the intent has no deviceIds', intentRow({ arguments: { scriptId: SCRIPT_ID } })],
    ['the intent is in an org the caller cannot access', intentRow({ orgId: ORG_B })],
  ])('refuses when %s', async (_label, row) => {
    currentIntent = row as Record<string, unknown> | null;
    const out = JSON.parse(await runScriptTool().handler(
      { scriptId: SCRIPT_ID, groupId: GROUP_ID },
      makeAuth(),
      { actionIntentId: INTENT_ID },
    ));
    expect(out.error).toMatch(/group_target_not_released/);
    expect(dispatchScriptToDevice).not.toHaveBeenCalled();
  });

  it('a group-less call is unchanged: no intent read, dispatches its own deviceIds', async () => {
    await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_1] }, makeAuth());
    expect(dispatchedDeviceIds()).toEqual([DEVICE_1]);
  });
});
