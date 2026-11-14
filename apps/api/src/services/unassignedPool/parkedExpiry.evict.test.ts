import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4142 W3: an expired parked device's agent socket is closed through the
// relay facade (on whichever instance holds it), after the decommission has
// committed, never from inside the caller's DB context.
const h = vi.hoisted(() => ({
  events: [] as string[],
  deferred: [] as Array<{ label: string; work: () => unknown }>,
  evict: vi.fn(),
  capture: vi.fn(),
  lockDevice: vi.fn(),
  decommission: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        const result = await fn({
          insert: () => ({ values: () => ({ returning: async () => [{ id: 'ledger-1' }] }) }),
        });
        h.events.push('commit');
        return result;
      } catch (err) {
        h.events.push('rollback');
        throw err;
      }
    },
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  runAfterDbContextExit: (label: string, work: () => unknown) => {
    h.events.push(`defer:${label}`);
    h.deferred.push({ label, work });
  },
}));
vi.mock('../agentCommandRelayEvict', () => ({ evictAgentSockets: h.evict }));
vi.mock('../sentry', () => ({ captureException: h.capture }));
vi.mock('../deviceDecommission', () => ({ decommissionDeviceInTransaction: h.decommission }));
vi.mock('../deviceLifecycle', () => ({ purgeRemovedDevice: vi.fn(), DeviceLifecycleError: class extends Error {} }));
vi.mock('./holdingAreaLock', () => ({ lockPartnerHoldingArea: vi.fn() }));
vi.mock('./assignParkedDeviceSteps', () => ({ lockDeviceForAssignment: h.lockDevice }));
vi.mock('../deviceReattach/intentStore', () => ({
  lockOpenReattachIntentsOfDevice: vi.fn(async () => []),
  endIntentInTransaction: vi.fn(),
  revokeCertificatesAfterCommit: vi.fn(),
}));
vi.mock('../deviceReattach/audit', () => ({ writeReattachAudit: vi.fn() }));
vi.mock('../deviceReattach/sourceMarker', () => ({ clearReattachSourceMarker: vi.fn() }));
vi.mock('../auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../agentOrgRateLimit', () => ({ invalidateOrgDeviceCount: vi.fn(async () => undefined) }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../routes/agentWs', () => {
  throw new Error('parkedExpiry must not load routes/agentWs (#4142)');
});

import { expireParkedDevice } from './parkedExpiry';

const deviceId = '44444444-4444-4444-8444-444444444444';
const partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { partnerId, deviceId, actorUserId: null, reason: 'parking_window' as const };

async function runDeferred(): Promise<void> {
  for (const task of h.deferred.splice(0)) await task.work();
}

describe('parkedExpiry decommission eviction (#4142 W3)', () => {
  beforeEach(() => {
    h.events.length = 0;
    h.deferred.length = 0;
    h.evict.mockReset();
    h.capture.mockReset();
    h.decommission.mockReset();
    h.decommission.mockResolvedValue({ updated: { decommissionedAt: new Date('2026-02-01') }, uninstallQueued: true });
    h.lockDevice.mockReset();
    h.lockDevice.mockResolvedValue({
      id: deviceId, orgPartnerId: partnerId, orgType: 'unassigned_pool', status: 'online',
      agentId: 'agent-1', hostname: 'host-1', orgId: 'holding-org', createdAt: new Date('2026-01-01'),
    });
  });

  it('the decommission eviction is registered post-commit with code 4041 and awaitAck:false', async () => {
    h.evict.mockResolvedValue(new Map([['agent-1', { status: 'queued' }]]));

    expect(await expireParkedDevice(input)).toMatchObject({ expired: true, deviceId });
    // Registered after the decommission committed, and not run inline.
    expect(h.events).toEqual(['commit', 'defer:parked device agent socket eviction']);
    expect(h.evict).not.toHaveBeenCalled();

    await runDeferred();
    expect(h.evict).toHaveBeenCalledTimes(1);
    expect(h.evict).toHaveBeenCalledWith(
      [{ agentId: 'agent-1', code: 4041, reason: 'Device decommissioned' }],
      { awaitAck: false },
    );
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('registers no eviction when the expiry is skipped', async () => {
    h.lockDevice.mockResolvedValue({
      id: deviceId, orgPartnerId: partnerId, orgType: 'unassigned_pool', status: 'decommissioned',
      agentId: 'agent-1', hostname: 'host-1', orgId: 'holding-org', createdAt: new Date('2026-01-01'),
    });
    expect(await expireParkedDevice(input)).toEqual({ expired: false, deviceId, reason: 'ALREADY_REMOVED' });
    expect(h.deferred).toEqual([]);
  });

  it('an eviction failure is reported via report(\'agent disconnect\', …), never thrown', async () => {
    const boom = new Error('relay exploded');
    h.evict.mockRejectedValue(boom);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await expireParkedDevice(input)).toMatchObject({ expired: true, deviceId });
      await expect(runDeferred()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(`[parkedExpiry] post-commit agent disconnect failed for ${deviceId}:`, boom);
      expect(h.capture).toHaveBeenCalledWith(boom);
    } finally { error.mockRestore(); }
  });

  it.each([
    [{ status: 'unavailable', reason: 'presence_unavailable' }, 'unavailable:presence_unavailable'],
    [{ status: 'close_failed', via: 'local' }, 'close_failed:local'],
  ])('a socket the facade could not close (%o) is reported as an agent disconnect failure', async (outcome, tag) => {
    h.evict.mockResolvedValue(new Map([['agent-1', outcome]]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expireParkedDevice(input);
      await runDeferred();
      expect(error).toHaveBeenCalledWith(
        `[parkedExpiry] post-commit agent disconnect failed for ${deviceId}:`,
        expect.objectContaining({ message: expect.stringContaining(tag) }),
      );
      expect(h.capture).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); }
  });

  it('an unconfirmed (indeterminate) eviction is logged, not reported', async () => {
    h.evict.mockResolvedValue(new Map([['agent-1', { status: 'indeterminate' }]]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expireParkedDevice(input);
      await runDeferred();
      expect(warn).toHaveBeenCalledWith(`[parkedExpiry] agent socket eviction unconfirmed for ${deviceId}`);
      expect(h.capture).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it.each([
    [{ status: 'queued' }],
    [{ status: 'closed', via: 'local' }],
    [{ status: 'not_connected' }],
  ])('a delivered or moot outcome (%o) is not reported', async (outcome) => {
    h.evict.mockResolvedValue(new Map([['agent-1', outcome]]));
    await expireParkedDevice(input);
    await runDeferred();
    expect(h.capture).not.toHaveBeenCalled();
  });
});
