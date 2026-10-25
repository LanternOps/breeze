/**
 * Shared reads, locks and state transitions of reattach intents (#8318 wave
 * 1b, spec §4.3, §6.3–§6.5). Every function takes the caller's transaction
 * (system scope); none opens its own.
 *
 * Lock order (§6.4, F13), for every path that writes an intent:
 *   1. the partner's holding-area advisory lock (request, confirm);
 *   2. the two device rows, in ascending id order (FOR UPDATE at request and
 *      confirm, FOR KEY SHARE at phase 1);
 *   3. the intent row, FOR UPDATE;
 *   4. the `partners` row, last, only through admitPartnerDeviceCapacity
 *      (confirm with restore_decommissioned).
 * Nothing that writes an intent takes a device lock after the intent's. The
 * expiry sweep and an admin cancel take the intent alone.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import type { db } from '../../db';
import {
  deviceMtlsCertificates,
  deviceReattachIntents,
  deviceReattachments,
  devices,
  organizations,
  type DeviceReattachIntent,
} from '../../db/schema';
import { revokeCertificateNowOrEnqueue } from '../deviceMtlsCertificateLifecycle';
import { captureException } from '../sentry';
import { OPEN_REATTACH_INTENT_STATES, type ReattachCancelReason } from './protocol';

export type ReattachTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LockedReattachDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string;
  hostname: string;
  status: string;
  isEphemeral: boolean;
  agentTokenSuspendedAt: Date | null;
  installIncarnation: number;
  rebindProtocolVersion: number;
  createdAt: Date;
  decommissionedAt: Date | null;
  lastSeenAt: Date | null;
  watchdogLastSeen: Date | null;
  agentTokenHash: string | null;
  previousTokenHash: string | null;
  pendingTokenHash: string | null;
  watchdogTokenHash: string | null;
  previousWatchdogTokenHash: string | null;
  pendingWatchdogTokenHash: string | null;
  helperTokenHash: string | null;
  previousHelperTokenHash: string | null;
  pendingHelperTokenHash: string | null;
  orgType: string;
  orgPartnerId: string;
  orgStatus: string;
  orgDeletedAt: Date | null;
}

const lockedDeviceColumns = {
  id: devices.id,
  agentId: devices.agentId,
  orgId: devices.orgId,
  siteId: devices.siteId,
  hostname: devices.hostname,
  status: devices.status,
  isEphemeral: devices.isEphemeral,
  agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
  installIncarnation: devices.installIncarnation,
  rebindProtocolVersion: devices.rebindProtocolVersion,
  createdAt: devices.createdAt,
  decommissionedAt: devices.decommissionedAt,
  lastSeenAt: devices.lastSeenAt,
  watchdogLastSeen: devices.watchdogLastSeen,
  agentTokenHash: devices.agentTokenHash,
  previousTokenHash: devices.previousTokenHash,
  pendingTokenHash: devices.pendingTokenHash,
  watchdogTokenHash: devices.watchdogTokenHash,
  previousWatchdogTokenHash: devices.previousWatchdogTokenHash,
  pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
  helperTokenHash: devices.helperTokenHash,
  previousHelperTokenHash: devices.previousHelperTokenHash,
  pendingHelperTokenHash: devices.pendingHelperTokenHash,
  orgType: organizations.type,
  orgPartnerId: organizations.partnerId,
  orgStatus: organizations.status,
  orgDeletedAt: organizations.deletedAt,
};

/**
 * Lock the two device rows in ascending id order (one statement each, so the
 * order is deterministic) and read each with its org. `update` at request and
 * confirm; `key share` at phase 1 (it only needs the rows to stay put for the
 * pending certificate's FK, and never blocks a heartbeat's own-row write).
 */
export async function lockReattachDevices(
  tx: ReattachTx,
  deviceIds: readonly [string, string],
  mode: 'update' | 'key share',
): Promise<Map<string, LockedReattachDevice>> {
  const locked = new Map<string, LockedReattachDevice>();
  for (const id of [...new Set(deviceIds)].sort()) {
    const [row] = await tx
      .select(lockedDeviceColumns)
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(eq(devices.id, id))
      .limit(1)
      .for(mode, { of: devices });
    if (row) locked.set(id, row as LockedReattachDevice);
  }
  return locked;
}

export async function readIntentForUpdate(tx: ReattachTx, intentId: string): Promise<DeviceReattachIntent | null> {
  const [row] = await tx
    .select()
    .from(deviceReattachIntents)
    .where(eq(deviceReattachIntents.id, intentId))
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Lock every open intent naming this device in either role (FOR UPDATE), for
 * the holding-area housekeeping that runs under the holding-area lock and the
 * device lock (parked expiry and purge, §6.5).
 */
export async function lockOpenReattachIntentsOfDevice(tx: ReattachTx, deviceId: string): Promise<DeviceReattachIntent[]> {
  return tx
    .select()
    .from(deviceReattachIntents)
    .where(and(
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
      or(eq(deviceReattachIntents.sourceDeviceId, deviceId), eq(deviceReattachIntents.targetDeviceId, deviceId)),
    ))
    .for('update');
}

/** Is either device in an open intent, in either role? */
export async function anyDeviceInOpenIntent(tx: ReattachTx, deviceIds: readonly string[]): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceReattachIntents.id })
    .from(deviceReattachIntents)
    .where(and(
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
      or(
        inArray(deviceReattachIntents.sourceDeviceId, [...deviceIds]),
        inArray(deviceReattachIntents.targetDeviceId, [...deviceIds]),
      ),
    ))
    .limit(1);
  return Boolean(row);
}

/** Was this device ever the SOURCE of a confirmed reattach (retired)? A ledger read. */
export async function wasRetiredReattachSource(tx: ReattachTx, deviceId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: deviceReattachments.id })
    .from(deviceReattachments)
    .where(eq(deviceReattachments.sourceDeviceId, deviceId))
    .limit(1);
  return Boolean(row);
}

/**
 * Demote the intent's staged (pending_activation) certificate to
 * pending_revocation, due now. Returns the id to revoke after commit, or null
 * when there was none (mTLS not configured, never staged, already moved on).
 */
export async function demoteStagedCertificate(
  tx: ReattachTx,
  certificateId: string | null,
  now: Date,
): Promise<string | null> {
  if (!certificateId) return null;
  const demoted = await tx
    .update(deviceMtlsCertificates)
    .set({ state: 'pending_revocation', nextRevokeAttemptAt: now, updatedAt: now })
    .where(and(
      eq(deviceMtlsCertificates.id, certificateId),
      eq(deviceMtlsCertificates.state, 'pending_activation'),
    ))
    .returning({ id: deviceMtlsCertificates.id });
  return demoted[0]?.id ?? null;
}

export interface EndedIntent {
  intentId: string;
  state: 'cancelled' | 'expired';
  cancelReason: ReattachCancelReason | null;
  /** Certificates to revoke once the transaction has committed. */
  revokeCertificateIds: string[];
}

/**
 * End an open intent (cancel with a reason, or expire): the staged agent,
 * watchdog and helper hashes are discarded, the confirmation hash is KEPT
 * (for the typed answer of §6.4) and the pending certificate is demoted.
 * Compare-and-set on the open states; null if the intent was not open.
 */
export async function endIntentInTransaction(
  tx: ReattachTx,
  intent: Pick<DeviceReattachIntent, 'id' | 'stagedMtlsCertificateId'>,
  outcome: { state: 'cancelled'; reason: ReattachCancelReason } | { state: 'expired' },
  now: Date = new Date(),
): Promise<EndedIntent | null> {
  const cancelReason = outcome.state === 'cancelled' ? outcome.reason : null;
  const ended = await tx
    .update(deviceReattachIntents)
    .set({
      state: outcome.state,
      cancelReason,
      stagedTokenHash: null,
      stagedWatchdogTokenHash: null,
      stagedHelperTokenHash: null,
    })
    .where(and(
      eq(deviceReattachIntents.id, intent.id),
      inArray(deviceReattachIntents.state, [...OPEN_REATTACH_INTENT_STATES]),
    ))
    .returning({ id: deviceReattachIntents.id });
  if (ended.length !== 1) return null;
  const demoted = await demoteStagedCertificate(tx, intent.stagedMtlsCertificateId, now);
  return {
    intentId: intent.id,
    state: outcome.state,
    cancelReason,
    revokeCertificateIds: demoted ? [demoted] : [],
  };
}

/**
 * Revoke certificates at the provider after the transaction that demoted them
 * committed (never inside it: a provider HTTP call must not hold a DB
 * transaction, #1105). Never throws; the five-minute sweep
 * (jobs/mtlsCertificateRevocation.ts) is the backstop.
 */
export async function revokeCertificatesAfterCommit(certificateIds: readonly string[]): Promise<void> {
  for (const id of certificateIds) {
    try {
      await revokeCertificateNowOrEnqueue(id);
    } catch (err) {
      console.error('[deviceReattach] post-commit certificate revoke failed; the sweep will retry it:', {
        certificateId: id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      captureException(err);
    }
  }
}
