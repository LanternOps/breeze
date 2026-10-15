/**
 * Workload host inventory (#3834) — shared vocabulary and limits. A pure leaf
 * module: no imports, so API, agent-facing validators and (later) web derive
 * from the same lists.
 */
export const WORKLOAD_RUNTIMES = ['docker', 'podman', 'hyperv', 'proxmox', 'containerd'] as const;
export type WorkloadRuntime = (typeof WORKLOAD_RUNTIMES)[number];

/** Runtimes whose workloads are enumerated in v1; `containerd` is detect-only. */
export const WORKLOAD_ENUMERATED_RUNTIMES = ['docker', 'podman', 'hyperv', 'proxmox'] as const;
export type WorkloadEnumeratedRuntime = (typeof WORKLOAD_ENUMERATED_RUNTIMES)[number];

export const WORKLOAD_KINDS = ['container', 'vm', 'lxc'] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export const WORKLOAD_STATES = ['running', 'stopped', 'paused', 'restarting', 'other'] as const;
export type WorkloadState = (typeof WORKLOAD_STATES)[number];

export const WORKLOAD_DETECTIONS = ['present', 'absent', 'unknown'] as const;
export type WorkloadDetection = (typeof WORKLOAD_DETECTIONS)[number];

export const WORKLOAD_COLLECTIONS = [
  'ok',
  'disabled',
  'unavailable',
  'permission_denied',
  'error',
  'unsupported',
] as const;
export type WorkloadCollection = (typeof WORKLOAD_COLLECTIONS)[number];

/** Which workload kinds each runtime may report. containerd lists none in v1. */
export const WORKLOAD_RUNTIME_KINDS: Readonly<Record<WorkloadRuntime, readonly WorkloadKind[]>> = {
  docker: ['container'],
  podman: ['container'],
  hyperv: ['vm'],
  proxmox: ['vm', 'lxc'],
  containerd: [],
};

/** Per runtime per report (spec §5.4, §6.1). */
export const WORKLOADS_MAX_PER_RUNTIME = 1000;
/** Rows retained per runtime after a truncated snapshot (spec §6.2). */
export const WORKLOADS_RETAINED_MAX_PER_RUNTIME = 1500;
/** A truncated snapshot deletes rows not seen for longer than this (spec §6.2). */
export const WORKLOADS_AGE_OUT_HOURS = 24;
/** Body limit for PUT /agents/:id/workloads (spec §6.1). */
export const WORKLOADS_REPORT_MAX_BYTES = 2 * 1024 * 1024;

/** SecurityCapabilities.workloadInventoryProtocolVersion the API recognizes. */
export const WORKLOAD_INVENTORY_PROTOCOL_VERSION = 1;

export const WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES = 15;
export const WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES = 1440;
export const WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Image currency (#3813, spec §9.1): per container row, how its local image
 * compares with the registry's current digest for the same tag. The
 * unknown-class statuses (pending, private, unsupported_registry, error) never
 * count as current (spec §10).
 */
export const WORKLOAD_UPSTREAM_STATUSES = [
  'pending',
  'current',
  'behind',
  'pinned',
  'local',
  'private',
  'unsupported_registry',
  'not_found',
  'error',
] as const;
export type WorkloadUpstreamStatus = (typeof WORKLOAD_UPSTREAM_STATUSES)[number];

/**
 * How a status counts toward patch compliance (spec §10.1, OD-2 option b):
 * - `stale`   (behind)  → a pending item;
 * - `current`           → an installed item;
 * - `unknown` (pending, private, unsupported_registry, error) → outside the
 *   denominator, surfaced as "N images not checked";
 * - `not_applicable` (pinned, local, not_found) → neither stale nor current,
 *   and not a coverage gap either: there is nothing to compare.
 */
export type WorkloadUpstreamStatusClass = 'stale' | 'current' | 'unknown' | 'not_applicable';

export const WORKLOAD_UPSTREAM_UNKNOWN_STATUSES = [
  'pending',
  'private',
  'unsupported_registry',
  'error',
] as const satisfies readonly WorkloadUpstreamStatus[];

export function workloadUpstreamStatusClass(status: WorkloadUpstreamStatus): WorkloadUpstreamStatusClass {
  switch (status) {
    case 'behind':
      return 'stale';
    case 'current':
      return 'current';
    case 'pinned':
    case 'local':
    case 'not_found':
      return 'not_applicable';
    case 'pending':
    case 'private':
    case 'unsupported_registry':
    case 'error':
      return 'unknown';
  }
}

/**
 * Per-device (or summed) container image term of patch compliance: counts of
 * DISTINCT image repository:tag pairs, replicas of one image on one host
 * counted once. Computed only by `containerImageComplianceTerms` in the API.
 */
export interface ContainerImageComplianceTerms {
  stale: number;
  current: number;
  unknown: number;
}

export function hasImageComplianceTerm(terms: ContainerImageComplianceTerms | null | undefined): boolean {
  return !!terms && terms.stale + terms.current + terms.unknown > 0;
}

/**
 * THE patch-compliance arithmetic with the image term folded in. Every
 * compute site (device %, org %, the CSV report, the web fallback) passes its
 * own existing `installed` / `total` and gets back exactly its old number when
 * `terms` is absent or all zero. A stale image adds one pending item, a
 * current image one installed item; unknown images never touch the ratio.
 */
export function compliancePercentWithImageTerm(
  installed: number,
  total: number,
  terms: ContainerImageComplianceTerms | null | undefined,
): number {
  const numerator = installed + (terms?.current ?? 0);
  const denominator = total + (terms?.stale ?? 0) + (terms?.current ?? 0);
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 100;
}
