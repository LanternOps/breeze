import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queueCommand,
  waitForCommandResult,
  executeCommand,
  getPendingCommands,
  markCommandsSent,
  submitCommandResult,
  DEVICE_UNREACHABLE_ERROR,
  SEND_RETRY_ATTEMPTS,
  CommandTypes,
} from './commandQueue';
import { db } from '../db';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(),
  releaseClaimedCommandDelivery: vi.fn(),
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('./backupMetrics', () => ({
  recordBackupCommandTimeout: vi.fn(),
  recordRestoreTimeout: vi.fn(),
}));

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    deviceCommands: {
      id: 'id',
      deviceId: 'deviceId',
      status: 'status',
      createdAt: 'createdAt'
    },
    devices: {
      id: 'id',
      status: 'status'
    }
  };
});

describe('command queue service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should queue a command for a device', async () => {
    const queued = {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'list_processes',
      payload: { filter: 'chrome' },
      status: 'pending',
      createdBy: 'user-1',
      createdAt: new Date(),
      executedAt: null,
      completedAt: null,
      result: null
    };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued])
      })
    } as any);

    const result = await queueCommand('dev-1', 'list_processes', { filter: 'chrome' }, 'user-1');

    expect(result).toEqual(queued);
    expect(db.insert).toHaveBeenCalled();
  });

  // Regression: queueCommand wraps BOTH the `devices` lookup and the
  // `audit_logs` insert in runOutsideDbContext + withSystemDbAccessContext
  // so BullMQ workers (which invoke queueCommand from system scope with no
  // request DB context) can both read `devices` and write `audit_logs`
  // under RLS. Sibling bug to #437. Prior to the fix, a naive wrapper only
  // around the insert would still silently no-op because the pre-wrapper
  // devices lookup is itself RLS-gated and returns zero rows from system
  // scope.
  it('wraps queueCommand audit block in runOutsideDbContext + withSystemDbAccessContext', async () => {
    const dbModule = await import('../db');
    const queued = {
      id: 'cmd-audit-1',
      deviceId: 'dev-1',
      type: CommandTypes.KILL_PROCESS,
      payload: { pid: 1234 },
      status: 'pending',
      createdBy: 'user-1',
      createdAt: new Date(),
      executedAt: null,
      completedAt: null,
      result: null,
    };

    // Order tracker: prove that both the devices SELECT and the audit INSERT
    // fire INSIDE the withSystemDbAccessContext callback. If a future edit
    // hoists the lookup back outside the wrapper, these calls will land
    // before 'enter-system' and the assertions below will fail.
    const callOrder: string[] = [];
    // mockImplementationOnce queues a single-use impl so the default
    // passthrough mock from vi.mock('../db', ...) is restored after this
    // test's one call — other tests using runOutsideDbContext /
    // withSystemDbAccessContext via runOutsideDbContextSafe keep working.
    vi.mocked(dbModule.runOutsideDbContext).mockImplementationOnce(async (fn: () => unknown) => {
      callOrder.push('enter-outside');
      const result = await fn();
      callOrder.push('exit-outside');
      return result;
    });
    vi.mocked(dbModule.withSystemDbAccessContext).mockImplementationOnce(async (fn: () => unknown) => {
      callOrder.push('enter-system');
      const result = await fn();
      callOrder.push('exit-system');
      return result;
    });

    const commandInsertChain = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued]),
      }),
    };
    const auditInsertValues = vi.fn().mockImplementation(() => {
      callOrder.push('audit-insert');
      return Promise.resolve();
    });
    const auditInsertChain = { values: auditInsertValues };

    vi.mocked(db.insert)
      .mockReturnValueOnce(commandInsertChain as any)
      .mockReturnValueOnce(auditInsertChain as any);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            callOrder.push('devices-select');
            return Promise.resolve([{ orgId: 'org-42', hostname: 'host-1' }]);
          }),
        }),
      }),
    } as any);

    await queueCommand('dev-1', CommandTypes.KILL_PROCESS, { pid: 1234 }, 'user-1');
    // Audit block is fire-and-forget; drain microtasks so the inner chain runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dbModule.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // Both the devices lookup and the audit insert must happen between
    // enter-system and exit-system — this is the contract that guards the
    // worker-path regression.
    expect(callOrder).toEqual([
      'enter-outside',
      'enter-system',
      'devices-select',
      'audit-insert',
      'exit-system',
      'exit-outside',
    ]);
    expect(auditInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-42',
        actorType: 'user',
        actorId: 'user-1',
        action: `agent.command.${CommandTypes.KILL_PROCESS}`,
        resourceType: 'device',
        resourceId: 'dev-1',
        resourceName: 'host-1',
        result: 'success',
      })
    );
  });

  // Guard the branch the codex review flagged: if the devices lookup
  // returns empty (simulating an RLS rejection or a deleted device), we
  // must NOT attempt the audit insert, and we must NOT throw — the block
  // is fire-and-forget and a no-op on missing device is correct.
  it('queueCommand audit block is a no-op when the devices lookup returns empty', async () => {
    const queued = {
      id: 'cmd-audit-2',
      deviceId: 'dev-missing',
      type: CommandTypes.KILL_PROCESS,
      payload: {},
      status: 'pending',
      createdBy: 'user-1',
      createdAt: new Date(),
      executedAt: null,
      completedAt: null,
      result: null,
    };

    const commandInsertChain = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued]),
      }),
    };
    const auditInsertValues = vi.fn();
    const auditInsertChain = { values: auditInsertValues };

    // Only queue the command-insert chain. The audit insert should never
    // be reached when the devices lookup returns empty; if it were, db.insert
    // would fall through to its default mock (undefined) and the test would
    // still fail — which is what we want.
    vi.mocked(db.insert).mockReturnValueOnce(commandInsertChain as any);
    // Keep a reference to auditInsertChain/Values so eslint-unused is happy
    // and so the negative assertion below is obviously about this spy.
    void auditInsertChain;

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await expect(
      queueCommand('dev-missing', CommandTypes.KILL_PROCESS, {}, 'user-1')
    ).resolves.toMatchObject({ id: 'cmd-audit-2' });

    await Promise.resolve();
    await Promise.resolve();

    expect(auditInsertValues).not.toHaveBeenCalled();
  });

  it('should return a completed command after polling', async () => {
    vi.useFakeTimers();
    const pending = {
      id: 'cmd-2',
      status: 'pending'
    };
    const completed = {
      id: 'cmd-2',
      status: 'completed',
      result: { status: 'completed', stdout: 'ok' }
    };

    const limitMock = vi.fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([completed]);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: limitMock
        })
      })
    } as any);

    const promise = waitForCommandResult('cmd-2', 1000, 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toEqual(completed);
    expect(limitMock).toHaveBeenCalledTimes(2);
  });

  it('should mark commands as failed on timeout', async () => {
    vi.useFakeTimers();
    const pending = { id: 'cmd-3', status: 'pending', type: 'mssql_backup' };
    const timedOut = {
      id: 'cmd-3',
      status: 'failed',
      result: { status: 'timeout' }
    };

    const limitMock = vi.fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([timedOut]);

    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'cmd-3', status: 'failed' }])
      })
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: limitMock
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    const promise = waitForCommandResult('cmd-3', 250, 100);
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result).toEqual(timedOut);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      result: expect.objectContaining({ status: 'timeout' })
    }));
  });

  it('should return failed when device does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const result = await executeCommand('missing-device', 'list_services');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Device not found');
  });

  it('should queue and return a completed result for online devices', async () => {
    const device = { id: 'dev-2', status: 'online' };
    const queued = { id: 'cmd-4' };
    const completed = {
      id: 'cmd-4',
      status: 'completed',
      result: { status: 'completed', stdout: 'done' }
    };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([device])
          })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([completed])
          })
        })
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued])
      })
    } as any);

    const result = await executeCommand('dev-2', 'list_services');

    expect(result).toEqual(completed.result);
  });

  it('should return pending commands for a device', async () => {
    const commands = [{ id: 'cmd-5' }, { id: 'cmd-6' }];
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(commands)
          })
        })
      })
    } as any);

    const result = await getPendingCommands('dev-3', 2);

    expect(result).toEqual(commands);
  });

  it('should mark commands as sent', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: whereMock });

    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    await markCommandsSent(['cmd-7', 'cmd-8']);

    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(whereMock).toHaveBeenCalledTimes(2);
  });

  it('should submit command result with completed status', async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    });

    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    await submitCommandResult('cmd-9', { status: 'completed', stdout: 'ok' });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({ status: 'completed' })
    }));
  });

  describe('executeCommand interactive WS handling', () => {
    // Wires up the mocks executeCommand needs once it gets past the device
    // lookup: DB row for the command, an audit-log insert, the dispatch
    // claim, and the polling fetch that returns a completed result.
    function setupOnlineDeviceMocks(opts: {
      completedResult?: unknown;
      pollFirst?: unknown;
    } = {}) {
      const device = {
        id: 'dev-online',
        status: 'online',
        agentId: 'agent-1',
        orgId: 'org-1',
        hostname: 'host-1',
      };
      const queued = { id: 'cmd-x' };
      const completed = opts.completedResult ?? {
        id: 'cmd-x',
        status: 'completed',
        result: { status: 'completed', stdout: 'ok' },
      };

      let pollCall = 0;
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              pollCall += 1;
              if (pollCall === 1) return Promise.resolve([device]);
              if (pollCall === 2 && opts.pollFirst) return Promise.resolve([opts.pollFirst]);
              return Promise.resolve([completed]);
            }),
          }),
        }),
      }) as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([queued]),
          execute: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({
        id: 'cmd-x',
        executedAt: new Date(),
      });
      vi.mocked(releaseClaimedCommandDelivery).mockResolvedValue(undefined);
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('fast-fails interactive command when WS pool has no live connection', async () => {
      const device = {
        id: 'dev-online',
        status: 'online',
        agentId: 'agent-1',
        orgId: 'org-1',
        hostname: 'host-1',
      };

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([device]),
          }),
        }),
      } as any);
      vi.mocked(isAgentConnected).mockReturnValue(false);

      const result = await executeCommand('dev-online', CommandTypes.FILE_LIST, { path: '/' });

      expect(result.status).toBe('failed');
      expect(result.error).toBe(DEVICE_UNREACHABLE_ERROR);
      // Must NOT have queued a row or attempted dispatch.
      expect(db.insert).not.toHaveBeenCalled();
      expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });

    it('does NOT fast-fail non-interactive commands when WS is dead', async () => {
      // Backup commands and similar must still queue normally so the agent
      // can pick them up via heartbeat after reconnect.
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(sendCommandToAgent).mockReturnValue(false);

      const result = await executeCommand('dev-online', CommandTypes.PATCH_SCAN);

      // It still goes through queue → dispatch attempts → poll completion.
      expect(db.insert).toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('retries sendCommandToAgent and succeeds on a later attempt', async () => {
      vi.useFakeTimers();
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(true);
      vi.mocked(sendCommandToAgent)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const promise = executeCommand('dev-online', CommandTypes.FILE_LIST, { path: '/' });
      // Advance through the 500ms retry sleep + the polling loop interval.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(sendCommandToAgent).toHaveBeenCalledTimes(2);
      // Claim must NOT be released — the second send succeeded.
      expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('releases the claim and short-circuits with DEVICE_UNREACHABLE_ERROR after exhausting all retries', async () => {
      vi.useFakeTimers();
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(true);
      vi.mocked(sendCommandToAgent).mockReturnValue(false);

      const promise = executeCommand(
        'dev-online',
        CommandTypes.FILE_LIST,
        { path: '/' },
        // Use a long timeout to prove we DON'T wait for it; the short-circuit
        // must return promptly after the retry loop, not after timeoutMs.
        { timeoutMs: 30000 },
      );
      // Only need to advance through the retry sleeps (~1s total).
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      // SEND_RETRY_ATTEMPTS attempts, then release exactly once.
      expect(sendCommandToAgent).toHaveBeenCalledTimes(SEND_RETRY_ATTEMPTS);
      expect(releaseClaimedCommandDelivery).toHaveBeenCalledTimes(1);
      // Caller sees the unreachable sentinel — the file browser maps this to
      // the "device unreachable" UI message rather than burning the timeout.
      expect(result.status).toBe('failed');
      expect(result.error).toBe(DEVICE_UNREACHABLE_ERROR);
    });

    it('skips dispatch entirely when claimPendingCommandForDelivery returns null', async () => {
      // Simulates another worker (or the heartbeat path) having already
      // claimed the command. The send path must be a no-op so we don't
      // double-dispatch, and we must still poll for the eventual result.
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(true);
      vi.mocked(claimPendingCommandForDelivery).mockResolvedValue(null);

      const result = await executeCommand('dev-online', CommandTypes.FILE_LIST, { path: '/' });

      expect(sendCommandToAgent).not.toHaveBeenCalled();
      expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
      // Polling still happens — the other worker will fulfill the command.
      expect(result.status).toBe('completed');
    });

    // Regression guard: executeCommand with targetRole='watchdog' must
    // insert target_role='watchdog' on the row AND must skip the WS
    // dispatch path entirely — the watchdog has no WS connection and is
    // picked up by the heartbeat claim query
    // (routes/agents/heartbeat.ts -> claimPendingCommandsForDevice(..., 'watchdog')).
    // Before the fix, the AI upgrade tool queued `agent_upgrade` with default
    // target_role='agent', which dispatched to the agent WS (wrong handler)
    // and never reached the watchdog heartbeat poll.
    it('routes watchdog-targeted commands to the row insert without WS dispatch', async () => {
      const device = {
        id: 'dev-watchdog',
        status: 'online',
        agentId: 'agent-wd',
        orgId: 'org-1',
        hostname: 'host-wd',
      };
      const queued = { id: 'cmd-wd', type: 'update_agent' };
      const completed = {
        id: 'cmd-wd',
        type: 'update_agent',
        status: 'completed',
        result: { status: 'completed', stdout: 'updated' },
      };

      let pollCall = 0;
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              pollCall += 1;
              if (pollCall === 1) return Promise.resolve([device]);
              return Promise.resolve([completed]);
            }),
          }),
        }),
      }) as any);

      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued]),
        execute: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockReturnValue({
        values: insertValues,
      } as any);

      // Even if the WS pool says the agent is connected, a watchdog-targeted
      // command must NOT hit the WS dispatch path.
      vi.mocked(isAgentConnected).mockReturnValue(true);

      const result = await executeCommand(
        'dev-watchdog',
        'update_agent',
        { version: '0.62.25-rc.2' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      // Row must be inserted with target_role='watchdog'.
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'dev-watchdog',
          type: 'update_agent',
          payload: { version: '0.62.25-rc.2' },
          status: 'pending',
          targetRole: 'watchdog',
        }),
      );
      // WS dispatch path must be fully skipped.
      expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
      expect(sendCommandToAgent).not.toHaveBeenCalled();
      expect(releaseClaimedCommandDelivery).not.toHaveBeenCalled();
      // Polling still returns the completed result (set by the watchdog's
      // command_result path, same as agent commands).
      expect(result.status).toBe('completed');
    });

    // Regression guard: default options (no targetRole) must still insert
    // target_role='agent' so existing agent-bound commands continue working.
    // A subtle regression here would break every non-watchdog command.
    it("defaults target_role to 'agent' when targetRole is not provided", async () => {
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(true);
      vi.mocked(sendCommandToAgent).mockReturnValue(true);

      // Capture the values passed to db.insert(...).values(...).
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'cmd-x' }]),
        execute: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockReturnValue({
        values: insertValues,
      } as any);

      await executeCommand('dev-online', CommandTypes.PATCH_SCAN);

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRole: 'agent',
        }),
      );
      // Normal agent path must still dispatch over WS.
      expect(sendCommandToAgent).toHaveBeenCalled();
    });

    it('skips the WS pre-check when preferHeartbeat is true', async () => {
      // Heartbeat-preferred callers (e.g. Tauri helper) intentionally let the
      // command queue and wait for the next agent poll, so the WS pre-check
      // must not short-circuit them even when isAgentConnected is false.
      setupOnlineDeviceMocks();
      vi.mocked(isAgentConnected).mockReturnValue(false);

      const result = await executeCommand(
        'dev-online',
        CommandTypes.FILE_LIST,
        { path: '/' },
        { preferHeartbeat: true },
      );

      // Must NOT have fast-failed: the row should have been queued and the
      // poll should have returned the completed result.
      expect(db.insert).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      // Dispatch path is skipped entirely because preferHeartbeat is true.
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    });
  });
});
