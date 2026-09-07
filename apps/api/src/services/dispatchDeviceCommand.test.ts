import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queueCommandMock,
  claimMock,
  releaseMock,
  sendMock,
  assertAllowedMock,
  selectMock,
  refreshMock,
  decryptMock,
  captureExceptionMock,
  inFlightMock,
} = vi.hoisted(() => ({
  queueCommandMock: vi.fn(),
  claimMock: vi.fn(),
  releaseMock: vi.fn(),
  sendMock: vi.fn(),
  assertAllowedMock: vi.fn(),
  selectMock: vi.fn(),
  refreshMock: vi.fn(),
  decryptMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  inFlightMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...(a as [])) },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../db/schema', () => ({ devices: { id: 'devices.id' } }));
vi.mock('./commandQueue', () => ({
  queueCommand: (...a: unknown[]) => queueCommandMock(...(a as [])),
}));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: (...a: unknown[]) => claimMock(...(a as [])),
  releaseClaimedCommandDelivery: (...a: unknown[]) => releaseMock(...(a as [])),
  countInFlightCommandsForDevice: (...a: unknown[]) => inFlightMock(...(a as [])),
}));
vi.mock('./commandDelivery', () => ({
  refreshPayloadForDelivery: (...a: unknown[]) => refreshMock(...(a as [])),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  decryptCommandForDelivery: (...a: unknown[]) => decryptMock(...(a as [])),
  toAgentCommandFrame: (c: unknown) => c,
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: (...a: unknown[]) => sendMock(...(a as [])) }));
vi.mock('./sentry', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...(a as [])),
}));
vi.mock('./partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: (...a: unknown[]) => assertAllowedMock(...(a as [])),
  TrustDeniedError: class TrustDeniedError extends Error {
    capability = 'device_execute' as const;
    constructor(
      public code: string,
      public reason: string,
      public deviceId: string,
      public commandType: string,
    ) {
      super(`Partner trust ${code}`);
      this.name = 'TrustDeniedError';
    }
  },
}));

import { dispatchDeviceCommand } from './dispatchDeviceCommand';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

function deviceRow(status: string, agentId: string | null = 'agent-1') {
  return { id: DEVICE, orgId: ORG, status, agentId };
}
function selectReturning(row: unknown) {
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) });
}

describe('dispatchDeviceCommand (#5128 W1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    assertAllowedMock.mockResolvedValue(undefined);
    refreshMock.mockImplementation(async (_t: string, p: unknown) => p);
    inFlightMock.mockResolvedValue(0);
    decryptMock.mockImplementation((c: unknown) => c);
    queueCommandMock.mockImplementation(async (_d, type, _p, _u, opts) => ({
      id: 'cmd-1',
      type,
      status: 'pending',
      deliverBy: opts?.deliverBy,
      submittedOrgId: opts?.submittedOrgId,
    }));
  });

  it('offline device + queue policy → row persisted with deliver_by and submitted_org_id, delivery=queued_offline', async () => {
    selectReturning(deviceRow('offline'));
    const before = Date.now();
    const res = await dispatchDeviceCommand({
      deviceId: DEVICE,
      type: 'refresh_inventory',
      offlinePolicy: { kind: 'queue', deliverWithinMs: 3_600_000 },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery).toBe('queued_offline');
    expect(res.deliverBy!.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    const opts = queueCommandMock.mock.calls[0]![4] as { deliverBy: Date; submittedOrgId: string };
    expect(opts.submittedOrgId).toBe(ORG);
    expect(opts.deliverBy).toBeInstanceOf(Date);
    expect(sendMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('offline device + reject policy → device_offline error, no row written', async () => {
    selectReturning(deviceRow('offline'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'list_processes' });
    expect(res).toMatchObject({ ok: false, code: 'device_offline', error: 'Device is offline, cannot execute command' });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('online device → claim + push, delivery=delivered, and the row still carries a deadline', async () => {
    selectReturning(deviceRow('online'));
    const executedAt = new Date();
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt });
    sendMock.mockReturnValue(true);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('delivered');
    expect(res.ok && res.command.status).toBe('sent');
    expect((queueCommandMock.mock.calls[0]![4] as { deliverBy: Date }).deliverBy).toBeInstanceOf(Date);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('online device, push fails → claim released, delivery=queued_live', async () => {
    selectReturning(deviceRow('online'));
    const executedAt = new Date();
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt });
    sendMock.mockReturnValue(false);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('queued_live');
    expect(releaseMock).toHaveBeenCalledWith('cmd-1', executedAt);
  });

  it('online device with no agent socket → queued_live, never pushed', async () => {
    selectReturning(deviceRow('online', null));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('queued_live');
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('preferHeartbeat skips the socket push even when connected', async () => {
    selectReturning(deviceRow('online'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory', preferHeartbeat: true });
    expect(res.ok && res.delivery).toBe('queued_live');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('runs the delivery refresher before decrypt on the enqueue-time push', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
    sendMock.mockReturnValue(true);
    refreshMock.mockResolvedValue({ s3Key: 'k', downloadUrl: 'https://fresh.example' });
    await dispatchDeviceCommand({
      deviceId: DEVICE,
      type: 'software_install',
      payload: { s3Key: 'k', downloadUrl: 'https://stale.example' },
    });
    expect(refreshMock).toHaveBeenCalledWith('software_install', { s3Key: 'k', downloadUrl: 'https://stale.example' });
    expect(decryptMock.mock.calls[0]![0]).toMatchObject({ payload: { downloadUrl: 'https://fresh.example' } });
  });

  it('a refresher failure releases the claim instead of pushing a stale payload', async () => {
    selectReturning(deviceRow('online'));
    const executedAt = new Date();
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt });
    refreshMock.mockResolvedValue(null);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'software_install', payload: { s3Key: 'k' } });
    expect(sendMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledWith('cmd-1', executedAt);
    expect(res.ok && res.delivery).toBe('queued_live');
  });

  it('expectedOrgId mismatch → device_not_found (never leaks existence)', async () => {
    selectReturning(deviceRow('online'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory', expectedOrgId: OTHER_ORG });
    expect(res).toMatchObject({ ok: false, code: 'device_not_found' });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('missing device → device_not_found', async () => {
    selectReturning(null);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res).toMatchObject({ ok: false, code: 'device_not_found', error: 'Device not found' });
  });

  it('decommissioned device → device_decommissioned regardless of policy, with the legacy error text', async () => {
    selectReturning(deviceRow('decommissioned'));
    const res = await dispatchDeviceCommand({
      deviceId: DEVICE,
      type: 'refresh_inventory',
      offlinePolicy: { kind: 'queue', deliverWithinMs: 1000 },
    });
    expect(res).toMatchObject({
      ok: false,
      code: 'device_decommissioned',
      error: 'Device is decommissioned, cannot execute command',
    });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('trust denial → trust_denied with the capability/reason payload, no row', async () => {
    selectReturning(deviceRow('online'));
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_RESTRICTED', 'partner_suspended', DEVICE, 'refresh_inventory')
    );
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res).toMatchObject({
      ok: false,
      code: 'trust_denied',
      trust: { capability: 'device_execute', reason: 'partner_suspended' },
    });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a non-trust error from the trust check propagates rather than being swallowed', async () => {
    selectReturning(deviceRow('online'));
    assertAllowedMock.mockRejectedValue(new Error('db down'));
    await expect(dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' })).rejects.toThrow('db down');
  });

  it('unregistered type throws before any DB read or write', async () => {
    selectReturning(deviceRow('online'));
    await expect(dispatchDeviceCommand({ deviceId: DEVICE, type: 'nope_not_real' })).rejects.toThrow(
      /COMMAND_OFFLINE_POLICY_REGISTRY/
    );
    expect(selectMock).not.toHaveBeenCalled();
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a reject-policy command against an ONLINE device gets NO delivery deadline', async () => {
    // #5128 review round 2 (J): the 5-minute race grace used to be stamped
    // here, which cut the pending window for every reject caller — including
    // watchdog-targeted `update_agent`/`restart_agent` and barrier-held
    // reboots — from the legacy 30-minute execution clock to 5 minutes. NULL
    // restores the legacy clock exactly.
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue(null);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'list_processes' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deliverBy).toBeNull();
    expect((queueCommandMock.mock.calls[0]![4] as { deliverBy: Date | null }).deliverBy).toBeNull();
  });

  it('flag off keeps a previouslyRejected caller rejecting an offline device', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    selectReturning(deviceRow('offline'));
    const res = await dispatchDeviceCommand({
      deviceId: DEVICE,
      type: 'install_patches',
      previouslyRejected: true,
    });
    expect(res).toMatchObject({ ok: false, code: 'device_offline' });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('flag off does NOT gate a caller that already queued today', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');
    selectReturning(deviceRow('offline'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'script', previouslyRejected: false });
    expect(res.ok && res.delivery).toBe('queued_offline');
  });

  it('a power-state command is HELD from the socket while anything is in flight', async () => {
    // Pushing straight down the socket would bypass partitionClaimable's
    // power-state barrier, which is the whole protection against a queued
    // reboot landing in the middle of a running script.
    for (const type of ['reboot', 'shutdown', 'reboot_safe_mode']) {
      vi.clearAllMocks();
      selectReturning(deviceRow('online'));
      inFlightMock.mockResolvedValue(1);
      queueCommandMock.mockResolvedValue({ id: 'cmd-1', type, status: 'pending' });
      const res = await dispatchDeviceCommand({ deviceId: DEVICE, type });
      expect(res.ok && res.delivery).toBe('queued_live');
      expect(claimMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    }
  });

  it('a power-state command IS pushed when nothing is in flight', async () => {
    // #5128 review round 2 (J): a blanket skip regressed the callers that have
    // always pushed a reboot immediately — maintenanceRebootWorker (Linux
    // maintenance windows) and the fleet-findings dispatch map — delaying a
    // scheduled reboot by a whole heartbeat interval. The barrier's real
    // condition is "nothing else in flight", so apply that instead.
    for (const type of ['reboot', 'shutdown', 'reboot_safe_mode']) {
      vi.clearAllMocks();
      selectReturning(deviceRow('online'));
      inFlightMock.mockResolvedValue(0);
      refreshMock.mockImplementation(async (_t: string, p: unknown) => p);
      decryptMock.mockImplementation((c: unknown) => c);
      queueCommandMock.mockResolvedValue({ id: 'cmd-1', type, status: 'pending' });
      claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
      sendMock.mockReturnValue(true);
      const res = await dispatchDeviceCommand({ deviceId: DEVICE, type });
      expect(res.ok && res.delivery).toBe('delivered');
      expect(inFlightMock).toHaveBeenCalledWith(DEVICE);
      expect(sendMock).toHaveBeenCalledTimes(1);
    }
  });

  it('a non-power-state command never pays for the in-flight probe', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
    sendMock.mockReturnValue(true);
    await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(inFlightMock).not.toHaveBeenCalled();
  });

  it('an offline AND trust-denied device answers device_offline, with the legacy string', async () => {
    // #5128 review round 2 (M): four backup routes classify a failure by the
    // `Device is <status>, cannot execute command` prefix
    // (routes/backup/vmrestore.ts, restore.ts, verificationService.ts,
    // verificationScheduled.ts). With the trust check first they would see the
    // raw trust code the day partner trust leaves shadow mode.
    selectReturning(deviceRow('offline'));
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_RESTRICTED', 'partner_suspended', DEVICE, 'list_processes'),
    );
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'list_processes' });
    expect(res).toMatchObject({
      ok: false,
      code: 'device_offline',
      error: 'Device is offline, cannot execute command',
    });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a QUEUE-policy command against an offline, trust-denied device still refuses on trust', async () => {
    // The reorder must not weaken trust: a queue caller has no offline
    // rejection to short-circuit on, so trust is still what stops it.
    selectReturning(deviceRow('offline'));
    const { TrustDeniedError } = await import('./partnerTrust.commands');
    assertAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_RESTRICTED', 'partner_suspended', DEVICE, 'script'),
    );
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'script' });
    expect(res).toMatchObject({ ok: false, code: 'trust_denied' });
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a non-power-state command to an online device is still pushed immediately', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt: new Date() });
    sendMock.mockReturnValue(true);
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
    expect(res.ok && res.delivery).toBe('delivered');
    expect(sendMock).toHaveBeenCalled();
  });

  it('a device in maintenance is treated as not-online and queues', async () => {
    selectReturning(deviceRow('maintenance'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'script' });
    expect(res.ok && res.delivery).toBe('queued_offline');
  });
  it('a release that itself fails still reports queued_live, and is captured', async () => {
    // The command IS persisted and the caller's response is already true, so a
    // failed release must not 500 a request whose write committed. The cost is
    // that the row sits `sent` until the reaper's EXECUTION clock reaps it —
    // recoverable, and worth reporting.
    selectReturning(deviceRow('online'));
    const executedAt = new Date();
    claimMock.mockResolvedValue({ id: 'cmd-1', executedAt });
    sendMock.mockReturnValue(false);
    releaseMock.mockRejectedValue(new Error('pool exhausted'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'refresh_inventory' });
      expect(res.ok && res.delivery).toBe('queued_live');
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect((captureExceptionMock.mock.calls[0]![0] as Error).message).toContain('cmd-1');
      expect((captureExceptionMock.mock.calls[0]![0] as Error).message).toContain('refresh_inventory');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
