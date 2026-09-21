import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Disk Cleanup v2 W05 review (F1/F3/F4) — `resolveSystemCleanupRunStatus`.
 *
 * ONE implementation of "what state is this system run in" serves both the
 * human poll route (`GET /devices/:id/filesystem/system-cleanup/run/:id`) and
 * the AI tool's `status` action. The route suite exercises it through Hono;
 * this suite pins the semantics against the seam directly, so the AI lane
 * cannot drift from what a tech sees in the panel.
 */

const seam = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  runRows: [] as Record<string, unknown>[],
  commandRows: [] as Record<string, unknown>[],
  whereClauses: [] as unknown[],
  /** Rows the runs-table CAS update returns: [] means a real result won first. */
  casRows: [] as Record<string, unknown>[],
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
}));

vi.mock('../db', () => ({
  db: {
    select: seam.select, insert: vi.fn(), update: seam.update,
    // `failSystemCleanupRunAndCancelCommand` is called through the module's
    // own binding, so it cannot be spied; its transaction runs for real here.
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ update: seam.update }),
  },
  withDbAccessContext: async (_context: unknown, callback: () => Promise<unknown>) => callback(),
  runOutsideDbContext: async (callback: () => Promise<unknown>) => callback(),
}));
vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceFilesystemCleanupRuns: {
    id: 'runs.id', orgId: 'runs.orgId', deviceId: 'runs.deviceId',
    kind: 'runs.kind', status: 'runs.status', commandId: 'runs.commandId', plan: 'runs.plan',
  },
  deviceCommands: {
    id: 'commands.id', deviceId: 'commands.deviceId', status: 'commands.status',
    type: 'commands.type', payload: 'commands.payload', result: 'commands.result',
  },
}));
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
}));
vi.mock('./commandQueue', () => ({
  queueCommandForExecutionWithSystemPrecheck: vi.fn(),
  CommandTypes: { SYSTEM_CLEANUP_LIST: 'system_cleanup_list', SYSTEM_CLEANUP_RUN: 'system_cleanup_run' },
}));

import { MIN_AGENT_VERSION_SYSTEM_CLEANUP, resolveSystemCleanupRunStatus } from './systemCleanup';

const DEVICE = { id: '33333333-3333-3333-3333-333333333333', orgId: '11111111-1111-1111-1111-111111111111' };
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';

function eqPairs(clause: unknown): Array<[unknown, unknown]> {
  const record = clause as { and?: unknown[]; eq?: [unknown, unknown] };
  if (record.eq) return [record.eq];
  return (record.and ?? []).flatMap(eqPairs);
}

describe('resolveSystemCleanupRunStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seam.runRows = [];
    seam.commandRows = [];
    seam.whereClauses = [];
    seam.select.mockImplementation(() => ({
      from: (table: { id: string }) => ({
        where: (clause: unknown) => {
          seam.whereClauses.push(clause);
          return {
            limit: () => Promise.resolve(table.id === 'runs.id' ? seam.runRows : seam.commandRows),
          };
        },
      }),
    }));
    seam.casRows = [];
    seam.updates = [];
    seam.update.mockImplementation((table: { id: string }) => ({
      set: (values: Record<string, unknown>) => {
        seam.updates.push({ table: table.id, set: values });
        return {
          where: () => ({
            returning: async () => (table.id === 'runs.id' ? seam.casRows : []),
          }),
        };
      },
    }));
  });

  it('looks the run up by id AND device AND org AND kind=system', async () => {
    seam.runRows = [];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toEqual({ ok: false, status: 404, error: 'run_not_found' });
    const pairs = eqPairs(seam.whereClauses[0]);
    expect(pairs).toEqual(expect.arrayContaining([
      ['runs.id', RUN_ID], ['runs.deviceId', DEVICE.id], ['runs.orgId', DEVICE.orgId], ['runs.kind', 'system'],
    ]));
  });

  it('returns the persisted projection for a finished run — the result handler is authoritative', async () => {
    seam.runRows = [{
      id: RUN_ID, deviceId: DEVICE.id, kind: 'system', status: 'executed', error: null, commandId: COMMAND_ID,
      bytesReclaimed: 3_000, requestedAt: new Date('2026-09-19T10:00:00Z'),
      plan: { actionIds: ['linux_pkg_cache_clean'], deadlineAt: '2026-09-19T10:20:00.000Z' },
      executedActions: {
        actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
        volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      },
    }];
    seam.commandRows = [{ status: 'completed', result: { stdout: '{}' } }];

    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toEqual({
      ok: true,
      run: {
        cleanupRunId: RUN_ID,
        commandId: COMMAND_ID,
        status: 'executed',
        error: null,
        freedBytes: 3_000,
        actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
        volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
        requestedAt: new Date('2026-09-19T10:00:00Z'),
        deadlineAt: '2026-09-19T10:20:00.000Z',
      },
    });
    // The command is scoped by id AND device AND type — device_commands has no
    // RLS, so the org context filters nothing there.
    const pairs = eqPairs(seam.whereClauses[1]);
    expect(pairs).toEqual(expect.arrayContaining([
      ['commands.id', COMMAND_ID], ['commands.deviceId', DEVICE.id], ['commands.type', 'system_cleanup_run'],
    ]));
    expect(seam.updates).toEqual([]);
  });

  it('reports a run whose every action failed as failed, never as success', async () => {
    seam.runRows = [{
      id: RUN_ID, status: 'failed', error: '2 cleanup action(s) did not complete', commandId: COMMAND_ID,
      bytesReclaimed: 0, requestedAt: new Date(), plan: {},
      executedActions: { actions: [{ id: 'win_cleanmgr', status: 'failed', exitCode: 1 }], volumes: [] },
    }];
    seam.commandRows = [{ status: 'completed', result: {} }];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: true, run: { status: 'failed', error: '2 cleanup action(s) did not complete', freedBytes: 0 } });
  });

  it('finalises a running row past its STORED deadline through the shared cancel-and-fail', async () => {
    seam.runRows = [{
      id: RUN_ID, status: 'running', error: null, commandId: COMMAND_ID, bytesReclaimed: 0,
      requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      plan: { actionIds: ['linux_pkg_cache_clean'], deadlineAt: new Date(Date.now() - 60_000).toISOString() },
      executedActions: [],
    }];
    seam.commandRows = [{ status: 'pending', result: null }];
    seam.casRows = [{ id: RUN_ID, commandId: COMMAND_ID }];

    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: true, run: { status: 'failed', error: 'timed out' } });
    // Both halves, in one transaction: the run is failed AND its pending
    // command is cancelled (spec §13 #6/#13).
    expect(seam.updates.map((u) => u.table)).toEqual(['runs.id', 'commands.id']);
    expect(seam.updates[0]!.set).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(seam.updates[1]!.set).toMatchObject({ status: 'cancelled' });
  });

  it('keeps reporting running when a real result won the CAS first', async () => {
    seam.runRows = [{
      id: RUN_ID, status: 'running', error: null, commandId: COMMAND_ID, bytesReclaimed: 0,
      requestedAt: new Date(), plan: { deadlineAt: new Date(Date.now() - 60_000).toISOString() }, executedActions: [],
    }];
    seam.commandRows = [{ status: 'running', result: null }];
    seam.casRows = []; // the CAS on status='running' matched nothing
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: true, run: { status: 'running', error: null } });
    expect(seam.updates.map((u) => u.table)).toEqual(['runs.id']);
  });

  it('leaves a running row inside its deadline alone', async () => {
    seam.runRows = [{
      id: RUN_ID, status: 'running', error: null, commandId: COMMAND_ID, bytesReclaimed: 0,
      requestedAt: new Date(), plan: { deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString() }, executedActions: [],
    }];
    seam.commandRows = [{ status: 'sent', result: null }];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: true, run: { status: 'running' } });
    expect(seam.updates).toEqual([]);
  });

  it('falls back to the three-hour ceiling when the row carries no stored deadline', async () => {
    seam.runRows = [{
      id: RUN_ID, status: 'running', error: null, commandId: null, bytesReclaimed: 0,
      requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), plan: {}, executedActions: [],
    }];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: true, run: { status: 'running', deadlineAt: null } });
    expect(seam.updates).toEqual([]);
    // No commandId on the row: no command lookup either.
    expect(seam.whereClauses).toHaveLength(1);
  });

  it('maps an unknown-command-type answer from the COMMAND to agent_update_required + minAgentVersion', async () => {
    seam.runRows = [{ id: RUN_ID, status: 'running', error: null, commandId: COMMAND_ID, requestedAt: new Date(), plan: {} }];
    seam.commandRows = [{ status: 'failed', result: { error: 'unknown command type: system_cleanup_run' } }];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toEqual({
      ok: false, status: 409, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
    });
  });

  it('maps an unknown-command-type answer persisted on the RUN the same way', async () => {
    seam.runRows = [{ id: RUN_ID, status: 'failed', error: 'unknown command type: system_cleanup_run', commandId: COMMAND_ID, requestedAt: new Date(), plan: {} }];
    const result = await resolveSystemCleanupRunStatus({ device: DEVICE, cleanupRunId: RUN_ID });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP });
  });
});
