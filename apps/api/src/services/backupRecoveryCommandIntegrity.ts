/**
 * Delivery refresher for the bare-metal recovery commands (`bmr_recover`,
 * `bare_metal_rebuild`): decides whether the command may run on integrity
 * grounds (services/backupRestoreGate.ts) and adds the snapshot's integrity
 * block (services/backupRestoreIntegrity.ts) to the delivered payload.
 *
 * Both commands run against a recovery token, and the recovery bootstrap the
 * helper receives when it authenticates carries the same block (recovery
 * authentication enforces the same rules); the copy on the command lets a
 * helper check it before it contacts the recovery endpoints.
 *
 * Both are privileged restores. The command is:
 *   - deferred while the executing device has not reported its backup helper,
 *     or the snapshot's attestation is still being checked;
 *   - refused for a helper below integrity protocol 2, for a snapshot that
 *     failed its check or cannot be resolved to exactly one row, and for a
 *     snapshot without a usable attestation unless a confirmed authorization
 *     (services/backupRestoreAuthorization.ts) is bound to this command or to
 *     the recovery it runs, for the same snapshot, recovered device and
 *     command type.
 * A lookup that fails is an ordinary error: the row is released for a later
 * attempt, never delivered without a decided block.
 *
 * The snapshot is resolved in the executing device's organization: for
 * `bmr_recover` from the payload's `snapshotId` (internal id or provider
 * snapshot id), for `bare_metal_rebuild` from the recovery it runs (whose
 * device is the one being recovered; the executing device is the rebuild
 * host).
 */
import { and, eq, or } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { backupSnapshots } from '../db/schema/backup';
import { bareMetalRecoveries } from '../db/schema/bareMetalRecoveries';
import { devices } from '../db/schema/devices';
import { recordRestoreIntegrity, type RestoreIntegrityMetricStatus } from './backupMetrics';
import { BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE, effectiveHelperProtocol } from './backupHelperProtocols';
import {
  authorizationCovers,
  findCommandRestoreAuthorization,
  findRecoveryRestoreAuthorizations,
  type StoredRestoreAuthorization,
} from './backupRestoreAuthorization';
import {
  MIN_RESTORE_INTEGRITY_PROTOCOL,
  RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE,
  RESTORE_INTEGRITY_MESSAGES,
  decideRestoreGate,
  overrideIntegrityPayload,
} from './backupRestoreGate';
import {
  integrityMetricLabels,
  integrityPayload,
  resolveRestoreIntegrity,
  type RestoreIntegrity,
} from './backupRestoreIntegrity';
import {
  CommandDeliveryDeferredError,
  CommandDeliveryRefusedError,
  type DeliveryRefreshContext,
} from './commandDeliveryRefusal';
import { CommandTypes } from './commandTypes';

export const RECOVERY_INTEGRITY_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BMR_RECOVER,
  CommandTypes.BARE_METAL_REBUILD,
];

const INTEGRITY_FIELD = 'integrity';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoveryCommandIntegrityDeps {
  lookupDeviceOrg(deviceId: string): Promise<string | null>;
  /** Stored snapshot integrity protocol: a number, NULL = not reported yet, undefined = device not found. */
  lookupDeviceIntegrityProtocol(deviceId: string): Promise<number | null | undefined>;
  /** Run `fn` inside the delivery path's DB context, or an org-scoped one when none is held. */
  inOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
  /** Internal ids of the org's snapshots whose internal id or provider snapshot id is `ref` (at most two). */
  findSnapshotIds(orgId: string, ref: string): Promise<string[]>;
  /** The snapshot and the device being recovered by one of the org's recoveries. */
  findRecovery(orgId: string, recoveryId: string): Promise<{ snapshotDbId: string | null; deviceId: string } | null>;
  /** Authorizations bound to this command, or to the recovery it runs. */
  findAuthorizations(binding: { commandId: string; recoveryId: string | null }): Promise<StoredRestoreAuthorization[]>;
  resolve(snapshotDbId: string): Promise<RestoreIntegrity | null>;
  recordIntegrity(commandType: string, status: RestoreIntegrityMetricStatus, reason: string): void;
}

function inDeliveryContext<T>(fn: () => Promise<T>): Promise<T> {
  // Only the context-free direct push reaches here without a context; it
  // holds no transaction, so a short system read does not double-hold a
  // connection.
  return hasDbAccessContext() ? fn() : withSystemDbAccessContext(fn);
}

export const defaultRecoveryCommandIntegrityDeps: RecoveryCommandIntegrityDeps = {
  lookupDeviceOrg: (deviceId) => inDeliveryContext(async () => {
    const [row] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    return row?.orgId ?? null;
  }),
  lookupDeviceIntegrityProtocol: (deviceId) => inDeliveryContext(async () => {
    const [row] = await db
      .select({ protocol: devices.backupIntegrityProtocolVersion })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    return row ? row.protocol : undefined;
  }),
  inOrgContext: (orgId, fn) => {
    // Join the context the delivery path already holds rather than opening a
    // second pooled connection inside it.
    if (hasDbAccessContext()) return fn();
    return withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], label: 'backupRecoveryCommandIntegrity.delivery' },
      fn,
    );
  },
  findSnapshotIds: async (orgId, ref) => {
    const rows = await db
      .select({ id: backupSnapshots.id })
      .from(backupSnapshots)
      .where(and(
        eq(backupSnapshots.orgId, orgId),
        UUID_PATTERN.test(ref)
          ? or(eq(backupSnapshots.id, ref), eq(backupSnapshots.snapshotId, ref))
          : eq(backupSnapshots.snapshotId, ref),
      ))
      .limit(2);
    return rows.map((r) => r.id);
  },
  findRecovery: async (orgId, recoveryId) => {
    const [row] = await db
      .select({ snapshotDbId: bareMetalRecoveries.snapshotId, deviceId: bareMetalRecoveries.deviceId })
      .from(bareMetalRecoveries)
      .where(and(eq(bareMetalRecoveries.id, recoveryId), eq(bareMetalRecoveries.orgId, orgId)))
      .limit(1);
    return row ?? null;
  },
  findAuthorizations: async ({ commandId, recoveryId }) => {
    const [byCommand, byRecovery] = await Promise.all([
      findCommandRestoreAuthorization(commandId),
      recoveryId ? findRecoveryRestoreAuthorizations({ recoveryId }) : Promise.resolve([]),
    ]);
    return [...(byCommand ? [byCommand] : []), ...byRecovery];
  },
  resolve: (snapshotDbId) => resolveRestoreIntegrity(snapshotDbId),
  recordIntegrity: (commandType, status, reason) => recordRestoreIntegrity(commandType, status, reason),
};

type RecoveryTarget = { snapshotDbId: string; targetDeviceId: string; recoveryId: string | null };

async function resolveTarget(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  orgId: string,
  deps: RecoveryCommandIntegrityDeps,
): Promise<RecoveryTarget | null> {
  const recoveryId = typeof payload.recoveryId === 'string' && UUID_PATTERN.test(payload.recoveryId) ? payload.recoveryId : null;
  if (ctx.type === CommandTypes.BARE_METAL_REBUILD) {
    if (!recoveryId) return null;
    const recovery = await deps.findRecovery(orgId, recoveryId);
    return recovery?.snapshotDbId ? { snapshotDbId: recovery.snapshotDbId, targetDeviceId: recovery.deviceId, recoveryId } : null;
  }
  const ref = typeof payload.snapshotId === 'string' ? payload.snapshotId.trim() : '';
  if (ref) {
    const ids = await deps.findSnapshotIds(orgId, ref);
    return ids.length === 1 ? { snapshotDbId: ids[0]!, targetDeviceId: ctx.deviceId, recoveryId } : null;
  }
  if (!recoveryId) return null;
  const recovery = await deps.findRecovery(orgId, recoveryId);
  return recovery?.snapshotDbId ? { snapshotDbId: recovery.snapshotDbId, targetDeviceId: ctx.deviceId, recoveryId } : null;
}

function refuse(ctx: DeliveryRefreshContext, deps: RecoveryCommandIntegrityDeps, reason: string, message: string): never {
  deps.recordIntegrity(ctx.type, 'refused', reason);
  throw new CommandDeliveryRefusedError(message);
}

export async function deliverRecoveryCommandIntegrity(
  queuedPayload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  deps: RecoveryCommandIntegrityDeps = defaultRecoveryCommandIntegrityDeps,
): Promise<Record<string, unknown>> {
  // Written by the server at delivery, never taken from what was queued.
  const { [INTEGRITY_FIELD]: _queued, ...payload } = queuedPayload;

  const protocol = effectiveHelperProtocol(
    ctx.reportedBackupIntegrityProtocolVersion,
    await deps.lookupDeviceIntegrityProtocol(ctx.deviceId),
  );
  if (protocol === null) throw new CommandDeliveryDeferredError(BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE);
  if (!(protocol >= MIN_RESTORE_INTEGRITY_PROTOCOL)) {
    refuse(ctx, deps, 'helper_update_required', RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE);
  }

  const orgId = await deps.lookupDeviceOrg(ctx.deviceId);
  if (!orgId) refuse(ctx, deps, 'snapshot_unresolved', RESTORE_INTEGRITY_MESSAGES.snapshot_unresolved);

  return deps.inOrgContext(orgId, async () => {
    const target = await resolveTarget(payload, ctx, orgId, deps);
    const integrity = target ? await deps.resolve(target.snapshotDbId) : null;
    const decision = decideRestoreGate({
      commandType: ctx.type,
      integrity,
      targetDeviceId: target?.targetDeviceId ?? ctx.deviceId,
    });
    if (decision.kind === 'allow') {
      const labels = integrityMetricLabels(integrity);
      deps.recordIntegrity(ctx.type, labels.status as RestoreIntegrityMetricStatus, labels.reason);
      return { ...payload, [INTEGRITY_FIELD]: integrityPayload(integrity!) };
    }
    if (decision.kind === 'refuse') {
      if (decision.code === 'attestation_pending') throw new CommandDeliveryDeferredError(decision.message);
      refuse(ctx, deps, decision.code, decision.message);
    }
    const authorizations = await deps.findAuthorizations({ commandId: ctx.commandId, recoveryId: target!.recoveryId });
    const covering = authorizations.find((a) => authorizationCovers(a, {
      snapshotDbId: target!.snapshotDbId,
      targetDeviceId: target!.targetDeviceId,
      commandTypes: [ctx.type],
    }));
    if (!covering) refuse(ctx, deps, 'authorization_missing', RESTORE_INTEGRITY_MESSAGES.authorization_missing);
    deps.recordIntegrity(ctx.type, 'override', decision.reason);
    return { ...payload, [INTEGRITY_FIELD]: overrideIntegrityPayload(integrity!.snapshotId, covering.id) };
  });
}
