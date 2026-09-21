import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn(), queue: vi.fn(),
  context: vi.fn(), outside: vi.fn(), lock: vi.fn(),
  depth: 0, committed: false,
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
    kind: 'runs.kind', status: 'runs.status', commandId: 'runs.commandId',
  },
  deviceCommands: { id: 'commands.id', deviceId: 'commands.deviceId', status: 'commands.status', type: 'commands.type', payload: 'commands.payload' },
}));
vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
}));
vi.mock('./commandQueue', () => ({
  queueCommandForExecutionWithSystemPrecheck: seam.queue,
  CommandTypes: { SYSTEM_CLEANUP_LIST: 'system_cleanup_list', SYSTEM_CLEANUP_RUN: 'system_cleanup_run' },
}));

import {
  AGENT_UPDATE_REQUIRED_ERROR,
  MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  agentSupportsSystemCleanup,
  isUnknownCommandTypeError,
  parseAgentJson,
  systemCleanupAgentGate,
  systemCleanupCatalogSchema,
  systemCleanupRunResultSchema,
  queueSystemCleanupList,
  startSystemCleanupRun,
  failSystemCleanupRunAndCancelCommand,
} from './systemCleanup';

describe('agentSupportsSystemCleanup (spec §5.3)', () => {
  // Plan amendment 11: the newest tag on this branch is v0.114.0, so W04 ships
  // in 0.115.0. Bump this in the same PR if a release lands first.
  it('pins the minimum version W04 ships in', () => {
    expect(MIN_AGENT_VERSION_SYSTEM_CLEANUP).toBe('0.115.0');
    expect(AGENT_UPDATE_REQUIRED_ERROR).toBe('agent_update_required');
  });

  it('accepts the minimum and anything above it', () => {
    for (const version of ['0.115.0', '0.115.1', '0.116.0', '1.0.0', 'v0.115.0']) {
      expect(agentSupportsSystemCleanup(version)).toBe(true);
    }
  });

  it('rejects anything below it', () => {
    for (const version of ['0.114.0', '0.113.9', '0.99.0', '0.114.99']) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // Plan amendment 10: compareAgentVersions returns 0 for an unparseable
  // input, so a naive `>= 0` comparison would let '' through as "equal to the
  // minimum". devices.agent_version is NOT NULL, so '' is reachable.
  it('fails CLOSED on a missing or unparseable version', () => {
    for (const version of ['', '   ', 'dev', 'latest', 'v', null, undefined]) {
      expect(agentSupportsSystemCleanup(version)).toBe(false);
    }
  });

  // "core semver" (spec §5.3): a prerelease of the shipping version is the
  // lab build W05 runs the acceptance gate on. Gating it out would make the
  // gate untestable.
  it('compares the core only, so an rc of the shipping version passes', () => {
    expect(agentSupportsSystemCleanup('0.115.0-rc1')).toBe(true);
    expect(agentSupportsSystemCleanup('0.114.0-rc1')).toBe(false);
  });
});

describe('isUnknownCommandTypeError', () => {
  // The agent's fallback for a type it has no handler for
  // (heartbeat.go:6475). It is the defensive half of the 409: a device that
  // reports a version above the minimum but genuinely lacks the handler
  // (a hand-built binary, a botched update) still gets "update the agent"
  // instead of a bare failure with no next step.
  it('matches the agent fallback and nothing else', () => {
    expect(isUnknownCommandTypeError('unknown command type: system_cleanup_list')).toBe(true);
    expect(isUnknownCommandTypeError('  unknown command type: system_cleanup_run')).toBe(true);
    expect(isUnknownCommandTypeError('cleanmgr.exe not present')).toBe(false);
    expect(isUnknownCommandTypeError('the agent said unknown command type: later on')).toBe(false);
    expect(isUnknownCommandTypeError(null)).toBe(false);
    expect(isUnknownCommandTypeError(undefined)).toBe(false);
  });
});

const catalogFixture = {
  catalogVersion: 1,
  actions: [
    {
      id: 'linux_pkg_cache_clean',
      label: 'Package manager cache',
      description: 'Removes downloaded package archives.',
      os: 'linux',
      available: true,
      estimateBytes: 412_000_000,
      estimateKnown: true,
      estimateDetail: 'size of /var/cache/apt/archives',
      riskFlags: [],
      affectsVolumes: ['/'],
    },
    {
      id: 'linux_pkg_autoremove',
      label: 'Remove orphaned packages',
      description: 'Removes dependency-only packages.',
      os: 'linux',
      available: false,
      unavailableReason: 'sandbox denies write to /var/cache/apt',
      estimateKnown: false,
      riskFlags: ['removes_packages'],
      affectsVolumes: ['/'],
    },
  ],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

describe('systemCleanupCatalogSchema', () => {
  it('accepts the agent §7.3 shape', () => {
    const parsed = systemCleanupCatalogSchema.parse(catalogFixture);
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[1]?.unavailableReason).toBe('sandbox denies write to /var/cache/apt');
  });

  it('accepts cleanmgr sub-actions', () => {
    const parsed = systemCleanupCatalogSchema.parse({
      ...catalogFixture,
      actions: [{
        id: 'win_cleanmgr',
        label: 'Windows Disk Cleanup',
        description: 'Runs the built-in handlers you select.',
        os: 'windows',
        available: true,
        estimateKnown: false,
        riskFlags: ['long_running'],
        affectsVolumes: [],
        subActions: [
          { id: 'win_cleanmgr:update_cleanup', label: 'Windows Update cleanup', estimateKnown: false },
          { id: 'win_cleanmgr:temporary_files', label: 'Temporary files', estimateBytes: 1_024, estimateKnown: true },
        ],
      }],
    });
    expect(parsed.actions[0]?.subActions).toHaveLength(2);
  });

  // The server never trusts an agent-supplied id: a compromised or buggy agent
  // must not be able to put an arbitrary string into a row the UI then sends
  // straight back in a run request.
  it('rejects an action id outside the shared catalogue', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], id: 'win_cleanmgr:DownloadsFolder' }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });

  it('rejects a risk flag outside the shared list', () => {
    const hostile = {
      ...catalogFixture,
      actions: [{ ...catalogFixture.actions[0], riskFlags: ['<img src=x onerror=1>'] }],
    };
    expect(systemCleanupCatalogSchema.safeParse(hostile).success).toBe(false);
  });
});

describe('systemCleanupRunResultSchema', () => {
  it('accepts the agent §7.3 run shape', () => {
    const parsed = systemCleanupRunResultSchema.parse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [
        { id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0, durationMs: 812, outputTail: 'Done' },
        { id: 'linux_journal_vacuum', status: 'failed', exitCode: 1, durationMs: 90, error: 'permission denied' },
      ],
      volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      freedBytes: 3_000,
    });
    expect(parsed.freedBytes).toBe(3_000);
    expect(parsed.actions[1]?.status).toBe('failed');
  });

  it('rejects an unknown per-action status', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [{ id: 'linux_pkg_cache_clean', status: 'sort-of', exitCode: 0, durationMs: 1 }],
      volumes: [],
      freedBytes: 0,
    }).success).toBe(false);
  });

  it('rejects a negative freedBytes — measurement is floored at 0 agent-side', () => {
    expect(systemCleanupRunResultSchema.safeParse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [],
      volumes: [],
      freedBytes: -1,
    }).success).toBe(false);
  });
});

describe('parseAgentJson', () => {
  it('returns the parsed value for valid stdout', () => {
    expect(parseAgentJson(systemCleanupCatalogSchema, JSON.stringify(catalogFixture))?.catalogVersion).toBe(1);
  });

  // The W01 lesson from the AI lane (spec defect 5): an unparseable agent
  // payload must produce NOTHING, never an empty-but-valid record.
  it('returns null for empty, non-JSON or schema-invalid stdout', () => {
    for (const stdout of ['', '   ', 'not json', '{}', '[]', null, undefined]) {
      expect(parseAgentJson(systemCleanupCatalogSchema, stdout)).toBeNull();
    }
  });
});

describe('systemCleanupAgentGate', () => {
  it('allows supported agents', () => {
    expect(systemCleanupAgentGate({ agentVersion: '0.115.0-rc1' })).toEqual({ ok: true });
  });

  it('returns the shared 409 response for old or unparseable agents', () => {
    for (const agentVersion of ['0.114.0', '', 'dev', null]) {
      expect(systemCleanupAgentGate({ agentVersion })).toEqual({
        ok: false,
        status: 409,
        error: 'agent_update_required',
        minAgentVersion: '0.115.0',
      });
    }
  });
});

describe('systemCleanupRunResultSchema maintenance and budget outcomes', () => {
  it.each(['busy', 'not_started'])('accepts the agent %s status for actions and sub-actions', (status) => {
    const parsed = systemCleanupRunResultSchema.parse({
      runId: '11111111-1111-4111-8111-111111111111',
      actions: [{
        id: 'win_cleanmgr',
        status,
        exitCode: -1,
        durationMs: 0,
        subActions: [{ id: 'win_cleanmgr:update_cleanup', status }],
      }],
      volumes: [],
      freedBytes: 0,
    });
    expect(parsed.actions[0]?.status).toBe(status);
    expect(parsed.actions[0]?.subActions?.[0]?.status).toBe(status);
  });
});


const SEAM_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const SEAM_ORG_ID = '11111111-1111-4111-8111-111111111111';
const SEAM_RUN_ID = '44444444-4444-4444-8444-444444444444';
const SEAM_COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const seamArgs = {
  device: { id: SEAM_DEVICE_ID, orgId: SEAM_ORG_ID, agentVersion: '0.115.0', status: 'online' },
  requestedBy: '55555555-5555-4555-8555-555555555555',
  actionIds: ['linux_pkg_cache_clean'],
};

// The mock tracks the transaction boundary rather than only invocation order:
// a websocket result can see the claim only after that transaction commits.
describe('system-cleanup queue/start service seam', () => {
  const writes: Array<{ table: unknown; values: Record<string, unknown>; condition?: unknown }> = [];
  let returnedUpdates: unknown[][];
  let activeRuns: unknown[];
  beforeEach(() => {
    vi.clearAllMocks();
    seam.depth = 0;
    seam.committed = false;
    writes.length = 0;
    returnedUpdates = [];
    activeRuns = [];
    seam.context.mockImplementation(async (_context: unknown, callback: () => Promise<unknown>) => {
      seam.depth++;
      try { return await callback(); } finally { seam.depth--; }
    });
    seam.outside.mockImplementation(async (callback: () => Promise<unknown>) => {
      const previous = seam.depth;
      seam.depth = 0;
      try { return await callback(); } finally { seam.depth = previous; }
    });
    seam.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const result = await callback({ select: seam.select, insert: seam.insert, update: seam.update });
      seam.committed = true;
      return result;
    });
    seam.lock.mockResolvedValue([{ id: SEAM_DEVICE_ID }]);
    seam.select.mockImplementation(() => ({
      from: (table: { id: string }) => ({
        where: () => ({
          for: seam.lock,
          limit: () => table.id === 'devices.id'
            ? { for: seam.lock, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([{ id: SEAM_DEVICE_ID }])) }
            : Promise.resolve(activeRuns),
        }),
      }),
    }));
    seam.insert.mockImplementation((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: SEAM_RUN_ID }] };
      },
    }));
    seam.update.mockImplementation((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          writes.push({ table, values, condition });
          const rows = returnedUpdates.shift() ?? [];
          return Object.assign(Promise.resolve(rows), { returning: async () => rows });
        },
      }),
    }));
    seam.queue.mockResolvedValue({ command: { id: SEAM_COMMAND_ID, status: 'pending' } });
  });

  it.each(['0.114.0', '', 'dev', null])('gates both callers before any claim or dispatch for %s', async (agentVersion) => {
    const args = { ...seamArgs, device: { ...seamArgs.device, agentVersion } };
    for (const invoke of [queueSystemCleanupList, startSystemCleanupRun]) {
      await expect(invoke(args)).resolves.toMatchObject({ ok: false, status: 409, error: 'agent_update_required' });
    }
    expect(seam.insert).not.toHaveBeenCalled();
    expect(seam.queue).not.toHaveBeenCalled();
  });

  it('rejects invalid action ids before writing or dispatching', async () => {
    await expect(startSystemCleanupRun({ ...seamArgs, actionIds: ['win_cleanmgr:DownloadsFolder'] }))
      .resolves.toMatchObject({ ok: false, status: 400 });
    expect(seam.insert).not.toHaveBeenCalled();
    expect(seam.queue).not.toHaveBeenCalled();
  });

  it('queues a catalog without creating a run', async () => {
    await expect(queueSystemCleanupList(seamArgs)).resolves.toEqual({ ok: true, commandId: SEAM_COMMAND_ID });
    expect(seam.queue).toHaveBeenCalledWith(SEAM_DEVICE_ID, 'system_cleanup_list', {}, { userId: seamArgs.requestedBy, expectedOrgId: SEAM_ORG_ID });
    expect(seam.insert).not.toHaveBeenCalled();
  });

  it('commits the locked claim before dispatch and stores its selection deadline', async () => {
    seam.queue.mockImplementation(async () => {
      expect(seam.depth).toBe(0);
      expect(seam.committed).toBe(true);
      expect(writes[0]?.values).toMatchObject({ kind: 'system', status: 'running' });
      return { command: { id: SEAM_COMMAND_ID } };
    });
    const started = await startSystemCleanupRun(seamArgs);
    expect(started).toEqual({ ok: true, commandId: SEAM_COMMAND_ID, cleanupRunId: SEAM_RUN_ID, deadlineAt: expect.any(String) });
    expect(seam.lock).toHaveBeenCalledWith('update');
    const plan = writes[0]?.values.plan as { deadlineAt: string };
    // The deadline the caller is told is the one STORED on the row — one number.
    expect((started as { deadlineAt: string }).deadlineAt).toBe(plan.deadlineAt);
    expect(new Date(plan.deadlineAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(new Date(plan.deadlineAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(writes.at(-1)?.values).toMatchObject({ commandId: SEAM_COMMAND_ID });
  });

  it('refuses an existing active claim after locking the device', async () => {
    activeRuns = [{ id: SEAM_RUN_ID, plan: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } }];
    await expect(startSystemCleanupRun(seamArgs)).resolves.toMatchObject({ ok: false, status: 409, error: 'run_in_progress', cleanupRunId: SEAM_RUN_ID });
    expect(seam.lock).toHaveBeenCalledWith('update');
    expect(seam.insert).not.toHaveBeenCalled();
    expect(seam.queue).not.toHaveBeenCalled();
  });

  it('expires a stale claim and cancels its command inside the new claim transaction', async () => {
    activeRuns = [{ id: SEAM_RUN_ID, plan: { deadlineAt: new Date(Date.now() - 1_000).toISOString() } }];
    returnedUpdates = [[{ id: SEAM_RUN_ID, commandId: SEAM_COMMAND_ID }], [{ id: SEAM_COMMAND_ID }]];
    await expect(startSystemCleanupRun(seamArgs)).resolves.toMatchObject({ ok: true });
    expect(writes[0]?.values).toMatchObject({ status: 'failed', error: 'run_expired' });
    expect(writes[1]?.values).toMatchObject({ status: 'cancelled' });
    expect(writes[2]?.values).toMatchObject({ status: 'running', kind: 'system' });
    expect(seam.transaction).toHaveBeenCalledTimes(1);
    expect(seam.queue).toHaveBeenCalledTimes(1);
  });

  it.each(['returned', 'thrown'])('marks the committed claim failed on a %s queue error', async (mode) => {
    if (mode === 'returned') seam.queue.mockResolvedValue({ error: 'Device is offline' });
    else seam.queue.mockRejectedValue(new Error('Device is offline'));
    await expect(startSystemCleanupRun(seamArgs)).resolves.toMatchObject({ ok: false, status: 503, error: 'Device is offline' });
    expect(writes.at(-1)?.values).toMatchObject({ status: 'failed', error: 'Device is offline' });
    expect(seam.depth).toBe(0);
  });

  it('atomically fails only the scoped running system run and cancels only its pending command', async () => {
    returnedUpdates = [[{ id: SEAM_RUN_ID, commandId: SEAM_COMMAND_ID }], [{ id: SEAM_COMMAND_ID }]];
    await expect(failSystemCleanupRunAndCancelCommand({ runId: SEAM_RUN_ID, deviceId: SEAM_DEVICE_ID, orgId: SEAM_ORG_ID, error: 'timed out' })).resolves.toBe(true);
    expect(seam.transaction).toHaveBeenCalledTimes(1);
    expect(writes[0]?.values).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(writes[0]?.condition).toMatchObject({ conditions: expect.arrayContaining([
      { left: 'runs.id', right: SEAM_RUN_ID }, { left: 'runs.deviceId', right: SEAM_DEVICE_ID },
      { left: 'runs.orgId', right: SEAM_ORG_ID }, { left: 'runs.kind', right: 'system' },
      { left: 'runs.status', right: 'running' },
    ]) });
    expect(writes[1]?.values).toMatchObject({ status: 'cancelled' });
    expect(writes[1]?.condition).toMatchObject({ conditions: expect.arrayContaining([
      { left: 'commands.id', right: SEAM_COMMAND_ID }, { left: 'commands.deviceId', right: SEAM_DEVICE_ID },
      { left: 'commands.status', right: 'pending' },
    ]) });
  });

  it('cancels an unlinked pending cleanup command by device and payload runId', async () => {
    returnedUpdates = [[{ id: SEAM_RUN_ID, commandId: null }], [{ id: SEAM_COMMAND_ID }]];
    await expect(failSystemCleanupRunAndCancelCommand({ runId: SEAM_RUN_ID, deviceId: SEAM_DEVICE_ID, orgId: SEAM_ORG_ID, error: 'run_expired' })).resolves.toBe(true);
    expect(writes[1]?.values).toMatchObject({ status: 'cancelled' });
    expect(writes[1]?.condition).toMatchObject({ conditions: expect.arrayContaining([
      { left: 'commands.deviceId', right: SEAM_DEVICE_ID },
      { left: 'commands.status', right: 'pending' },
      { conditions: expect.arrayContaining([
        { left: 'commands.type', right: 'system_cleanup_run' },
        { strings: ["", "->>'runId' = ", ""], values: ['commands.payload', SEAM_RUN_ID] },
      ]) },
    ]) });
  });

  it('leaves the command untouched when a real result wins the run CAS', async () => {
    returnedUpdates = [[]];
    await expect(failSystemCleanupRunAndCancelCommand({ runId: SEAM_RUN_ID, deviceId: SEAM_DEVICE_ID, orgId: SEAM_ORG_ID, error: 'timed out' })).resolves.toBe(false);
    expect(seam.update).toHaveBeenCalledTimes(1);
  });
});
