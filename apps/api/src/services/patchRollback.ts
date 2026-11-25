import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { devicePatches, devices, patches, patchRollbacks } from '../db/schema';
import type { CommandPayload, QueueCommandForExecutionResult } from './commandQueue';
import { CommandTypes } from './commandTypes';

export type RollbackDevice = { id: string; orgId: string; siteId: string | null };

/**
 * The rollback shared by POST /patches/:id/rollback and the AI `manage_patches`
 * rollback action (#12492). Each caller brings its own access rule and its own
 * way to reach a device: AI code may only use services/aiDispatch.ts.
 *
 * Queues one rollback command per accessible device that has the patch
 * installed, then records a `patch_rollbacks` row for each command that
 * queued. Returns null when the patch does not exist.
 */
export async function queuePatchRollbacks(input: {
  patchId: string;
  deviceIds?: string[];
  reason: string | null;
  initiatedBy: string;
  canAccess: (device: RollbackDevice) => boolean;
  queue: (device: RollbackDevice, type: string, payload: CommandPayload) => Promise<QueueCommandForExecutionResult>;
}) {
  const { patchId: id, deviceIds, reason, initiatedBy, canAccess, queue } = input;

  const [patch] = await db
    .select({
      id: patches.id,
      source: patches.source,
      externalId: patches.externalId,
      title: patches.title
    })
    .from(patches)
    .where(eq(patches.id, id))
    .limit(1);

  if (!patch) return null;

  let candidateDevices: RollbackDevice[] = [];
  let missingDeviceIds: string[] = [];
  let notInstalledDeviceIds: string[] = [];

  if (deviceIds && deviceIds.length > 0) {
    // Bind each rollback target to the device's own `installed` observation
    // (#5565), mirroring how install binds to `pending`. A device
    // that exists but never reported this patch as installed is skipped
    // rather than sent a rollback for a catalog row it has no relation to.
    const requestedDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        observationId: devicePatches.id
      })
      .from(devices)
      .leftJoin(devicePatches, and(
        eq(devicePatches.deviceId, devices.id),
        eq(devicePatches.patchId, id),
        eq(devicePatches.status, 'installed')
      ))
      .where(inArray(devices.id, deviceIds));

    const foundIds = new Set(requestedDevices.map((device) => device.id));
    missingDeviceIds = deviceIds.filter((deviceId) => !foundIds.has(deviceId));
    // Access is decided before install state is revealed: a device the
    // caller cannot reach is reported as inaccessible whether or not it has
    // the patch, so the response never discloses per-device install status
    // for devices outside the caller's scope.
    notInstalledDeviceIds = requestedDevices
      .filter((device) => device.observationId === null && canAccess(device))
      .map((device) => device.id);
    candidateDevices = requestedDevices
      .filter((device) => device.observationId !== null || !canAccess(device))
      .map(({ id: deviceId, orgId, siteId }) => ({ id: deviceId, orgId, siteId }));
  } else {
    candidateDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId
      })
      .from(devicePatches)
      .innerJoin(devices, eq(devicePatches.deviceId, devices.id))
      .where(
        and(
          eq(devicePatches.patchId, id),
          eq(devicePatches.status, 'installed')
        )
      );
  }

  const accessibleDevices = candidateDevices.filter(canAccess);
  const inaccessibleDeviceIds = candidateDevices
    .filter((device) => !canAccess(device))
    .map((device) => device.id);

  const payload = { patchIds: [id], patches: [patch], reason };
  const queued: Array<{ deviceId: string; commandId: string; commandStatus: string }> = [];
  const failed: Array<{ deviceId: string; error: string }> = [];
  // One device at a time, each in its own savepoint, which must never run
  // beside a sibling's statements (docs/agents/tenancy-rls.md). A thrown
  // database error rolls back only that device; the others still get rows.
  for (const device of accessibleDevices) {
    let result: QueueCommandForExecutionResult;
    try {
      result = await withDbTransaction(() => queue(device, CommandTypes.ROLLBACK_PATCHES, payload));
    } catch {
      result = {};
    }
    // A cancelled command carries both a row and an error: it will never run, so it is a failure.
    if (result.command && !result.error) {
      queued.push({ deviceId: device.id, commandId: result.command.id, commandStatus: result.command.status });
    } else {
      failed.push({ deviceId: device.id, error: result.error ?? 'Rollback command was not queued' });
    }
  }

  if (queued.length > 0) {
    await db
      .insert(patchRollbacks)
      .values(
        queued.map((entry) => ({
          deviceId: entry.deviceId,
          patchId: id,
          reason,
          status: 'pending' as const,
          initiatedBy
        }))
      );
  }

  return {
    patch,
    accessibleDevices,
    queued,
    failed,
    skipped: { missingDeviceIds, notInstalledDeviceIds, inaccessibleDeviceIds }
  };
}
