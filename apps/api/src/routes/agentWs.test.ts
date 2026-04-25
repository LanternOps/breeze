import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateRestoreJobFromResultMock = vi.fn().mockResolvedValue(true);

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn()
  },
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn())
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    agentTokenHash: 'devices.agentTokenHash',
    orgId: 'devices.orgId',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    updatedAt: 'devices.updatedAt'
  },
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    status: 'deviceCommands.status',
  },
  discoveryJobs: {
    id: 'discoveryJobs.id',
    orgId: 'discoveryJobs.orgId',
    siteId: 'discoveryJobs.siteId',
    agentId: 'discoveryJobs.agentId',
  },
  remoteSessions: {
    id: 'remoteSessions.id',
    deviceId: 'remoteSessions.deviceId',
    status: 'remoteSessions.status',
  },
  scriptExecutions: {
    id: 'scriptExecutions.id',
    deviceId: 'scriptExecutions.deviceId',
    status: 'scriptExecutions.status',
    scriptId: 'scriptExecutions.scriptId',
  },
  scriptExecutionBatches: {
    id: 'scriptExecutionBatches.id',
    scriptId: 'scriptExecutionBatches.scriptId',
    devicesCompleted: 'scriptExecutionBatches.devicesCompleted',
    devicesFailed: 'scriptExecutionBatches.devicesFailed',
  },
  backupJobs: {},
  restoreJobs: {
    id: 'restoreJobs.id',
    commandId: 'restoreJobs.commandId',
    deviceId: 'restoreJobs.deviceId',
    restoreType: 'restoreJobs.restoreType',
    status: 'restoreJobs.status',
    targetConfig: 'restoreJobs.targetConfig',
  },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
}));

vi.mock('./terminalWs', () => ({
  handleTerminalOutput: vi.fn(),
  getActiveTerminalSession: vi.fn(),
  unregisterTerminalOutputCallback: vi.fn()
}));

vi.mock('./desktopWs', () => ({
  handleDesktopFrame: vi.fn(),
  isDesktopSessionOwnedByAgent: vi.fn(() => true)
}));

vi.mock('../jobs/discoveryWorker', () => ({
  enqueueDiscoveryResults: vi.fn()
}));

vi.mock('../jobs/snmpWorker', () => ({
  enqueueSnmpPollResults: vi.fn()
}));

vi.mock('../jobs/monitorWorker', () => ({
  enqueueMonitorCheckResult: vi.fn(),
  recordMonitorCheckResult: vi.fn()
}));

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedis: vi.fn(() => null)
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: new Date() })
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue('event-id'),
}));

vi.mock('./backup/verificationService', () => ({
  processBackupVerificationResult: vi.fn(),
}));

vi.mock('../services/restoreResultPersistence', () => ({
  updateRestoreJobByCommandId: vi.fn(),
  updateRestoreJobFromResult: vi.fn((...args: unknown[]) => updateRestoreJobFromResultMock(...(args as []))),
}));

import { db } from '../db';
import { createAgentWsHandlers, createAgentWsRoutes } from './agentWs';
import { enqueueDiscoveryResults } from '../jobs/discoveryWorker';
import { enqueueSnmpPollResults } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult } from '../jobs/monitorWorker';
import { getActiveTerminalSession, handleTerminalOutput } from './terminalWs';
import { processBackupVerificationResult } from './backup/verificationService';
import { updateRestoreJobFromResult } from '../services/restoreResultPersistence';
import { rateLimiter } from '../services/rate-limit';

function wsMock() {
  return {
    send: vi.fn(),
    close: vi.fn()
  };
}

function selectOwnedCommandResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectAgentDevice(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectWithInnerJoin(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

function updateResult(rows: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
      returning: vi.fn().mockResolvedValue(rows),
    })
  };
}

describe('agent websocket command results', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects cross-device command result updates', async () => {
    // Auth is now pre-validated before WS upgrade, so we pass the context directly
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([]) as any);
    vi.mocked(db.update).mockReturnValue(updateResult() as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '11111111-1111-4111-8111-111111111111',
        status: 'completed',
        exitCode: 0
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('updates command result when command belongs to connected agent', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-1',
          type: 'run_script',
          payload: {},
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-1' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        exitCode: 0,
        stdout: 'ok'
      })
    } as any, ws as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('ignores replayed command results when no in-flight command row exists', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([]) as any);
    vi.mocked(db.update).mockReturnValue(updateResult() as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'completed',
        stdout: 'stale'
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('reconciles orphaned restore results using restore_jobs.command_id and inferred command type', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([
        {
          id: 'restore-1',
          orgId: 'org-123',
          agentId: 'agent-123',
          restoreType: 'full',
          status: 'running',
          targetConfig: {
            mode: 'instant_boot',
          },
        }
      ]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        result: {
          status: 'completed',
          backgroundSyncActive: true,
          syncProgress: 58,
        }
      })
    } as any, ws as any);

    expect(updateRestoreJobFromResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'restore-1',
        restoreType: 'full',
        targetConfig: {
          mode: 'instant_boot',
        },
      }),
      'vm_instant_boot',
      expect.objectContaining({
        status: 'completed',
        result: expect.objectContaining({
          backgroundSyncActive: true,
          syncProgress: 58,
        }),
      })
    );
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('bypasses device_commands lookup for non-UUID command IDs', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'dev-push-test-123',
        status: 'completed'
      })
    } as any, ws as any);

    expect(db.select).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects unexpected orphaned monitor results without a recorded dispatch', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'mon-monitor-1-123',
        status: 'completed',
        result: {
          monitorId: 'monitor-1',
          status: 'online',
          responseMs: 12
        }
      })
    } as any, ws as any);

    expect(db.select).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueMonitorCheckResult)).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('drops terminal output for sessions not owned by the connected agent', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(getActiveTerminalSession).mockReturnValue({
      agentId: 'agent-999',
      userId: 'user-1',
      deviceId: 'device-999',
      startedAt: new Date(),
      lastPongAt: Date.now(),
      userWs: wsMock() as any,
    } as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'terminal_output',
        sessionId: 'session-123',
        data: 'whoami'
      })
    } as any, ws as any);

    expect(vi.mocked(handleTerminalOutput)).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('does not activate a desktop session from a desk-stop result', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'session-123' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'desk-stop-session-123',
        status: 'completed',
        result: {
          sessionId: 'session-123',
          answer: 'fake-answer'
        }
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects desktop disconnect results with mismatched session IDs', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'session-123' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'desk-disconnect-session-123',
        status: 'completed',
        result: {
          sessionId: 'session-other',
          event: 'peer_disconnected'
        }
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects desktop start failures with mismatched session IDs', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'session-123' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'desk-start-session-123',
        status: 'failed',
        result: {
          sessionId: 'session-other',
          error: 'bad session'
        }
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects mismatched discovery job IDs in command results', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-1',
          type: 'network_discovery',
          payload: { jobId: 'job-expected' },
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult() as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        result: {
          jobId: 'job-other',
          hosts: [{ ip: '10.0.0.1', assetType: 'server', methods: ['ping'] }]
        }
      })
    } as any, ws as any);

    expect(vi.mocked(enqueueDiscoveryResults)).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('skips downstream processing when the command row was already completed by another result', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-1',
          type: 'network_discovery',
          payload: { jobId: 'job-expected' },
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '55555555-5555-4555-8555-555555555555',
        status: 'completed',
        result: {
          jobId: 'job-expected',
          hosts: [{ ip: '10.0.0.1', assetType: 'server', methods: ['ping'] }]
        }
      })
    } as any, ws as any);

    expect(vi.mocked(enqueueDiscoveryResults)).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects malformed critical verification payloads before readiness processing', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-verify-1',
          type: 'backup_verify',
          payload: {},
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-verify-1' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '66666666-6666-4666-8666-666666666666',
        status: 'completed',
        result: {
          filesVerified: 10
        }
      })
    } as any, ws as any);

    expect(vi.mocked(processBackupVerificationResult)).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('rejects mismatched SNMP device IDs in command results', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-1',
          type: 'snmp_poll',
          payload: { deviceId: 'snmp-expected' },
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult() as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '44444444-4444-4444-8444-444444444444',
        status: 'completed',
        result: {
          deviceId: 'snmp-other',
          metrics: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 42, timestamp: new Date().toISOString() }]
        }
      })
    } as any, ws as any);

    expect(vi.mocked(enqueueSnmpPollResults)).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  // H5: malformed term-* command_result is dropped without DB call
  it('drops malformed term-* command_result without touching DB (H5)', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Invalid status value — schema rejects before any DB lookup
    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'term-start-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'totally-not-a-real-status',
        result: { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    // No ack on malformed fast-path messages — they are silently dropped after warn.
    expect(ws.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping malformed term-command_result'));
    warnSpy.mockRestore();
  });

  it('drops malformed terminal_output without invoking handleTerminalOutput (H5)', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Missing required `data` field
    await handlers.onMessage({
      data: JSON.stringify({
        type: 'terminal_output',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
    } as any, ws as any);

    expect(vi.mocked(handleTerminalOutput)).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping malformed terminal_output'));
    warnSpy.mockRestore();
  });

  // M-D1: 10 cross-tenant drops within 5 min triggers warn
  it('emits cross-tenant probe warning after threshold drops (M-D1)', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const handlers = createAgentWsHandlers('agent-malicious', preValidatedAgent);
    const ws = wsMock();

    // Owner mismatch: session belongs to a DIFFERENT agent
    vi.mocked(getActiveTerminalSession).mockReturnValue({
      agentId: 'other-agent',
      userId: 'user-1',
      deviceId: 'device-other',
      startedAt: new Date(),
      lastPongAt: Date.now(),
      userWs: wsMock() as any,
    } as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Send 10 schema-passing-but-ownership-failing terminal_output messages.
    for (let i = 0; i < 10; i += 1) {
      await handlers.onMessage({
        data: JSON.stringify({
          type: 'terminal_output',
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          data: 'probe',
        })
      } as any, ws as any);
    }

    // The probe-pattern warning is emitted exactly once after the threshold.
    const probeWarnings = warnSpy.mock.calls.filter(call =>
      typeof call[0] === 'string' && call[0].includes('cross-tenant probe pattern')
    );
    expect(probeWarnings.length).toBe(1);
    expect(probeWarnings[0]?.[0]).toContain('agent=agent-malicious');
    expect(probeWarnings[0]?.[0]).toContain('drops=10');
    warnSpy.mockRestore();
  });

  // H4: connection without Bearer header returns 401 (and rejects ?token=)
  describe('H4 — agent WS auth', () => {
    function makeStubUpgrade() {
      // Stub upgradeWebSocket so route mounting doesn't require a real WS.
      // If middleware lets the request through, this is what runs.
      return (_handler: unknown) => async (_c: any) => new Response('ws', { status: 101 });
    }

    it('rejects connection without Authorization: Bearer header', async () => {
      const app = createAgentWsRoutes(makeStubUpgrade());
      const res = await app.request('/00000000-0000-4000-8000-000000000000/ws');
      expect(res.status).toBe(401);
    });

    it('does NOT accept token via ?token= query param (H4 fallback removed)', async () => {
      const app = createAgentWsRoutes(makeStubUpgrade());
      const res = await app.request('/00000000-0000-4000-8000-000000000000/ws?token=brz_should_be_ignored');
      // Without a Bearer header we reject as 401 even when ?token= is supplied.
      expect(res.status).toBe(401);
    });
  });

  // M-D2: rate limiter calls the Redis helper with the expected key/limit
  it('M-D2 rate limiter delegates to Redis sliding-window helper', async () => {
    const { getRedis } = await import('../services/redis');
    // Pretend Redis is available so the helper is consulted (not in-memory fallback).
    const fakeRedis = {} as any;
    vi.mocked(getRedis).mockReturnValueOnce(fakeRedis);

    const app = createAgentWsRoutes(((_handler: unknown) => async (_c: any) => new Response('ws', { status: 101 })) as any);
    await app.request('/agent-xyz/ws');

    expect(rateLimiter).toHaveBeenCalledWith(
      fakeRedis,
      'agentws:conn:agent-xyz',
      6,
      60
    );
  });

  it('M-D2 rejects with 429 when Redis rate-limit helper returns not allowed', async () => {
    const { getRedis } = await import('../services/redis');
    vi.mocked(getRedis).mockReturnValueOnce({} as any);
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

    const app = createAgentWsRoutes(((_handler: unknown) => async (_c: any) => new Response('ws', { status: 101 })) as any);
    const res = await app.request('/agent-overlimit/ws');
    expect(res.status).toBe(429);
  });
});
