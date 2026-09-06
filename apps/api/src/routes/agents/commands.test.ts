import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #3409 PR4a: sealing a secret envelope requires v3 (AAD-bound) encryption,
// which only happens when a key id and keyring are configured.
process.env.APP_ENCRYPTION_KEY_ID = 'current';
process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material' });

const selectMock = vi.fn();
const updateMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
// Tracks whether we are currently INSIDE the route's explicit system context.
// This route is self-managed-context (middleware/agentAuth leaves none behind
// on the REST paths), so anything touching the DB must run inside it.
let insideSystemDbContext = false;
const withSystemDbAccessContextMock = vi.fn(async (fn: () => any) => {
  const prior = insideSystemDbContext;
  insideSystemDbContext = true;
  try {
    return await fn();
  } finally {
    insideSystemDbContext = prior;
  }
});
const updateRestoreJobByCommandIdMock = vi.fn().mockResolvedValue(true);
const claimPendingCommandsForDeviceMock = vi.fn();
const applyCommandAutomationTerminalMock = vi.fn().mockResolvedValue(true);
const consumePamReconciliationRateLimitMock = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 119,
  resetAt: new Date('2026-08-26T12:01:00.000Z'),
});

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
  withSystemDbAccessContext: (...args: unknown[]) =>
    withSystemDbAccessContextMock(...(args as [any])),
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
    id: 'deployment_results.id',
    deploymentId: 'deployment_results.deployment_id',
    deviceId: 'deployment_results.device_id',
    status: 'deployment_results.status',
    retryCount: 'deployment_results.retry_count',
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
  releaseClaimedCommandDelivery: vi.fn(async () => undefined),
}));

// #3409 PR4c-2 — the secret-delivery claim gate. `services/commandDelivery`
// itself runs for real here (that is the point of the route-level test); only
// the gate's DB work is stubbed. The stub records the context it was called
// in, and models a capability-0 device by withholding envelope-bearing script
// commands — its real terminal-write behavior has its own suite in
// services/scriptSecretDelivery.test.ts.
const secretGateContexts: boolean[] = [];
let secretGateWithholds = false;
const failClaimedSecretCommandsMock = vi.fn(async (claimed: any[]) => {
  secretGateContexts.push(insideSystemDbContext);
  return secretGateWithholds
    ? claimed.filter(
        (cmd) => !(cmd.type === 'script' && typeof cmd.payload?.secretEnvEnvelope === 'string'),
      )
    : claimed;
});
vi.mock('../../services/scriptSecretDelivery', () => ({
  failClaimedSecretCommandsForUnsupportedAgent: (...args: unknown[]) =>
    failClaimedSecretCommandsMock(...(args as [any])),
}));

vi.mock('../../services/vaultSyncPersistence', () => ({
  applyVaultSyncCommandResult: vi.fn(),
}));

vi.mock('../../services/automationTerminalEvidence', () => ({
  applyCommandAutomationTerminal: (...args: unknown[]) =>
    applyCommandAutomationTerminalMock(...(args as [])),
}));

vi.mock('../../services/automationActionResults', () => ({
  applyAutomationActionTerminal: vi.fn().mockResolvedValue(true),
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

// #3097 — the shared registry this route now dispatches for the handful of
// types it never post-processed inline. `cis_benchmark` is present here on
// purpose: it is one of the thirteen keys this route DOES handle inline, so its
// mock existing proves the route skips the registry by intent rather than
// because the handler happened to be missing.
const scriptRegistryHandlerMock = vi.fn().mockResolvedValue(undefined);
const peripheralV2RegistryHandlerMock = vi.fn().mockResolvedValue(undefined);
const pamRegistryHandlerMock = vi.fn().mockResolvedValue({ kind: 'pam', classification: 'applied' });
const cisRegistryHandlerMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/commandResultHandlers', () => ({
  commandResultHandlers: {
    script: (...args: unknown[]) => scriptRegistryHandlerMock(...(args as [])),
    peripheral_policy_sync_v2: (...args: unknown[]) => peripheralV2RegistryHandlerMock(...(args as [])),
    pam_apply_v2: (...args: unknown[]) => pamRegistryHandlerMock(...(args as [])),
    pam_cleanup_v2: (...args: unknown[]) => pamRegistryHandlerMock(...(args as [])),
    cis_benchmark: (...args: unknown[]) => cisRegistryHandlerMock(...(args as [])),
  },
}));

vi.mock('../../services/pamReconciliationRateLimit', () => ({
  consumePamReconciliationRateLimit: (...args: unknown[]) =>
    consumePamReconciliationRateLimitMock(...(args as [])),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
  // BREEZE-X: the terminal CAS now runs through dbWriteExpectingRows, which
  // calls captureMessage on the 0-row branch. Omitting it here would fail the
  // whole route with "captureMessage is not a function".
  captureMessage: vi.fn(),
}));

import { captureMessage } from '../../services/sentry';
import { handleCisCommandResult } from './helpers';
import { commandsRoutes } from './commands';
import { and, eq } from 'drizzle-orm';
import { deploymentResults } from '../../db/schema';
import { encryptSensitivePayloadFields } from '../../services/sensitiveCommandPayload';

describe('agent commands routes', () => {
  let app: Hono;
  // 64-char SHA-256 hex — matches the production agent ID format (cfg.AgentID).
  // Using a UUID here previously hid the bug fixed in PR #435 where the route's
  // param schema rejected anything that wasn't a UUID.
  const agentId = 'ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776';
  const commandId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    secretGateContexts.length = 0;
    secretGateWithholds = false;
    insideSystemDbContext = false;
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: 'device-1',
        agentId: 'agent-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
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

  // #3097 — a script result submitted over HTTP used to reach no per-type
  // handler at all, so script_executions kept whatever status the reaper had
  // written while the real output sat in device_commands.result.
  it('dispatches a script result to the shared handler over the HTTP path', async () => {
    const command = {
      id: commandId,
      deviceId: 'device-1',
      type: 'script',
      status: 'sent',
      payload: { executionId: '33333333-3333-4333-8333-333333333333' },
    };
    selectMock.mockReturnValueOnce(chainMock([command]));
    updateMock.mockReturnValueOnce(chainMock([{ id: 'cmd-1' }]));

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandId,
        status: 'completed',
        exitCode: 0,
        stdout: 'hello from the script',
      }),
    });

    expect(res.status).toBe(200);
    expect(scriptRegistryHandlerMock).toHaveBeenCalledTimes(1);
    expect(scriptRegistryHandlerMock).toHaveBeenCalledWith({
      agentId: 'agent-1',
      command: expect.objectContaining({ id: commandId, type: 'script' }),
      // The id comes from the authorized path param, never the request body.
      commandId,
      result: expect.objectContaining({ status: 'completed', exitCode: 0 }),
      resolvedDeviceId: 'device-1',
      stdout: 'hello from the script',
    });
    expect(applyCommandAutomationTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      commandId,
      result: expect.objectContaining({ status: 'completed', exitCode: 0 }),
      output: 'hello from the script',
    }));
  });

  it('dispatches a peripheral v2 result to the shared handler over the HTTP path', async () => {
    const command = {
      id: commandId,
      deviceId: 'device-1',
      type: 'peripheral_policy_sync_v2',
      status: 'sent',
      payload: {},
    };
    selectMock.mockReturnValueOnce(chainMock([command]));
    updateMock.mockReturnValueOnce(chainMock([{ id: commandId }]));

    const protocolResult = {
      schemaVersion: 2,
      phase: 'clear_legacy',
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      outcome: 'applied',
    };
    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
    });

    expect(res.status).toBe(200);
    expect(peripheralV2RegistryHandlerMock).toHaveBeenCalledWith(expect.objectContaining({
      command,
      commandId,
      resolvedDeviceId: 'device-1',
      result: expect.objectContaining({ result: protocolResult }),
    }));
  });

  it.each(['pam_apply_v2', 'pam_cleanup_v2'])(
    'dispatches %s results to the shared handler over the HTTP path',
    async (commandType) => {
      const command = { id: commandId, deviceId: 'device-1', type: commandType, status: 'sent', payload: {} };
      selectMock.mockReturnValueOnce(chainMock([command]));
      updateMock.mockReturnValueOnce(chainMock([{ id: commandId }]));
      const protocolResult = {
        protocolVersion: 2,
        observationId: '11111111-1111-4111-8111-111111111111',
        actuationId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        state: 'received',
        observedAt: '2026-08-25T12:00:00.000Z',
        evidence: { bootId: 'boot-1' },
      };
      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ protocolVersion: 1, classification: 'applied' });
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(pamRegistryHandlerMock).toHaveBeenCalledWith(expect.objectContaining({
        command, commandId, resolvedDeviceId: 'device-1',
        result: expect.objectContaining({ result: protocolResult }),
      }));
      expect(consumePamReconciliationRateLimitMock).not.toHaveBeenCalled();
    },
  );

  it.each(['pam_apply_v2', 'pam_cleanup_v2'])(
    'accepts a valid supplemental %s result for a terminal row without rewriting it',
    async (commandType) => {
      const command = {
        id: commandId,
        deviceId: 'device-1',
        type: commandType,
        status: 'completed',
        targetRole: 'agent',
        payload: null,
        result: { status: 'completed', result: { retained: true } },
        completedAt: new Date('2026-08-25T12:00:00.000Z'),
      };
      const before = structuredClone(command);
      selectMock.mockReturnValueOnce(chainMock([command]));
      const protocolResult = {
        protocolVersion: 2,
        observationId: '11111111-1111-4111-8111-111111111111',
        actuationId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        state: commandType === 'pam_apply_v2' ? 'verified_active' : 'cleaned',
        observedAt: '2026-08-25T12:00:00.000Z',
        evidence: { bootId: 'boot-1' },
      };

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ protocolVersion: 1, classification: 'applied' });
      expect(consumePamReconciliationRateLimitMock).toHaveBeenCalledWith('device-1');
      expect(pamRegistryHandlerMock).toHaveBeenCalledTimes(1);
      expect(pamRegistryHandlerMock).toHaveBeenCalledWith(expect.objectContaining({
        command,
        commandId,
        resolvedDeviceId: 'device-1',
        result: expect.objectContaining({ result: protocolResult }),
      }));
      expect(updateMock).not.toHaveBeenCalled();
      expect(command).toEqual(before);
    },
  );

  it('preserves the terminal short circuit for malformed PAM results', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: commandId,
      deviceId: 'device-1',
      type: 'pam_apply_v2',
      status: 'completed',
      targetRole: 'agent',
      payload: { retained: true },
      result: { status: 'completed' },
    }]));

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', result: { protocolVersion: 2 } }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(consumePamReconciliationRateLimitMock).not.toHaveBeenCalled();
    expect(pamRegistryHandlerMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rate-limits valid supplemental terminal PAM results by authenticated device', async () => {
    consumePamReconciliationRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-08-26T12:01:00.000Z'),
    });
    selectMock.mockReturnValueOnce(chainMock([{
      id: commandId,
      deviceId: 'device-1',
      type: 'pam_apply_v2',
      status: 'completed',
      targetRole: 'agent',
      payload: {},
      result: { status: 'completed' },
    }]));
    const protocolResult = {
      protocolVersion: 2,
      observationId: '11111111-1111-4111-8111-111111111111',
      actuationId: '22222222-2222-4222-8222-222222222222',
      generation: 2,
      state: 'verified_active',
      observedAt: '2026-08-25T12:00:00.000Z',
      evidence: { bootId: 'boot-1' },
    };

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
    });

    expect(res.status).toBe(429);
    expect(consumePamReconciliationRateLimitMock).toHaveBeenCalledWith('device-1');
    expect(pamRegistryHandlerMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('treats a server-timeout PAM row as terminal supplemental evidence without rewriting it', async () => {
    const command = {
      id: commandId,
      deviceId: 'device-1',
      type: 'pam_apply_v2',
      status: 'failed',
      targetRole: 'agent',
      payload: { retained: true },
      result: { status: 'timeout', retained: true },
      completedAt: new Date('2026-08-25T12:00:00.000Z'),
    };
    selectMock.mockReturnValueOnce(chainMock([command]));
    const protocolResult = {
      protocolVersion: 2,
      observationId: '11111111-1111-4111-8111-111111111111',
      actuationId: '22222222-2222-4222-8222-222222222222',
      generation: 2,
      state: 'verified_active',
      observedAt: '2026-08-25T12:00:00.000Z',
      evidence: { bootId: 'boot-1' },
    };

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ protocolVersion: 1, classification: 'applied' });
    expect(consumePamReconciliationRateLimitMock).toHaveBeenCalledWith('device-1');
    expect(pamRegistryHandlerMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('preserves the terminal short circuit for non-PAM commands', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: commandId,
      deviceId: 'device-1',
      type: 'script',
      status: 'completed',
      targetRole: 'agent',
      payload: {},
      result: { status: 'completed' },
    }]));

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', stdout: 'late' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(consumePamReconciliationRateLimitMock).not.toHaveBeenCalled();
    expect(scriptRegistryHandlerMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns no acknowledgement when terminal PAM persistence throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pamRegistryHandlerMock.mockRejectedValueOnce(new Error('PAM persistence unavailable'));
    selectMock.mockReturnValueOnce(chainMock([{
      id: commandId,
      deviceId: 'device-1',
      type: 'pam_apply_v2',
      status: 'completed',
      targetRole: 'agent',
      payload: {},
      result: { status: 'completed' },
    }]));
    const protocolResult = {
      protocolVersion: 2,
      observationId: '11111111-1111-4111-8111-111111111111',
      actuationId: '22222222-2222-4222-8222-222222222222',
      generation: 2,
      state: 'verified_active',
      observedAt: '2026-08-25T12:00:00.000Z',
      evidence: { bootId: 'boot-1' },
    };

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', result: protocolResult }),
    });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('"protocolVersion":1');
    expect(updateMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // The other half of the contract: types this route already post-processes
  // inline must NOT also go through the registry, or every one of them would
  // run twice.
  it('does not re-dispatch a type it already handles inline', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'cis_benchmark',
          status: 'sent',
        },
      ])
    );
    updateMock.mockReturnValueOnce(chainMock([{ id: 'cmd-1' }]));

    const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId, status: 'completed', stdout: '{}' }),
    });

    expect(res.status).toBe(200);
    expect(cisRegistryHandlerMock).not.toHaveBeenCalled();
    // …and the inline path is what actually ran.
    expect(vi.mocked(handleCisCommandResult)).toHaveBeenCalledTimes(1);
  });

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
        partnerId: 'partner-1',
        siteId: 'site-1',
        role: 'agent',
        tenantDraining: true,
        // #3986 — derived ONCE by agentAuthMiddleware; every claim site reads
        // it instead of restating the literal, so the harness must mirror the
        // real context shape.
        claimTypeAllowlist: ['self_uninstall'] as const,
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

  // #3409 PR4c-2 — the claim gate reads `devices` (RLS) and drives offending
  // device_commands/script_executions rows terminal, so it MUST run inside the
  // route's own system context. Calling it after the claim closure returned
  // would make those contextless bare-pool queries (#1375).
  it('runs the secret-delivery claim gate inside the route system db context', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([
      { id: commandId, type: 'run_script', deviceId: 'device-1', payload: { scriptId: 'script-1' } },
    ]);

    const res = await app.request(`/agents/${agentId}/commands`, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(failClaimedSecretCommandsMock).toHaveBeenCalledTimes(1);
    expect(secretGateContexts).toEqual([true]);
    // …and the whole thing still ran outside any inherited request context.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
  });

  it('withholds an envelope-bearing command from the poll response when the agent cannot open it', async () => {
    secretGateWithholds = true;
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([
      {
        id: commandId,
        type: 'script',
        deviceId: 'device-1',
        payload: { scriptId: 'script-1', executionId: 'exec-1', secretEnvEnvelope: 'enc:v3:key-1:ciphertext' },
      },
      { id: 'cmd-sibling', type: 'run_script', deviceId: 'device-1', payload: { scriptId: 'script-2' } },
    ]);

    const res = await app.request(`/agents/${agentId}/commands`, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Array<{ id: string }> };
    // The secret-bearing command is gone; its sibling still delivers.
    expect(body.commands.map((cmd) => cmd.id)).toEqual(['cmd-sibling']);
    expect(JSON.stringify(body)).not.toContain('secretEnvEnvelope');
    expect(secretGateContexts).toEqual([true]);
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

  // #3409 PR4a — REST twin of the WS exact-value redaction test. The
  // private-key redaction above is NAME/pattern-based; a bare echoed
  // credential only falls to this layer.
  it('redacts the exact secret values the command carried, from stdout/stderr/error', async () => {
    // The AAD binds the command id and device id, so seal with the same pair
    // the route reconstructs from the device_commands row.
    const payload = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'sup3r-s3cret-token' } },
      { commandId, deviceId: 'device-1' },
    );
    expect(payload.secretEnvEnvelope).toBeDefined();

    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'script',
          status: 'sent',
          targetRole: 'agent',
          payload,
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
        stdout: 'echoed sup3r-s3cret-token here',
        stderr: 'also sup3r-s3cret-token',
        error: 'failed using sup3r-s3cret-token',
      }),
    });

    expect(res.status).toBe(200);
    const stored = updateChain.set.mock.calls[0][0];
    for (const field of ['stdout', 'stderr', 'error'] as const) {
      expect(stored.result[field]).not.toContain('sup3r-s3cret-token');
      expect(stored.result[field]).toContain('[REDACTED]');
    }
  });

  it('discards all output when the command envelope will not open', async () => {
    // Sealed against a DIFFERENT device: the AAD will not verify, so the
    // server cannot know what to redact and must not persist raw output.
    const payload = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'sup3r-s3cret-token' } },
      { commandId, deviceId: 'some-other-device' },
    );

    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'script',
          status: 'sent',
          targetRole: 'agent',
          payload,
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
        stdout: 'echoed sup3r-s3cret-token here',
      }),
    });

    expect(res.status).toBe(200);
    const stored = updateChain.set.mock.calls[0][0];
    expect(stored.result.stdout).toBe('[OUTPUT_REDACTED:VERIFICATION_FAILED]');
    // Status survives — the operator still learns the script completed.
    expect(stored.status).toBe('completed');
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
        partnerId: 'partner-1',
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

  // Retry race guard (this fix): a sw-install commandId's optional
  // `-<attempt>` suffix must gate the deployment_results UPDATE on
  // retryCount, so a late result from an attempt a retry already superseded
  // is dropped instead of landing on the new attempt's fresh 'pending' row.
  describe('sw-install attempt-suffix retry guard', () => {
    const deploymentUuid = '11111111-1111-4111-8111-111111111111';
    const deviceUuid = '33333333-3333-4333-8333-333333333333';

    function makeSwApp() {
      const swApp = new Hono();
      swApp.use('*', async (c, next) => {
        c.set('agent', {
          deviceId: deviceUuid,
          agentId: 'agent-1',
          orgId: 'org-1',
          partnerId: 'partner-1',
          siteId: 'site-1',
          role: 'agent',
        });
        await next();
      });
      swApp.route('/agents', commandsRoutes);
      return swApp;
    }

    it('parses the attempt suffix and guards the UPDATE on retryCount', async () => {
      const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}-2`;
      const updateChain = chainMock([{ id: 'dr-1' }]);
      updateMock.mockReturnValueOnce(updateChain);

      const res = await makeSwApp().request(`/agents/${agentId}/commands/${swCommandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: swCommandId, status: 'completed', exitCode: 0 }),
      });

      expect(res.status).toBe(200);
      expect(updateChain.where).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, deploymentUuid),
          eq(deploymentResults.deviceId, deviceUuid),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 2),
        ),
      );
    });

    it('drops (and logs) a late result whose attempt suffix no longer matches the row current retryCount', async () => {
      // Attempt 1's command id delivers late after a retry bumped retryCount
      // to 2 — the UPDATE's retryCount=1 condition matches zero real rows.
      const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}-1`;
      const updateChain = chainMock([]);
      updateMock.mockReturnValueOnce(updateChain);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await makeSwApp().request(`/agents/${agentId}/commands/${swCommandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: swCommandId, status: 'completed', exitCode: 0 }),
      });

      expect(res.status).toBe(200);
      expect(updateChain.where).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, deploymentUuid),
          eq(deploymentResults.deviceId, deviceUuid),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 1),
        ),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('attempt=1'));
      warnSpy.mockRestore();
    });

    it('defaults to attempt 0 for a legacy commandId with no attempt suffix', async () => {
      const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}`;
      const updateChain = chainMock([{ id: 'dr-1' }]);
      updateMock.mockReturnValueOnce(updateChain);

      const res = await makeSwApp().request(`/agents/${agentId}/commands/${swCommandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: swCommandId, status: 'completed', exitCode: 0 }),
      });

      expect(res.status).toBe(200);
      expect(updateChain.where).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, deploymentUuid),
          eq(deploymentResults.deviceId, deviceUuid),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 0),
        ),
      );
    });
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

    // Queued (offline-fallback) commands don't use the sw-install-<dep>-<device>-<attempt>
    // id shape — the device_commands row carries a plain UUID — so the attempt
    // number for the retry guard travels in the payload instead (written by
    // buildAndDispatchSoftwareInstalls). This proves it threads through here too.
    it('guards the deployment_results UPDATE on the payload retryCount for a queued result', async () => {
      selectMock.mockReturnValueOnce(chainMock([swInstallCommandRow({
        payload: { deploymentId: deploymentUuid, downloadUrl: 'https://dl/pkg.exe', retryCount: 1 },
      })]));
      const deviceCommandsChain = chainMock([{ id: commandId }]);
      const deploymentResultsChain = chainMock([{ id: 'dr-1' }]);
      updateMock
        .mockReturnValueOnce(deviceCommandsChain)
        .mockReturnValueOnce(deploymentResultsChain);

      const res = await app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, status: 'completed', exitCode: 0 }),
      });

      expect(res.status).toBe(200);
      expect(deploymentResultsChain.where).toHaveBeenCalledWith(
        and(
          eq(deploymentResults.deploymentId, deploymentUuid),
          eq(deploymentResults.deviceId, 'device-1'),
          eq(deploymentResults.status, 'pending'),
          eq(deploymentResults.retryCount, 1),
        ),
      );
    });

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

  // BREEZE-X: the REST twin of the WS terminal compare-and-set used to return
  // {success:true} on 0 rows with no signal at all, so a cross-transport race
  // could not be confirmed from the WS side alone. It now reports with its own
  // cas_label and the same prior_status evidence.
  describe('terminal CAS 0-row branch', () => {
    function queueTerminalCas(updatedRows: unknown[], priorRow?: unknown) {
      // 1st select: the command pre-read (still non-terminal, so the route
      // does NOT short-circuit and actually attempts the CAS).
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
      // 2nd select (0-row branch only): the prior-status diagnostic re-read.
      selectMock.mockReturnValueOnce(chainMock(priorRow === undefined ? [] : [priorRow]));
      updateMock.mockReturnValueOnce(chainMock(updatedRows));
    }

    async function postResult() {
      return app.request(`/agents/${agentId}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId, status: 'completed', exitCode: 0, stdout: 'ok' }),
      });
    }

    it('reports the 0-row CAS to Sentry with cas_label + prior_status', async () => {
      queueTerminalCas([], {
        status: 'failed',
        result: { status: 'timeout', error: 'no response', timedOutBy: 'server' },
      });

      const res = await postResult();

      // Behaviour is unchanged for the agent — this is observability only.
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true });

      expect(captureMessage).toHaveBeenCalledTimes(1);
      const call = vi.mocked(captureMessage).mock.calls[0]!;
      expect(call[1]?.eventCode).toBe('db_write_expecting_rows_zero');
      expect(call[1]?.tags).toEqual({
        cas_label: 'device_commands.rest_result_terminal_cas',
        prior_status: 'failed:server-timeout',
      });
      // Pre-read + the diagnostic re-read, nothing more.
      expect(selectMock).toHaveBeenCalledTimes(2);
    });

    it('does not re-read the row or capture anything when the CAS moves a row', async () => {
      queueTerminalCas([{ id: commandId }], { status: 'failed', result: null });

      const res = await postResult();

      expect(res.status).toBe(200);
      expect(captureMessage).not.toHaveBeenCalled();
      // Only the pre-read: the diagnostic read must stay on the 0-row branch.
      expect(selectMock).toHaveBeenCalledTimes(1);
    });
  });
});

// #3986 Layer 4 — the RESULT endpoint while the agent is on a narrowed drain
// surface. Being on the drain ROUTE allowlist is not the same as being
// harmless: this route has two entrances, and only one of them ever looks at a
// device_commands row.
describe('POST /agents/:id/commands/:commandId/result — drain narrowing (#3986)', () => {
  const agentId = 'ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776';
  const commandId = '22222222-2222-4222-8222-222222222222';
  const deploymentUuid = '11111111-1111-4111-8111-111111111111';
  const deviceUuid = '33333333-3333-4333-8333-333333333333';

  /**
   * `drain` mirrors the three contexts agentAuthMiddleware can hand this route:
   *   'none'   — healthy device on a healthy tenant; no allowlist.
   *   'device' — #3986 device-remove drain.
   *   'tenant' — #2774 offboarding drain. The device itself is healthy, but the
   *              middleware derives the SAME `claimTypeAllowlist`.
   *
   * The tenant case exists because this route's gates are deliberately driven
   * by `claimTypeAllowlist` — the ONE derived value — and not by
   * `deviceUninstallDraining`. That is a real behaviour change to the shipped
   * #2774 path (see the LOW-2 section of the task-9 report): a `sw-install-…`
   * result and a non-self_uninstall ack from an offboarding tenant's still-live
   * machine are now refused too. It is intentional — a second, divergent notion
   * of "draining" at this layer is exactly the drift the single derived value
   * exists to prevent — so it is pinned by tests rather than left as prose.
   */
  function buildApp(opts: { drain: 'none' | 'device' | 'tenant'; deviceId?: string }): Hono {
    const drainContext =
      opts.drain === 'device'
        ? { deviceUninstallDraining: true, claimTypeAllowlist: ['self_uninstall'] as const }
        : opts.drain === 'tenant'
          ? { tenantDraining: true, claimTypeAllowlist: ['self_uninstall'] as const }
          : {};

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: opts.deviceId ?? 'device-1',
        agentId: 'agent-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
        siteId: 'site-1',
        role: 'agent',
        ...drainContext,
      });
      await next();
    });
    app.route('/agents', commandsRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset, not just clearAllMocks: `clearAllMocks` leaves UNCONSUMED
    // `mockReturnValueOnce` entries queued, and the suite above ends with one
    // deliberately unconsumed (the diagnostic re-read that must not happen).
    // Inheriting it would shift every queued row in this block by one — which
    // is exactly how a drain assertion could pass against the wrong fixture.
    selectMock.mockReset();
    updateMock.mockReset();
    secretGateContexts.length = 0;
    secretGateWithholds = false;
    insideSystemDbContext = false;
  });

  function postResult(app: Hono, id: string) {
    return app.request(`/agents/${agentId}/commands/${id}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: id, status: 'completed', exitCode: 0, stdout: 'ok' }),
    });
  }

  it('rejects a non-UUID command result while draining', async () => {
    // `sw-install-<deployment>-<device>` has NO device_commands row: the
    // handler writes deployment_results gated only on the embedded device UUID
    // matching the authenticated device, so a command-TYPE allowlist cannot
    // see it at all. A removed machine must not keep stamping deployment
    // history for the org.
    const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}`;
    const updateChain = chainMock([]);
    updateMock.mockReturnValue(updateChain);

    const res = await postResult(buildApp({ drain: 'device', deviceId: deviceUuid }), swCommandId);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    // The real assertion: nothing was written to deployment_results.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('the SAME sw-install result still lands when NOT draining (proves the refusal is the drain gate)', async () => {
    const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}`;
    const updateChain = chainMock([]);
    updateMock.mockReturnValue(updateChain);

    const res = await postResult(buildApp({ drain: 'none', deviceId: deviceUuid }), swCommandId);

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalled();
  });

  it('rejects a result for a non-self_uninstall command while draining', async () => {
    // A UUID-keyed row of some other type — claimed before the drain opened,
    // or pushed over another path. The result handlers below this check are a
    // wide fan-out (security findings, filesystem analysis, vault sync, backup
    // verification, restore jobs, CIS, software remediation) that all write
    // tenant data, so the ack must be refused too, not just the claim.
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'script',
          status: 'sent',
          targetRole: 'agent',
          payload: {},
        },
      ])
    );

    const res = await postResult(buildApp({ drain: 'device' }), commandId);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    // Refused BEFORE any terminalizing write to device_commands.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('ACCEPTS the self_uninstall result while draining — the ack the window exists for', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'self_uninstall',
          status: 'sent',
          targetRole: 'agent',
          payload: { removeConfig: true },
        },
      ])
    );
    updateMock.mockReturnValue(chainMock([{ id: commandId }]));

    const res = await postResult(buildApp({ drain: 'device' }), commandId);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
    expect(updateMock).toHaveBeenCalled();
  });

  it('leaves a non-draining agent free to ack any command type', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'script',
          status: 'sent',
          targetRole: 'agent',
          payload: {},
        },
      ])
    );
    updateMock.mockReturnValue(chainMock([{ id: commandId }]));

    const res = await postResult(buildApp({ drain: 'none' }), commandId);

    expect(res.status).toBe(200);
  });

  // ---- LOW-2: the gates key on `claimTypeAllowlist`, so they fire for a TENANT
  // drain as well. Without these two cases the decision is a one-line revert
  // away (`agent.deviceUninstallDraining && …`) with zero test failures.

  it('rejects a non-UUID (sw-install) command result during a TENANT drain too', async () => {
    // #2774's machines are still live, but the `sw-install-…` branch is the same
    // hole on the same route: it writes deployment_results with no
    // device_commands row to consult, gated only on the embedded device UUID.
    // An offboarding customer's fleet must stop feeding that too.
    const swCommandId = `sw-install-${deploymentUuid}-${deviceUuid}`;
    const updateChain = chainMock([]);
    updateMock.mockReturnValue(updateChain);

    const res = await postResult(buildApp({ drain: 'tenant', deviceId: deviceUuid }), swCommandId);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a result for a non-self_uninstall command during a TENANT drain too', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'script',
          status: 'sent',
          targetRole: 'agent',
          payload: {},
        },
      ])
    );

    const res = await postResult(buildApp({ drain: 'tenant' }), commandId);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'drain_restricted' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('ACCEPTS the self_uninstall result during a TENANT drain (the narrowing is by TYPE, not a blanket refusal)', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
        {
          id: commandId,
          deviceId: 'device-1',
          type: 'self_uninstall',
          status: 'sent',
          targetRole: 'agent',
          payload: { removeConfig: true },
        },
      ])
    );
    updateMock.mockReturnValue(chainMock([{ id: commandId }]));

    const res = await postResult(buildApp({ drain: 'tenant' }), commandId);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
  });

  it('narrows the GET poll claim for a DEVICE drain too, not just a tenant drain', async () => {
    claimPendingCommandsForDeviceMock.mockResolvedValueOnce([]);

    const res = await buildApp({ drain: 'device' }).request(`/agents/${agentId}/commands`, {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(claimPendingCommandsForDeviceMock).toHaveBeenCalledWith('device-1', 10, 'agent', [
      'self_uninstall',
    ]);
  });
});
