import {
  WORKLOAD_ENUMERATED_RUNTIMES,
  WORKLOADS_AGE_OUT_HOURS,
  WORKLOADS_RETAINED_MAX_PER_RUNTIME,
  type WorkloadCollection,
  type WorkloadDetection,
  type WorkloadReportItem,
  type WorkloadRuntime,
  type WorkloadRuntimeReport,
} from '@breeze/shared';
import { planChildRowSync, type ChildRowPlan } from '../inventoryChildSync';

/**
 * Pure planner for one workloads report (spec §6.2). Reads nothing, writes
 * nothing, has no clock: every decision the ingest transaction applies is made
 * here and is table-tested without a database. The branch order below is the
 * bullet order of spec §6.2.
 */

const HOUR_MS = 3_600_000;
const FAILURE_COLLECTIONS: ReadonlySet<WorkloadCollection> = new Set([
  'unavailable',
  'permission_denied',
  'error',
  'unsupported',
]);

export interface StoredWorkloadRuntime {
  runtime: WorkloadRuntime;
  collectedAt: Date;
}
export interface StoredWorkload {
  id: string;
  runtime: WorkloadRuntime;
  workloadId: string;
  lastSeenAt: Date;
}

export interface WorkloadSyncInput {
  /** Server receive time. */
  now: Date;
  /**
   * The agent's snapshot time (`report.collectedAt`). The ordering guard and
   * the stored collected_at use min(collectedAt, now) so a fast agent clock
   * cannot park the device in the future.
   */
  collectedAt: Date;
  runtimes: readonly WorkloadRuntimeReport[];
  storedRuntimes: readonly StoredWorkloadRuntime[];
  /** Only rows of the reported runtimes are needed. */
  storedWorkloads: readonly StoredWorkload[];
  /** Effective policy: is enumeration enabled for this runtime? */
  isEnabled: (runtime: WorkloadRuntime) => boolean;
  /** devices.workload_runtimes before this report. */
  previousHostRuntimes: readonly string[];
  /** devices.hosts_workloads before this report. */
  previousHostsWorkloads: boolean;
}

export interface WorkloadRuntimeWrite {
  runtime: WorkloadRuntime;
  detection: WorkloadDetection;
  collection: WorkloadCollection;
  complete: boolean;
  runtimeVersion: string | null;
  observedCount: number;
  reportedCount: number;
  lastError: string | null;
  collectedAt: Date;
  lastAttemptAt: Date;
  /** null = keep the stored last_success_at (only an ok collection advances it). */
  lastSuccessAt: Date | null;
}

export interface WorkloadRuntimePlan {
  runtime: WorkloadRuntime;
  /** false when the ordering guard skipped this runtime entirely. */
  applied: boolean;
  /** Collection after the policy override; null when the runtime was skipped. */
  collection: WorkloadCollection | null;
  runtimeRow: WorkloadRuntimeWrite | null;
  /** deleteIds is final: age-out and the retained cap are already applied. */
  workloads: ChildRowPlan<WorkloadReportItem>;
}

export interface WorkloadHostAxis {
  workloadRuntimes: string[];
  hostsWorkloads: boolean;
  changed: boolean;
}

export interface WorkloadSyncPlan {
  runtimes: WorkloadRuntimePlan[];
  host: WorkloadHostAxis;
}

const emptyWorkloadPlan = (): ChildRowPlan<WorkloadReportItem> => ({ updates: [], inserts: [], deleteIds: [] });

function isEnumeratedRuntime(runtime: WorkloadRuntime): boolean {
  return (WORKLOAD_ENUMERATED_RUNTIMES as readonly string[]).includes(runtime);
}

const sortedIds = (rows: readonly StoredWorkload[]): string[] => rows.map((row) => row.id).sort();

/**
 * A truncated snapshot (spec §6.2): rows absent from the report are NOT
 * deleted by absence. Rows not seen for more than 24 h age out; then the
 * oldest unreported rows are trimmed so at most 1500 remain.
 */
function truncatedDeleteIds(
  stored: readonly StoredWorkload[],
  reported: readonly WorkloadReportItem[],
  now: Date,
): string[] {
  const reportedIds = new Set(reported.map((workload) => workload.workloadId));
  const cutoff = now.getTime() - WORKLOADS_AGE_OUT_HOURS * HOUR_MS;
  const unreported = stored.filter((row) => !reportedIds.has(row.workloadId));
  const aged = unreported.filter((row) => row.lastSeenAt.getTime() < cutoff);
  const kept = unreported.filter((row) => row.lastSeenAt.getTime() >= cutoff);
  const overflow = reportedIds.size + kept.length - WORKLOADS_RETAINED_MAX_PER_RUNTIME;
  const trimmed =
    overflow > 0
      ? [...kept]
          .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime() || a.id.localeCompare(b.id))
          .slice(0, overflow)
      : [];
  return sortedIds([...aged, ...trimmed]);
}

function planWorkloads(
  report: WorkloadRuntimeReport,
  collection: WorkloadCollection,
  stored: readonly StoredWorkload[],
  now: Date,
): ChildRowPlan<WorkloadReportItem> {
  if (collection === 'disabled') {
    return { updates: [], inserts: [], deleteIds: sortedIds(stored) };
  }
  if (collection !== 'ok' || !isEnumeratedRuntime(report.runtime)) return emptyWorkloadPlan();
  const plan = planChildRowSync(stored, report.workloads, {
    storedKey: (row: StoredWorkload) => row.workloadId,
    reportedKey: (row: WorkloadReportItem) => row.workloadId,
    storedExact: (row: StoredWorkload) => row.workloadId,
    reportedExact: (row: WorkloadReportItem) => row.workloadId,
  });
  const truncated = !report.complete || report.observedCount > report.workloads.length;
  if (!truncated) return plan;
  return { updates: plan.updates, inserts: plan.inserts, deleteIds: truncatedDeleteIds(stored, report.workloads, now) };
}

/** Spec §6.2: min(collectedAt, receivedAt). */
function effectiveCollectedAt(input: WorkloadSyncInput): Date {
  return input.collectedAt.getTime() <= input.now.getTime() ? input.collectedAt : input.now;
}

function toRuntimeWrite(
  report: WorkloadRuntimeReport,
  collection: WorkloadCollection,
  input: WorkloadSyncInput,
): WorkloadRuntimeWrite {
  // An absent runtime has had all its workloads deleted: record it as cleared.
  const disabled = collection === 'disabled' || report.detection === 'absent';
  return {
    runtime: report.runtime,
    detection: report.detection,
    collection,
    complete: disabled ? true : report.complete,
    runtimeVersion: report.runtimeVersion,
    observedCount: disabled ? 0 : report.observedCount,
    reportedCount: disabled ? 0 : report.workloads.length,
    lastError: FAILURE_COLLECTIONS.has(collection) ? report.error : null,
    collectedAt: effectiveCollectedAt(input),
    lastAttemptAt: input.now,
    lastSuccessAt: collection === 'ok' ? input.now : null,
  };
}

export function planWorkloadSync(input: WorkloadSyncInput): WorkloadSyncPlan {
  const storedRuntime = new Map(input.storedRuntimes.map((row) => [row.runtime, row] as const));
  const membership = new Set(input.previousHostRuntimes);
  const effective = effectiveCollectedAt(input);

  const runtimes = input.runtimes.map((report): WorkloadRuntimePlan => {
    const existing = storedRuntime.get(report.runtime);
    if (existing && effective.getTime() <= existing.collectedAt.getTime()) {
      return {
        runtime: report.runtime,
        applied: false,
        collection: null,
        runtimeRow: null,
        workloads: emptyWorkloadPlan(),
      };
    }
    const stored = input.storedWorkloads.filter((row) => row.runtime === report.runtime);

    if (report.detection === 'absent') {
      membership.delete(report.runtime);
      // The row is KEPT (detection = absent) so the ordering guard survives a
      // replayed older `present` report; absent rows are never host-axis members.
      return {
        runtime: report.runtime,
        applied: true,
        collection: report.collection,
        runtimeRow: toRuntimeWrite(report, report.collection, input),
        workloads: { updates: [], inserts: [], deleteIds: sortedIds(stored) },
      };
    }
    if (report.detection === 'present') membership.add(report.runtime);

    const collection: WorkloadCollection =
      isEnumeratedRuntime(report.runtime) && !input.isEnabled(report.runtime) ? 'disabled' : report.collection;
    return {
      runtime: report.runtime,
      applied: true,
      collection,
      runtimeRow: toRuntimeWrite(report, collection, input),
      workloads: planWorkloads(report, collection, stored, input.now),
    };
  });

  const next = [...membership].sort();
  const previous = [...input.previousHostRuntimes].sort();
  const hostsWorkloads = next.length > 0;
  const changed =
    hostsWorkloads !== input.previousHostsWorkloads ||
    next.length !== previous.length ||
    next.some((runtime, index) => runtime !== previous[index]);
  return { runtimes, host: { workloadRuntimes: next, hostsWorkloads, changed } };
}
