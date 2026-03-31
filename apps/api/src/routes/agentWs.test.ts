import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  restoreJobs: {},
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
  isRedisAvailable: vi.fn(() => false)
}));

import { db } from '../db';
import { createAgentWsHandlers } from './agentWs';
import { enqueueDiscoveryResults } from '../jobs/discoveryWorker';
import { enqueueSnmpPollResults } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult } from '../jobs/monitorWorker';
import { getActiveTerminalSession, handleTerminalOutput } from './terminalWs';

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
      .mockReturnValueOnce(selectAgentDevice([]) as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      })
    } as any);

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

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      })
    } as any);

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
      .mockReturnValueOnce(selectAgentDevice([]) as any);
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
});
