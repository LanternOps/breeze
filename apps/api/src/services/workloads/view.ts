import { and, eq } from 'drizzle-orm';
import type {
  WorkloadCollection,
  WorkloadDetection,
  WorkloadKind,
  WorkloadRuntime,
  WorkloadState,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceWorkloadRuntimes, deviceWorkloads, devices } from '../../db/schema';

type RuntimeRow = typeof deviceWorkloadRuntimes.$inferSelect;
type WorkloadRow = typeof deviceWorkloads.$inferSelect;

export interface DeviceWorkloadRuntimeView {
  runtime: WorkloadRuntime;
  detection: WorkloadDetection;
  collection: WorkloadCollection;
  complete: boolean;
  runtimeVersion: string | null;
  observedCount: number | null;
  reportedCount: number | null;
  lastError: string | null;
  collectedAt: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
}

export interface DeviceWorkloadView {
  id: string;
  runtime: WorkloadRuntime;
  kind: WorkloadKind;
  workloadId: string;
  name: string;
  state: WorkloadState;
  rawState: string | null;
  imageRef: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageDigest: string | null;
  imageId: string | null;
  guestOs: string | null;
  composeProject: string | null;
  composeService: string | null;
  composeWorkingDir: string | null;
  restartPolicy: string | null;
  cpuCount: number | null;
  memoryMb: number | null;
  startedAt: string | null;
  runtimeCreatedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Spec §6.3: exactly these three keys. */
export interface DeviceWorkloadsView {
  capability: 0 | 1;
  runtimes: DeviceWorkloadRuntimeView[];
  workloads: DeviceWorkloadView[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

/** Pure projection + ordering (runtime, state, name — workloadId breaks ties). */
export function buildDeviceWorkloadsView(
  capability: number,
  runtimeRows: readonly RuntimeRow[],
  workloadRows: readonly WorkloadRow[],
): DeviceWorkloadsView {
  const runtimes = [...runtimeRows]
    .sort((a, b) => cmp(a.runtime, b.runtime))
    .map(
      (row): DeviceWorkloadRuntimeView => ({
        runtime: row.runtime,
        detection: row.detection,
        collection: row.collection,
        complete: row.complete,
        runtimeVersion: row.runtimeVersion,
        observedCount: row.observedCount,
        reportedCount: row.reportedCount,
        lastError: row.lastError,
        collectedAt: iso(row.collectedAt),
        lastAttemptAt: iso(row.lastAttemptAt),
        lastSuccessAt: isoOrNull(row.lastSuccessAt),
      }),
    );
  const workloads = [...workloadRows]
    .sort(
      (a, b) =>
        cmp(a.runtime, b.runtime) || cmp(a.state, b.state) || cmp(a.name, b.name) || cmp(a.workloadId, b.workloadId),
    )
    .map(
      (row): DeviceWorkloadView => ({
        id: row.id,
        runtime: row.runtime,
        kind: row.kind,
        workloadId: row.workloadId,
        name: row.name,
        state: row.state,
        rawState: row.rawState,
        imageRef: row.imageRef,
        imageRepository: row.imageRepository,
        imageTag: row.imageTag,
        imageDigest: row.imageDigest,
        imageId: row.imageId,
        guestOs: row.guestOs,
        composeProject: row.composeProject,
        composeService: row.composeService,
        composeWorkingDir: row.composeWorkingDir,
        restartPolicy: row.restartPolicy,
        cpuCount: row.cpuCount,
        memoryMb: row.memoryMb,
        startedAt: isoOrNull(row.startedAt),
        runtimeCreatedAt: isoOrNull(row.runtimeCreatedAt),
        firstSeenAt: iso(row.firstSeenAt),
        lastSeenAt: iso(row.lastSeenAt),
      }),
    );
  return { capability: capability >= 1 ? 1 : 0, runtimes, workloads };
}

/** null = the device is not visible to the caller (RLS) or does not exist. */
export async function getDeviceWorkloadsView(deviceId: string): Promise<DeviceWorkloadsView | null> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, capability: devices.workloadInventoryProtocolVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return null;
  const runtimeRows = await db
    .select()
    .from(deviceWorkloadRuntimes)
    .where(and(eq(deviceWorkloadRuntimes.deviceId, deviceId), eq(deviceWorkloadRuntimes.orgId, device.orgId)));
  const workloadRows = await db
    .select()
    .from(deviceWorkloads)
    .where(and(eq(deviceWorkloads.deviceId, deviceId), eq(deviceWorkloads.orgId, device.orgId)));
  return buildDeviceWorkloadsView(device.capability, runtimeRows, workloadRows);
}
