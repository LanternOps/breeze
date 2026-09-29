/**
 * Expiry and purge of parked devices — one device per system-context
 * transaction.
 *
 * Expiry removes a parked device: status `decommissioned`, a `self_uninstall`
 * queued through the uninstall drain (so the agent removes itself when it next
 * checks in), and an `expired` ledger row. It runs from the hourly expiry job
 * (a device past PARKED_DEVICE_TTL_DAYS) and from the incident action that
 * expires every device one deploy key parked.
 *
 * Purge hard-deletes a holding-org device that expired more than
 * PARKED_PURGE_AFTER_EXPIRY_DAYS ago (the general removed-device purge skips
 * orgs without a lifecycle policy, and a holding org never has one), through
 * the same hardened `purgeRemovedDevice` the Permanently Delete button uses,
 * and writes a `purged` ledger row.
 *
 * Both take the per-partner holding-area lock FIRST, then the device row —
 * the same order as assignment — and re-check, under those locks, that the
 * device is still parked in this partner's holding org. A device assigned
 * while a sweep was running is therefore never expired or purged under its
 * new org, and an assignment that loses the race sees a removed device.
 */
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devicePoolAssignmentEvents } from '../../db/schema';
import { decommissionDeviceInTransaction } from '../deviceDecommission';
import { DeviceLifecycleError, purgeRemovedDevice } from '../deviceLifecycle';
import { createAuditLog } from '../auditService';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { invalidateOrgDeviceCount } from '../agentOrgRateLimit';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
import { disconnectAgent } from '../../routes/agentWs';
import { isUnassignedPoolOrgType } from './orgType';
import { lockPartnerHoldingArea } from './holdingAreaLock';
import { lockDeviceForAssignment, type LockedParkedDevice } from './assignParkedDeviceSteps';

const LOG_PREFIX = '[parkedExpiry]';

export type ParkedExpiryReason = 'parking_window' | 'deploy_key_incident';

export type ParkedExpirySkip =
  /** Gone, or not this partner's device. */
  | 'NOT_FOUND'
  /** No longer in a holding org — assigned meanwhile. */
  | 'NOT_PARKED'
  /** Already removed. */
  | 'ALREADY_REMOVED'
  /** Parked more recently than the caller's cutoff (re-checked under the lock). */
  | 'NOT_DUE';

export type ParkedExpiryOutcome =
  | { expired: true; deviceId: string; ledgerEventId: string; uninstallQueued: boolean }
  | { expired: false; deviceId: string; reason: ParkedExpirySkip };

/** Test seam; production callers never pass it. */
export interface ParkedExpiryHooks {
  afterDeviceLock?: (deviceId: string) => Promise<void>;
}

const inSystemTransaction = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(fn)));

function report(label: string, deviceId: string, err: unknown): void {
  console.error(`${LOG_PREFIX} post-commit ${label} failed for ${deviceId}:`, err);
  captureException(err);
}

export async function expireParkedDevice(
  input: {
    partnerId: string;
    deviceId: string;
    /** The user behind an incident action; null for the scheduled job. */
    actorUserId: string | null;
    reason: ParkedExpiryReason;
    /** Expire only if parked before this instant (the job's window, re-applied under the lock). */
    cutoff?: Date;
    /** The deploy key an incident action named, recorded on the ledger row. */
    deployKeyId?: string;
  },
  options: { hooks?: ParkedExpiryHooks } = {},
): Promise<ParkedExpiryOutcome> {
  const { partnerId, deviceId } = input;
  type Locked =
    | { skip: ParkedExpirySkip }
    | { device: LockedParkedDevice; ledgerEventId: string; uninstallQueued: boolean };
  const result = await inSystemTransaction(async (tx): Promise<Locked> => {
    await lockPartnerHoldingArea(tx, partnerId);
    const device = await lockDeviceForAssignment(tx, deviceId);
    if (!device || device.orgPartnerId !== partnerId) return { skip: 'NOT_FOUND' };
    if (!isUnassignedPoolOrgType(device.orgType)) return { skip: 'NOT_PARKED' };
    if (device.status === 'decommissioned') return { skip: 'ALREADY_REMOVED' };
    if (input.cutoff && device.createdAt.getTime() >= input.cutoff.getTime()) return { skip: 'NOT_DUE' };
    await options.hooks?.afterDeviceLock?.(device.id);

    // The same decommission the device Remove route performs: status, the
    // cancellation of ordinary queued work and its owning records, and the
    // queued agent uninstall — one transaction.
    const decommission = await decommissionDeviceInTransaction(tx, {
      deviceId: device.id,
      queueUninstall: true,
      actorUserId: input.actorUserId,
    });
    const now = decommission.updated?.decommissionedAt ?? new Date();

    const [ledger] = await tx
      .insert(devicePoolAssignmentEvents)
      .values({
        partnerId,
        deviceId: device.id,
        deviceAgentId: device.agentId,
        eventType: 'expired',
        fromOrgId: device.orgId,
        toOrgId: null,
        deployKeyId: input.deployKeyId ?? null,
        parkedAt: device.createdAt,
        parkedDurationSeconds: Math.max(0, Math.floor((now.getTime() - device.createdAt.getTime()) / 1000)),
      })
      .returning({ id: devicePoolAssignmentEvents.id });
    if (!ledger) throw new Error('expired ledger row was not written');

    return {
      device,
      ledgerEventId: ledger.id,
      uninstallQueued: decommission.uninstallQueued,
    };
  });

  if ('skip' in result) return { expired: false, deviceId, reason: result.skip };

  // Post-commit, each isolated: the device is already removed.
  const { device } = result;
  try {
    await createAuditLog({
      orgId: device.orgId,
      actorType: input.actorUserId ? 'user' : 'system',
      actorId: input.actorUserId ?? ANONYMOUS_ACTOR_ID,
      action: 'device.parked.expired',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        partnerId,
        reason: input.reason,
        ledgerEventId: result.ledgerEventId,
        uninstallQueued: result.uninstallQueued,
        ...(input.deployKeyId ? { deployKeyId: input.deployKeyId } : {}),
        ...(input.actorUserId ? {} : { job: 'parked-device-expiry' }),
      },
      result: 'success',
      initiatedBy: input.actorUserId ? 'manual' : 'schedule',
    });
  } catch (err) {
    report('audit', device.id, err);
  }
  try {
    disconnectAgent(device.agentId, 4041, 'Device decommissioned');
  } catch (err) {
    report('agent disconnect', device.id, err);
  }
  invalidateOrgDeviceCount(getRedis(), device.orgId).catch((err: unknown) => report('device-count cache invalidation', device.id, err));

  return { expired: true, deviceId, ledgerEventId: result.ledgerEventId, uninstallQueued: result.uninstallQueued };
}

export type ParkedPurgeSkip =
  | 'NOT_FOUND'
  | 'NOT_PARKED'
  /** Not removed, or removed more recently than the cutoff. */
  | 'NOT_DUE'
  /** A `device_remove` uninstall is still collectable; comes back on a later run. */
  | 'UNINSTALL_PENDING'
  /** Another purge refusal (for example a backup snapshot under hold). */
  | 'REFUSED';

export type ParkedPurgeOutcome =
  | { purged: true; deviceId: string; hostname: string; holdingOrgId: string }
  | { purged: false; deviceId: string; reason: ParkedPurgeSkip };

export async function purgeExpiredParkedDevice(input: {
  partnerId: string;
  deviceId: string;
  /** Purge only if removed before this instant (re-applied under the lock). */
  cutoff: Date;
}): Promise<ParkedPurgeOutcome> {
  const { partnerId, deviceId } = input;
  try {
    return await inSystemTransaction(async (tx): Promise<ParkedPurgeOutcome> => {
      await lockPartnerHoldingArea(tx, partnerId);
      const device = await lockDeviceForAssignment(tx, deviceId);
      if (!device || device.orgPartnerId !== partnerId) return { purged: false, deviceId, reason: 'NOT_FOUND' };
      if (!isUnassignedPoolOrgType(device.orgType)) return { purged: false, deviceId, reason: 'NOT_PARKED' };
      const [stamp] = (await tx.execute(
        sql`SELECT decommissioned_at FROM devices WHERE id = ${device.id}`,
      )) as unknown as Array<{ decommissioned_at: Date | string | null }>;
      const removedAt = stamp?.decommissioned_at ? new Date(stamp.decommissioned_at) : null;
      if (
        device.status !== 'decommissioned'
        || removedAt === null
        || Number.isNaN(removedAt.getTime())
        || removedAt.getTime() >= input.cutoff.getTime()
      ) {
        return { purged: false, deviceId, reason: 'NOT_DUE' };
      }

      await purgeRemovedDevice(tx, device.id);
      await tx.insert(devicePoolAssignmentEvents).values({
        partnerId,
        deviceId: device.id,
        deviceAgentId: device.agentId,
        eventType: 'purged',
        fromOrgId: device.orgId,
        toOrgId: null,
        parkedAt: device.createdAt,
      });
      return { purged: true, deviceId, hostname: device.hostname, holdingOrgId: device.orgId };
    });
  } catch (err) {
    // Caught outside the transaction, so the refusal still rolled it back.
    if (err instanceof DeviceLifecycleError) {
      return { purged: false, deviceId, reason: err.code === 'UNINSTALL_PENDING' ? 'UNINSTALL_PENDING' : 'REFUSED' };
    }
    throw err;
  }
}
