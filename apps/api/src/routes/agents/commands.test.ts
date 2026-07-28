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
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'agent', undefined);
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

  // #2774 — during an offboarding drain the poll claims self_uninstall only.
  it('narrows the claim to self_uninstall when the tenant is draining', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([]);

    const drainApp = new Hono();
    drainApp.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: 'device-1',
        agentId: 'agent-1',
        orgId: 'org-1',
        siteId: 'site-1',
        role: 'agent',
        tenantDraining: true,
      });
      await next();
    });
    drainApp.route('/agents', commandsRoutes);

    const res = await drainApp.request(`/agents/${agentId}/commands`, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith(
      'device-1',
      10,
      'agent',
      ['self_uninstall']
    );
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

  // Offline-fallback path: the install command was queued as a device_commands
  // row (UUID id), so the result flows through the UUID branch and must ALSO
  // reconcile the matching deployment_results row via the payload deploymentId.
  describe('queued software_install result reconciliation', () => {
    const deploymentUuid = '44444444-4444-4444-8444-444444444444';

    function swInstallCommandRow(overrides: Record<string, unknown> = {}) {
      return {
        id: commandId,
        deviceId: 'device-1',
        type: 'software_install',
        status: 'sent',
        targetRole: 'agent',
        payload: { deploymentId: deploymentUuid, downloadUrl: 'https://dl/pkg.exe' },
        ...overrides,
      };
    }

    it('updates both device_commands and deployment_results for a queued install result', async () => {
      selectMock.mockReturnValueOnce(chainMock([swInstallCommandRow()]));
      const deviceCommandsChain = chainMock([{ id: commandId }]);
      const deploymentResultsChain = chainMock([]);
      updateMock
        .mockReturnValueOnce(deviceCommandsChain)
        .mockReturnValueOnce(deploymentResultsChain);

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          status: 'completed',
          exitCode: 0,
          stdout: 'installed',
          durationMs: 12_000,
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });

      // device_commands terminal write happened…
      const cmdStored = deviceCommandsChain.set.mock.calls[0][0];
      expect(cmdStored.status).toBe('completed');

      // …and the deployment_results row was reconciled with the shared mapping.
      const drStored = deploymentResultsChain.set.mock.calls[0][0];
      expect(drStored.status).toBe('completed');
      expect(drStored.exitCode).toBe(0);
      expect(drStored.output).toBe('installed');
      expect(drStored.completedAt).toBeInstanceOf(Date);
      // startedAt reconstructed from durationMs.
      expect(drStored.completedAt.getTime() - drStored.startedAt.getTime()).toBe(12_000);
    });

    it('maps a completed result with non-zero exit code to a failed deployment_results row', async () => {
      selectMock.mockReturnValueOnce(chainMock([swInstallCommandRow()]));
      const deviceCommandsChain = chainMock([{ id: commandId }]);
      const deploymentResultsChain = chainMock([]);
      updateMock
        .mockReturnValueOnce(deviceCommandsChain)
        .mockReturnValueOnce(deploymentResultsChain);

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          status: 'completed',
          exitCode: 1603,
          stderr: 'msi fatal error',
        }),
      });

      expect(res.status).toBe(200);
      const drStored = deploymentResultsChain.set.mock.calls[0][0];
      expect(drStored.status).toBe('failed');
      expect(drStored.exitCode).toBe(1603);
      expect(drStored.errorMessage).toBe('msi fatal error');
    });

    it('is a no-op on a second result delivery (device_commands already terminal)', async () => {
      selectMock.mockReturnValueOnce(chainMock([swInstallCommandRow({ status: 'completed' })]));

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          status: 'completed',
          exitCode: 0,
        }),
      });

      // Route accepts the replay but writes nothing — neither device_commands
      // nor deployment_results.
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('skips deployment_results reconciliation when the payload has no deploymentId', async () => {
      selectMock.mockReturnValueOnce(chainMock([swInstallCommandRow({ payload: {} })]));
      updateMock.mockReturnValueOnce(chainMock([{ id: commandId }]));

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId,
          status: 'completed',
          exitCode: 0,
        }),
      });

      expect(res.status).toBe(200);
      // Only the device_commands terminal write — no deployment_results update.
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
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

  it('hands per-type post-processing handlers redacted error/stderr (#2434 chokepoint)', async () => {
    const { processBackupVerificationResult } = await import('../backup/verificationService');
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'backup_verify',
          status: 'sent',
          targetRole: 'agent',
        },
      ])
    );
    updateMock.mockReturnValueOnce(chainMock([{ id: 'cmd-1' }]));

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        status: 'failed',
        exitCode: 1,
        error: `verify failed ${PRIVATE_KEY_BLOCK} end`,
        stderr: `stderr ${PRIVATE_KEY_BLOCK} end`,
      }),
    });

    expect(res.status).toBe(200);
    expect(processBackupVerificationResult).toHaveBeenCalledTimes(1);
    const handlerArg = vi.mocked(processBackupVerificationResult).mock.calls[0]![1] as {
      error?: string;
    };
    expect(handlerArg.error).toBe('verify failed [PRIVATE_KEY_REDACTED] end');
    expect(JSON.stringify(handlerArg)).not.toContain('BEGIN PRIVATE KEY');
  });
});
