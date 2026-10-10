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
