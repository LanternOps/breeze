import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./deviceDeletion', () => ({ deleteDeviceCascade: vi.fn(async () => undefined) }));
vi.mock('./deviceLinkGroups', () => ({
  dissolveLinkGroupIfBelowMinimum: vi.fn(async () => true),
  LinkGroupSiteAccessError: class LinkGroupSiteAccessError extends Error {
    constructor() {
      super('site denied');
      this.name = 'LinkGroupSiteAccessError';
    }
  },
}));
vi.mock('./deviceUninstallDrain', async (orig) => {
  const actual = await orig<typeof import('./deviceUninstallDrain')>();
  return {
    ...actual,
    releaseDeviceRemoveReason: vi.fn(async () => ({
      cancelled: 1,
      retainedOtherOwner: 0,
      alreadyDispatched: 0,
    })),
  };
});

// #7982: device purge reuses org erasure's policy-level legal hold check,
// narrowed to the device. Its own behaviour is pinned in
// erasureBackupLegalHold.test.ts; here only the purge gate's use of it.
vi.mock('./erasureBackupLegalHold', () => ({
  findPolicyBackupLegalHoldInContext: vi.fn(async () => null),
}));

vi.mock('./partnerDeviceCapacity', async (orig) => {
  const actual = await orig<typeof import('./partnerDeviceCapacity')>();
  return {
    ...actual,
    deviceTakesLicensedSlot: vi.fn(async () => true),
    admitPartnerDeviceCapacity: vi.fn(async () => ({
      allowed: true,
      partnerId: 'partner-1',
      maxDevices: 10,
      activeCount: 3,
    })),
  };
});

import {
  restoreRemovedDevice,
  purgeRemovedDevice,
  DeviceLifecycleError,
  DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS,
} from './deviceLifecycle';
import { deleteDeviceCascade } from './deviceDeletion';
import { dissolveLinkGroupIfBelowMinimum } from './deviceLinkGroups';
import { releaseDeviceRemoveReason } from './deviceUninstallDrain';
import { findPolicyBackupLegalHoldInContext } from './erasureBackupLegalHold';
import {
  admitPartnerDeviceCapacity,
  deviceTakesLicensedSlot,
  PartnerDeviceCapacityError,
} from './partnerDeviceCapacity';

const DEV = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
/** Where the caller's tenant-scoped read found the device. */
const AUTHORIZED = { orgId: ORG, siteId: SITE };
/** The devices row as the lock sees it, still where the caller authorized it. */
const REMOVED_ROW = {
  id: DEV,
  status: 'decommissioned',
  org_id: ORG,
  site_id: SITE,
  is_ephemeral: false,
  link_group_id: null,
};

interface Script {
  lockRow?: Record<string, unknown> | null;
  /** The unlocked restore pre-read (device + owning partner). Defaults to lockRow. */
  targetRow?: Record<string, unknown> | null;
  pendingUninstall?: boolean;
  protectedBackupSnapshot?: boolean;
  updatedRow?: Record<string, unknown>;
}

/**
 * Minimal tx double: records the ORDER of statements and serves scripted rows.
 *
 * Statement classification is on the compiled sql`` text (JSON-serialised
 * chunks), not on call index, so inserting a statement can't silently shift
 * which scripted row a later statement receives.
 */
function makeTx(script: Script) {
  const calls: string[] = [];
  const statements: string[] = [];
  const setPayloads: Array<Record<string, unknown>> = [];
  const tx = {
    execute: vi.fn(async (q: unknown) => {
      const text = JSON.stringify(q);
      statements.push(text);
      if (text.includes('pg_settings')) {
        calls.push('tighten-lock-timeout');
        return [{ prior_ms: '0' }];
      }
      if (text.includes('FOR UPDATE')) {
        calls.push('lock');
        return script.lockRow ? [script.lockRow] : [];
      }
      if (text.includes('partner_id')) {
        calls.push('read-target');
        const target = script.targetRow === undefined
          ? (script.lockRow ? { ...script.lockRow, partner_id: PARTNER } : null)
          : script.targetRow;
        return target ? [target] : [];
      }
      if (text.includes('self_uninstall')) {
        calls.push('pending-check');
        return script.pendingUninstall ? [{ id: 'cmd' }] : [];
      }
      if (text.includes('SELECT org_id FROM devices')) {
        calls.push('device-org');
        return script.lockRow ? [{ org_id: script.lockRow.org_id ?? ORG }] : [];
      }
      if (text.includes('backup_snapshots')) {
        calls.push('backup-hold-check');
        return script.protectedBackupSnapshot ? [{ id: 'snap' }] : [];
      }
      if (text.includes('set_config')) {
        calls.push('restore-lock-timeout');
        return [];
      }
      calls.push('execute');
      return [];
    }),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        setPayloads.push(values);
        return {
          where: () => ({
            returning: async () => {
              calls.push('update');
              return [script.updatedRow ?? { id: DEV, status: 'offline' }];
            },
          }),
        };
      },
    })),
    select: vi.fn(),
  };
  return { tx: tx as never, calls, statements, setPayloads };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(releaseDeviceRemoveReason).mockResolvedValue({
    cancelled: 1,
    retainedOtherOwner: 0,
    alreadyDispatched: 0,
  });
  vi.mocked(dissolveLinkGroupIfBelowMinimum).mockResolvedValue(true);
  vi.mocked(deleteDeviceCascade).mockResolvedValue({ removedTopologyAlerts: 0 });
  vi.mocked(findPolicyBackupLegalHoldInContext).mockResolvedValue(null);
  vi.mocked(deviceTakesLicensedSlot).mockResolvedValue(true);
  vi.mocked(admitPartnerDeviceCapacity).mockResolvedValue({
    allowed: true,
    partnerId: PARTNER,
    maxDevices: 10,
    activeCount: 3,
  });
});

describe('restoreRemovedDevice', () => {
  it('locks the devices row BEFORE releasing the uninstall reason (lock order)', async () => {
    const { tx, calls } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(releaseDeviceRemoveReason).mockImplementation(async () => {
      calls.push('release');
      return { cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 };
    });
    await restoreRemovedDevice(tx, DEV, AUTHORIZED);
    // Guard every operand against -1 before comparing indices: a missing
    // statement indexes to -1, which compares "less than" everything and would
    // let the ordering assertions pass vacuously.
    for (const step of ['lock', 'release', 'update']) {
      expect(calls.indexOf(step), `${step} was never recorded`).toBeGreaterThanOrEqual(0);
    }
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('release'));
    expect(calls.indexOf('release')).toBeLessThan(calls.indexOf('update'));
  });

  it('bounds the wait for the devices row lock instead of blocking forever', async () => {
    const { tx, calls, statements } = makeTx({ lockRow: REMOVED_ROW });
    await restoreRemovedDevice(tx, DEV, AUTHORIZED);
    // Both statements must actually have been issued. Without this, dropping
    // tightenLockTimeout entirely would make indexOf return -1, which is
    // "less than" the lock's index — the ordering assertion below would pass
    // against code that never bounds the wait at all.
    expect(calls.indexOf('tighten-lock-timeout')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('lock')).toBeGreaterThanOrEqual(0);
    // The bound has to be applied BEFORE the lock is attempted, or a delete
    // racing a long-running site move / moveOrg pins a pooled connection for
    // as long as the other writer holds the row (same reasoning as
    // deviceDeletion.ts's own tightenLockTimeout).
    expect(calls.indexOf('tighten-lock-timeout')).toBeLessThan(calls.indexOf('lock'));
    expect(statements.some((s) => s.includes(String(DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS)))).toBe(true);
  });

  it('throws NOT_FOUND when the lock returns no row', async () => {
    const { tx } = makeTx({ lockRow: null, targetRow: { ...REMOVED_ROW, partner_id: PARTNER } });
    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('throws NOT_REMOVED when the locked row is no longer decommissioned', async () => {
    const { tx } = makeTx({
      lockRow: { ...REMOVED_ROW, status: 'online' },
      targetRow: { ...REMOVED_ROW, partner_id: PARTNER },
    });
    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'NOT_REMOVED',
      status: 409,
    });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
  });

  // #2787 item 4 — Restore is the ONLY way a device leaves 'decommissioned',
  // so it is the only place `decommissioned_at` can be cleared. Leaving the
  // stamp behind on a restored device would make the retention job eligible to
  // permanently delete a device the operator deliberately brought back.
  it('clears decommissioned_at in the same write that flips the status back', async () => {
    const { tx, setPayloads } = makeTx({ lockRow: REMOVED_ROW });

    await restoreRemovedDevice(tx, DEV, AUTHORIZED);

    expect(setPayloads).toHaveLength(1);
    expect(setPayloads[0]).toEqual({
      status: 'offline',
      decommissionedAt: null,
      updatedAt: expect.any(Date),
    });
  });

  it('reports uninstallAlreadyDispatched from the release result', async () => {
    const { tx } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(releaseDeviceRemoveReason).mockResolvedValueOnce({
      cancelled: 0,
      retainedOtherOwner: 0,
      alreadyDispatched: 1,
    });
    const r = await restoreRemovedDevice(tx, DEV, AUTHORIZED);
    expect(r.uninstallAlreadyDispatched).toBe(true);
    expect(r.device).toMatchObject({ id: DEV, status: 'offline' });
  });
});

describe('restoreRemovedDevice — partner device limit', () => {
  it('refuses at the limit with the enrollment refusal, before touching the device', async () => {
    const { tx, calls } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(admitPartnerDeviceCapacity).mockResolvedValueOnce({
      allowed: false,
      partnerId: PARTNER,
      maxDevices: 5,
      activeCount: 5,
    });

    const err = await restoreRemovedDevice(tx, DEV, AUTHORIZED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeviceLifecycleError);
    expect(err).toMatchObject({
      code: 'DEVICE_LIMIT_REACHED',
      message: 'Device limit reached',
      status: 403,
      details: { currentDevices: 5, maxDevices: 5 },
    });
    // The device itself is left out of the count: the question is "may THIS
    // device be active", so a concurrent restore of the same device that
    // committed first yields NOT_REMOVED under the lock, not a limit refusal.
    expect(admitPartnerDeviceCapacity).toHaveBeenCalledWith(tx, {
      orgId: ORG,
      expectedPartnerId: PARTNER,
      excludeDeviceId: DEV,
    });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
    expect(calls).not.toContain('update');
  });

  it('admits on the partner row BEFORE locking the devices row (enrollment lock order)', async () => {
    const { tx, calls } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(admitPartnerDeviceCapacity).mockImplementationOnce(async () => {
      calls.push('admit');
      return { allowed: true, partnerId: PARTNER, maxDevices: 5, activeCount: 4 };
    });

    await restoreRemovedDevice(tx, DEV, AUTHORIZED);

    for (const step of ['admit', 'lock', 'update']) {
      expect(calls.indexOf(step), `${step} was never recorded`).toBeGreaterThanOrEqual(0);
    }
    expect(calls.indexOf('admit')).toBeLessThan(calls.indexOf('lock'));
  });

  it('skips admission for a device that takes no licensed slot (ephemeral or parked)', async () => {
    const { tx, calls } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(deviceTakesLicensedSlot).mockResolvedValueOnce(false);
    vi.mocked(admitPartnerDeviceCapacity).mockResolvedValue({
      allowed: false,
      partnerId: PARTNER,
      maxDevices: 5,
      activeCount: 5,
    });

    await restoreRemovedDevice(tx, DEV, AUTHORIZED);

    expect(deviceTakesLicensedSlot).toHaveBeenCalledWith(tx, DEV);
    expect(admitPartnerDeviceCapacity).not.toHaveBeenCalled();
    expect(calls).toContain('update');
  });

  it('answers NOT_REMOVED, not a limit refusal, for a device that is already active', async () => {
    const { tx } = makeTx({ lockRow: { ...REMOVED_ROW, status: 'online' } });

    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'NOT_REMOVED',
    });
    expect(admitPartnerDeviceCapacity).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND without admitting when the device does not exist', async () => {
    const { tx } = makeTx({ lockRow: null });

    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(admitPartnerDeviceCapacity).not.toHaveBeenCalled();
  });

  it.each([
    ['moved to another org before the pre-read', { targetRow: { ...REMOVED_ROW, org_id: 'other-org', partner_id: PARTNER } }],
    ['moved to another org before the lock', { lockRow: { ...REMOVED_ROW, org_id: 'other-org' }, targetRow: { ...REMOVED_ROW, partner_id: PARTNER } }],
    ['moved to another site before the lock', { lockRow: { ...REMOVED_ROW, site_id: 'other-site' }, targetRow: { ...REMOVED_ROW, partner_id: PARTNER } }],
    ['changed its licensed standing before the lock', { lockRow: { ...REMOVED_ROW, is_ephemeral: true }, targetRow: { ...REMOVED_ROW, partner_id: PARTNER } }],
  ])('refuses with STATE_CHANGED when the device %s', async (_name, script) => {
    const { tx, calls } = makeTx({ lockRow: REMOVED_ROW, ...script });

    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'STATE_CHANGED',
      status: 409,
    });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
    expect(calls).not.toContain('update');
  });

  it('maps a changed org-to-partner mapping during admission to STATE_CHANGED', async () => {
    const { tx } = makeTx({ lockRow: REMOVED_ROW });
    vi.mocked(admitPartnerDeviceCapacity).mockRejectedValueOnce(
      new PartnerDeviceCapacityError('ORG_PARTNER_CHANGED', 'Organization partner changed during device admission'),
    );

    await expect(restoreRemovedDevice(tx, DEV, AUTHORIZED)).rejects.toMatchObject({
      code: 'STATE_CHANGED',
      status: 409,
    });
    expect(releaseDeviceRemoveReason).not.toHaveBeenCalled();
  });
});

describe('purgeRemovedDevice', () => {
  it('re-checks status under the lock and refuses a device that was restored concurrently', async () => {
    const { tx } = makeTx({ lockRow: { id: DEV, status: 'offline', link_group_id: null } });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'NOT_REMOVED' });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the lock returns no row', async () => {
    const { tx } = makeTx({ lockRow: null });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('refuses while a device_remove uninstall is still pending', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      pendingUninstall: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'UNINSTALL_PENDING',
      status: 409,
    });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it('checks for the pending uninstall only AFTER the devices row is locked', async () => {
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      pendingUninstall: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });
    expect(calls.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('pending-check')).toBeGreaterThanOrEqual(0);
    // Lock order is non-negotiable: devices FIRST, device_commands second.
    // The inverse order against a concurrent Remove (which locks devices then
    // writes device_commands) is a textbook AB-BA deadlock (40P01).
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('pending-check'));
  });

  it('refuses while the device has a backup snapshot under legal hold or immutability', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      protectedBackupSnapshot: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
      code: 'BACKUP_PROTECTED',
      status: 409,
    });
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
  });

  it.each(['backup_policy', 'configuration_policy'] as const)(
    'refuses while a %s legal hold applies to the device, before any cascade (#7982)',
    async (source) => {
      vi.mocked(findPolicyBackupLegalHoldInContext).mockResolvedValue(source);
      const { tx } = makeTx({
        lockRow: { id: DEV, status: 'decommissioned', org_id: ORG, link_group_id: null },
      });
      await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({
        code: 'BACKUP_PROTECTED',
        status: 409,
      });
      expect(deleteDeviceCascade).not.toHaveBeenCalled();
      // Narrowed to THIS device, in the device's org, with the hold rows
      // locked FOR SHARE so a concurrent "set hold" cannot slip in between
      // this check and the cascade in the same transaction.
      expect(findPolicyBackupLegalHoldInContext).toHaveBeenCalledWith(ORG, { deviceId: DEV, lockForShare: true });
    },
  );

  it('purges when no snapshot- or policy-level hold applies', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', org_id: ORG, link_group_id: null },
    });
    await purgeRemovedDevice(tx, DEV);
    expect(findPolicyBackupLegalHoldInContext).toHaveBeenCalledWith(ORG, { deviceId: DEV, lockForShare: true });
    expect(deleteDeviceCascade).toHaveBeenCalledTimes(1);
  });

  it('bounds the policy-hold FOR SHARE wait and restores the caller lock_timeout afterwards', async () => {
    let callsAtCheck: string[] = [];
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', org_id: ORG, link_group_id: null },
    });
    vi.mocked(findPolicyBackupLegalHoldInContext).mockImplementation(async () => {
      callsAtCheck = [...calls];
      return null;
    });
    await purgeRemovedDevice(tx, DEV);
    // The check runs with the bound in force: tightened after the org lookup
    // (the first tighten belongs to the devices-row lock) ...
    const orgLookup = callsAtCheck.indexOf('device-org');
    expect(orgLookup).toBeGreaterThanOrEqual(0);
    expect(callsAtCheck.lastIndexOf('tighten-lock-timeout')).toBeGreaterThan(orgLookup);
    // ... and put back right after it (makeTx reports a disabled prior, 0).
    expect(calls.slice(callsAtCheck.length)[0]).toBe('restore-lock-timeout');
  });

  it('checks for a protected backup snapshot only AFTER the pending-uninstall check', async () => {
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
      protectedBackupSnapshot: true,
    });
    await expect(purgeRemovedDevice(tx, DEV)).rejects.toMatchObject({ code: 'BACKUP_PROTECTED' });
    expect(calls.indexOf('pending-check')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('backup-hold-check')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('pending-check')).toBeLessThan(calls.indexOf('backup-hold-check'));
  });

  it('cascades and dissolves the link group when eligible', async () => {
    const { tx, calls } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: 'lg-1' },
    });
    const r = await purgeRemovedDevice(tx, DEV);
    expect(deleteDeviceCascade).toHaveBeenCalledWith(tx, DEV);
    expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledWith(tx, 'lg-1', undefined);
    expect(r.linkGroupDissolved).toBe(true);
    expect(calls.filter((c) => c !== 'tighten-lock-timeout')[0]).toBe('lock');
  });

  it('converts a hidden-survivor refusal into an opaque state conflict', async () => {
    const { LinkGroupSiteAccessError } = await import('./deviceLinkGroups');
    vi.mocked(dissolveLinkGroupIfBelowMinimum).mockRejectedValueOnce(
      new LinkGroupSiteAccessError(),
    );
    const { tx } = makeTx({
      lockRow: {
        id: DEV,
        status: 'decommissioned',
        site_id: 'site-visible',
        link_group_id: 'lg-1',
      },
    });

    await expect(purgeRemovedDevice(tx, DEV, ['site-visible'])).rejects.toMatchObject({
      code: 'STATE_CHANGED',
      message: 'Device access or linked state changed before deletion',
      status: 409,
    });
    expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledWith(
      tx,
      'lg-1',
      ['site-visible'],
    );
  });

  it('re-checks the target site under its row lock before starting the cascade', async () => {
    const { tx, calls } = makeTx({
      lockRow: {
        id: DEV,
        status: 'decommissioned',
        site_id: 'site-hidden',
        link_group_id: null,
      },
    });

    await expect(purgeRemovedDevice(tx, DEV, ['site-visible'])).rejects.toMatchObject({
      code: 'SITE_ACCESS_DENIED',
      status: 403,
    });
    expect(calls).not.toContain('pending-check');
    expect(deleteDeviceCascade).not.toHaveBeenCalled();
    expect(dissolveLinkGroupIfBelowMinimum).not.toHaveBeenCalled();
  });

  it('does not touch link groups when the purged device was unlinked', async () => {
    const { tx } = makeTx({
      lockRow: { id: DEV, status: 'decommissioned', link_group_id: null },
    });
    const r = await purgeRemovedDevice(tx, DEV);
    expect(dissolveLinkGroupIfBelowMinimum).not.toHaveBeenCalled();
    expect(r.linkGroupDissolved).toBe(false);
  });
});

describe('DeviceLifecycleError', () => {
  it('maps not-found, site-denied, and state conflicts to their HTTP domains', () => {
    expect(new DeviceLifecycleError('NOT_FOUND', 'x').status).toBe(404);
    expect(new DeviceLifecycleError('SITE_ACCESS_DENIED', 'x').status).toBe(403);
    expect(new DeviceLifecycleError('STATE_CHANGED', 'x').status).toBe(409);
    expect(new DeviceLifecycleError('NOT_REMOVED', 'x').status).toBe(409);
    expect(new DeviceLifecycleError('UNINSTALL_PENDING', 'x').status).toBe(409);
  });
});
