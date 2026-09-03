/**
 * commandQueue DB-context scoping for the background dispatch entry point
 * (#4150, #1105 class).
 *
 * `executeCommand` needs an RLS context for its PRECHECK (the `devices` SELECT
 * and `assertDeviceExecuteAllowed`) and then runs the queue/dispatch/poll
 * phase inside `runOutsideDbContext`. That inner escape exits the
 * AsyncLocalStorage so `db` resolves to the bare pool — but it CANNOT release
 * an outer `withDbAccessContext` transaction's pooled connection. A background
 * caller that opened a system context just to satisfy the precheck therefore
 * pinned a connection idle-in-transaction for the whole `waitForCommandResult`
 * poll (up to 30s). That is what #4150 fixes.
 *
 * `executeCommandWithSystemPrecheck` is the depth-0-safe entry point: it opens
 * a SHORT system context for the precheck, closes it, and only then queues,
 * dispatches and waits.
 *
 * The `runOutsideDbContext` mock below is a depth-PRESERVING passthrough on
 * purpose — modelling it as a depth reset would make this suite pass against
 * the very bug it exists for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ctxState, dbState, partnerTrustMocks, agentWsMocks, commandDispatchMocks, sentryMocks } = vi.hoisted(() => ({
  ctxState: { depth: 0, events: [] as string[], ambient: undefined as { scope: string } | undefined },
  dbState: {
    deviceRows: [] as unknown[],
    commandRows: [] as unknown[],
    insertedCommand: null as Record<string, unknown> | null,
  },
  partnerTrustMocks: { assertDeviceExecuteAllowed: vi.fn(async () => undefined) },
  agentWsMocks: { sendCommandToAgent: vi.fn(), isAgentConnected: vi.fn(() => true) },
  commandDispatchMocks: {
    claimPendingCommandForDelivery: vi.fn(),
    releaseClaimedCommandDelivery: vi.fn(async () => undefined),
  },
  sentryMocks: { captureMessage: vi.fn() },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')] ?? table);
        const builder: Record<string, unknown> = {
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(async () => {
            ctxState.events.push(`select:${name}@depth${ctxState.depth}`);
            if (name === 'devices') return dbState.deviceRows;
            if (name === 'device_commands') return dbState.commandRows;
            return [];
          }),
        };
        return builder;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          ctxState.events.push(`insert:device_commands@depth${ctxState.depth}`);
          dbState.insertedCommand = { ...row, id: 'cmd-1' };
          return [dbState.insertedCommand];
        }),
        execute: vi.fn(async () => undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
      })),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => ctxState.ambient),
  // Depth-preserving on purpose — see the file header.
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    const previous = ctxState.ambient;
    ctxState.ambient = ctx as { scope: string };
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
      ctxState.ambient = previous;
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const previous = ctxState.ambient;
    ctxState.ambient = { scope: 'system' };
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
      ctxState.ambient = previous;
    }
  }),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: (...args: unknown[]) => {
    ctxState.events.push(`wsSend@depth${ctxState.depth}`);
    return agentWsMocks.sendCommandToAgent(...args);
  },
  isAgentConnected: (...args: unknown[]) => agentWsMocks.isAgentConnected(...(args as [])),
}));

vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: (...args: unknown[]) => {
    ctxState.events.push(`claim@depth${ctxState.depth}`);
    return commandDispatchMocks.claimPendingCommandForDelivery(...args);
  },
  releaseClaimedCommandDelivery: (...args: unknown[]) =>
    commandDispatchMocks.releaseClaimedCommandDelivery(...(args as [])),
}));

vi.mock('./partnerTrust.commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./partnerTrust.commands')>();
  return {
    ...actual,
    assertDeviceExecuteAllowed: async (...args: unknown[]) => {
      ctxState.events.push(`trustCheck@depth${ctxState.depth}`);
      return partnerTrustMocks.assertDeviceExecuteAllowed(...(args as []));
    },
  };
});

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: sentryMocks.captureMessage }));
vi.mock('./backupMetrics', () => ({
  recordBackupCommandTimeout: vi.fn(),
  recordRestoreTimeout: vi.fn(),
}));

import { executeCommand, executeCommandWithSystemPrecheck } from './commandQueue';
import { TrustDeniedError } from './partnerTrust.commands';

const ONLINE_DEVICE = {
  id: 'device-1',
  status: 'online',
  agentId: 'agent-1',
  orgId: 'org-1',
  hostname: 'host-1',
  watchdogLastSeen: null,
  agentEdition: null,
  agentVersion: null,
  watchdogVersion: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  ctxState.depth = 0;
  ctxState.events = [];
  ctxState.ambient = undefined;
  dbState.deviceRows = [ONLINE_DEVICE];
  dbState.insertedCommand = null;
  // First poll of waitForCommandResult sees a terminal row, so the test never
  // sleeps and the event log stays deterministic.
  dbState.commandRows = [{ id: 'cmd-1', status: 'completed', type: 'list_services', result: { status: 'completed', stdout: '{}' } }];
  agentWsMocks.sendCommandToAgent.mockReturnValue(true);
  agentWsMocks.isAgentConnected.mockReturnValue(true);
  commandDispatchMocks.claimPendingCommandForDelivery.mockResolvedValue({ executedAt: new Date() });
});

describe('executeCommandWithSystemPrecheck (#4150/#1105)', () => {
  it('closes the precheck context BEFORE dispatching and waiting', async () => {
    const result = await executeCommandWithSystemPrecheck('device-1', 'list_services', { search: 'Spooler' }, {
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('completed');
    expect(ctxState.events).toEqual([
      // Phase 1 — precheck in its OWN short system context.
      'ctx:enter',
      'select:devices@depth1',
      'trustCheck@depth1',
      'ctx:exit',
      // Phase 2 — the insert takes its own short context (device_commands is
      // system-scoped, #1375); everything that waits on the device runs at
      // depth 0 with no connection held.
      'ctx:enter',
      'insert:device_commands@depth1',
      'ctx:exit',
      'claim@depth0',
      'wsSend@depth0',
      'select:device_commands@depth0',
    ]);
    // Nothing may still be open once the call returns.
    expect(ctxState.depth).toBe(0);
    // Called correctly (depth 0), so the held-context guard must stay quiet.
    expect(sentryMocks.captureMessage).not.toHaveBeenCalled();
  });

  it('opens no context at all past the precheck when the device is missing', async () => {
    dbState.deviceRows = [];

    const result = await executeCommandWithSystemPrecheck('device-1', 'list_services', {}, { timeoutMs: 5_000 });

    expect(result).toEqual({ status: 'failed', error: 'Device not found' });
    expect(ctxState.events).toEqual(['ctx:enter', 'select:devices@depth1', 'ctx:exit']);
    expect(agentWsMocks.sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('joins an ambient system context instead of opening a SECOND one', async () => {
    // A nested withSystemDbAccessContext would check out a second pooled
    // connection while the caller's is still held — strictly worse than the
    // bug being fixed. The precheck must run in the context that is already
    // open, adding no ctx:enter of its own.
    ctxState.ambient = { scope: 'system' };
    ctxState.depth = 1;

    const result = await executeCommandWithSystemPrecheck('device-1', 'list_services', {}, { timeoutMs: 5_000 });

    expect(result.status).toBe('completed');
    // No leading ctx:enter — the precheck read is the very first event.
    expect(ctxState.events[0]).toBe('select:devices@depth1');
    // Exactly one ctx:enter in the whole call, and it belongs to the dispatch
    // phase's insert, not to the precheck.
    expect(ctxState.events.filter((e) => e === 'ctx:enter')).toHaveLength(1);
    expect(ctxState.events).toContain('insert:device_commands@depth2');
    // The precondition is broken here and cannot be recovered from, so it must
    // be REPORTED rather than silently tolerated — see the guard's comment.
    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureMessage.mock.calls[0]![0]).toContain(
      "called from inside a 'system' DB access context",
    );
    expect(sentryMocks.captureMessage.mock.calls[0]![1]).toMatchObject({
      eventCode: 'db_operation_inside_held_context',
    });
  });

  it('surfaces a trust denial as a terminal result and dispatches nothing', async () => {
    partnerTrustMocks.assertDeviceExecuteAllowed.mockRejectedValueOnce(
      new TrustDeniedError('TRUST_PROBATION', 'probation_default_deny', 'device-1', 'list_services'),
    );

    const result = await executeCommandWithSystemPrecheck('device-1', 'list_services', {}, { timeoutMs: 5_000 });

    expect(result).toEqual({
      status: 'failed',
      error: 'TRUST_PROBATION',
      trust: { capability: 'device_execute', reason: 'probation_default_deny' },
    });
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'select:devices@depth1',
      'trustCheck@depth1',
      'ctx:exit',
    ]);
    expect(agentWsMocks.sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('rethrows a non-trust precheck error rather than reporting a failed command', async () => {
    partnerTrustMocks.assertDeviceExecuteAllowed.mockRejectedValueOnce(new Error('trust store unreachable'));

    await expect(
      executeCommandWithSystemPrecheck('device-1', 'list_services', {}, { timeoutMs: 5_000 }),
    ).rejects.toThrow('trust store unreachable');
    // The context must still have closed on the throw path.
    expect(ctxState.depth).toBe(0);
    expect(agentWsMocks.sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('opens no context past the precheck when the device is offline', async () => {
    dbState.deviceRows = [{ ...ONLINE_DEVICE, status: 'offline' }];

    const result = await executeCommandWithSystemPrecheck('device-1', 'list_services', {}, { timeoutMs: 5_000 });

    expect(result).toEqual({ status: 'failed', error: 'Device is offline, cannot execute command' });
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'select:devices@depth1',
      'trustCheck@depth1',
      'ctx:exit',
    ]);
  });
});

describe('executeCommand (unchanged by #4150)', () => {
  it('still runs its precheck in the CALLER’s context and opens none of its own', async () => {
    const result = await executeCommand('device-1', 'list_services', {}, { timeoutMs: 5_000 });

    expect(result.status).toBe('completed');
    // No leading ctx:enter/ctx:exit pair: the precheck reads at the caller's
    // depth exactly as before. Callers inside a request transaction keep
    // today's RLS-gated behaviour.
    expect(ctxState.events).toEqual([
      'select:devices@depth0',
      'trustCheck@depth0',
      'ctx:enter',
      'insert:device_commands@depth1',
      'ctx:exit',
      'claim@depth0',
      'wsSend@depth0',
      'select:device_commands@depth0',
    ]);
  });
});
