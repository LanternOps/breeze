import type { WorkloadRuntime, WorkloadState } from '@breeze/shared';
import type { DeviceWorkloadsView } from './view';

/** Max workload rows returned to the model; counts always cover the full set. */
export const AI_WORKLOADS_LIMIT = 200;

export interface WorkloadsAiFilters {
  runtime?: WorkloadRuntime;
  state?: WorkloadState;
  /** Rows returned; clamped to 1..AI_WORKLOADS_LIMIT. */
  limit?: number;
}

const COLLECTION_NOTE =
  'Workload inventory collection is off by default; it is enabled per device by a configuration policy with the "Workload inventory" feature.';

/**
 * Bounded, model-facing projection of the shared workloads view. containerd is
 * detect-only: it never contributes a workload count. Host paths, raw runtime
 * state and image internals are not exposed.
 */
export function projectWorkloadsForAi(
  deviceId: string,
  hostname: string | null | undefined,
  view: DeviceWorkloadsView,
  filters: WorkloadsAiFilters = {},
) {
  const agentTooOld = view.capability === 0;
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? AI_WORKLOADS_LIMIT), 1), AI_WORKLOADS_LIMIT);
  const runtimes = view.runtimes.map((r) => {
    const detectOnly = r.runtime === 'containerd';
    return {
      runtime: r.runtime,
      detection: r.detection,
      collection: r.collection,
      complete: r.complete,
      runtimeVersion: r.runtimeVersion,
      observedCount: detectOnly ? null : r.observedCount,
      reportedCount: detectOnly ? null : r.reportedCount,
      lastError: r.lastError,
      lastSuccessAt: r.lastSuccessAt,
    };
  });

  const matching = view.workloads.filter(
    (w) =>
      w.runtime !== 'containerd' &&
      (!filters.runtime || w.runtime === filters.runtime) &&
      (!filters.state || w.state === filters.state),
  );
  const byRuntime: Record<string, number> = {};
  const byState: Record<string, number> = {};
  for (const w of matching) {
    byRuntime[w.runtime] = (byRuntime[w.runtime] ?? 0) + 1;
    byState[w.state] = (byState[w.state] ?? 0) + 1;
  }

  return {
    deviceId,
    ...(hostname ? { hostname } : {}),
    capability: view.capability,
    agentTooOld,
    collectionNote: agentTooOld
      ? `The agent on this device predates workload inventory; update it first. ${COLLECTION_NOTE}`
      : COLLECTION_NOTE,
    runtimes,
    counts: { total: matching.length, byRuntime, byState },
    workloads: matching.slice(0, limit).map((w) => ({
      name: w.name,
      runtime: w.runtime,
      kind: w.kind,
      state: w.state,
      imageRef: w.imageRef,
      guestOs: w.guestOs,
      composeProject: w.composeProject,
      composeService: w.composeService,
      startedAt: w.startedAt,
    })),
    truncated: matching.length > limit,
  };
}
