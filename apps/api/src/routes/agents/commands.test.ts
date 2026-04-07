import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const selectMock = vi.fn();
const updateMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
const updateRestoreJobByCommandIdMock = vi.fn().mockResolvedValue(true);

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) => runOutsideDbContextMock(...(args as [any])),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  deviceCommands: {
    id: 'device_commands.id',
    deviceId: 'device_commands.device_id',
    type: 'device_commands.type',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
  },
  devices: {
    id: 'devices.id',
    agentId: 'devices.agent_id',
  },
}));

vi.mock('../../services/restoreResultPersistence', () => ({
  updateRestoreJobByCommandId: (...args: unknown[]) => updateRestoreJobByCommandIdMock(...(args as [])),
}));

vi.mock('../backup/verificationService', () => ({
  processBackupVerificationResult: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../../services/vaultSyncPersistence', () => ({
  applyVaultSyncCommandResult: vi.fn(),
}));

vi.mock('./helpers', () => ({
  handleSecurityCommandResult: vi.fn(),
  handleFilesystemAnalysisCommandResult: vi.fn(),
  handleSensitiveDataCommandResult: vi.fn(),
  handleSoftwareRemediationCommandResult: vi.fn(),
  handleCisCommandResult: vi.fn(),
}));

vi.mock('../../services/auditBaselineService', () => ({
  processCollectedAuditPolicyCommandResult: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { commandsRoutes } from './commands';

describe('agent commands routes', () => {
  let app: Hono;
  const agentId = '11111111-1111-4111-8111-111111111111';
  const commandId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: 'device-1',
        agentId: 'agent-1',
        orgId: 'org-1',
        siteId: 'site-1',
      });
      await next();
    });
    app.route('/agents', commandsRoutes);
  });

  it.each(['backup_restore', 'bmr_recover'] as const)(
    'reconciles %s results through the HTTP result path',
    async (commandType) => {
      selectMock.mockReturnValueOnce(
        chainMock([
          {
            id: commandId,
            deviceId: 'device-1',
            type: commandType,
            status: 'sent',
          },
        ])
      );
      updateMock.mockReturnValueOnce(
        chainMock([
          {
            id: 'cmd-1',
          },
        ])
      );

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          status: 'completed',
          result: {
            status: 'completed',
            filesRestored: 3,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(updateRestoreJobByCommandIdMock).toHaveBeenCalledWith({
        commandId,
        deviceId: 'device-1',
        commandType,
        result: expect.objectContaining({
          status: 'completed',
        }),
      });
    }
  );
});
