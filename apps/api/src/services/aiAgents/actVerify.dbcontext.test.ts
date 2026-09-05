/**
 * actVerify DB-context scoping (#4150, #1105 class).
 *
 * The regression this locks down: `verifyServiceRunning` and
 * `verifyProcessAbsent` wrapped their `executeCommand` call — a device-command
 * round-trip bounded at VERIFY_READ_TIMEOUT_MS — in `inSystemDbContext`, so a
 * pooled Postgres connection sat idle-in-transaction for the whole wait.
 * Exactly the shape #4133/3ec0439d2 removed from the BullMQ workers.
 *
 * `actVerify.test.ts` mocks the context helpers as identity passthroughs, so
 * it can assert *that* a system context was used but never *how long* it was
 * held. This suite tracks real enter/exit DEPTH and asserts which depth each
 * dispatch and each DB write ran at.
 *
 * `runOutsideDbContext` is deliberately mocked as a depth-PRESERVING
 * passthrough: that is what it really is (it exits the AsyncLocalStorage but
 * cannot release an outer `withDbAccessContext` transaction's connection).
 * Modelling it as a depth reset would make this suite pass against the very
 * bug it exists for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMockState, ctxState, commandQueueMock } = vi.hoisted(() => ({
  dbMockState: {
    ambientContext: undefined as { scope: string } | undefined,
    insertedRows: [] as unknown[],
  },
  ctxState: { depth: 0, events: [] as string[] },
  commandQueueMock: {
    executeCommandWithSystemPrecheck: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: unknown) => {
        ctxState.events.push(`alertInsert@depth${ctxState.depth}`);
        dbMockState.insertedRows.push(row);
      }),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
  // Depth-preserving on purpose — see the file header.
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const previous = dbMockState.ambientContext;
    dbMockState.ambientContext = { scope: 'system' };
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
      dbMockState.ambientContext = previous;
    }
  }),
}));

vi.mock('../commandQueue', () => commandQueueMock);

import { ACT_MANIFEST, type ActOperation } from './actManifest';
import { recordActVerifyFailureAlert, verifyActExecution } from './actVerify';
import type { ActAssetPin } from './actRevalidation';

const RUN = { id: 'run-1', orgId: 'org-1', agentId: 'agent-1', deviceId: 'device-1' };
const AGENT_USER_ID = 'agent-1';

const restartOp = ACT_MANIFEST.find((op) => op.key === 'manage_services.restart')!;
// Mirrors actVerify.test.ts: manage_processes.kill is not in ACT_MANIFEST, but
// `verifyProcessAbsent` is still live code and carries the same #1105 shape.
const processAbsentOp: ActOperation = {
  key: 'manage_processes.kill',
  toolName: 'manage_processes',
  matches: () => false,
  normalizeTarget: () => ({ ok: false, reason: 'unreachable — not in ACT_MANIFEST' }),
  verifySpec: { kind: 'process_absent' },
};

function recordingResult(stdout: string) {
  return vi.fn(async () => {
    ctxState.events.push(`executeCommand@depth${ctxState.depth}`);
    return { status: 'completed' as const, stdout };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.ambientContext = undefined;
  dbMockState.insertedRows = [];
  ctxState.depth = 0;
  ctxState.events = [];
});

describe('verifyActExecution DB-context scoping (#4150/#1105)', () => {
  it('runs the service_running read-back with NO DB context held', async () => {
    commandQueueMock.executeCommandWithSystemPrecheck = recordingResult(
      JSON.stringify({ services: [{ name: 'Spooler', status: 'Running' }] }),
    );

    const outcome = await verifyActExecution({
      pin: { op: restartOp, target: { kind: 'service', serviceName: 'Spooler' } } as ActAssetPin,
      toolOutput: JSON.stringify({ status: 'completed' }),
      isError: false,
      run: RUN,
      agentUserId: AGENT_USER_ID,
    });

    expect(outcome.verification).toBe('passed');
    // THE assertion: before the #4150 fix this read `executeCommand@depth1`.
    expect(ctxState.events).toEqual(['executeCommand@depth0']);
  });

  it('runs the process_absent read-back with NO DB context held', async () => {
    commandQueueMock.executeCommandWithSystemPrecheck = recordingResult(
      JSON.stringify({ processes: [{ pid: 999 }] }),
    );

    const outcome = await verifyActExecution({
      pin: { op: processAbsentOp, target: { kind: 'process', processName: 'bad.exe', pid: '4242' } } as ActAssetPin,
      toolOutput: JSON.stringify({ status: 'completed' }),
      isError: false,
      run: RUN,
      agentUserId: AGENT_USER_ID,
    });

    expect(outcome.verification).toBe('passed');
    expect(ctxState.events).toEqual(['executeCommand@depth0']);
  });

  it('holds no context when the read-back throws', async () => {
    commandQueueMock.executeCommandWithSystemPrecheck = vi.fn(async () => {
      ctxState.events.push(`executeCommand@depth${ctxState.depth}`);
      throw new Error('relay down');
    });

    const outcome = await verifyActExecution({
      pin: { op: restartOp, target: { kind: 'service', serviceName: 'Spooler' } } as ActAssetPin,
      toolOutput: JSON.stringify({ status: 'completed' }),
      isError: false,
      run: RUN,
      agentUserId: AGENT_USER_ID,
    });

    expect(outcome.verification).toBe('inconclusive');
    expect(ctxState.events).toEqual(['executeCommand@depth0']);
  });
});

describe('recordActVerifyFailureAlert DB-context scoping (#4150/#1105)', () => {
  it('keeps its short system context around the alert insert', async () => {
    await recordActVerifyFailureAlert({
      run: RUN,
      op: { key: 'manage_services.restart' },
      target: { kind: 'service', serviceName: 'Spooler' },
      detail: 'service status is "Stopped"',
    });

    // A short context around a pure DB write is correct and must stay.
    expect(ctxState.events).toEqual(['ctx:enter', 'alertInsert@depth1', 'ctx:exit']);
    expect(dbMockState.insertedRows).toHaveLength(1);
  });
});
