import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const selectMock = vi.fn();
const updateMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
const updateRestoreJobByCommandIdMock = vi.fn().mockResolvedValue(true);
const claimPendingCommandsForDeviceMock = vi.fn();

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
    targetRole: 'device_commands.target_role',
    payload: 'device_commands.payload',
  },
  devices: {
    id: 'devices.id',
    agentId: 'devices.agent_id',
  },
  deploymentResults: {
    deploymentId: 'deployment_results.deployment_id',
    deviceId: 'deployment_results.device_id',
    status: 'deployment_results.status',
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

vi.mock('../../services/commandDispatch', () => ({
  claimPendingCommandsForDevice: (...args: unknown[]) => claimPendingCommandsForDeviceMock(...(args as [])),
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
  // 64-char SHA-256 hex — matches the production agent ID format (cfg.AgentID).
  // Using a UUID here previously hid the bug fixed in PR #435 where the route's
  // param schema rejected anything that wasn't a UUID.
  const agentId = 'ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776';
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
        role: 'agent',
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

  it('claims commands for the authenticated credential role only', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([
      {
        id: commandId,
        type: 'run_script',
        payload: { scriptId: 'script-1' },
      },
    ]);

    const res = await app.request(`/agents/${agentId}/commands?role=watchdog`, {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'agent');
    await expect(res.json()).resolves.toEqual({
      commands: [
        {
          id: commandId,
          type: 'run_script',
          payload: { scriptId: 'script-1' },
        },
      ],
    });
  });

  // A complete, well-formed PEM private-key block (header + base64 body +
  // footer). The base64 body must survive verbatim if redaction fails, so we
  // assert the body marker is gone after ingest.
  const PRIVATE_KEY_BLOCK = [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDexampleAAAA1234',
    'BODYb64lineTwoZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ567890',
    '-----END PRIVATE KEY-----',
  ].join('\n');

  it('redacts private-key blocks from stdout, stderr, AND error before persisting the command result', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'run_script',
          status: 'sent',
          targetRole: 'agent',
        },
      ])
    );
    const updateChain = chainMock([{ id: 'cmd-1' }]);
    updateMock.mockReturnValueOnce(updateChain);

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        status: 'completed',
        exitCode: 0,
        stdout: `stdout-pre ${PRIVATE_KEY_BLOCK} stdout-post`,
        stderr: `stderr-pre ${PRIVATE_KEY_BLOCK} stderr-post`,
        error: `error-pre ${PRIVATE_KEY_BLOCK} error-post`,
      }),
    });

    expect(res.status).toBe(200);

    // Assert on exactly what is handed to db.update(...).set(...).
    const stored = updateChain.set.mock.calls[0][0];
    expect(stored.result.stdout).toBe('stdout-pre [PRIVATE_KEY_REDACTED] stdout-post');
    expect(stored.result.stderr).toBe('stderr-pre [PRIVATE_KEY_REDACTED] stderr-post');
    expect(stored.result.error).toBe('error-pre [PRIVATE_KEY_REDACTED] error-post');

    // No fragment of the key (header, footer, or base64 body) survives anywhere
    // in the persisted result object.
    const serialized = JSON.stringify(stored.result);
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain('END PRIVATE KEY');
    expect(serialized).not.toContain('MIIEvQ');
    expect(serialized).not.toContain('BODYb64lineTwo');
  });

  it('stores capture_pprof stdout byte-for-byte (secret redaction would corrupt the base64 profiles, #2401)', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'capture_pprof',
          status: 'sent',
          targetRole: 'agent',
        },
      ])
    );
    const updateChain = chainMock([{ id: 'cmd-1' }]);
    updateMock.mockReturnValueOnce(updateChain);

    // Base64 profile payload containing substrings the redaction patterns
    // fire on (case-insensitive AKIA + 16 alnum; token=...). In random
    // base64 these occur by chance roughly once per ~MB — redaction would
    // silently corrupt the gzip protobuf.
    const pprofStdout = JSON.stringify({
      capturedAt: '2026-07-12T10:00:00Z',
      heapProfileBase64: `QUJDakiAABCDEF1234567890abToken=abcdefgh12345678REVG${'Zm9v'.repeat(100)}`,
      heapProfileBytes: 4096,
    });

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        status: 'completed',
        exitCode: 0,
        stdout: pprofStdout,
        stderr: `stderr-pre ${PRIVATE_KEY_BLOCK} stderr-post`,
      }),
    });

    expect(res.status).toBe(200);

    const stored = updateChain.set.mock.calls[0][0];
    // stdout is the artifact channel — byte-for-byte.
    expect(stored.result.stdout).toBe(pprofStdout);
    // stderr is NOT exempt.
    expect(stored.result.stderr).toBe('stderr-pre [PRIVATE_KEY_REDACTED] stderr-post');
  });

  it('redacts private-key blocks from the software-install deployment result path', async () => {
    // sw-install commandId embeds deployment + device UUIDs; the device UUID
    // must equal the authenticated agent's deviceId for the update to fire.
    const deploymentUuid = '11111111-1111-4111-8111-111111111111';
    const deviceUuid = '33333333-3333-4333-8333-333333333333';
    const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}`;

    const swApp = new Hono();
    swApp.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: deviceUuid,
        agentId: 'agent-1',
        orgId: 'org-1',
        siteId: 'site-1',
        role: 'agent',
      });
      await next();
    });
    swApp.route('/agents', commandsRoutes);

    const updateChain = chainMock([]);
    updateMock.mockReturnValueOnce(updateChain);

    const res = await swApp.request(`/agents/${agentId}/commands/${swCommandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId: swCommandId,
        status: 'completed',
        exitCode: 0,
        stdout: `install-log ${PRIVATE_KEY_BLOCK} done`,
        error: `install-error ${PRIVATE_KEY_BLOCK} boom`,
      }),
    });

    expect(res.status).toBe(200);

    // deployment_results is never queried via selectMock on this path.
    expect(selectMock).not.toHaveBeenCalled();
    const stored = updateChain.set.mock.calls[0][0];
    expect(stored.output).toBe('install-log [PRIVATE_KEY_REDACTED] done');
    expect(stored.errorMessage).toBe('install-error [PRIVATE_KEY_REDACTED] boom');

    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain('MIIEvQ');
    expect(serialized).not.toContain('BODYb64lineTwo');
  });

  it('rejects normal agent results for watchdog-targeted commands', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'update_agent',
          status: 'sent',
          targetRole: 'watchdog',
        },
      ])
    );

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        result: { updated_to: '1.2.3' },
      }),
    });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
