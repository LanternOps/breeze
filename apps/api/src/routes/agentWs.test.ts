import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq, notInArray } from 'drizzle-orm';

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
    previousTokenHash: 'devices.previousTokenHash',
    previousTokenExpiresAt: 'devices.previousTokenExpiresAt',
    watchdogTokenHash: 'devices.watchdogTokenHash',
    previousWatchdogTokenHash: 'devices.previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'devices.previousWatchdogTokenExpiresAt',
    orgId: 'devices.orgId',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    updatedAt: 'devices.updatedAt'
  },
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    status: 'deviceCommands.status',
    targetRole: 'deviceCommands.targetRole',
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
  tunnelSessions: {
    id: 'tunnelSessions.id',
    deviceId: 'tunnelSessions.deviceId',
    status: 'tunnelSessions.status',
    errorMessage: 'tunnelSessions.errorMessage',
    endedAt: 'tunnelSessions.endedAt',
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

vi.mock('./tunnelWs', () => ({
  handleTunnelDataFromAgent: vi.fn(),
  isTunnelOwnedByAgent: vi.fn(() => true),
  registerTunnelOwnership: vi.fn(),
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

vi.mock('../services/viewerTokenRevocation', () => ({
  revokeViewerSession: vi.fn(async () => undefined),
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

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn().mockResolvedValue(undefined),
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../services/tenantStatus', () => ({
  isAgentTenantActive: vi.fn(async () => true),
}));

import { db } from '../db';
import { devices } from '../db/schema';
import {
  createAgentWsHandlers,
  createAgentWsRoutes,
  validateAgentToken,
  disconnectAgent,
  isAgentConnected,
  __resetCrossTenantDropsForTest,
  AGENT_WS_CAPABILITIES,
} from './agentWs';
import { writeAuditEvent } from '../services/auditEvents';
import { isAgentTenantActive } from '../services/tenantStatus';
import { enqueueDiscoveryResults } from '../jobs/discoveryWorker';
import { enqueueSnmpPollResults } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult } from '../jobs/monitorWorker';
import { getActiveTerminalSession, handleTerminalOutput } from './terminalWs';
import { registerTunnelOwnership } from './tunnelWs';
import { processBackupVerificationResult } from './backup/verificationService';
import { updateRestoreJobFromResult } from '../services/restoreResultPersistence';
import { rateLimiter } from '../services/rate-limit';
import { revokeViewerSession } from '../services/viewerTokenRevocation';
import { publishEvent } from '../services/eventBus';

function wsMock() {
  return {
    send: vi.fn(),
    close: vi.fn()
  };
}

describe('validateAgentToken — tenant-status gate', () => {
  const TOKEN = 'brz_ws_test_token';
  const deviceRow = {
    id: 'device-1',
    orgId: 'org-1',
    agentTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    status: 'online',
    agentTokenSuspendedAt: null,
  };

  function queueDeviceSelect(row: unknown | undefined) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) })),
      })),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);
  });

  it('accepts a valid agent token for an active tenant', async () => {
    queueDeviceSelect(deviceRow);

    const result = await validateAgentToken('agent-1', TOKEN);

    expect(result).toEqual({ ok: true, ctx: { deviceId: 'device-1', orgId: 'org-1', role: 'agent' } });
    expect(isAgentTenantActive).toHaveBeenCalledWith('org-1');
  });

  it('refuses the upgrade when the device tenant is not active', async () => {
    queueDeviceSelect(deviceRow);
    vi.mocked(isAgentTenantActive).mockResolvedValue(false);

    const result = await validateAgentToken('agent-1', TOKEN);

    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
  });
});

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
  const returning = vi.fn().mockResolvedValue(rows);
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning }),
      returning,
    })
  };
}

describe('agent websocket handshake', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('advertises terminal_output_base64 in the connected message', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onOpen({}, ws as any);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0] as string);
    expect(payload.type).toBe('connected');
    expect(payload.capabilities).toEqual([...AGENT_WS_CAPABILITIES]);
  });

  it('decodes base64 terminal_output and relays UTF-8 to the terminal consumer', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(getActiveTerminalSession).mockReturnValue({
      agentId: 'agent-123',
      userId: 'user-1',
      deviceId: 'device-123',
      startedAt: new Date(),
      lastPongAt: Date.now(),
      userWs: wsMock() as any,
    } as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();
    const base64Payload = Buffer.from('café\n', 'utf8').toString('base64');

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'terminal_output',
        sessionId,
        data: base64Payload,
        encoding: 'base64',
      }),
    } as any, ws as any);

    expect(vi.mocked(handleTerminalOutput)).toHaveBeenCalledWith(sessionId, 'café\n');
  });
});

// Regression coverage for #2230 — see the updateDeviceStatus() doc comment in
// agentWs.ts for the full incident writeup. These tests pin the terminal-status
// guard on every agent-driven status write: connect, WS heartbeat (the actual
// resurrection vector), disconnect, and the update_status self-update message.
describe('WS lifecycle status writes — terminal-status guard (#2230)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const TERMINAL_GUARD = notInArray(devices.status, ['decommissioned', 'quarantined']);

  function rigStatusUpdateCapture() {
    const whereMock = vi.fn().mockResolvedValue([]);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
    return { whereMock, setMock };
  }

  it('excludes decommissioned/quarantined rows when flipping a device online on connect', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const { whereMock, setMock } = rigStatusUpdateCapture();
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    await handlers.onOpen({}, wsMock() as any);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'online' }));
    expect(whereMock).toHaveBeenCalledWith(
      and(eq(devices.agentId, 'agent-123'), TERMINAL_GUARD)
    );
  });

  it('excludes decommissioned/quarantined rows when flipping a device offline on disconnect', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    // Connect first so onClose sees this ws as the active connection.
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);
    await handlers.onOpen({}, ws as any);

    vi.clearAllMocks();
    vi.mocked(publishEvent).mockResolvedValue('event-id');
    const { whereMock, setMock } = rigStatusUpdateCapture();
    // onClose status pre-check select — return a live row so the offline write runs.
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([
      { id: 'device-123', siteId: 'site-1', status: 'online', hostname: 'host-1' },
    ]) as any);

    await handlers.onClose({}, ws as any);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline' }));
    expect(whereMock).toHaveBeenCalledWith(
      and(eq(devices.agentId, 'agent-123'), TERMINAL_GUARD)
    );
  });

  it('excludes decommissioned/quarantined rows when a WS heartbeat flips a device online', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const { whereMock, setMock } = rigStatusUpdateCapture();
    // getPendingCommands device lookup — no row, so no command claim follows.
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({ type: 'heartbeat', timestamp: 1234567890 }),
    } as any, ws as any);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'online' }));
    expect(whereMock).toHaveBeenCalledWith(
      and(eq(devices.agentId, 'agent-123'), TERMINAL_GUARD)
    );
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"heartbeat_ack"'));
  });

  it('excludes decommissioned/quarantined rows when update_status flips a device to updating', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const { whereMock, setMock } = rigStatusUpdateCapture();

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);

    await handlers.onMessage({
      data: JSON.stringify({ type: 'update_status', targetVersion: '1.2.3' }),
    } as any, wsMock() as any);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'updating' }));
    expect(whereMock).toHaveBeenCalledWith(
      and(eq(devices.agentId, 'agent-123'), TERMINAL_GUARD)
    );
  });
});

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

  it('rejects watchdog-targeted command results on the agent websocket', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-1',
          type: 'update_agent',
          payload: {},
          deviceId: 'device-123',
          targetRole: 'watchdog',
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-1' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        exitCode: 0,
        stdout: 'spoofed'
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
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

  it('does not register tunnel ownership when a tunnel open result is not DB-bound to the authenticated device', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'tun-open-44444444-4444-4444-8444-444444444444',
        status: 'completed'
      })
    } as any, ws as any);

    expect(registerTunnelOwnership).not.toHaveBeenCalled();
    expect(revokeViewerSession).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('registers tunnel ownership only after a DB-backed transition for the authenticated device', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult([
      { id: '44444444-4444-4444-8444-444444444444', deviceId: 'device-123' }
    ]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'tun-open-44444444-4444-4444-8444-444444444444',
        status: 'completed'
      })
    } as any, ws as any);

    expect(registerTunnelOwnership).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', 'agent-123');
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

  // #2307: fielded agents confirm desk-stop with result {"stopped": true}.
  // The strict result schema must accept the key instead of dropping the
  // message as a malformed desk-command_result.
  it('accepts a desk-stop result carrying {"stopped": true} without a malformed-drop warn (#2307)', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'desk-stop-session-123',
        status: 'completed',
        result: { stopped: true }
      })
    } as any, ws as any);

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Dropping malformed desk-command_result')
    );
    // Message passes the fast-path schema and is acked like any other result.
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
    warnSpy.mockRestore();
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
    __resetCrossTenantDropsForTest();
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

  // Task 18: 5 cross-tenant drops within 5 min auto-suspends the agent token.
  describe('Task 18 — agent token auto-suspend on cross-tenant probe', () => {
    it('suspends the agent token after SUSPEND_THRESHOLD (5) cross-tenant drops', async () => {
      __resetCrossTenantDropsForTest();
      const preValidatedAgent = { deviceId: 'device-abc', orgId: 'org-abc' };
      const handlers = createAgentWsHandlers('agent-task18-suspend', preValidatedAgent);
      const ws = wsMock();

      // Owner mismatch: every terminal_output is for a session owned by
      // somebody else, so each one increments the cross-tenant counter.
      vi.mocked(getActiveTerminalSession).mockReturnValue({
        agentId: 'other-agent',
        userId: 'user-1',
        deviceId: 'device-other',
        startedAt: new Date(),
        lastPongAt: Date.now(),
        userWs: wsMock() as any,
      } as any);

      // Capture the suspend UPDATE so we can assert it ran exactly once.
      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Fire 5 probes — the 5th should trip the suspend.
      for (let i = 0; i < 5; i += 1) {
        await handlers.onMessage({
          data: JSON.stringify({
            type: 'terminal_output',
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            data: 'probe',
          }),
        } as any, ws as any);
      }

      // Let the fire-and-forget suspend microtask settle.
      await new Promise((r) => setImmediate(r));

      // The DB UPDATE fires once with the suspend columns set.
      expect(updateSet).toHaveBeenCalledTimes(1);
      const updateArg = updateSet.mock.calls[0]?.[0];
      expect(updateArg).toMatchObject({
        agentTokenSuspendedReason: 'cross-tenant-probe',
      });
      expect(updateArg.agentTokenSuspendedAt).toBeInstanceOf(Date);

      // Console log surfaced the suspension.
      const suspendLogs = warnSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('auto-suspending agent token')
      );
      expect(suspendLogs.length).toBe(1);
      expect(suspendLogs[0]?.[0]).toContain('device=device-abc');
      expect(suspendLogs[0]?.[0]).toContain('drops=5');
      warnSpy.mockRestore();
    });

    it('does NOT suspend after only 4 drops (below the threshold)', async () => {
      __resetCrossTenantDropsForTest();
      const preValidatedAgent = { deviceId: 'device-not-yet', orgId: 'org-x' };
      const handlers = createAgentWsHandlers('agent-task18-undercount', preValidatedAgent);
      const ws = wsMock();

      vi.mocked(getActiveTerminalSession).mockReturnValue({
        agentId: 'other-agent',
        userId: 'user-1',
        deviceId: 'device-other',
        startedAt: new Date(),
        lastPongAt: Date.now(),
        userWs: wsMock() as any,
      } as any);

      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (let i = 0; i < 4; i += 1) {
        await handlers.onMessage({
          data: JSON.stringify({
            type: 'terminal_output',
            sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            data: 'probe',
          }),
        } as any, ws as any);
      }

      await new Promise((r) => setImmediate(r));

      // No suspend yet — the counter is at 4, threshold is 5.
      expect(updateSet).not.toHaveBeenCalled();
      const suspendLogs = warnSpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('auto-suspending agent token')
      );
      expect(suspendLogs.length).toBe(0);
      warnSpy.mockRestore();
    });

    it('suspends only once even when probes continue past threshold', async () => {
      __resetCrossTenantDropsForTest();
      const preValidatedAgent = { deviceId: 'device-once', orgId: 'org-y' };
      const handlers = createAgentWsHandlers('agent-task18-once', preValidatedAgent);
      const ws = wsMock();

      vi.mocked(getActiveTerminalSession).mockReturnValue({
        agentId: 'other-agent',
        userId: 'user-1',
        deviceId: 'device-other',
        startedAt: new Date(),
        lastPongAt: Date.now(),
        userWs: wsMock() as any,
      } as any);

      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 15 probes — only the 5th should trip the suspend.
      for (let i = 0; i < 15; i += 1) {
        await handlers.onMessage({
          data: JSON.stringify({
            type: 'terminal_output',
            sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            data: 'probe',
          }),
        } as any, ws as any);
      }

      await new Promise((r) => setImmediate(r));

      expect(updateSet).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
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

// Finding #4 — one authorized socket per agent. A second socket must close the
// first, and disconnectAgent/revocation must always act on the authoritative
// (newest) socket so no orphan survives.
describe('Finding #4 — one-socket-per-agent invariant', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('closes the previous socket when a second socket opens for the same agent', async () => {
    const preValidatedAgent = { deviceId: 'device-dup', orgId: 'org-dup' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    // Empty device select: onOpen registers the socket without reaching the
    // (unmocked) command-claim path.
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-dup', preValidatedAgent);
    const ws1 = wsMock();
    const ws2 = wsMock();

    await handlers.onOpen({}, ws1 as any);
    await handlers.onOpen({}, ws2 as any);

    expect(ws1.close).toHaveBeenCalledWith(4002, 'Superseded by newer connection');
    expect(ws2.close).not.toHaveBeenCalled();
    expect(isAgentConnected('agent-dup')).toBe(true);
  });

  it('disconnectAgent closes the current authoritative socket', async () => {
    const preValidatedAgent = { deviceId: 'device-auth', orgId: 'org-auth' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-auth', preValidatedAgent);
    const ws = wsMock();
    await handlers.onOpen({}, ws as any);

    const outcome = disconnectAgent('agent-auth', 4041, 'Device decommissioned');

    expect(outcome).toBe('closed');
    expect(ws.close).toHaveBeenCalledWith(4041, 'Device decommissioned');
  });

  it('an orphaned socket cannot outlive its replacement — onClose of the orphan never evicts the live socket', async () => {
    const preValidatedAgent = { deviceId: 'device-orphan', orgId: 'org-orphan' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-orphan', preValidatedAgent);
    const ws1 = wsMock();
    const ws2 = wsMock();

    await handlers.onOpen({}, ws1 as any); // ws1 authoritative
    await handlers.onOpen({}, ws2 as any); // ws2 supersedes; ws1 closed as orphan

    // The orphan's late onClose must NOT evict ws2 from the connection map or
    // clobber its ping state (both guarded by connection identity).
    await handlers.onClose({}, ws1 as any);

    expect(isAgentConnected('agent-orphan')).toBe(true);
    disconnectAgent('agent-orphan');
    expect(ws2.close).toHaveBeenCalled();
  });
});

// Finding #3 — established sockets must stop acting once containment changes.
describe('Finding #3 — lifecycle recheck on sensitive operations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('severs the socket on a command result when the device was quarantined after connect', async () => {
    const preValidatedAgent = { deviceId: 'device-q', orgId: 'org-q' };
    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-1' }]) as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any); // onOpen: register only

    const handlers = createAgentWsHandlers('agent-q', preValidatedAgent);
    const ws = wsMock();
    await handlers.onOpen({}, ws as any);
    vi.mocked(ws.close).mockClear();
    vi.mocked(db.update).mockClear();

    // command lookup returns a live row, then the lifecycle recheck sees the
    // device is now quarantined.
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        { id: 'cmd-1', type: 'run_script', payload: {}, deviceId: 'device-q' },
      ]) as any)
      .mockReturnValueOnce(selectAgentDevice([{ status: 'quarantined', agentTokenSuspendedAt: null }]) as any);

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '77777777-7777-4777-8777-777777777777',
        status: 'completed',
        stdout: 'ok',
      }),
    } as any, ws as any);

    expect(ws.close).toHaveBeenCalledWith(4001, 'Device no longer authorized');
    // Aborted before persisting: the command row is never terminally updated.
    expect(db.update).not.toHaveBeenCalled();
  });

  it('severs the socket on a heartbeat command-claim when the token was suspended after connect', async () => {
    const preValidatedAgent = { deviceId: 'device-s', orgId: 'org-s' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any); // onOpen: register only

    const handlers = createAgentWsHandlers('agent-s', preValidatedAgent);
    const ws = wsMock();
    await handlers.onOpen({}, ws as any);
    vi.mocked(ws.close).mockClear();

    // The claim path re-checks the same device row it fetches: a suspended
    // token (org/partner tenant suspension denormalizes here) severs the socket.
    vi.mocked(db.select).mockReturnValue(
      selectAgentDevice([{ id: 'device-s', status: 'online', agentTokenSuspendedAt: new Date() }]) as any
    );

    await handlers.onMessage({
      data: JSON.stringify({ type: 'heartbeat', timestamp: 123 }),
    } as any, ws as any);

    expect(ws.close).toHaveBeenCalledWith(4001, 'Device no longer authorized');
  });
});

// Finding #8 — WS command results emit the same append-only audit as REST.
// Finding #5 — WS result stdout/stderr are redacted before persistence.
describe('Findings #8 / #5 — WS command-result audit + secret redaction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('emits agent.command.result.submit exactly once after a real terminal transition', async () => {
    const preValidatedAgent = { deviceId: 'device-a', orgId: 'org-a' };
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      { id: 'cmd-1', type: 'run_script', payload: {}, deviceId: 'device-a' },
    ]) as any);
    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-1' }]) as any);

    const handlers = createAgentWsHandlers('agent-a', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '88888888-8888-4888-8888-888888888888',
        status: 'completed',
        exitCode: 0,
        stdout: 'done',
      }),
    } as any, ws as any);

    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const auditEvent = vi.mocked(writeAuditEvent).mock.calls[0]![1];
    expect(auditEvent).toMatchObject({
      action: 'agent.command.result.submit',
      actorType: 'agent',
      actorId: 'agent-a',
      orgId: 'org-a',
      resourceType: 'device_command',
      resourceId: '88888888-8888-4888-8888-888888888888',
      result: 'success',
      details: { commandType: 'run_script', status: 'completed', exitCode: 0 },
    });
  });

  it('does NOT audit when the compare-and-set no-ops (duplicate/late result)', async () => {
    const preValidatedAgent = { deviceId: 'device-a', orgId: 'org-a' };
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      { id: 'cmd-1', type: 'run_script', payload: {}, deviceId: 'device-a' },
    ]) as any);
    // returning [] — the row was already terminal, so no transition occurred.
    vi.mocked(db.update).mockReturnValue(updateResult([]) as any);

    const handlers = createAgentWsHandlers('agent-a', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '88888888-8888-4888-8888-888888888888',
        status: 'completed',
        exitCode: 0,
        stdout: 'done',
      }),
    } as any, ws as any);

    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('redacts a PEM private key from stdout before it is persisted', async () => {
    const preValidatedAgent = { deviceId: 'device-r', orgId: 'org-r' };
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      { id: 'cmd-1', type: 'run_script', payload: {}, deviceId: 'device-r' },
    ]) as any);

    // Capture the persisted result payload from the terminal UPDATE .set(...).
    const setSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }]) }),
    });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

    const handlers = createAgentWsHandlers('agent-r', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '99999999-9999-4999-8999-999999999999',
        status: 'completed',
        exitCode: 0,
        stdout: `key follows:\n${pem}\nend`,
      }),
    } as any, ws as any);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const stored = setSpy.mock.calls[0]![0] as { result: { stdout: string } };
    expect(stored.result.stdout).toContain('[PRIVATE_KEY_REDACTED]');
    expect(stored.result.stdout).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});
