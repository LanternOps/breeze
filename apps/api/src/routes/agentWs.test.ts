import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    agentTokenHash: 'devices.agentTokenHash',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    updatedAt: 'devices.updatedAt'
  },
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId'
  },
  discoveryJobs: {},
  scriptExecutions: {},
  scriptExecutionBatches: {}
}));

vi.mock('./terminalWs', () => ({
  handleTerminalOutput: vi.fn()
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

vi.mock('../services/redis', () => ({
  isRedisAvailable: vi.fn(() => false)
}));

import { db } from '../db';
import { createAgentWsHandlers } from './agentWs';

function wsMock() {
  return {
    send: vi.fn(),
    close: vi.fn()
  };
}

function selectOwnedCommandResult(rows: unknown[]) {
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

describe('agent websocket command results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects cross-device command result updates', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([]) as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      })
    } as any);

    const handlers = createAgentWsHandlers('agent-123', undefined);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'cmd-1',
        status: 'completed',
        exitCode: 0
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('updates command result when command belongs to connected agent', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      {
        command: {
          id: 'cmd-1',
          type: 'run_script',
          payload: {}
        },
        deviceId: 'device-123'
      }
    ]) as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      })
    } as any);

    const handlers = createAgentWsHandlers('agent-123', undefined);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'cmd-1',
        status: 'completed',
        exitCode: 0,
        stdout: 'ok'
      })
    } as any, ws as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });
});
