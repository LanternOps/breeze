import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isWorkloadRuntimeEnabled,
  type WorkloadReportItem,
  type WorkloadRuntime,
  type WorkloadsReport,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { deviceWorkloadRuntimes, deviceWorkloads, devices } from '../../db/schema';
import { lockDeviceInventory } from '../inventoryChildSync';
import { planWorkloadSync, type WorkloadRuntimePlan } from './plan';
import { getDeviceWorkloadInventorySettings } from './settings';

export interface IngestWorkloadsArgs {
  deviceId: string;
  orgId: string;
  report: WorkloadsReport;
  receivedAt: Date;
}

export interface IngestWorkloadsResult {
  accepted: true;
  runtimes: Array<{ runtime: WorkloadRuntime; applied: boolean }>;
}

/** Rows per INSERT … ON CONFLICT statement (≈25 parameters each, well under the driver cap). */
const UPSERT_CHUNK = 200;

const toDate = (value: string | null): Date | null => (value ? new Date(value) : null);

function toWorkloadRow(args: IngestWorkloadsArgs, runtime: WorkloadRuntime, item: WorkloadReportItem) {
  return {
    deviceId: args.deviceId,
    orgId: args.orgId,
    // Only enumerated runtimes ever reach here (the planner emits no upserts for containerd).
    runtime: runtime as 'docker' | 'podman' | 'hyperv' | 'proxmox',
    kind: item.kind,
    workloadId: item.workloadId,
    name: item.name,
    state: item.state,
    rawState: item.rawState,
    imageRef: item.imageRef,
    imageRepository: item.imageRepository,
    imageTag: item.imageTag,
    imageDigest: item.imageDigest,
    imageId: item.imageId,
    guestOs: item.guestOs,
    composeProject: item.composeProject,
    composeService: item.composeService,
    composeWorkingDir: item.composeWorkingDir,
    restartPolicy: item.restartPolicy,
    cpuCount: item.cpuCount,
    memoryMb: item.memoryMb,
    startedAt: toDate(item.startedAt),
    runtimeCreatedAt: toDate(item.runtimeCreatedAt),
    firstSeenAt: args.receivedAt,
    lastSeenAt: args.receivedAt,
    updatedAt: args.receivedAt,
  };
}

async function applyRuntimePlan(args: IngestWorkloadsArgs, plan: WorkloadRuntimePlan) {
  // Deletes first so the (device_id, runtime, workload_id) unique key is trivially satisfied.
  // The runtime row is never deleted: an absent runtime is upserted as `absent`.
  if (plan.workloads.deleteIds.length > 0) {
    await db
      .delete(deviceWorkloads)
      .where(and(eq(deviceWorkloads.deviceId, args.deviceId), inArray(deviceWorkloads.id, plan.workloads.deleteIds)));
  }
  if (plan.runtimeRow) {
    const row = plan.runtimeRow;
    await db
      .insert(deviceWorkloadRuntimes)
      .values({
        deviceId: args.deviceId,
        orgId: args.orgId,
        runtime: row.runtime,
        detection: row.detection,
        collection: row.collection,
        complete: row.complete,
        runtimeVersion: row.runtimeVersion,
        observedCount: row.observedCount,
        reportedCount: row.reportedCount,
        lastError: row.lastError,
        collectedAt: row.collectedAt,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        updatedAt: args.receivedAt,
      })
      .onConflictDoUpdate({
        target: [deviceWorkloadRuntimes.deviceId, deviceWorkloadRuntimes.runtime],
        set: {
          detection: sql`excluded.detection`,
          collection: sql`excluded.collection`,
          complete: sql`excluded.complete`,
          runtimeVersion: sql`excluded.runtime_version`,
          observedCount: sql`excluded.observed_count`,
          reportedCount: sql`excluded.reported_count`,
          lastError: sql`excluded.last_error`,
          collectedAt: sql`excluded.collected_at`,
          lastAttemptAt: sql`excluded.last_attempt_at`,
          // Only an ok collection advances last_success_at; null = keep the stored value.
          lastSuccessAt: sql`COALESCE(excluded.last_success_at, ${deviceWorkloadRuntimes.lastSuccessAt})`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  const upserts = [...plan.workloads.updates.map((update) => update.row), ...plan.workloads.inserts];
  for (let offset = 0; offset < upserts.length; offset += UPSERT_CHUNK) {
    await db
      .insert(deviceWorkloads)
      .values(upserts.slice(offset, offset + UPSERT_CHUNK).map((item) => toWorkloadRow(args, plan.runtime, item)))
      .onConflictDoUpdate({
        // The unique key keeps ids and first_seen_at stable: neither is in `set`.
        target: [deviceWorkloads.deviceId, deviceWorkloads.runtime, deviceWorkloads.workloadId],
        set: {
          kind: sql`excluded.kind`,
          name: sql`excluded.name`,
          state: sql`excluded.state`,
          rawState: sql`excluded.raw_state`,
          imageRef: sql`excluded.image_ref`,
          imageRepository: sql`excluded.image_repository`,
          imageTag: sql`excluded.image_tag`,
          imageDigest: sql`excluded.image_digest`,
          imageId: sql`excluded.image_id`,
          guestOs: sql`excluded.guest_os`,
          composeProject: sql`excluded.compose_project`,
          composeService: sql`excluded.compose_service`,
          composeWorkingDir: sql`excluded.compose_working_dir`,
          restartPolicy: sql`excluded.restart_policy`,
          cpuCount: sql`excluded.cpu_count`,
          memoryMb: sql`excluded.memory_mb`,
          startedAt: sql`excluded.started_at`,
          runtimeCreatedAt: sql`excluded.runtime_created_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

/**
 * Apply one agent workloads report (spec §6.2) in a single transaction.
 *
 * The effective policy is resolved BEFORE any lock or write: a resolver
 * failure rejects with nothing written, never "disabled" (which would delete
 * rows). All write decisions come from planWorkloadSync.
 */
export async function ingestWorkloadsReport(args: IngestWorkloadsArgs): Promise<IngestWorkloadsResult> {
  const { settings } = await getDeviceWorkloadInventorySettings(args.deviceId);
  return withDbTransaction(async () => {
    await lockDeviceInventory(db, 'device_workloads', args.deviceId);
    // Per-device advisory lock (above) serializes concurrent reports; no other
    // writer takes this key. Then the device row, before any child row, which
    // is the same device-before-children order the deletion cascade uses.
    const [device] = await db
      .select({ id: devices.id, hostsWorkloads: devices.hostsWorkloads, workloadRuntimes: devices.workloadRuntimes })
      .from(devices)
      .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)))
      .for('no key update');
    if (!device) throw new Error('Workload inventory device missing or ownership changed');

    const reported = args.report.runtimes.map((entry) => entry.runtime);
    const storedRuntimes = reported.length
      ? await db
          .select({ runtime: deviceWorkloadRuntimes.runtime, collectedAt: deviceWorkloadRuntimes.collectedAt })
          .from(deviceWorkloadRuntimes)
          .where(and(eq(deviceWorkloadRuntimes.deviceId, args.deviceId), inArray(deviceWorkloadRuntimes.runtime, reported)))
      : [];
    // containerd is detect-only: it never has workload rows, so it is not queried.
    const enumerated = reported.filter(
      (runtime): runtime is 'docker' | 'podman' | 'hyperv' | 'proxmox' => runtime !== 'containerd',
    );
    const storedWorkloads = enumerated.length
      ? await db
          .select({
            id: deviceWorkloads.id,
            runtime: deviceWorkloads.runtime,
            workloadId: deviceWorkloads.workloadId,
            lastSeenAt: deviceWorkloads.lastSeenAt,
          })
          .from(deviceWorkloads)
          .where(and(eq(deviceWorkloads.deviceId, args.deviceId), inArray(deviceWorkloads.runtime, enumerated)))
      : [];

    const plan = planWorkloadSync({
      now: args.receivedAt,
      collectedAt: new Date(args.report.collectedAt), // the planner clamps to min(collectedAt, receivedAt)
      runtimes: args.report.runtimes,
      storedRuntimes,
      storedWorkloads,
      isEnabled: (runtime) => isWorkloadRuntimeEnabled(settings, runtime),
      previousHostRuntimes: device.workloadRuntimes,
      previousHostsWorkloads: device.hostsWorkloads,
    });

    for (const runtimePlan of plan.runtimes) {
      if (runtimePlan.applied) await applyRuntimePlan(args, runtimePlan);
    }
    if (plan.host.changed) {
      await db
        .update(devices)
        .set({ hostsWorkloads: plan.host.hostsWorkloads, workloadRuntimes: plan.host.workloadRuntimes })
        .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)));
    }
    return {
      accepted: true as const,
      runtimes: plan.runtimes.map(({ runtime, applied }) => ({ runtime, applied })),
    };
  });
}
