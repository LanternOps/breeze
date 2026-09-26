import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #7103 — the AI `run_script` tool created the script_executions and
 * device_commands rows in a short system transaction, but sent the command
 * over the agent WebSocket INSIDE that transaction, before it committed. A fast
 * agent's result could race the commit and be dropped as an orphan.
 *
 * Pinned here: dispatch is asked to defer delivery, and the send happens only
 * after the system context that created the rows has closed.
 */

const txState = vi.hoisted(() => ({ open: 0 }));
const events = vi.hoisted(() => [] as Array<{ kind: 'create' | 'send'; open: number }>);

const mocks = vi.hoisted(() => ({ dispatchScriptToDevice: vi.fn() }));
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
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    txState.open += 1;
    try {
      return await fn();
    } finally {
      txState.open -= 1;
    }
  }),
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
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as any;
}

const scriptRow = { id: SCRIPT_ID, orgId: ORG_A, partnerId: null, language: 'powershell', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' };
const deviceRow = { id: DEVICE_A, orgId: ORG_A, hostname: 'devA', siteId: null, status: 'online' };

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  txState.open = 0;
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn((table: unknown) => {
      const rows = table === scripts ? [scriptRow] : table === devices ? [deviceRow] : [];
      return { where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) };
    }),
  })) as any);
  dispatchScriptToDevice.mockImplementation(async (input: { deferDelivery?: boolean }) => {
    events.push({ kind: 'create', open: txState.open });
    const base = {
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      executedAt: null,
      runAs: 'system',
      targetSessionId: null,
      ignoredParameters: [],
    };
    const deliverNow = async () => {
      events.push({ kind: 'send', open: txState.open });
      return { ...base, delivered: true, deliveryOutcome: 'sent' };
    };
    if (input.deferDelivery) {
      return { ...base, delivered: false, deliveryOutcome: 'deferred', deliver: deliverNow };
    }
    return deliverNow();
  });
});

describe('run_script sends only after its rows commit (#7103)', () => {
  it('creates the rows inside the system context and sends after it closed', async () => {
    const out = JSON.parse(await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A] }, makeAuth()));

    expect(dispatchScriptToDevice).toHaveBeenCalledWith(expect.objectContaining({ deferDelivery: true }));
    expect(events).toEqual([
      { kind: 'create', open: 1 },
      { kind: 'send', open: 0 },
    ]);
    expect(out.results[DEVICE_A]).toMatchObject({ commandId: 'cmd-1', executionId: 'exec-1' });
  });

  it('a send that throws does not report the committed run as failed', async () => {
    dispatchScriptToDevice.mockImplementationOnce(async () => ({
      ok: true,
      commandId: 'cmd-1',
      executionId: 'exec-1',
      executedAt: null,
      runAs: 'system',
      targetSessionId: null,
      ignoredParameters: [],
      delivered: false,
      deliveryOutcome: 'deferred',
      deliver: async () => { throw new Error('socket exploded'); },
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = JSON.parse(await runScriptTool().handler({ scriptId: SCRIPT_ID, deviceIds: [DEVICE_A] }, makeAuth()));

    // The command stays queued and the tool still waits for its result.
    expect(out.results[DEVICE_A]).toMatchObject({ commandId: 'cmd-1', executionId: 'exec-1', exitCode: 0 });
    error.mockRestore();
  });
});
