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
} = vi.hoisted(() => ({
  queueCommandMock: vi.fn(),
  claimMock: vi.fn(),
  releaseMock: vi.fn(),
  sendMock: vi.fn(),
  assertAllowedMock: vi.fn(),
  selectMock: vi.fn(),
  refreshMock: vi.fn(),
  decryptMock: vi.fn(),
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
}));
vi.mock('./commandDelivery', () => ({
  refreshPayloadForDelivery: (...a: unknown[]) => refreshMock(...(a as [])),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  decryptCommandForDelivery: (...a: unknown[]) => decryptMock(...(a as [])),
  toAgentCommandFrame: (c: unknown) => c,
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: (...a: unknown[]) => sendMock(...(a as [])) }));
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
import { REJECT_RACE_GRACE_MS } from './commandOfflinePolicy';

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
    expect(res.deliverBy.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
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

  it('a reject-policy command against an ONLINE device still gets the short race-grace deadline', async () => {
    selectReturning(deviceRow('online'));
    claimMock.mockResolvedValue(null);
    const before = Date.now();
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'list_processes' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deliverBy.getTime()).toBeGreaterThanOrEqual(before + REJECT_RACE_GRACE_MS);
    expect(res.deliverBy.getTime()).toBeLessThan(before + REJECT_RACE_GRACE_MS + 60_000);
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

  it('a device in maintenance is treated as not-online and queues', async () => {
    selectReturning(deviceRow('maintenance'));
    const res = await dispatchDeviceCommand({ deviceId: DEVICE, type: 'script' });
    expect(res.ok && res.delivery).toBe('queued_offline');
  });
});
