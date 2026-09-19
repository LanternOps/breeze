/**
 * playbookActExecutor DB-context scoping (#4150, #1105 class).
 *
 * The regression this locks down: `readServiceStatus` wrapped its
 * `executeCommandFn` call — a device-command round-trip bounded at
 * SERVICE_STATUS_READ_TIMEOUT_MS (30s) — in `inSystemDbContext`, so a pooled
 * Postgres connection sat idle-in-transaction for the whole wait. Exactly the
 * shape #4133/3ec0439d2 removed from monitorWorker/discoveryWorker/backupWorker.
 *
 * An identity `fn => fn()` mock of the context helpers can never catch that,
 * so the mock below tracks real enter/exit DEPTH and the tests assert WHICH
 * depth each DB read and the command dispatch happened at — mirroring
 * `jobs/monitorWorker.dbcontext.test.ts`'s ctxState.events harness.
 *
 * Critically, `runOutsideDbContext` is mocked as a depth-PRESERVING
 * passthrough, because that is what it really is: it exits the
 * AsyncLocalStorage so `db` resolves to the bare pool, but it cannot release
 * an outer `withDbAccessContext` transaction's connection. Modelling it as a
 * depth reset would make this suite pass against the very bug it exists for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentKind } from '@breeze/shared';
import type { PlaybookStep } from '../../db/schema/playbooks';
import type { AuthContext } from '../../middleware/auth';

const { dbMockState, ctxState } = vi.hoisted(() => ({
  dbMockState: {
    diskRows: [] as unknown[],
    ambientContext: undefined as { scope: string } | undefined,
  },
  ctxState: { depth: 0, events: [] as string[] },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const builder: Record<string, unknown> = {
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(async () => {
            ctxState.events.push(`select:${tableName}@depth${ctxState.depth}`);
            if (tableName === 'device_disks') return dbMockState.diskRows;
            throw new Error(`Unexpected table: ${tableName}`);
          }),
        };
        return builder;
      }),
    })),
    insert: vi.fn(),
    update: vi.fn(),
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
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    const previous = dbMockState.ambientContext;
    dbMockState.ambientContext = ctx as { scope: string };
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

import { runPlaybookSteps, type PlaybookExecutorDeps } from './playbookActExecutor';

const RUN = {
  id: 'run-1',
  orgId: 'org-1',
  agentId: 'agent-1',
  agentKind: 'triage' as AiAgentKind,
  deviceId: 'device-1',
  deviceSiteId: 'site-1',
};
const AGENT_AUTH = { user: { id: 'agent-1' } } as unknown as AuthContext;
const FAR_FUTURE_DEADLINE = Date.now() + 60_000;

function makeDeps(overrides: Partial<PlaybookExecutorDeps> = {}): PlaybookExecutorDeps {
  return {
    revalidate: vi.fn(),
    executeToolFn: vi.fn(async () => JSON.stringify({ status: 'completed' })),
    executeCommandFn: vi.fn(async () => {
      ctxState.events.push(`executeCommand@depth${ctxState.depth}`);
      return { status: 'completed' as const, stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Running' }] }) };
    }),
    sleepFn: vi.fn(async () => undefined),
    ...overrides,
  } as PlaybookExecutorDeps;
}

function serviceVerifyStep(): PlaybookStep {
  return {
    type: 'verify', name: 'check running', description: '', tool: 'manage_services',
    toolInput: { deviceId: 'device-1', action: 'list', serviceName: 'Spooler' },
    verifyCondition: { metric: 'service_status', operator: 'eq', value: 'running' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.diskRows = [];
  dbMockState.ambientContext = undefined;
  ctxState.depth = 0;
  ctxState.events = [];
});

describe('readServiceStatus DB-context scoping (#4150/#1105)', () => {
  it('runs the up-to-30s device-command read-back with NO DB context held', async () => {
    const deps = makeDeps();

    const outcome = await runPlaybookSteps([serviceVerifyStep()], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });

    expect(outcome.verification).toBe('passed');
    // THE assertion: the command round-trip must happen at depth 0. Before the
    // #4150 fix this read `executeCommand@depth1`, i.e. a pooled connection
    // pinned idle-in-transaction for the whole wait.
    expect(ctxState.events).toEqual(['executeCommand@depth0']);
  });

  it('still holds NO context when the read-back does not complete', async () => {
    const deps = makeDeps({
      executeCommandFn: vi.fn(async () => {
        ctxState.events.push(`executeCommand@depth${ctxState.depth}`);
        return { status: 'timeout' as const, error: 'timed out' };
      }),
    });

    const outcome = await runPlaybookSteps([serviceVerifyStep()], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });

    expect(outcome.verification).toBe('inconclusive');
    expect(ctxState.events).toEqual(['executeCommand@depth0']);
  });

  it('leaves the pure-DB disk read in its own short context (unchanged by #4150)', async () => {
    dbMockState.diskRows = [{ usedPercent: 42 }];
    const deps = makeDeps();
    const step: PlaybookStep = {
      type: 'verify', name: 'disk', description: '', tool: 'disk_cleanup',
      toolInput: { deviceId: 'device-1' },
      verifyCondition: { metric: 'disk_usage_percent', operator: 'lt', value: 90 },
    };

    const outcome = await runPlaybookSteps([step], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });

    expect(outcome.verification).toBe('passed');
    // A short context around a pure DB read is correct and must stay.
    expect(ctxState.events).toEqual(['ctx:enter', 'select:device_disks@depth1', 'ctx:exit']);
    expect(deps.executeCommandFn).not.toHaveBeenCalled();
  });
});
