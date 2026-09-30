/**
 * Delivery refresher for the bare-metal recovery commands (`bmr_recover`,
 * `bare_metal_rebuild`): adds the snapshot's integrity expectation
 * (services/backupRestoreIntegrity.ts) to the delivered payload.
 *
 * Both commands run against a recovery token, and the recovery bootstrap the
 * helper receives when it authenticates carries the same block; the copy on
 * the command lets a helper check it before it contacts the recovery
 * endpoints. Informational in this release: nothing is refused here.
 *
 * The snapshot is resolved in the target device's organization: for
 * `bmr_recover` from the payload's `snapshotId` (internal id or provider
 * snapshot id), for `bare_metal_rebuild` from the recovery it runs. When it
 * cannot be resolved to exactly one row, or the lookup fails, the command goes
 * without a block.
 */
import { and, eq, or } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { backupSnapshots } from '../db/schema/backup';
import { bareMetalRecoveries } from '../db/schema/bareMetalRecoveries';
import { devices } from '../db/schema/devices';
import { recordRestoreIntegrity, type RestoreIntegrityMetricStatus } from './backupMetrics';
import {
  INTEGRITY_LOOKUP_FAILED,
  integrityMetricLabels,
  integrityPayload,
  lookupIntegrityInformational,
  resolveRestoreIntegrity,
  type RestoreIntegrity,
} from './backupRestoreIntegrity';
import type { DeliveryRefreshContext } from './commandDeliveryRefusal';
import { CommandTypes } from './commandTypes';

export const RECOVERY_INTEGRITY_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BMR_RECOVER,
  CommandTypes.BARE_METAL_REBUILD,
];

const INTEGRITY_FIELD = 'integrity';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoveryCommandIntegrityDeps {
  lookupDeviceOrg(deviceId: string): Promise<string | null>;
  /** Run `fn` inside the delivery path's DB context, or an org-scoped one when none is held. */
  inOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
  /** Internal ids of the org's snapshots whose internal id or provider snapshot id is `ref` (at most two). */
  findSnapshotIds(orgId: string, ref: string): Promise<string[]>;
  findRecoverySnapshotId(orgId: string, recoveryId: string): Promise<string | null>;
  resolve(snapshotDbId: string): Promise<RestoreIntegrity | null>;
  recordIntegrity(commandType: string, status: RestoreIntegrityMetricStatus, reason: string): void;
}

export const defaultRecoveryCommandIntegrityDeps: RecoveryCommandIntegrityDeps = {
  lookupDeviceOrg: async (deviceId) => {
    const load = async () => {
      const [row] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
      return row?.orgId ?? null;
    };
    // Only the context-free direct push reaches here without a context; it
    // holds no transaction, so a short system read does not double-hold a
    // connection.
    return hasDbAccessContext() ? load() : withSystemDbAccessContext(load);
  },
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
  findRecoverySnapshotId: async (orgId, recoveryId) => {
    const [row] = await db
      .select({ snapshotId: bareMetalRecoveries.snapshotId })
      .from(bareMetalRecoveries)
      .where(and(eq(bareMetalRecoveries.id, recoveryId), eq(bareMetalRecoveries.orgId, orgId)))
      .limit(1);
    return row?.snapshotId ?? null;
  },
  resolve: (snapshotDbId) => resolveRestoreIntegrity(snapshotDbId),
  recordIntegrity: (commandType, status, reason) => recordRestoreIntegrity(commandType, status, reason),
};

async function resolveSnapshotDbId(
  payload: Record<string, unknown>,
  type: string,
  orgId: string,
  deps: RecoveryCommandIntegrityDeps,
): Promise<string | null> {
  const recoveryId = typeof payload.recoveryId === 'string' && UUID_PATTERN.test(payload.recoveryId) ? payload.recoveryId : null;
  if (type === CommandTypes.BARE_METAL_REBUILD) {
    return recoveryId ? deps.findRecoverySnapshotId(orgId, recoveryId) : null;
  }
  const ref = typeof payload.snapshotId === 'string' ? payload.snapshotId.trim() : '';
  if (ref) {
    const ids = await deps.findSnapshotIds(orgId, ref);
    return ids.length === 1 ? ids[0]! : null;
  }
  return recoveryId ? deps.findRecoverySnapshotId(orgId, recoveryId) : null;
}

export async function deliverRecoveryCommandIntegrity(
  queuedPayload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  deps: RecoveryCommandIntegrityDeps = defaultRecoveryCommandIntegrityDeps,
): Promise<Record<string, unknown>> {
  // Written by the server at delivery, never taken from what was queued.
  const { [INTEGRITY_FIELD]: _queued, ...payload } = queuedPayload;

  // Informational: a failed lookup never holds the command back.
  const snapshotRef = typeof payload.snapshotId === 'string'
    ? payload.snapshotId
    : typeof payload.recoveryId === 'string' ? `recovery:${payload.recoveryId}` : null;
  const integrity = await lookupIntegrityInformational(
    { label: `${ctx.type} delivery`, commandId: ctx.commandId, deviceId: ctx.deviceId, snapshotRef },
    async () => {
      const orgId = await deps.lookupDeviceOrg(ctx.deviceId);
      if (!orgId) return null;
      return deps.inOrgContext(orgId, async () => {
        const snapshotDbId = await resolveSnapshotDbId(payload, ctx.type, orgId, deps);
        return snapshotDbId ? deps.resolve(snapshotDbId) : null;
      });
    },
  );

  const labels = integrityMetricLabels(integrity);
  deps.recordIntegrity(ctx.type, labels.status as RestoreIntegrityMetricStatus, labels.reason);
  return integrity && integrity !== INTEGRITY_LOOKUP_FAILED
    ? { ...payload, [INTEGRITY_FIELD]: integrityPayload(integrity) }
    : payload;
}
