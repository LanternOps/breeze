import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { UNINSTALL_REASON_DEVICE_REMOVE } from '../services/deviceUninstallDrain';

const { selectMock, updateMock, deviceCommandsTable, restoreJobsTable, backupJobsTable, devicesTable, softwareDeploymentsTable, deploymentResultsTable, scriptExecutionsTable, scriptExecutionBatchesTable, queueBackupStopCommandMock, applyAutomationActionTerminalMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  deviceCommandsTable: {
    id: 'device_commands.id',
    type: 'device_commands.type',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
    createdAt: 'device_commands.created_at',
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
    result: 'device_commands.result',
    deviceId: 'device_commands.device_id',
    uninstallReasons: 'device_commands.uninstall_reasons',
    deviceRemoveExpiresAt: 'device_commands.device_remove_expires_at',
  },
  restoreJobsTable: {
    id: 'restore_jobs.id',
    commandId: 'restore_jobs.command_id',
    status: 'restore_jobs.status',
    targetConfig: 'restore_jobs.target_config',
    completedAt: 'restore_jobs.completed_at',
    updatedAt: 'restore_jobs.updated_at',
  },
  backupJobsTable: {
    id: 'backup_jobs.id',
    deviceId: 'backup_jobs.device_id',
    status: 'backup_jobs.status',
    lastProgressAt: 'backup_jobs.last_progress_at',
    startedAt: 'backup_jobs.started_at',
    createdAt: 'backup_jobs.created_at',
    completedAt: 'backup_jobs.completed_at',
    updatedAt: 'backup_jobs.updated_at',
    errorLog: 'backup_jobs.error_log',
  },
  devicesTable: {
    id: 'devices.id',
    status: 'devices.status',
    lastSeenAt: 'devices.last_seen_at',
  },
  softwareDeploymentsTable: {
    id: 'software_deployments.id',
    dispatchedAt: 'software_deployments.dispatched_at',
  },
  deploymentResultsTable: {
    id: 'deployment_results.id',
    deploymentId: 'deployment_results.deployment_id',
    status: 'deployment_results.status',
    completedAt: 'deployment_results.completed_at',
    errorMessage: 'deployment_results.error_message',
    deviceCommandId: 'deployment_results.device_command_id',
  },
  scriptExecutionsTable: {
    id: 'script_executions.id',
    status: 'script_executions.status',
    scriptId: 'script_executions.script_id',
    createdAt: 'script_executions.created_at',
    startedAt: 'script_executions.started_at',
    completedAt: 'script_executions.completed_at',
    errorMessage: 'script_executions.error_message',
  },
  scriptExecutionBatchesTable: {
    id: 'script_execution_batches.id',
    devicesTargeted: 'script_execution_batches.devices_targeted',
    devicesCompleted: 'script_execution_batches.devices_completed',
    devicesFailed: 'script_execution_batches.devices_failed',
    status: 'script_execution_batches.status',
    completedAt: 'script_execution_batches.completed_at',
  },
  queueBackupStopCommandMock: vi.fn(),
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: (...args: unknown[]) => selectMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
  };
});

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    deviceCommands: deviceCommandsTable,
    restoreJobs: restoreJobsTable,
    backupJobs: backupJobsTable,
    devices: devicesTable,
    softwareDeployments: softwareDeploymentsTable,
    deploymentResults: deploymentResultsTable,
    scriptExecutions: scriptExecutionsTable,
    scriptExecutionBatches: scriptExecutionBatchesTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

vi.mock('../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/commandQueue')>();
  return {
    ...actual,
    queueBackupStopCommand: (...args: unknown[]) => queueBackupStopCommandMock(...(args as [])),
  };
});

import {
  reapStaleDeviceCommands,
  reapStaleBackupJobs,
  reapStaleSoftwareDeploymentResults,
  resolveMaxReapPerRun,
  SOFTWARE_INSTALL_TIMEOUT_MS,
  SOFTWARE_QUEUED_EXPIRY_MS,
  reapStaleScriptExecutions
} from './staleCommandReaper';

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

function backupUpdateChain(returningValue: unknown) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(returningValue),
      })),
    })),
  };
}

// The `0 == unlimited` knob is subtle and availability-critical: drizzle's
// `.limit(0)` returns ZERO rows, so a naive pass-through would silently
// disable the reaper entirely rather than uncapping it. #2823 also changed
// what an EMPTY `STALE_REAPER_MAX_PER_RUN` resolves to — it used to reach
// this mapping as 0 (unlimited); it now reaches it as the 5000 default.
describe('resolveMaxReapPerRun', () => {
  it('passes a positive cap through', () => {
    expect(resolveMaxReapPerRun(5000)).toBe(5000);
    expect(resolveMaxReapPerRun(1)).toBe(1);
  });

  it('maps an explicit 0 to unlimited, never to a zero-row limit', () => {
    expect(resolveMaxReapPerRun(0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(resolveMaxReapPerRun(0)).not.toBe(0);
  });

  it('falls back to the default for a negative cap', () => {
    expect(resolveMaxReapPerRun(-1)).toBe(5000);
  });
});

describe('stale command reaper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('propagates timeout failures into restore jobs for all restore command types', async () => {
    const staleCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: 'cmd-restore',
        type: 'backup_restore',
        status: 'pending',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: null,
      },
      {
        id: 'cmd-vm',
        type: 'vm_restore_from_backup',
        status: 'sent',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: staleCreatedAt,
      },
      {
        id: 'cmd-boot',
        type: 'vm_instant_boot',
        status: 'sent',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: staleCreatedAt,
      },
      {
        id: 'cmd-bmr',
        type: 'bmr_recover',
        status: 'pending',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: null,
      },
    ]));

    const deviceCommandReturning = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'cmd-restore' }])
      .mockResolvedValueOnce([{ id: 'cmd-vm' }])
      .mockResolvedValueOnce([{ id: 'cmd-boot' }])
      .mockResolvedValueOnce([{ id: 'cmd-bmr' }]);

    const deviceCommandSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: deviceCommandReturning,
      })),
    }));

    const restoreWhere = vi.fn().mockResolvedValue([]);
    const restoreSet = vi.fn(() => ({
      where: restoreWhere,
    }));

    updateMock.mockImplementation((table: unknown) => {
      if (table === deviceCommandsTable) {
        return { set: deviceCommandSet };
      }
      if (table === restoreJobsTable) {
        return { set: restoreSet };
      }
      throw new Error(`Unexpected table update: ${String(table)}`);
    });

    const reaped = await reapStaleDeviceCommands();

    expect(reaped).toBe(4);
    expect(deviceCommandReturning).toHaveBeenCalledTimes(4);
    expect(restoreWhere).toHaveBeenCalledTimes(4);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledTimes(4);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'reaper',
      commandId: 'cmd-restore',
      terminalStatus: 'timed_out',
    }));
  });

  // #2774 — a drain-window self_uninstall must outlive the 30-min timeout
  // while (and only while) its tenant is `offboarding`. Pin that the SELECT's
  // WHERE carries the offboarding-scoped exemption so a refactor can't
  // silently drop it and resurrect the silent-expiry bug.
  it('scopes the self_uninstall reap exemption to offboarding tenants', async () => {
    const chain = selectChain([]);
    selectMock.mockReturnValueOnce(chain);

    await reapStaleDeviceCommands();

    const whereArg = chain.where.mock.calls[0]?.[0];
    const containsString = (root: unknown, needle: string): boolean => {
      const seen = new WeakSet<object>();
      const walk = (value: unknown): boolean => {
        if (typeof value === 'string') return value.includes(needle);
        if (!value || typeof value !== 'object') return false;
        if (seen.has(value as object)) return false;
        seen.add(value as object);
        return Object.values(value as Record<string, unknown>).some(walk);
      };
      return walk(root);
    };
    expect(containsString(whereArg, 'self_uninstall')).toBe(true);
    expect(containsString(whereArg, 'offboarding')).toBe(true);
  });

  // #3986 Task 10 — the device-remove drain gets its OWN arm inside the same
  // NOT(...) wrapper, independent of the #2774 offboarding arm above (which
  // stays untouched — see module comment on why it is NOT reused/widened).
  //
  // These compile the actual `.where()` argument to real parameterized SQL
  // via `PgDialect().sqlToQuery(...)` and assert on both `.sql` and
  // `.params` — the documented history here is that a bare `toContain(...)`
  // substring check passes identically whether the code wrote `and()` or
  // `or()`, or whether a clause got dropped, so structure (not just
  // presence) is what's under test. The mocked schema's columns compile to
  // BOUND PARAMETERS rather than real identifiers (they're plain strings,
  // not Drizzle Column instances), which is exactly what lets us assert
  // precise param adjacency below.
  describe('the device_remove drain arm (#3986)', () => {
    function compileWhere() {
      const chain = selectChain([]);
      selectMock.mockReturnValueOnce(chain);
      return reapStaleDeviceCommands().then(() => {
        const whereArg = chain.where.mock.calls[0]?.[0];
        return new PgDialect().sqlToQuery(whereArg as never);
      });
    }

    it('does not reap a device_remove uninstall inside its deadline: the exemption arm is a 3-way AND (self_uninstall type + the device_remove reason + an unexpired deadline), joined to the offboarding arm by OR inside the same NOT(...)', async () => {
      const { sql: sqlText, params } = await compileWhere();

      // The arm itself, verbatim — proves it's a conjunction (a row must
      // satisfy type AND reason AND deadline together to be exempted), and
      // that it sits as an OR-alternative to the offboarding arm rather than
      // replacing/widening it.
      expect(sqlText).toContain(
        "OR (\n        $15 = 'self_uninstall'\n        AND $16 @> ARRAY[$17]::text[]\n        AND $18 > now()\n      )",
      );

      // The reason bound to the containment check is the exported constant,
      // never a hardcoded literal re-typed in the reaper — and it sits
      // immediately between the uninstall_reasons column and the deadline
      // column, i.e. it can only be reached via this exact clause shape.
      const reasonIdx = params.indexOf(UNINSTALL_REASON_DEVICE_REMOVE);
      expect(reasonIdx).toBeGreaterThan(0);
      expect(params[reasonIdx - 1]).toBe('device_commands.uninstall_reasons');
      expect(params[reasonIdx + 1]).toBe('device_commands.device_remove_expires_at');
    });

    it('reaps it once device_remove_expires_at has passed: the deadline is compared with a strict `>` against Postgres\'s own now(), never `>=` and never a JS-computed timestamp bound as a param', async () => {
      const { sql: sqlText, params } = await compileWhere();

      expect(sqlText).toContain('$18 > now()');
      expect(sqlText).not.toMatch(/>=\s*now\(\)/);

      // now() is evaluated by Postgres itself on every poll. The only bound
      // Date in the whole WHERE is the unrelated SQL pre-filter cutoff
      // (`createdAt < now - SHORTEST_TIMEOUT_MS`, computed once per reaper
      // run) — nothing stands in for "now" in the deadline arm itself,
      // which would otherwise freeze it at reaper-start time instead of
      // re-evaluating it fresh on every row, every poll.
      const dateParams = params.filter((p) => p instanceof Date);
      expect(dateParams).toHaveLength(1);
    });

    // The regression guard: this is the test that must go RED if the reason
    // clause is ever relaxed (e.g. dropped so the arm keys on
    // self_uninstall + deadline alone, or widened to key on devices.status).
    // routes/admin/abuse.ts queues self_uninstall onto every device under a
    // suspended partner with NO status filter — including already-
    // decommissioned devices — and never sets uninstallReasons or
    // deviceRemoveExpiresAt. Such a row satisfies neither arm here, so it is
    // never excluded from the SELECT and keeps expiring at the normal
    // 30-minute self_uninstall timeout (MEDIUM_TIMEOUT_TYPES in
    // commandTimeouts.ts) — proven behaviorally below, once the structural
    // proof establishes the row survives the WHERE.
    //
    // "Satisfies neither arm" only holds because of the NULL guard pinned by
    // the test that follows this one. Both halves of the device-remove arm
    // evaluate to NULL (not false) for such a row, and an unguarded NULL
    // propagates out through NOT(...) and silently drops the row from the
    // candidate set instead. Nothing in THIS test can see that: the compiled
    // clause shape is identical either way.
    it('still reaps an abuse-queued self_uninstall on an already-decommissioned device at 30 minutes', async () => {
      const { sql: sqlText, params } = await compileWhere();

      // Structural: devices.status never appears anywhere in the compiled
      // predicate — decommissioned status can never itself satisfy either
      // exemption arm. (The offboarding arm keys on organizations/partners
      // status, not devices.status, and this arm doesn't touch devices at
      // all.)
      expect(sqlText).not.toContain('devices.status');
      expect(params).not.toContain('devices.status');

      // Structural: the ONLY appearance of the device_remove literal is
      // paired with uninstall_reasons — there is no second, looser route
      // (e.g. a bare `type = 'self_uninstall'` OR-branch) to the exemption.
      const reasonOccurrences = params.filter((p) => p === UNINSTALL_REASON_DEVICE_REMOVE).length;
      expect(reasonOccurrences).toBe(1);

      // Behavioral: an abuse-queued row that reaches the reaper's JS loop
      // (i.e. survived the WHERE, which the structural proof above
      // establishes for a row with no device_remove reason) on an
      // already-decommissioned device is reaped at the ordinary 30-minute
      // self_uninstall timeout, exactly like any other command.
      const staleCreatedAt = new Date(Date.now() - 31 * 60 * 1000);
      selectMock.mockReturnValueOnce(selectChain([
        {
          id: 'cmd-abuse',
          type: 'self_uninstall',
          status: 'pending',
          payload: null,
          createdAt: staleCreatedAt,
          executedAt: null,
        },
      ]));
      const returning = vi.fn().mockResolvedValueOnce([{ id: 'cmd-abuse' }]);
      updateMock.mockReturnValueOnce({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      });

      const reaped = await reapStaleDeviceCommands();

      expect(reaped).toBe(1);
      expect(returning).toHaveBeenCalledTimes(1);
    });

    // Cheap structural backstop for a defect only a live database can
    // actually demonstrate (deviceUninstallDrain.integration.test.ts's
    // incident guard). `NULL @> ARRAY['device_remove']` and `NULL > now()`
    // are both NULL, so for a reason-less row the exemption disjunction is
    // NULL and `NOT NULL` is NULL — which does NOT match, silently dropping
    // every abuse-queued self_uninstall out of the reaper's candidate set and
    // making it immortal. COALESCE(..., FALSE) is what keeps the NOT boolean.
    it('wraps the exemption disjunction in COALESCE(..., FALSE) so a NULL uninstall_reasons / deadline cannot void the whole NOT(...)', async () => {
      const { sql: sqlText } = await compileWhere();

      expect(sqlText).toContain('NOT COALESCE(');
      expect(sqlText).toContain('), FALSE)');
      expect(sqlText).not.toMatch(/NOT \(\n\s+\(\n\s+\$\d+ = 'self_uninstall'/);
    });
  });
});

describe('reapStaleBackupJobs', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

  beforeEach(() => {
    vi.resetAllMocks();
    queueBackupStopCommandMock.mockResolvedValue({ command: {} });
  });

  it('reaps a stalled running job (rule A) on an online device and queues a stop command', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-stall',
          deviceId: 'device-1',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-stall' }]),
      })),
    }));
    updateMock.mockImplementation((table: unknown) => {
      if (table !== backupJobsTable) throw new Error(`Unexpected table update: ${String(table)}`);
      return { set: setMock };
    });

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: '[stale-backup-reaper] Backup stalled: no progress reported for 15 minutes',
      })
    );
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-1', { jobId: 'job-stall' });
  });

  it('reaps a running job whose device went offline (rule B) and does NOT queue a stop command', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-offline',
          deviceId: 'device-2',
          lastProgressAt: minutesAgo(12),
          startedAt: minutesAgo(30),
          errorLog: null,
          deviceStatus: 'offline',
          deviceLastSeenAt: minutesAgo(12),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-offline' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: '[stale-backup-reaper] Device went offline during backup',
      })
    );
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('reaps a legacy running job with no progress signal past the absolute cap (rule C)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-legacy',
          deviceId: 'device-3',
          lastProgressAt: null,
          startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          errorLog: 'previous warning',
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-legacy' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: 'previous warning\n[stale-backup-reaper] Backup timed out (no completion after 24h)',
      })
    );
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-3', { jobId: 'job-legacy' });
  });

  it('does not reap a healthy running job with recent progress', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-healthy',
          deviceId: 'device-4',
          lastProgressAt: minutesAgo(2),
          startedAt: minutesAgo(30),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('does not reap a recent legacy job (no progress, 2h old, device online)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-recent-legacy',
          deviceId: 'device-5',
          lastProgressAt: null,
          startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reaps a pending job stuck past the pending timeout', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-stuck',
          errorLog: null,
          createdAt: minutesAgo(90),
        },
      ]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-pending-stuck' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: '[stale-backup-reaper] Backup dispatch never completed',
      })
    );
  });

  it('does not reap a pending job under an hour old', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-fresh',
          errorLog: null,
          createdAt: minutesAgo(30),
        },
      ]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('queues a stop command only for the online device among multiple reaped jobs', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-online',
          deviceId: 'device-online',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
        {
          id: 'job-offline-2',
          deviceId: 'device-offline',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'offline',
          deviceLastSeenAt: minutesAgo(20),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'reaped' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(2);
    expect(queueBackupStopCommandMock).toHaveBeenCalledTimes(1);
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-online', { jobId: 'job-online' });
  });

  it('does not double-count or queue a stop command when a concurrent completion wins (terminal-status guard)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-race',
          deviceId: 'device-6',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        // Simulates the job already having transitioned to a terminal status
        // (e.g. 'completed') between the select and this guarded update.
        returning: vi.fn().mockResolvedValue([]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('reaps an unreapable zombie: running job with BOTH lastProgressAt and startedAt NULL, old createdAt (COALESCE createdAt fallback)', async () => {
    // Before the fix, progressRef = lastProgressAt ?? startedAt was NULL, the
    // `if (!progressRef) continue` skipped the row, and COALESCE(null, null) in
    // SQL never matched — a permanent zombie. createdAt (NOT NULL) now backstops
    // both, so the absolute-cap rule can reap it.
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-zombie',
          deviceId: 'device-z',
          lastProgressAt: null,
          startedAt: null,
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-zombie' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: '[stale-backup-reaper] Backup timed out (no completion after 24h)',
      })
    );
  });

  it('reaps a running job on an "online" device that is actually silent (lastSeenAt stale > 5min) via the offline rule, without queueing a stop', async () => {
    // isDeviceOfflineForReap staleness arm: status 'online'/'updating' but no
    // heartbeat for >5min counts as offline, so a WS-silent-but-HTTP-"online"
    // device is reaped by the offline grace rule (12min > 10min) and gets NO
    // backup_stop (it can't receive it).
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-silent-online',
          deviceId: 'device-silent',
          lastProgressAt: minutesAgo(12),
          startedAt: minutesAgo(30),
          createdAt: minutesAgo(35),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(6), // stale > 5min → offline-for-reap
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-silent-online' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: '[stale-backup-reaper] Device went offline during backup',
      })
    );
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('does NOT reap a pending job that is still receiving progress pings (recent lastProgressAt), even past the pending timeout', async () => {
    // applyBackupStartedAck/applyBackupProgress bump lastProgressAt on a pending
    // job without promoting it to running. A pending job stuck 90min but with a
    // 2-min-old progress ping is alive and must be spared.
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-alive',
          errorLog: null,
          createdAt: minutesAgo(90),
          lastProgressAt: minutesAgo(2),
        },
      ]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reaps a pending job past the pending timeout whose lastProgressAt is also stale', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-dead',
          deviceId: 'device-queued',
          errorLog: null,
          createdAt: minutesAgo(90),
          lastProgressAt: minutesAgo(20), // > 15min stall window → not "alive"
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(1),
          deviceBackupVersion: '0.110.0',
        },
      ]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-pending-dead' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorLog: '[stale-backup-reaper] Backup dispatch never completed' })
    );
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-queued', { jobId: 'job-pending-dead' });
  });

  // The queued admission ack can be lost on the agent WS after the helper has
  // already parked the ticket. last_progress_at stays NULL, but the helper
  // still holds the job and would run it after the row is failed. A
  // queue-capable helper must get the targeted stop regardless.
  it('cancels a reaped pending job on a queue-capable helper even when no admission ack was persisted', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-lost-ack',
          deviceId: 'device-queued',
          errorLog: null,
          createdAt: minutesAgo(90),
          lastProgressAt: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(1),
          deviceBackupVersion: '0.110.0',
        },
      ]));
    updateMock.mockImplementation(() => backupUpdateChain([{ id: 'job-pending-lost-ack' }]));

    expect(await reapStaleBackupJobs()).toBe(1);
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-queued', { jobId: 'job-pending-lost-ack' });
  });

  // A pre-queue helper ignores jobId and treats backup_stop as device-wide,
  // so a stop for a never-delivered pending row would kill whatever backup is
  // actually running on that device. Only a persisted ack (which proves the
  // helper speaks the queue protocol) may trigger a stop there.
  it('does NOT send backup_stop for a reaped pending job on an older helper with no persisted ack', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-legacy',
          deviceId: 'device-legacy',
          errorLog: null,
          createdAt: minutesAgo(90),
          lastProgressAt: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(1),
          deviceBackupVersion: '0.109.0',
        },
      ]));
    updateMock.mockImplementation(() => backupUpdateChain([{ id: 'job-pending-legacy' }]));

    expect(await reapStaleBackupJobs()).toBe(1);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('does NOT queue a backup_stop for a reaped pending job whose device is offline', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-offline',
          deviceId: 'device-offline',
          errorLog: null,
          createdAt: minutesAgo(90),
          lastProgressAt: minutesAgo(20),
          deviceStatus: 'offline',
          deviceLastSeenAt: minutesAgo(30),
          deviceBackupVersion: '0.110.0',
        },
      ]));
    updateMock.mockImplementation(() => backupUpdateChain([{ id: 'job-pending-offline' }]));

    expect(await reapStaleBackupJobs()).toBe(1);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });
});

describe('reapStaleBackupJobs — boundary pins (frozen clock, N±1ms)', () => {
  const STALL_MS = 15 * 60 * 1000;
  const OFFLINE_GRACE_MS = 10 * 60 * 1000;
  const ABSOLUTE_MS = 24 * 60 * 60 * 1000;
  const PENDING_MS = 60 * 60 * 1000;
  const T = new Date('2026-07-17T00:00:00.000Z').getTime();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    queueBackupStopCommandMock.mockResolvedValue({ command: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function runningRow(over: boolean, field: 'lastProgressAt' | 'startedAt', thresholdMs: number, extra: Record<string, unknown> = {}) {
    const ageMs = over ? thresholdMs + 1 : thresholdMs - 1;
    return {
      id: 'job-b',
      deviceId: 'device-b',
      lastProgressAt: null as Date | null,
      startedAt: null as Date | null,
      createdAt: new Date(T - ABSOLUTE_MS - 1),
      errorLog: null,
      deviceStatus: 'online',
      deviceLastSeenAt: new Date(T - 1000),
      [field]: new Date(T - ageMs),
      ...extra,
    };
  }

  function expectReaped(reaped: number, count: number) {
    expect(reaped).toBe(count);
  }

  function setUpUpdateReturning() {
    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'job-b' }]) })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));
  }

  it('stall rule: lastProgressAt STALL+1ms is reaped, STALL-1ms is not', async () => {
    setUpUpdateReturning();
    selectMock.mockReturnValueOnce(selectChain([runningRow(true, 'lastProgressAt', STALL_MS)])).mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 1);

    vi.resetAllMocks();
    vi.setSystemTime(T);
    selectMock.mockReturnValueOnce(selectChain([runningRow(false, 'lastProgressAt', STALL_MS)])).mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 0);
  });

  it('offline-grace rule: offline device progressRef OFFLINE_GRACE+1ms is reaped, -1ms is not', async () => {
    setUpUpdateReturning();
    selectMock
      .mockReturnValueOnce(selectChain([runningRow(true, 'lastProgressAt', OFFLINE_GRACE_MS, { deviceStatus: 'offline' })]))
      .mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 1);

    vi.resetAllMocks();
    vi.setSystemTime(T);
    selectMock
      .mockReturnValueOnce(selectChain([runningRow(false, 'lastProgressAt', OFFLINE_GRACE_MS, { deviceStatus: 'offline' })]))
      .mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 0);
  });

  it('absolute-cap rule: no progress, startedAt ABSOLUTE+1ms is reaped, -1ms is not', async () => {
    setUpUpdateReturning();
    selectMock
      .mockReturnValueOnce(selectChain([runningRow(true, 'startedAt', ABSOLUTE_MS, { createdAt: new Date(T - ABSOLUTE_MS - 5000) })]))
      .mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 1);

    vi.resetAllMocks();
    vi.setSystemTime(T);
    selectMock
      .mockReturnValueOnce(selectChain([runningRow(false, 'startedAt', ABSOLUTE_MS, { createdAt: new Date(T - ABSOLUTE_MS + 100) })]))
      .mockReturnValueOnce(selectChain([]));
    expectReaped(await reapStaleBackupJobs(), 0);
  });

  it('pending rule: createdAt PENDING+1ms is reaped, PENDING-1ms is not', async () => {
    setUpUpdateReturning();
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ id: 'job-b', errorLog: null, createdAt: new Date(T - (PENDING_MS + 1)), lastProgressAt: null }]));
    expectReaped(await reapStaleBackupJobs(), 1);

    vi.resetAllMocks();
    vi.setSystemTime(T);
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ id: 'job-b', errorLog: null, createdAt: new Date(T - (PENDING_MS - 1)), lastProgressAt: null }]));
    expectReaped(await reapStaleBackupJobs(), 0);
  });
});

describe('reapStaleSoftwareDeploymentResults', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  function setUpUpdates(opts: { raced?: boolean } = {}) {
    const resultReturning = vi.fn().mockResolvedValue(opts.raced ? [] : [{ id: 'reaped' }]);
    const resultWhere = vi.fn(() => ({ returning: resultReturning }));
    const resultSet = vi.fn(() => ({ where: resultWhere }));
    const commandWhere = vi.fn().mockResolvedValue(undefined);
    const commandSet = vi.fn(() => ({ where: commandWhere }));
    updateMock.mockImplementation((table: unknown) => {
      if (table === deploymentResultsTable) return { set: resultSet };
      if (table === deviceCommandsTable) return { set: commandSet };
      throw new Error(`Unexpected table update: ${String(table)}`);
    });
    return { resultSet, resultReturning, commandSet, commandWhere };
  }

  it('pins the exported timeout constants (55 min install, 7 day queued expiry)', () => {
    expect(SOFTWARE_INSTALL_TIMEOUT_MS).toBe(55 * 60 * 1000);
    expect(SOFTWARE_QUEUED_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('tier 1: reaps delivered-but-silent rows past the timeout (WS-dispatched and queued-then-sent/completed)', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      // WS-dispatched directly — no queued command row
      { id: 'res-ws', deviceCommandId: null, dispatchedAt: minutesAgo(60), commandStatus: null },
      // Offline-queued, agent claimed it (sent) then went silent
      { id: 'res-sent', deviceCommandId: 'cmd-sent', dispatchedAt: minutesAgo(90), commandStatus: 'sent' },
      // Command completed but the result POST never landed
      { id: 'res-done', deviceCommandId: 'cmd-done', dispatchedAt: minutesAgo(90), commandStatus: 'completed' },
    ]));
    const { resultSet, commandSet } = setUpUpdates();

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(3);
    expect(resultSet).toHaveBeenCalledTimes(3);
    expect(resultSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Server-side timeout: no response from agent',
      })
    );
    // Delivered rows never touch device_commands
    expect(commandSet).not.toHaveBeenCalled();
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledTimes(3);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'reaper',
      deploymentResultId: 'reaped',
      terminalStatus: 'timed_out',
    }));
  });

  it('tier 1: leaves a delivered row alone before the 55-min timeout', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      { id: 'res-fresh', deviceCommandId: null, dispatchedAt: minutesAgo(30), commandStatus: null },
    ]));

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('tier 2: leaves a queued-offline row (device_commands still pending) alone before the 7-day expiry', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      { id: 'res-queued', deviceCommandId: 'cmd-queued', dispatchedAt: daysAgo(2), commandStatus: 'pending' },
    ]));

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('tier 2: reaps a queued-offline row after the 7-day expiry AND cancels the queued device_commands row', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      { id: 'res-expired', deviceCommandId: 'cmd-expired', dispatchedAt: daysAgo(8), commandStatus: 'pending' },
    ]));
    const { resultSet, commandSet, commandWhere } = setUpUpdates();

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(1);
    expect(resultSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Device did not come online before the deployment expired',
      })
    );
    expect(commandSet).toHaveBeenCalledTimes(1);
    expect(commandSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'cancelled',
        result: expect.objectContaining({ status: 'cancelled', cancelledBy: 'stale-command-reaper' }),
      })
    );
    expect(commandWhere).toHaveBeenCalledTimes(1);
  });

  it('never touches rows whose deployment dispatchedAt is NULL (scheduled, not yet dispatched)', async () => {
    // The SQL filter excludes these; pin the defensive JS guard too.
    selectMock.mockReturnValueOnce(selectChain([
      { id: 'res-scheduled', deviceCommandId: null, dispatchedAt: null, commandStatus: null },
      { id: 'res-scheduled-2', deviceCommandId: 'cmd-x', dispatchedAt: null, commandStatus: 'pending' },
    ]));

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not count a row (or cancel its command) when a concurrent real result wins the pending-guard race', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      { id: 'res-race', deviceCommandId: 'cmd-race', dispatchedAt: daysAgo(8), commandStatus: 'pending' },
    ]));
    const { commandSet } = setUpUpdates({ raced: true });

    const reaped = await reapStaleSoftwareDeploymentResults();

    expect(reaped).toBe(0);
    expect(commandSet).not.toHaveBeenCalled();
  });

  it('boundary: dispatchedAt exactly 1ms past each threshold reaps, 1ms short does not', async () => {
    vi.useFakeTimers();
    const T = new Date('2026-07-17T00:00:00.000Z').getTime();
    vi.setSystemTime(T);
    try {
      // Tier 1 over/under
      setUpUpdates();
      selectMock.mockReturnValueOnce(selectChain([
        { id: 'r1', deviceCommandId: null, dispatchedAt: new Date(T - SOFTWARE_INSTALL_TIMEOUT_MS - 1), commandStatus: null },
      ]));
      expect(await reapStaleSoftwareDeploymentResults()).toBe(1);

      vi.resetAllMocks();
      vi.setSystemTime(T);
      selectMock.mockReturnValueOnce(selectChain([
        { id: 'r1', deviceCommandId: null, dispatchedAt: new Date(T - SOFTWARE_INSTALL_TIMEOUT_MS + 1), commandStatus: null },
      ]));
      expect(await reapStaleSoftwareDeploymentResults()).toBe(0);

      // Tier 2 over/under
      vi.resetAllMocks();
      vi.setSystemTime(T);
      setUpUpdates();
      selectMock.mockReturnValueOnce(selectChain([
        { id: 'r2', deviceCommandId: 'cmd-b', dispatchedAt: new Date(T - SOFTWARE_QUEUED_EXPIRY_MS - 1), commandStatus: 'pending' },
      ]));
      expect(await reapStaleSoftwareDeploymentResults()).toBe(1);

      vi.resetAllMocks();
      vi.setSystemTime(T);
      selectMock.mockReturnValueOnce(selectChain([
        { id: 'r2', deviceCommandId: 'cmd-b', dispatchedAt: new Date(T - SOFTWARE_QUEUED_EXPIRY_MS + 1), commandStatus: 'pending' },
      ]));
      expect(await reapStaleSoftwareDeploymentResults()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});


// #3190: the reaper used a flat 300s+grace deadline for every execution and
// ignored the script's own `timeoutSeconds`, which is wrong in both directions.
// These two cases are the issue's two symptoms, and each one flips if the
// per-script deadline is reverted to a constant.
describe('reapStaleScriptExecutions per-script timeout (#3190)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function arrangeExec(opts: { timeoutSeconds: number; ageMs: number }) {
    const createdAt = new Date(Date.now() - opts.ageMs);
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'exec-1',
          status: 'pending',
          scriptId: 'script-1',
          createdAt,
          startedAt: null,
          timeoutSeconds: opts.timeoutSeconds,
        },
      ]))
      // the #3097 device-command lookup — no terminal row, so the guard is inert
      .mockReturnValueOnce(selectChain([]));

    const execSet = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) })),
    }));
    updateMock.mockImplementation((table: unknown) => {
      if (table === scriptExecutionsTable) return { set: execSet };
      throw new Error(`Unexpected table update: ${String(table)}`);
    });
    return { execSet };
  }

  it('reaps a short-timeout script once its own deadline has passed', async () => {
    // 30s script => 30s + 5min grace = 5.5min. At 7 minutes it is overdue.
    // Under the old flat 10-minute deadline this row was skipped, so the
    // execution sat pending far past its own contract.
    const { execSet } = arrangeExec({ timeoutSeconds: 30, ageMs: 7 * 60 * 1000 });

    const reaped = await reapStaleScriptExecutions();

    expect(reaped).toBe(1);
    expect(execSet).toHaveBeenCalledTimes(1);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'reaper',
      scriptExecutionId: 'exec-1',
      terminalStatus: 'timed_out',
    }));
  });

  // Pins the `running` reference-time branch, which had no coverage anywhere in
  // this file. It only mattered once the deadline became per-script: "which
  // timestamp do we measure from" and "how long is the budget" now interact, so
  // a regression in either could otherwise ship green. Old createdAt, recent
  // startedAt, short script — measuring from createdAt would reap it, measuring
  // from startedAt correctly does not.
  it('measures a running execution from startedAt, not createdAt', async () => {
    const createdAt = new Date(Date.now() - 60 * 60 * 1000);
    const startedAt = new Date(Date.now() - 60 * 1000);
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'exec-1',
          status: 'running',
          scriptId: 'script-1',
          createdAt,
          startedAt,
          timeoutSeconds: 30,
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const execSet = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) })),
    }));
    updateMock.mockImplementation((table: unknown) => {
      if (table === scriptExecutionsTable) return { set: execSet };
      throw new Error(`Unexpected table update: ${String(table)}`);
    });

    const reaped = await reapStaleScriptExecutions();

    expect(reaped).toBe(0);
    expect(execSet).not.toHaveBeenCalled();
  });

  it('leaves a long-timeout script alone while it is still within its deadline', async () => {
    // 1h script => 1h + 5min grace. At 30 minutes it is still running legally.
    // Under the old flat 10-minute deadline this was reaped and reported as
    // "no response from agent" while the script was working correctly.
    const { execSet } = arrangeExec({ timeoutSeconds: 3600, ageMs: 30 * 60 * 1000 });

    const reaped = await reapStaleScriptExecutions();

    expect(reaped).toBe(0);
    expect(execSet).not.toHaveBeenCalled();
  });
});

// #3097: script results submitted over the HTTP path never reach
// `script_executions`, so the row stays pending, lands in this reaper, and was
// stamped `timeout` / "no response from agent". That is false whenever a terminal
// device_commands row exists — the agent DID answer. On one live instance 89
// executions read `timeout` while their command had completed with output.
describe('reapStaleScriptExecutions terminal-command guard (#3097)', () => {
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  function arrange(cmdRow: Record<string, unknown> | undefined) {
    // 1st select: the stale executions. 2nd: the related device command.
    selectMock
      .mockReturnValueOnce(selectChain([
        { id: 'exec-1', status: 'pending', scriptId: 'script-1', createdAt: longAgo, startedAt: null },
      ]))
      .mockReturnValueOnce(selectChain(cmdRow ? [cmdRow] : []));

    // Typed parameter so `execSet.mock.calls[0][0]` is the written row rather
    // than `never` — the assertions below read it directly.
    const execSet = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) })),
    }));
    updateMock.mockImplementation((table: unknown) => {
      if (table === scriptExecutionsTable) return { set: execSet };
      throw new Error(`Unexpected table update: ${String(table)}`);
    });
    return { execSet };
  }

  it('does not claim "no response from agent" when the command completed', async () => {
    const { execSet } = arrange({
      payload: { executionId: 'exec-1' },
      status: 'completed',
      result: { status: 'completed', stdout: 'it ran' },
    });

    await reapStaleScriptExecutions();

    const written = execSet.mock.calls[0]![0];
    expect(written.status).toBe('completed');
    expect(String(written.errorMessage)).not.toContain('no response from agent');
  });

  it('records failed — not timeout — when the command failed', async () => {
    const { execSet } = arrange({
      payload: { executionId: 'exec-1' },
      status: 'failed',
      result: { status: 'failed', stderr: 'boom' },
    });

    await reapStaleScriptExecutions();

    const written = execSet.mock.calls[0]![0];
    expect(written.status).toBe('failed');
    expect(String(written.errorMessage)).not.toContain('no response from agent');
  });

  it('still reports a genuine agent silence as timeout', async () => {
    // Command never reached a terminal state — the original claim is true here
    // and must survive, or the guard would mask real agent silence.
    const { execSet } = arrange({
      payload: { executionId: 'exec-1' },
      status: 'sent',
      result: null,
    });

    await reapStaleScriptExecutions();

    const written = execSet.mock.calls[0]![0];
    expect(written.status).toBe('timeout');
    expect(String(written.errorMessage)).toContain('no response from agent');
  });

  it('still reports timeout when no command row exists at all', async () => {
    const { execSet } = arrange(undefined);

    await reapStaleScriptExecutions();

    const written = execSet.mock.calls[0]![0];
    expect(written.status).toBe('timeout');
    expect(String(written.errorMessage)).toContain('no response from agent');
  });
});
