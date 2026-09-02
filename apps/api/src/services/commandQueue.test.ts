import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
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
  queueCommandForExecution,
  rearmIdempotentCommandForDelivery,
  resolveCommandCreatedBy,
} from './commandQueue';
import { db } from '../db';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { TrustDeniedError } from './partnerTrust.commands';

const partnerTrustCommandMocks = vi.hoisted(() => ({
  assertDeviceExecuteAllowed: vi.fn(),
}));

vi.mock('./partnerTrust.commands', async () => {
  const actual = await vi.importActual<typeof import('./partnerTrust.commands')>(
    './partnerTrust.commands',
  );
  return {
    ...actual,
    assertDeviceExecuteAllowed: partnerTrustCommandMocks.assertDeviceExecuteAllowed,
  };
});

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
    partnerTrustCommandMocks.assertDeviceExecuteAllowed.mockImplementation(
      async (_deviceId, type) => {
        if (type === 'script') {
          throw new TrustDeniedError(
            'TRUST_PROBATION',
            'probation_default_deny',
            'd1',
            'script',
          );
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queueCommand refuses a gated type for a probation partner and inserts nothing', async () => {
    await expect(queueCommand('d1', 'script', {}, 'u1')).rejects.toBeInstanceOf(
      TrustDeniedError,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('queueCommand still queues self_uninstall', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'u1' }]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'cmd-self-uninstall' }]),
      }),
    } as any);

    await expect(
      queueCommand('d1', 'self_uninstall', { removeConfig: true }, 'u1'),
    ).resolves.toBeTruthy();
  });

  it('queueCommandForExecution returns a structured trust error instead of throwing', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'd1', status: 'online' }]),
        }),
      }),
    } as any);

    await expect(queueCommandForExecution('d1', 'script', {})).resolves.toMatchObject({
      error: 'TRUST_PROBATION',
      trust: { reason: 'probation_default_deny' },
    });
  });

  it('executeCommand returns a failed CommandResult with the trust code', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'd1', status: 'online' }]),
        }),
      }),
    } as any);

    await expect(executeCommand('d1', 'script', {})).resolves.toMatchObject({
      success: false,
      error: 'TRUST_PROBATION',
    });
  });

  it('refuses to re-arm a desktop stop row whose payload is not exact', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: '11111111-1111-4111-8111-111111111111',
            deviceId: '22222222-2222-4222-8222-222222222222',
            type: 'desktop_stream_stop',
            targetRole: 'agent',
            payload: {
              sessionId: '33333333-3333-4333-8333-333333333333',
              finalizationId: '11111111-1111-4111-8111-111111111111',
              changed: true,
            },
          }]),
        }),
      }),
    } as any);

    await expect(rearmIdempotentCommandForDelivery({
      commandId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      type: 'desktop_stream_stop',
      payload: {
        sessionId: '33333333-3333-4333-8333-333333333333',
        finalizationId: '11111111-1111-4111-8111-111111111111',
      },
    })).resolves.toEqual({
      delivered: false,
      reason: 'command_conflict',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
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
    // The created_by users probe (#3978) runs before the insert. Mock it
    // explicitly rather than inheriting whatever db.select impl a previous test
    // left behind — vi.clearAllMocks() resets calls, not implementations.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
        }),
      }),
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

    // Order tracker: prove that the created_by users probe, the devices SELECT
    // and the audit INSERT each fire INSIDE a runOutsideDbContext +
    // withSystemDbAccessContext pair. If a future edit hoists any of them back
    // outside the wrapper, these calls will land before 'enter-system' and the
    // assertions below will fail.
    //
    // queueCommand opens THREE wrapped blocks: the created_by probe (#3978),
    // then the device_commands insert, then the fire-and-forget audit block.
    // All three need a context — the probe reads RLS-protected `users`, the
    // audit block reads RLS-protected `devices`, and the insert itself must not
    // be a contextless bare-pool write (#1375). A BullMQ worker has no request
    // context for any of them. Only the probe and the audit block additionally
    // need to ESCAPE a caller context, so only those two use runOutsideDbContext.
    const callOrder: string[] = [];
    // mockImplementationOnce queues single-use impls so the default passthrough
    // mock from vi.mock('../db', ...) is restored after this test's calls —
    // other tests using runOutsideDbContext / withSystemDbAccessContext via
    // runOutsideDbContextSafe keep working. Two are queued per wrapper, one per
    // block.
    const trackOutside = async (fn: () => unknown) => {
      callOrder.push('enter-outside');
      const result = await fn();
      callOrder.push('exit-outside');
      return result;
    };
    const trackSystem = async (fn: () => unknown) => {
      callOrder.push('enter-system');
      const result = await fn();
      callOrder.push('exit-system');
      return result;
    };
    vi.mocked(dbModule.runOutsideDbContext)
      .mockImplementationOnce(trackOutside)
      .mockImplementationOnce(trackOutside);
    vi.mocked(dbModule.withSystemDbAccessContext)
      .mockImplementationOnce(trackSystem)
      .mockImplementationOnce(trackSystem)
      .mockImplementationOnce(trackSystem);

    const commandInsertChain = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          callOrder.push('command-insert');
          return Promise.resolve([queued]);
        }),
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

    // Route the two SELECTs by the table they target: the created_by probe hits
    // `users`, the audit block hits `devices`. Discriminating on the real table
    // object (rather than call order) keeps the labels honest if the sequence
    // ever changes.
    const schema = await import('../db/schema');
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn((table: unknown) => {
        const isDevices = table === schema.devices;
        return {
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              callOrder.push(isDevices ? 'devices-select' : 'users-probe');
              return Promise.resolve(
                isDevices
                  ? [{ orgId: 'org-42', hostname: 'host-1' }]
                  : [{ id: 'user-1' }],
              );
            }),
          }),
        };
      }),
    })) as any);

    await queueCommand('dev-1', CommandTypes.KILL_PROCESS, { pid: 1234 }, 'user-1');
    // The audit block is fire-and-forget, so it settles AFTER queueCommand
    // resolves. Poll for the full sequence instead of draining a fixed number
    // of microtasks: this test queues two single-use impls per wrapper (probe +
    // audit block), and a fixed drain that returns early would both fail here
    // and leak the unconsumed mockImplementationOnce entries into later tests
    // in this file.
    await vi.waitFor(() => expect(callOrder).toHaveLength(14));

    // Two context ESCAPES (probe, audit block) and three system contexts
    // (probe, insert, audit block).
    expect(dbModule.runOutsideDbContext).toHaveBeenCalledTimes(2);
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(3);
    // The users probe, the devices lookup and the audit insert must each happen
    // between an enter-system and its exit-system — this is the contract that
    // guards the worker-path regression.
    expect(callOrder).toEqual([
      // 1. created_by probe: escapes the caller context, then system scope.
      'enter-outside',
      'enter-system',
      'users-probe',
      'exit-system',
      'exit-outside',
      // 2. the device_commands insert: system scope, no escape (it belongs on
      //    the caller's transaction when there is one).
      'enter-system',
      'command-insert',
      'exit-system',
      // 3. fire-and-forget audit block: escapes, then system scope.
      'enter-outside',
      'enter-system',
      'devices-select',
      'audit-insert',
      'exit-system',
      'exit-outside',
    ]);
    // #4225: this row is written at DISPATCH time, before the agent has
    // reported back, so it must NOT claim 'success' — that would assert an
    // outcome the command hasn't reached yet. Assert the neutral value
    // explicitly (not just objectContaining) so a regression back to
    // 'success' fails here rather than only in a UI test.
    expect(auditInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-42',
        actorType: 'user',
        actorId: 'user-1',
        action: `agent.command.${CommandTypes.KILL_PROCESS}`,
        resourceType: 'device',
        resourceId: 'dev-1',
        resourceName: 'host-1',
        result: 'dispatched',
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

    // executeCommand attaches the device_commands row id so callers can
    // reference the persisted result (#2401).
    expect(result).toEqual({ ...completed.result, commandId: completed.id });
  });

  // Wave 3b (#3824): device_commands.created_by FK-references users(id), but
  // synthetic principals (ai_agent auth carries the agent's ai_agents id as
  // auth.user.id) reach executeCommand through the same tool handlers as
  // humans. The chokepoint probes users once and degrades a non-user id to
  // created_by NULL instead of aborting the dispatch with a 23503 AFTER the
  // human approval already happened.
  it('keeps created_by when the caller userId resolves to a real users row', async () => {
    const device = { id: 'dev-2', status: 'online', orgId: 'org-1', hostname: 'host-a', agentId: null };
    const completed = { id: 'cmd-user', status: 'completed', result: { status: 'completed' } };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([device]) })
        })
      } as any)
      // users existence probe — the id IS a users row.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]) })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([completed]) })
        })
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'cmd-user' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const result = await executeCommand('dev-2', 'list_services', {}, { userId: 'user-1' });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'user-1' }));
    expect(result.status).toBe('completed');
  });

  it('nulls created_by when the caller userId is not a users row (synthetic ai_agent id)', async () => {
    const device = { id: 'dev-2', status: 'online', orgId: 'org-1', hostname: 'host-a', agentId: null };
    const completed = { id: 'cmd-agent', status: 'completed', result: { status: 'completed' } };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([device]) })
        })
      } as any)
      // users existence probe — no row: the id is an ai_agents id, not a user.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([completed]) })
        })
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'cmd-agent' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const result = await executeCommand('dev-2', 'list_services', {}, { userId: 'agent-synthetic-1' });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }));
    expect(result.status).toBe('completed');
  });

  // #3112: the agent's helper-IPC path bounded its own wait with a hardcoded
  // per-attempt timeout, so `timeoutMs` governed only how long the SERVER waited
  // while the device gave up underneath on its own schedule. The budget now
  // travels with the command as `timeoutSeconds`. These assert the value that
  // actually reaches the insert, not a re-derivation of the expression.
  it('publishes the caller timeout budget into the command payload', async () => {
    const device = { id: 'dev-2', status: 'online', orgId: 'org-1', hostname: 'host-a', agentId: null };
    const completed = { id: 'cmd-budget', status: 'completed', result: { status: 'completed' } };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([device]) })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([completed]) })
        })
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'cmd-budget' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    await executeCommand('dev-2', CommandTypes.TAKE_SCREENSHOT, { display: 0 }, { timeoutMs: 120_000 });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      payload: { display: 0, timeoutSeconds: 120 },
    }));
  });

  it('does not clobber a timeoutSeconds the caller set explicitly', async () => {
    const device = { id: 'dev-2', status: 'online', orgId: 'org-1', hostname: 'host-a', agentId: null };
    const completed = { id: 'cmd-budget-2', status: 'completed', result: { status: 'completed' } };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([device]) })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([completed]) })
        })
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'cmd-budget-2' }])
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    await executeCommand('dev-2', CommandTypes.TAKE_SCREENSHOT, { timeoutSeconds: 1500 }, { timeoutMs: 30_000 });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      payload: { timeoutSeconds: 1500 },
    }));
  });

  // Behavioral pin for AUDITED_COMMANDS membership: capture_pprof is a
  // privileged diagnostic, so dispatching it must write an audit_logs row.
  // AUDITED_COMMANDS is module-private, so removal of the entry would be
  // invisible without this test (#2401).
  it('writes an audit log when executing capture_pprof', async () => {
    const device = { id: 'dev-2', status: 'online', orgId: 'org-1', hostname: 'host-a', agentId: null };
    const queued = { id: 'cmd-pprof' };
    const completed = {
      id: 'cmd-pprof',
      status: 'completed',
      result: { status: 'completed', stdout: '{}' }
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

    const auditValues = vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.insert)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([queued])
        })
      } as any)
      .mockReturnValueOnce({ values: auditValues } as any);

    const result = await executeCommand('dev-2', CommandTypes.CAPTURE_PPROF, { profile: 'all' }, { userId: 'user-1' });

    expect(result.status).toBe('completed');
    // #4225: the audit row is written when the command is DISPATCHED, not
    // when it completes — `result.status` above being 'completed' is the
    // polled command outcome, unrelated to the audit row's `result` field.
    // The audit insert must not claim 'success' regardless of how the
    // command ultimately resolves.
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.command.capture_pprof',
      actorId: 'user-1',
      resourceType: 'device',
      resourceId: 'dev-2',
      orgId: 'org-1',
      result: 'dispatched',
    }));
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
        watchdogLastSeen: new Date(),
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

    // A watchdog-targeted command must be ACCEPTED for an offline device as
    // long as the watchdog itself is still reporting — that "agent silent,
    // watchdog OK" state is precisely what watchdog restarts/upgrades recover.
    // device.status reflects the (down) main agent, so gating on it would
    // reject the entire population this path exists for.
    it('accepts a watchdog command for an OFFLINE device with a fresh watchdog', async () => {
      const device = {
        id: 'dev-silent',
        status: 'offline',
        agentId: 'agent-silent',
        orgId: 'org-1',
        hostname: 'host-silent',
        watchdogLastSeen: new Date(), // watchdog still reporting
      };
      let pollCall = 0;
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              pollCall += 1;
              if (pollCall === 1) return Promise.resolve([device]);
              return Promise.resolve([{ id: 'cmd-s', status: 'completed', result: { status: 'completed' } }]);
            }),
          }),
        }),
      }) as any);
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'cmd-s', type: 'restart_agent' }]),
        execute: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

      const result = await executeCommand(
        'dev-silent',
        'restart_agent',
        {},
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      // Not rejected by the offline guard — the row is written.
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ targetRole: 'watchdog', type: 'restart_agent' }),
      );
      expect(result.status).toBe('completed');
    });

    // Inverse guard: if the watchdog itself has gone stale (box down, or agent
    // healthy so the watchdog never failed over and isn't polling), fail fast
    // instead of queueing a command nothing will ever claim.
    it('rejects a watchdog command when watchdogLastSeen is stale', async () => {
      const device = {
        id: 'dev-dead',
        status: 'offline',
        agentId: 'agent-dead',
        orgId: 'org-1',
        hostname: 'host-dead',
        watchdogLastSeen: new Date(Date.now() - 60 * 60 * 1000), // 1h stale
      };
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([device]),
          }),
        }),
      }) as any);
      const insertValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

      const result = await executeCommand(
        'dev-dead',
        'restart_agent',
        {},
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/watchdog is not reporting/i);
      // No row written — fail-fast before insert.
      expect(insertValues).not.toHaveBeenCalled();
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

  // ============================================================
  // #4093 — artifact-edition gate on agent-binary update dispatch
  // ============================================================
  //
  // #4072/#4091 taught the HEARTBEAT offer path to withhold an update from a
  // build that would refuse the served artifact edition after download. The
  // manual/AI dispatch door (`trigger_agent_upgrade` -> executeCommand with
  // type 'update_agent') bypassed it entirely — the same failure class as
  // "manual Remediate ignores enforceMode" (#3381).
  //
  // The gate lives here, at executeCommand, because that is the single point
  // every agent-binary update dispatch funnels through; gating at the one
  // known caller is how a third caller silently ships ungated.
  describe('agent-binary update edition gate (#4093)', () => {
    const ORIGINAL_EDITION = process.env.BINARY_EDITION;

    function mockDevice(device: Record<string, unknown>) {
      let pollCall = 0;
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              pollCall += 1;
              if (pollCall === 1) return Promise.resolve([device]);
              return Promise.resolve([
                { id: 'cmd-e', status: 'completed', result: { status: 'completed' } },
              ]);
            }),
          }),
        }),
      }) as any);
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'cmd-e', type: 'update_agent' }]),
        execute: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
      return insertValues;
    }

    // A device stranded in the 0.105.0-0.106.x band: it carries the client-side
    // edition check but is a self-host build, and it predates edition
    // reporting, so agent_edition is NULL.
    const strandedDevice = {
      id: 'dev-stranded',
      status: 'online',
      agentId: 'agent-stranded',
      orgId: 'org-1',
      hostname: 'stranded-pc',
      watchdogLastSeen: new Date(),
      agentEdition: null,
      agentVersion: '0.105.1',
      watchdogVersion: '0.105.1',
    };

    beforeEach(() => {
      vi.clearAllMocks();
      process.env.BINARY_EDITION = 'hosted';
    });

    afterEach(() => {
      if (ORIGINAL_EDITION === undefined) delete process.env.BINARY_EDITION;
      else process.env.BINARY_EDITION = ORIGINAL_EDITION;
    });

    it('refuses update_agent for a build that would reject the served edition', async () => {
      const insertValues = mockDevice(strandedDevice);

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/edition/i);
      // The command row must never be written — a dispatched command whose
      // artifact the device refuses is a wasted one-shot the operator has to
      // decode from a raw updater error.
      expect(insertValues).not.toHaveBeenCalled();
    });

    // The refusal is the operator's only correlation signal when the dispatch
    // came from an automated caller, so it must reach the logs, not just the
    // return value.
    it('logs the refusal with the device id so ops can correlate it', async () => {
      mockDevice(strandedDevice);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('dev-stranded');
      expect(logged).toContain('#4093');
      warn.mockRestore();
    });

    // Ordering contract: the edition gate must be evaluated BEFORE the
    // watchdog-liveness gate. An edition mismatch is a permanent property of
    // the installed build; reporting the transient "watchdog is not reporting"
    // instead would send the operator back to retry a dispatch that can never
    // succeed. Swap the two blocks in executeCommand and this fails.
    it('reports the permanent edition reason ahead of a stale-watchdog reason', async () => {
      const insertValues = mockDevice({
        ...strandedDevice,
        watchdogLastSeen: new Date(Date.now() - 60 * 60 * 1000), // an hour stale
      });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/edition/i);
      expect(result.error).not.toMatch(/not reporting/i);
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('refuses update_watchdog on the same grounds', async () => {
      const insertValues = mockDevice(strandedDevice);

      const result = await executeCommand(
        'dev-stranded',
        'update_watchdog',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/edition/i);
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('allows update_agent when the device reports its edition (transition-capable build)', async () => {
      const insertValues = mockDevice({ ...strandedDevice, agentEdition: 'self-host', agentVersion: '0.108.0', watchdogVersion: '0.108.0' });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.109.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('completed');
      expect(insertValues).toHaveBeenCalled();
    });

    it('allows update_agent for a pre-check build (< 0.105.0) with no reported edition', async () => {
      const insertValues = mockDevice({ ...strandedDevice, agentVersion: '0.104.0', watchdogVersion: '0.104.0' });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('completed');
      expect(insertValues).toHaveBeenCalled();
    });

    // The WATCHDOG performs the download for a targetRole:'watchdog' command
    // (agent/cmd/breeze-watchdog handleFailoverCommand -> doUpdateAgent), so
    // the band inference must key on the watchdog's version, not the main
    // agent's. Same reasoning as heartbeat.ts's failover branch.
    it('keys the version band on the WATCHDOG version for watchdog-targeted dispatch', async () => {
      const insertValues = mockDevice({
        ...strandedDevice,
        agentVersion: '0.104.0', // main agent predates the check
        watchdogVersion: '0.105.1', // but the downloading watchdog does not
      });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/edition/i);
      expect(insertValues).not.toHaveBeenCalled();
    });

    it('allows a watchdog older than the check band even when the main agent is inside it', async () => {
      // The watchdog is the downloader; a pre-0.105.0 watchdog has no edition
      // check and applies the artifact fine, whatever the wedged main agent is.
      const insertValues = mockDevice({
        ...strandedDevice,
        agentVersion: '0.105.1',
        watchdogVersion: '0.104.0',
      });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('completed');
      expect(insertValues).toHaveBeenCalled();
    });

    // The main agent has no handler for update_agent/update_watchdog: an
    // agent-targeted row is sent to the agent WebSocket and never picked up,
    // so it is a dead command, not merely an ungated one.
    it('refuses an agent-targeted agent-binary update outright', async () => {
      const insertValues = mockDevice({
        ...strandedDevice,
        agentEdition: 'hosted',
        agentVersion: '0.108.0',
        watchdogVersion: '0.108.0',
      });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.109.0' },
        { userId: 'user-1' }, // default targetRole: 'agent'
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/targetRole 'watchdog'/);
      expect(insertValues).not.toHaveBeenCalled();
    });

    // A hosted build hard-refuses a self-host artifact by design (that
    // direction would strip the host-policy allowlist), so a self-host server
    // must not push one at a hosted-edition agent either.
    it('refuses pushing a self-host artifact at a hosted-edition build', async () => {
      process.env.BINARY_EDITION = 'self-host';
      const insertValues = mockDevice({ ...strandedDevice, agentEdition: 'hosted', agentVersion: '0.108.0', watchdogVersion: '0.108.0' });

      const result = await executeCommand(
        'dev-stranded',
        'update_agent',
        { version: '0.108.0' },
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/edition/i);
      expect(insertValues).not.toHaveBeenCalled();
    });

    // The gate is scoped to agent-binary update types only. A watchdog RESTART
    // downloads nothing, so an edition-incompatible build must still be able
    // to receive it — that is the recovery path for the very devices the gate
    // withholds updates from.
    it('does not gate non-update commands (restart_agent still dispatches)', async () => {
      const insertValues = mockDevice(strandedDevice);

      const result = await executeCommand(
        'dev-stranded',
        'restart_agent',
        {},
        { userId: 'user-1', targetRole: 'watchdog' },
      );

      expect(result.status).toBe('completed');
      expect(insertValues).toHaveBeenCalled();
    });

    // queueCommand is the SIBLING device_commands insert site. It has no
    // device row (BullMQ workers call it with no DB context), so it cannot
    // evaluate the gate — it must refuse these types outright rather than
    // become an ungated back door.
    it('queueCommand refuses agent-binary update types outright', async () => {
      await expect(queueCommand('dev-stranded', 'update_agent', { version: '0.108.0' }))
        .rejects.toThrow(/executeCommand/i);
      await expect(queueCommand('dev-stranded', 'update_watchdog', { version: '0.108.0' }))
        .rejects.toThrow(/executeCommand/i);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('queueCommandForExecution expectedOrgId guard', () => {
    function mockDeviceLookup(device: unknown) {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(device ? [device] : []),
          }),
        }),
      } as any);
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('refuses a device whose orgId differs from expectedOrgId', async () => {
      mockDeviceLookup({ id: 'dev-foreign', status: 'online', orgId: 'org-evil' });

      const result = await queueCommandForExecution(
        'dev-foreign',
        CommandTypes.BACKUP_RESTORE,
        {},
        { expectedOrgId: 'org-victim' },
      );

      // Matches the adjacent "Device not found" contract — no info leak.
      expect(result.error).toBe('Device not found');
      // Must not have proceeded to queue the command.
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('passes the org gate when device.orgId matches expectedOrgId', async () => {
      // offline so it short-circuits AFTER the org check passes, proving the
      // org gate did not reject a same-org device.
      mockDeviceLookup({ id: 'dev-mine', status: 'offline', orgId: 'org-victim' });

      const result = await queueCommandForExecution(
        'dev-mine',
        CommandTypes.BACKUP_RESTORE,
        {},
        { expectedOrgId: 'org-victim' },
      );

      expect(result.error).toBe('Device is offline, cannot execute command');
    });

    it('is unaffected when expectedOrgId is omitted (existing callers)', async () => {
      // Foreign org, but no expectedOrgId passed: gate is inert, falls through
      // to the normal status check.
      mockDeviceLookup({ id: 'dev-any', status: 'offline', orgId: 'org-whatever' });

      const result = await queueCommandForExecution('dev-any', CommandTypes.BACKUP_RESTORE, {});

      expect(result.error).toBe('Device is offline, cannot execute command');
    });
  });
});

// ---------------------------------------------------------------------------
// created_by FK guard (#3978)
// ---------------------------------------------------------------------------
// device_commands.created_by carries a FK to users(id). queueCommand used to
// stamp the caller's id verbatim, so an `ai_agent` principal (auth.user.id is
// an ai_agents id) or a helper session (auth.user.id IS the device id) blew up
// with SQLSTATE 23503 — after a human had already approved the intent.
//
// The 23503 itself is proved against real Postgres in
// src/__tests__/integration/commandQueueCreatedBy.integration.test.ts; a mocked
// suite has no FK to violate. These tests instead pin the resolution CONTRACT
// in the fast unit job: what lands in the insert, that the probe predicate is
// real, and that the probe escapes the caller's DB context.
describe('created_by FK guard (#3978)', () => {
  const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
  const HUMAN_ID = '55555555-5555-4555-8555-555555555555';
  const AGENT_ID = '66666666-6666-4666-8666-666666666666';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Capture the object actually handed to `.values()` so assertions read the
   * real insert payload rather than a hand-shaped fixture the driver would
   * never produce.
   */
  function captureCommandInsert(): Record<string, unknown>[] {
    const captured: Record<string, unknown>[] = [];
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn((values: Record<string, unknown>) => {
        captured.push(values);
        return { returning: vi.fn().mockResolvedValue([{ id: 'cmd-guard', ...values }]) };
      }),
    } as any);
    return captured;
  }

  /** The single captured insert payload, or a hard failure if none was made. */
  function onlyInsert(captured: Record<string, unknown>[]): Record<string, unknown> {
    expect(captured).toHaveLength(1);
    const values = captured[0];
    if (!values) {
      throw new Error('queueCommand made no insert');
    }
    return values;
  }

  /**
   * Stand in for the `users` existence probe. Resolves a row only for ids in
   * `existingUserIds`, decided by COMPILING the real `.where()` argument and
   * reading its bound params — so a helper that probed a constant, or dropped
   * the predicate, cannot pass.
   */
  function mockUsersProbe(existingUserIds: string[]): { wheres: unknown[] } {
    const wheres: unknown[] = [];
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition: unknown) => {
          wheres.push(condition);
          const { params } = new PgDialect().sqlToQuery(condition as never);
          const probedId = params.find((p): p is string => typeof p === 'string');
          return {
            limit: vi.fn().mockResolvedValue(
              probedId && existingUserIds.includes(probedId) ? [{ id: probedId }] : [],
            ),
          };
        }),
      }),
    })) as any);
    return { wheres };
  }

  it('stamps created_by NULL for an ai_agent id that is not a users row', async () => {
    mockUsersProbe([]); // no matching users row — the agent case
    const inserted = captureCommandInsert();

    await queueCommand(DEVICE_ID, CommandTypes.LIST_PROCESSES, {}, AGENT_ID);

    const values = onlyInsert(inserted);
    expect(values.createdBy).toBeNull();
    // Never the raw agent id — that is the value that violated the FK.
    expect(values.createdBy).not.toBe(AGENT_ID);
  });

  it('probes users for the caller id itself, as a real bound predicate', async () => {
    const probe = mockUsersProbe([HUMAN_ID]);
    captureCommandInsert();

    await queueCommand(DEVICE_ID, CommandTypes.LIST_PROCESSES, {}, HUMAN_ID);

    expect(probe.wheres).toHaveLength(1);
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(probe.wheres[0] as never);
    // Real column identifier + the caller id as a bound param: proves the probe
    // asks "is THIS id a users row", not something incidental.
    expect(sqlText).toContain('"users"."id"');
    expect(params).toContain(HUMAN_ID);
  });

  it('preserves a real human id — attribution must survive the guard', async () => {
    mockUsersProbe([HUMAN_ID]);
    const inserted = captureCommandInsert();

    await queueCommand(DEVICE_ID, CommandTypes.LIST_PROCESSES, {}, HUMAN_ID);

    expect(onlyInsert(inserted).createdBy).toBe(HUMAN_ID);
  });

  it('short-circuits a helper session (userId === deviceId) without probing', async () => {
    const probe = mockUsersProbe([]);
    const inserted = captureCommandInsert();

    await queueCommand(DEVICE_ID, CommandTypes.LIST_PROCESSES, {}, DEVICE_ID);

    expect(onlyInsert(inserted).createdBy).toBeNull();
    // The device id can never be a users row, so the DB round-trip is skipped.
    expect(probe.wheres).toHaveLength(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('short-circuits an absent userId without probing', async () => {
    const probe = mockUsersProbe([]);
    const inserted = captureCommandInsert();

    await queueCommand(DEVICE_ID, CommandTypes.LIST_PROCESSES, {});

    expect(onlyInsert(inserted).createdBy).toBeNull();
    expect(probe.wheres).toHaveLength(0);
  });

  it('runs the probe OUTSIDE the caller DB context, in a system context', async () => {
    // The load-bearing part of the fix. `users` is RLS-protected and
    // withSystemDbAccessContext is a no-op when a caller context is already
    // open, so the probe must first exit that context via runOutsideDbContext.
    // Without this, an org-scoped worker dispatch would read zero rows and
    // degrade a REAL human to created_by NULL.
    const dbModule = await import('../db');
    const order: string[] = [];
    vi.mocked(dbModule.runOutsideDbContext).mockImplementationOnce(async (fn: () => unknown) => {
      order.push('enter-outside');
      const result = await fn();
      order.push('exit-outside');
      return result;
    });
    vi.mocked(dbModule.withSystemDbAccessContext).mockImplementationOnce(async (fn: () => unknown) => {
      order.push('enter-system');
      const result = await fn();
      order.push('exit-system');
      return result;
    });
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            order.push('users-probe');
            return Promise.resolve([{ id: HUMAN_ID }]);
          }),
        }),
      }),
    })) as any);

    await expect(resolveCommandCreatedBy(DEVICE_ID, HUMAN_ID)).resolves.toBe(HUMAN_ID);

    // Nesting matters: outside must open before system, and the read must land
    // between them.
    expect(order).toEqual([
      'enter-outside',
      'enter-system',
      'users-probe',
      'exit-system',
      'exit-outside',
    ]);
  });
});
