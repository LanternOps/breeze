import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5022 W01 contract, applied to the W04 system-cleanup seam (W05 amendment B11).
 *
 * `services/aiDispatch.contract.test.ts` scans only
 * `services/aiTools*.ts` and `services/aiAgents/**`, so THIS module can reach
 * the command queue with no origin and no suite notices. The AI lane decides a
 * `system_cleanup run` — a destructive, unattended device mutation — so the
 * origin has to survive the hop into the shared service, or the
 * `ai.command.executed` attribution row is never written.
 *
 * Mock shape mirrors `systemCleanup.test.ts`'s seam: W04 dispatches through
 * `queueCommandForExecutionWithSystemPrecheck` and claims the run row inside a
 * short `withDbAccessContext` + `db.transaction`, outside the request context.
 */

const seam = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn(), queue: vi.fn(),
  context: vi.fn(), outside: vi.fn(), lock: vi.fn(),
  queueCalls: [] as Array<{ type: string; payload: Record<string, unknown>; options: Record<string, unknown> }>,
  insertedRuns: [] as Record<string, unknown>[],
  commandRows: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => ({
  db: { select: seam.select, insert: seam.insert, update: seam.update, transaction: seam.transaction },
  withDbAccessContext: seam.context,
  runOutsideDbContext: seam.outside,
}));
vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceFilesystemCleanupRuns: {
    id: 'runs.id', orgId: 'runs.orgId', deviceId: 'runs.deviceId',
    kind: 'runs.kind', status: 'runs.status', commandId: 'runs.commandId', plan: 'runs.plan',
  },
  deviceCommands: {
    id: 'commands.id', deviceId: 'commands.deviceId', status: 'commands.status',
    type: 'commands.type', payload: 'commands.payload', result: 'commands.result', error: 'commands.error',
  },
}));
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));
vi.mock('./commandQueue', () => ({
  queueCommandForExecutionWithSystemPrecheck: vi.fn(async (
    _deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    seam.queueCalls.push({ type, payload, options });
    return { command: { id: `cmd-${seam.queueCalls.length}` }, delivery: 'delivered' };
  }),
  CommandTypes: { SYSTEM_CLEANUP_LIST: 'system_cleanup_list', SYSTEM_CLEANUP_RUN: 'system_cleanup_run' },
}));

import { awaitSystemCleanupResult, queueSystemCleanupList, startSystemCleanupRun } from './systemCleanup';

const DEVICE = {
  id: '33333333-3333-3333-3333-333333333333',
  orgId: '11111111-1111-1111-1111-111111111111',
  agentVersion: '9.9.9',
  status: 'online',
};

const AI_ORIGIN = { kind: 'ai_assistant', sessionId: 'sess-1' } as const;

describe('systemCleanup service — AI origin passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seam.queueCalls = [];
    seam.insertedRuns = [];
    seam.commandRows = [];
    seam.context.mockImplementation(async (_context: unknown, callback: () => Promise<unknown>) => callback());
    seam.outside.mockImplementation(async (callback: () => Promise<unknown>) => callback());
    seam.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ select: seam.select, insert: seam.insert, update: seam.update }));
    seam.lock.mockResolvedValue([{ id: DEVICE.id }]);
    seam.select.mockImplementation(() => ({
      from: (table: { id: string }) => ({
        where: () => ({
          for: seam.lock,
          limit: () => {
            if (table.id === 'devices.id') {
              return { for: seam.lock, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([{ id: DEVICE.id }])) };
            }
            if (table.id === 'commands.id') return Promise.resolve(seam.commandRows);
            return Promise.resolve([]);
          },
        }),
      }),
    }));
    seam.insert.mockImplementation(() => ({
      values: (row: Record<string, unknown>) => {
        const id = `run-${seam.insertedRuns.length + 1}`;
        seam.insertedRuns.push({ ...row, id });
        return { returning: async () => [{ id }] };
      },
    }));
    seam.update.mockImplementation(() => ({
      set: () => ({
        where: () => Object.assign(Promise.resolve([]), { returning: async () => [] }),
      }),
    }));
  });

  it('forwards aiOrigin to the command queue for system_cleanup_list', async () => {
    const result = await queueSystemCleanupList({
      device: DEVICE,
      requestedBy: null,
      aiOrigin: AI_ORIGIN,
    });

    expect(result).toMatchObject({ ok: true });
    expect(seam.queueCalls).toHaveLength(1);
    expect(seam.queueCalls[0]!.type).toBe('system_cleanup_list');
    expect(seam.queueCalls[0]!.options.aiOrigin).toEqual(AI_ORIGIN);
    // The W04 precheck contract survives the new field.
    expect(seam.queueCalls[0]!.options.expectedOrgId).toBe(DEVICE.orgId);
  });

  it('forwards aiOrigin to the command queue for system_cleanup_run', async () => {
    const result = await startSystemCleanupRun({
      device: DEVICE,
      requestedBy: null,
      actionIds: ['linux_pkg_cache_clean'],
      aiOrigin: AI_ORIGIN,
    });

    expect(result).toMatchObject({ ok: true });
    expect(seam.queueCalls).toHaveLength(1);
    expect(seam.queueCalls[0]!.type).toBe('system_cleanup_run');
    expect(seam.queueCalls[0]!.options.aiOrigin).toEqual(AI_ORIGIN);
    // The run row is created by THIS function, not by the caller — one
    // implementation of the insert, shared by the route and the AI tool.
    expect(seam.insertedRuns).toHaveLength(1);
    expect(seam.insertedRuns[0]).toMatchObject({ kind: 'system', status: 'running' });
  });

  it('omits aiOrigin entirely on the human route path (no synthetic origin)', async () => {
    await queueSystemCleanupList({ device: DEVICE, requestedBy: 'user-1' });
    expect(seam.queueCalls[0]!.options).not.toHaveProperty('aiOrigin');
  });
});

// Own timeout, well above the 10 s fake-timer poll budget below: under a
// loaded full-suite run the default 5 s can expire mid-test, and a test that
// dies with fake timers armed poisons every test after it.
describe('awaitSystemCleanupResult', { timeout: 30_000 }, () => {
  const whereClauses: unknown[] = [];
  const LIST = { commandId: 'cmd-1', deviceId: DEVICE.id, orgId: DEVICE.orgId, type: 'system_cleanup_list' } as const;

  function eqPairs(clause: unknown): Array<[unknown, unknown]> {
    const record = clause as { conditions?: unknown[]; left?: unknown; right?: unknown };
    if (record.conditions) return record.conditions.flatMap(eqPairs);
    return [[record.left, record.right]];
  }

  // Every piece of seam state is (re)installed here, never inherited from the
  // describe above or from a previous test: mutable module-level state is what
  // made an earlier version of this block flake under a loaded full-suite run.
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    seam.commandRows = [];
    seam.queueCalls = [];
    whereClauses.length = 0;
    seam.context.mockImplementation(async (_context: unknown, callback: () => Promise<unknown>) => callback());
    seam.outside.mockImplementation(async (callback: () => Promise<unknown>) => callback());
    seam.select.mockImplementation(() => ({
      from: () => ({
        where: (clause: unknown) => {
          whereClauses.push(clause);
          // device_commands has NO RLS, so the org context filters nothing:
          // the predicates themselves are the only isolation. Evaluate them.
          const pairs = eqPairs(clause);
          const matches = (row: Record<string, unknown>) => pairs.every(([column, value]) => {
            if (column === 'commands.id') return row.id === value;
            if (column === 'commands.deviceId') return row.deviceId === value;
            if (column === 'commands.type') return row.type === value;
            return true;
          });
          return { limit: () => Promise.resolve(seam.commandRows.filter(matches)) };
        },
      }),
    }));
  });
  afterEach(() => {
    // Always, even when an assertion above threw with fake timers armed.
    vi.useRealTimers();
  });

  it('returns the parsed agent payload from a completed command row', async () => {
    seam.commandRows = [{ id: 'cmd-1', deviceId: DEVICE.id, type: 'system_cleanup_list', status: 'completed', result: { stdout: '{"catalogVersion":1}', error: undefined } }];
    const outcome = await awaitSystemCleanupResult(LIST, 1_000);
    expect(outcome).toEqual({ status: 'completed', result: { catalogVersion: 1 }, error: undefined });
  });

  it('selects the command by id AND device AND type (F2: the org context filters nothing on device_commands)', async () => {
    seam.commandRows = [{ id: 'cmd-1', deviceId: DEVICE.id, type: 'system_cleanup_list', status: 'completed', result: { stdout: '{}' } }];
    await awaitSystemCleanupResult(LIST, 1_000);
    expect(eqPairs(whereClauses[0])).toEqual(expect.arrayContaining([
      ['commands.id', 'cmd-1'],
      ['commands.deviceId', DEVICE.id],
      ['commands.type', 'system_cleanup_list'],
    ]));
  });

  it('never resolves a completed command that belongs to another device', async () => {
    seam.commandRows = [{ id: 'cmd-1', deviceId: 'some-other-device', type: 'system_cleanup_list', status: 'completed', result: { stdout: '{"catalogVersion":1}' } }];
    const outcome = await awaitSystemCleanupResult(LIST, 1_000);
    expect(outcome.status).not.toBe('completed');
    expect(outcome).toEqual({ status: 'not_found', error: 'command not found' });
  });

  it('never resolves a completed command of another type', async () => {
    seam.commandRows = [{ id: 'cmd-1', deviceId: DEVICE.id, type: 'system_cleanup_run', status: 'completed', result: { stdout: '{"catalogVersion":1}' } }];
    const outcome = await awaitSystemCleanupResult(LIST, 1_000);
    expect(outcome.status).not.toBe('completed');
    expect(outcome).toEqual({ status: 'not_found', error: 'command not found' });
  });

  it('maps the agent "unknown command type:" fallback to agent_update_required', async () => {
    seam.commandRows = [{ id: 'cmd-1', deviceId: DEVICE.id, type: 'system_cleanup_list', status: 'failed', result: { error: 'unknown command type: system_cleanup_list' } }];
    const outcome = await awaitSystemCleanupResult(LIST, 1_000);
    expect(outcome).toEqual({ status: 'failed', error: 'agent_update_required' });
  });

  it('actually polls at the interval, then times out when the row never terminalises', async () => {
    vi.useFakeTimers();
    seam.commandRows = [{ id: 'cmd-1', deviceId: DEVICE.id, type: 'system_cleanup_list', status: 'pending', result: null }];

    const pending = awaitSystemCleanupResult(LIST, 10_000, 1_000);
    // First poll happens synchronously on entry.
    await vi.advanceTimersByTimeAsync(0);
    expect(seam.select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seam.select).toHaveBeenCalledTimes(4);
    // Each poll is its own short org-scoped context, never a held one.
    expect(seam.outside).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ status: 'timeout', error: 'timed out' });
    expect(seam.select.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(seam.select.mock.calls.length).toBeLessThanOrEqual(11);
  });
});
