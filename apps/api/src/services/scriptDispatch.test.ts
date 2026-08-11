import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('./commandQueue', () => ({ queueCommand: vi.fn() }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { claimPendingCommandForDelivery } from './commandDispatch';
import { decryptCommandForDelivery, encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';
import { dispatchScriptToDevice } from './scriptDispatch';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null, ...o,
}) as any;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

// Mocks the live `devices.status` re-read the requireOnline gate performs.
// Pass `undefined` to model a device row that no longer exists.
const mockLiveDeviceStatus = (status: string | undefined) => {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(status === undefined ? [] : [{ status }]),
      }),
    }),
  } as any);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
});

describe('dispatchScriptToDevice — invariants', () => {
  it('rejects a decommissioned device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'decommissioned' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('device_decommissioned');
    expect(db.insert).not.toHaveBeenCalled();
    // Decommission is permanent — checked against the caller's snapshot with
    // no live re-read.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects offline device when requireOnline (snapshot and live read agree)', async () => {
    mockLiveDeviceStatus('offline');
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), requireOnline: true, source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device is offline, cannot execute command');
    }
  });

  it('queues for an offline device when requireOnline is not set (manual semantics)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(true);
    // requireOnline:false is deliberate offline-queueing (manual/route
    // semantics) — no live re-read should fire for it.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('requireOnline gate re-reads live status: rejects a stale-online snapshot when the live read says offline', async () => {
    // Automation fleet runs snapshot device status once at run start
    // (automationRuntime.ts:1712/2269) and can dispatch minutes later — the
    // snapshot passed in here says 'online', but the live devices row has
    // since gone offline. The gate must trust the live read, not the
    // snapshot, or it would dispatch to a device that's actually offline.
    mockLiveDeviceStatus('offline');
    const r = await dispatchScriptToDevice({
      device: device({ status: 'online' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device is offline, cannot execute command');
    }
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('requireOnline gate proceeds when the live read says online, even off a stale non-online snapshot', async () => {
    mockLiveDeviceStatus('online');
    const r = await dispatchScriptToDevice({
      device: device({ status: 'offline' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('requireOnline gate rejects with "Device not found" when the live row is gone', async () => {
    mockLiveDeviceStatus(undefined);
    const r = await dispatchScriptToDevice({
      device: device({ status: 'online' }), requireOnline: true, source: { kind: 'saved', script: savedScript() },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('device_offline');
      expect(r.error).toBe('Device not found');
    }
  });

  it('rejects cross-org saved script (org-equality invariant)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: 'org-a' }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('org_mismatch');
  });

  it('allows org-null (system/partner-wide) saved script on any device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: null }) } });
    expect(r.ok).toBe(true);
  });

  it('rejects OS-incompatible saved script', async () => {
    const r = await dispatchScriptToDevice({ device: device({ osType: 'windows' }), source: { kind: 'saved', script: savedScript({ osTypes: ['linux'] }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('os_mismatch');
  });
});

describe('dispatchScriptToDevice — rows and payload', () => {
  it('saved: creates an execution row with the DEVICE org and passes executionId in payload', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript() },
      parameters: { a: '1' }, triggeredBy: 'user-1', triggerType: 'manual', automationRunId: null,
    });
    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ scriptId: 'script-1', deviceId: 'device-1', orgId: 'org-a', triggeredBy: 'user-1', status: 'pending' });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'script-1', executionId: 'exec-1', language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' });
  });

  it('raw: creates NO execution row and uses provenance as payload scriptId', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      timeoutSeconds: 300, runAs: 'system',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.executionId).toBeNull();
    expect(db.insert).not.toHaveBeenCalled(); // no scriptExecutions insert; command goes via queueCommand
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'automation:auto-1', content: 'ipconfig', language: 'powershell' });
    expect((payload as Record<string, unknown>).executionId).toBeUndefined();
  });

  it('runs the payload through encryptSensitivePayloadFields before queueCommand', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(encryptSensitivePayloadFields).toHaveBeenCalledWith('script', expect.any(Object));
    expect(vi.mocked(encryptSensitivePayloadFields).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(queueCommand).mock.invocationCallOrder[0]!);
  });

  it('input runAs/timeoutSeconds override script defaults', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() }, runAs: 'user', timeoutSeconds: 5 });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ runAs: 'user', timeoutSeconds: 5 });
  });

  it('deletes the pending execution row if queueCommand throws', async () => {
    const del = { where: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.delete).mockReturnValue(del as any);
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(db.delete).toHaveBeenCalled();
  });

  it('rethrows the ORIGINAL queueCommand error even if the cleanup delete also throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const del = { where: vi.fn().mockRejectedValue(new Error('cleanup-db-down')) };
    vi.mocked(db.delete).mockReturnValue(del as any);
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(db.delete).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('dispatchScriptToDevice — delivery', () => {
  it('claims, decrypts via decryptCommandForDelivery, sends, and marks execution running (guarded)', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) } as any);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date('2026-08-11T00:00:00Z') } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(decryptCommandForDelivery).toHaveBeenCalled();
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: 'cmd-1', type: 'script' }));
    if (r.ok) { expect(r.delivered).toBe(true); expect(r.executedAt).toEqual(new Date('2026-08-11T00:00:00Z')); }
  });

  it('releases the claim when decrypt returns null (does NOT send raw payload)', async () => {
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(decryptCommandForDelivery).mockReturnValue(null as any);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(releaseClaimedCommandDelivery).toHaveBeenCalledWith('cmd-1', expect.any(Date));
    if (r.ok) expect(r.delivered).toBe(false);
  });

  it('releases the claim when the WS send fails', async () => {
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(false);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(releaseClaimedCommandDelivery).toHaveBeenCalled();
    if (r.ok) expect(r.delivered).toBe(false);
  });

  it('skips delivery entirely when deliver:false or agentId null', async () => {
    await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), deliver: false, source: { kind: 'saved', script: savedScript() } });
    await dispatchScriptToDevice({ device: device({ agentId: null }), source: { kind: 'saved', script: savedScript() } });
    expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
  });
});
