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
  // Real services/backupProgress.ts and services/backupResultPersistence.ts run
  // in these tests and import these two from ../db/schema, so the mock must
  // provide them (otherwise inArray(status, undefined) throws mid-handler).
  IN_FLIGHT_BACKUP_JOB_STATUSES: ['pending', 'running'] as const,
  STALE_BACKUP_REAP_MARKER: '[stale-backup-reaper]',
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

vi.mock('../services/commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(),
  releaseClaimedCommandDelivery: vi.fn(),
  claimPendingCommandsForDevice: vi.fn(async () => []),
}));

// Task 7 backup-result guard-ordering tests exercise the REAL
// services/backupProgress.ts predicates/appliers (unit-tested separately in
// backupProgress.test.ts) through the agentWs message-handling path, so only
// the Redis-backed expectation service and the DB-writing job-completion
// persister are mocked here — everything else in the guard chain is real.
vi.mock('../services/agentWorkExpectation', () => ({
  claimConsumeOnce: vi.fn(),
  consumeDispatchedExpectation: vi.fn(),
  recordDispatchedExpectation: vi.fn(),
  refreshDispatchedExpectation: vi.fn(),
}));

vi.mock('../services/backupResultPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/backupResultPersistence')>();
  return {
    ...actual,
    applyBackupCommandResultToJob: vi.fn(),
  };
});

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
import { claimPendingCommandsForDevice } from '../services/commandDispatch';
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
import {
  consumeDispatchedExpectation,
  refreshDispatchedExpectation,
} from '../services/agentWorkExpectation';
import { applyBackupCommandResultToJob } from '../services/backupResultPersistence';

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

  it('stores capture_pprof stdout byte-for-byte on the WS leg (secret redaction would corrupt the base64 profiles, #2401)', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-pprof',
          type: 'capture_pprof',
          payload: { profile: 'heap' },
          deviceId: 'device-123'
        }
      ]) as any);

    const updateChain = updateResult([{ id: 'cmd-pprof' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    // Contains substrings the redaction patterns fire on (case-insensitive
    // AKIA + 16 alnum; token=...); must be persisted unmodified.
    const pprofStdout = JSON.stringify({
      capturedAt: '2026-07-12T10:00:00Z',
      heapProfileBase64: `QUJDakiAABCDEF1234567890abToken=abcdefgh12345678REVG${'Zm9v'.repeat(100)}`,
      heapProfileBytes: 4096,
    });

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        exitCode: 0,
        stdout: pprofStdout,
        stderr: 'password=supersecret123'
      })
    } as any, ws as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    const stored = updateChain.set.mock.calls[0]![0] as { result: { stdout: string; stderr: string } };
    expect(stored.result.stdout).toBe(pprofStdout);
    // stderr is NOT exempt.
    expect(stored.result.stderr).toContain('[REDACTED]');
    expect(stored.result.stderr).not.toContain('supersecret123');
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

  it('fails the backup_verifications record when a critical verification payload is malformed (not left running)', async () => {
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
        // Missing the required `status` field — schema rejects, so the result is
        // a genuine malformed payload deepJsonParse cannot rescue.
        result: {
          filesVerified: 10
        }
      })
    } as any, ws as any);

    // device_commands still transitions to failed...
    expect(db.update).toHaveBeenCalled();
    // ...AND the linked backup_verifications row is driven to a terminal failed
    // state via the normal failure path (IMPORTANT #1, #2556) rather than being
    // stranded in 'running'/'pending' until the 30-min stale-timeout sweep.
    expect(vi.mocked(processBackupVerificationResult)).toHaveBeenCalledTimes(1);
    const [commandId, handed] = vi.mocked(processBackupVerificationResult).mock.calls[0]! as [
      string,
      { status: string; error?: string }
    ];
    expect(commandId).toBe('66666666-6666-4666-8666-666666666666');
    expect(handed.status).toBe('failed');
    expect(handed.error).toContain('Rejected malformed backup_verify result');
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('fails the backup_verifications record when verification stdout exceeds the size limit', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([
        {
          id: 'cmd-verify-2',
          type: 'backup_verify',
          payload: {},
          deviceId: 'device-123'
        }
      ]) as any);

    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-verify-2' }]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    // stdout beyond CRITICAL_RESULT_STDOUT_MAX_BYTES (1 MiB) trips
    // ensureCriticalResultSizeLimits, which is the second way a critical result
    // gets rejected.
    const oversizeStdout = 'x'.repeat(1_048_576 + 16);

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '77777777-7777-4777-8777-777777777777',
        status: 'completed',
        stdout: oversizeStdout,
      })
    } as any, ws as any);

    expect(db.update).toHaveBeenCalled();
    expect(vi.mocked(processBackupVerificationResult)).toHaveBeenCalledTimes(1);
    const [, handed] = vi.mocked(processBackupVerificationResult).mock.calls[0]! as [
      string,
      { status: string; error?: string }
    ];
    expect(handed.status).toBe('failed');
    expect(handed.error).toContain('exceeds');
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

// Task 7 — backup command_result non-terminal guards. Unit coverage for the
// extracted predicates/appliers (isBackupStartedAck, isLegacyBackupTimeoutResult,
// applyBackupStartedAck, tryParseBackupResultPayload) lives in
// backupProgress.test.ts. These tests instead exercise the REAL guard
// placement inside agentWs's orphaned command_result path — a backup job's
// commandId has no device_commands row, so a result for it always resolves
// via processOrphanedCommandResult — proving the started-ack and legacy
// timeout guards return BEFORE consumeDispatchedExpectation runs (so the
// one-shot expectation survives for the real terminal result), while a
// genuine failure or a completed result still falls through to consume it.
describe('backup command_result non-terminal guards (guard ordering integration)', () => {
  const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const backupJobRow = { id: jobId, orgId: 'org-123', deviceId: 'device-123', agentId: 'agent-123' };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('started-ack result bumps lastProgressAt, refreshes the dispatch TTL, and does NOT consume the expectation (job stays in-flight)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any) // device_commands: no row → orphaned path
      .mockReturnValueOnce(selectAgentDevice([]) as any) // discoveryJobs: none
      .mockReturnValueOnce(selectWithInnerJoin([backupJobRow]) as any); // backupJobs: found

    const updateChain = updateResult([{ id: jobId }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);
    vi.mocked(refreshDispatchedExpectation).mockResolvedValue(true);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: jobId,
        status: 'completed',
        result: JSON.stringify({ started: true }),
      })
    } as any, ws as any);

    // applyBackupStartedAck's update only bumps progress/updatedAt — no
    // `status` key — so the (pending|running) job never transitions.
    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).toHaveProperty('lastProgressAt');
    expect(setArg.status).toBeUndefined();

    expect(refreshDispatchedExpectation).toHaveBeenCalledWith('backup', 'device-123', jobId);
    expect(consumeDispatchedExpectation).not.toHaveBeenCalled();
    expect(applyBackupCommandResultToJob).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('started-ack on an already-terminal job is a no-op: does not log the "started-ack" line (FIX 10)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([backupJobRow]) as any);

    // Guarded update matches zero rows → applyBackupStartedAck returns false.
    vi.mocked(db.update).mockReturnValue(updateResult([]) as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: jobId,
        status: 'completed',
        result: JSON.stringify({ started: true }),
      })
    } as any, ws as any);

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('started-ack from agent'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring started-ack for already-terminal backup job'));
    expect(refreshDispatchedExpectation).not.toHaveBeenCalled();
    expect(consumeDispatchedExpectation).not.toHaveBeenCalled();

    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('legacy "command timed out" result is dropped without consuming the expectation or failing the job', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([backupJobRow]) as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: jobId,
        status: 'failed',
        error: 'command timed out after 10m0s',
      })
    } as any, ws as any);

    expect(db.update).not.toHaveBeenCalled();
    expect(consumeDispatchedExpectation).not.toHaveBeenCalled();
    expect(applyBackupCommandResultToJob).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring legacy 10-minute timed-out result'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));

    warnSpy.mockRestore();
  });

  it('a genuine (non-timeout) failure result still consumes the expectation and fails the job', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([backupJobRow]) as any);

    vi.mocked(consumeDispatchedExpectation).mockResolvedValue({ ok: true });
    vi.mocked(applyBackupCommandResultToJob).mockResolvedValue({
      applied: true,
      snapshotDbId: null,
      providerSnapshotId: null,
    });

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: jobId,
        status: 'failed',
        error: 'disk full',
      })
    } as any, ws as any);

    expect(consumeDispatchedExpectation).toHaveBeenCalledWith('backup', 'device-123', jobId);
    expect(applyBackupCommandResultToJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        orgId: 'org-123',
        deviceId: 'device-123',
        resultStatus: 'failed',
      })
    );
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
  });

  it('a completed result still consumes the expectation and completes the job', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectOwnedCommandResult([]) as any)
      .mockReturnValueOnce(selectAgentDevice([]) as any)
      .mockReturnValueOnce(selectWithInnerJoin([backupJobRow]) as any);

    vi.mocked(consumeDispatchedExpectation).mockResolvedValue({ ok: true });
    vi.mocked(applyBackupCommandResultToJob).mockResolvedValue({
      applied: true,
      snapshotDbId: 'snap-db-1',
      providerSnapshotId: 'snap-1',
    });

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: jobId,
        status: 'completed',
        result: JSON.stringify({ snapshotId: 'snap-1', filesBackedUp: 5, bytesBackedUp: 1000 }),
      })
    } as any, ws as any);

    expect(consumeDispatchedExpectation).toHaveBeenCalledWith('backup', 'device-123', jobId);
    expect(applyBackupCommandResultToJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        resultStatus: 'completed',
        result: expect.objectContaining({ snapshotId: 'snap-1' }),
      })
    );
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"ack"'));
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

  it('severs the socket on a heartbeat when the token was suspended after connect', async () => {
    const preValidatedAgent = { deviceId: 'device-s', orgId: 'org-s' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any); // onOpen: register only

    const handlers = createAgentWsHandlers('agent-s', preValidatedAgent);
    const ws = wsMock();
    await handlers.onOpen({}, ws as any);
    vi.mocked(ws.close).mockClear();

    // The heartbeat handler re-checks the device lifecycle row: a suspended
    // token (org/partner tenant suspension denormalizes here) severs the socket.
    vi.mocked(db.select).mockReturnValue(
      selectAgentDevice([{ id: 'device-s', status: 'online', agentTokenSuspendedAt: new Date() }]) as any
    );

    await handlers.onMessage({
      data: JSON.stringify({ type: 'heartbeat', timestamp: 123 }),
    } as any, ws as any);

    expect(ws.close).toHaveBeenCalledWith(4001, 'Device no longer authorized');
  });

  it('severs the socket on a heartbeat when the device was decommissioned after connect', async () => {
    const preValidatedAgent = { deviceId: 'device-d', orgId: 'org-d' };
    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any); // onOpen: register only

    const handlers = createAgentWsHandlers('agent-d', preValidatedAgent);
    const ws = wsMock();
    await handlers.onOpen({}, ws as any);
    vi.mocked(ws.close).mockClear();
    vi.mocked(db.update).mockClear();

    vi.mocked(db.select).mockReturnValue(
      selectAgentDevice([{ id: 'device-d', status: 'decommissioned', agentTokenSuspendedAt: null }]) as any
    );

    await handlers.onMessage({
      data: JSON.stringify({ type: 'heartbeat', timestamp: 123 }),
    } as any, ws as any);

    expect(ws.close).toHaveBeenCalledWith(4001, 'Device no longer authorized');
    // Severed BEFORE the status write — a contained device must not be
    // flipped back online by its own heartbeat.
    expect(db.update).not.toHaveBeenCalled();
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

  it('redacts a PEM private key from stdout, stderr, AND error before persistence (#2419)', async () => {
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
        status: 'failed',
        exitCode: 1,
        stdout: `key follows:\n${pem}\nend`,
        stderr: `warning, leaked key:\n${pem}`,
        error: `command failed while handling key:\n${pem}`,
      }),
    } as any, ws as any);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const stored = setSpy.mock.calls[0]![0] as {
      result: { stdout: string; stderr: string; error: string };
    };
    for (const field of ['stdout', 'stderr', 'error'] as const) {
      expect(stored.result[field]).toContain('[PRIVATE_KEY_REDACTED]');
      expect(stored.result[field]).not.toContain('BEGIN RSA PRIVATE KEY');
    }
  });
});

// Regression for #2407: pending commands must never be claimed into agent WS
// frames. No agent version has ever parsed `pendingCommands` out of the
// `connected` welcome frame or `commands` out of `heartbeat_ack` (the agent's
// readPump skips ID-less frames), so a WS-side claim marked rows 'sent' that
// were never delivered or executed — they sat falsely 'sent' until the stale
// command reaper flipped them to 'failed' with a misleading agent-timeout
// error. Commands must stay 'pending' for the HTTP heartbeat claim and
// executeCommand's direct per-command push.
describe('WS frames never claim pending commands (#2407)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('onOpen sends the welcome frame without pendingCommands and claims nothing', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onOpen({}, ws as any);

    expect(claimPendingCommandsForDevice).not.toHaveBeenCalled();
    const payload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0] as string);
    expect(payload.type).toBe('connected');
    expect(payload).not.toHaveProperty('pendingCommands');
  });

  it('heartbeat_ack always carries an empty commands array and claims nothing', async () => {
    const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123' };

    vi.mocked(db.update).mockReturnValue(updateResult() as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);

    const handlers = createAgentWsHandlers('agent-123', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({ type: 'heartbeat', timestamp: 1234567890 }),
    } as any, ws as any);

    expect(claimPendingCommandsForDevice).not.toHaveBeenCalled();
    const ack = vi.mocked(ws.send).mock.calls
      .map(call => JSON.parse(call[0] as string))
      .find(frame => frame.type === 'heartbeat_ack');
    expect(ack).toBeDefined();
    expect(ack!.commands).toEqual([]);
  });
});

// #2434 — agent-supplied error/output strings persisted OUTSIDE device_commands
// must be redacted too (script_executions, tunnel_sessions, remote_sessions).
describe('#2434 — secret redaction on non-device_commands persistence surfaces', () => {
  const pem2434 =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('redacts stdout/stderr/errorMessage persisted to script_executions', async () => {
    const preValidatedAgent = { deviceId: 'device-se', orgId: 'org-se' };
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      { id: 'cmd-se', type: 'script', payload: { executionId: 'exec-1' }, deviceId: 'device-se' },
    ]) as any);

    // 1st update: device_commands terminal transition. 2nd: script_executions.
    const scriptSetSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'exec-1', scriptId: 'script-1' }]),
      }),
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(updateResult([{ id: 'cmd-se' }]) as any)
      .mockReturnValueOnce({ set: scriptSetSpy } as any);

    const handlers = createAgentWsHandlers('agent-se', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '99999999-9999-4999-8999-999999999999',
        status: 'failed',
        exitCode: 1,
        stdout: `out with key:\n${pem2434}`,
        stderr: `err with key:\n${pem2434}`,
        error: `boom with key:\n${pem2434}`,
      }),
    } as any, ws as any);

    expect(scriptSetSpy).toHaveBeenCalledTimes(1);
    const stored = scriptSetSpy.mock.calls[0]![0] as {
      stdout: string; stderr: string; errorMessage: string;
    };
    for (const field of ['stdout', 'stderr', 'errorMessage'] as const) {
      expect(stored[field]).toContain('[PRIVATE_KEY_REDACTED]');
      expect(stored[field]).not.toContain('BEGIN RSA PRIVATE KEY');
    }
  });

  it('redacts tunnel_sessions.errorMessage on a failed tun-open result (orphaned-path chokepoint)', async () => {
    const preValidatedAgent = { deviceId: 'device-tn', orgId: 'org-tn' };
    const tunnelSetSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'tunnel1', deviceId: 'device-tn' }]),
      }),
    });
    vi.mocked(db.update).mockReturnValue({ set: tunnelSetSpy } as any);

    const handlers = createAgentWsHandlers('agent-tn', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'tun-open-tunnel1',
        status: 'failed',
        error: `tunnel bind failed, key follows:\n${pem2434}`,
      }),
    } as any, ws as any);

    expect(tunnelSetSpy).toHaveBeenCalledTimes(1);
    const stored = tunnelSetSpy.mock.calls[0]![0] as { errorMessage: string };
    expect(stored.errorMessage).toContain('[PRIVATE_KEY_REDACTED]');
    expect(stored.errorMessage).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('hands per-type handlers a redacted result — pins the processCommandResult chokepoint', async () => {
    // Regression guard for the chokepoint itself. Several downstream handlers
    // (CIS failure branch, software-remediation audit) persist agent error text
    // that ONLY this call redacts on the WS leg. Without this test, deleting the
    // chokepoint leaves every other suite green while raw key material lands in
    // cis_baseline_results. `backup_verify` is the probe: its handler is mocked,
    // so we can assert exactly what the dispatch handed it.
    const preValidatedAgent = { deviceId: 'device-ck', orgId: 'org-ck' };
    vi.mocked(db.select).mockReturnValueOnce(selectOwnedCommandResult([
      { id: 'cmd-ck', type: 'backup_verify', payload: {}, deviceId: 'device-ck' },
    ]) as any);
    vi.mocked(db.update).mockReturnValue(updateResult([{ id: 'cmd-ck' }]) as any);

    const handlers = createAgentWsHandlers('agent-ck', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: '99999999-9999-4999-8999-999999999999',
        status: 'failed',
        exitCode: 1,
        error: `verify failed, key follows:\n${pem2434}`,
        stderr: `stderr, key follows:\n${pem2434}`,
      }),
    } as any, ws as any);

    expect(processBackupVerificationResult).toHaveBeenCalledTimes(1);
    const handed = vi.mocked(processBackupVerificationResult).mock.calls[0]![1] as {
      error?: string;
    };
    expect(handed.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(JSON.stringify(handed)).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('redacts remote_sessions.errorMessage on a failed desk-start result (fast path)', async () => {
    const preValidatedAgent = { deviceId: 'device-rs', orgId: 'org-rs' };
    const sessionSetSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'sess1' }]),
      }),
    });
    vi.mocked(db.update).mockReturnValue({ set: sessionSetSpy } as any);

    const handlers = createAgentWsHandlers('agent-rs', preValidatedAgent);
    const ws = wsMock();

    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: 'desk-start-sess1',
        status: 'failed',
        error: `capture init failed, key follows: ${pem2434}`,
      }),
    } as any, ws as any);

    expect(sessionSetSpy).toHaveBeenCalledTimes(1);
    const stored = sessionSetSpy.mock.calls[0]![0] as { errorMessage: string };
    expect(stored.errorMessage).toContain('[PRIVATE_KEY_REDACTED]');
    expect(stored.errorMessage).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});
