import { z } from 'zod';
import {
  WORKLOAD_COLLECTIONS,
  WORKLOAD_DETECTIONS,
  WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES,
  WORKLOAD_KINDS,
  WORKLOAD_RUNTIME_KINDS,
  WORKLOAD_RUNTIMES,
  WORKLOAD_STATES,
  WORKLOADS_MAX_PER_RUNTIME,
  type WorkloadRuntime,
} from '../constants/workloads';

/**
 * A bounded string Postgres can store: varchar/text reject U+0000 (22021),
 * which would abort the whole ingest transaction instead of returning a 400.
 */
const text = (max: number) =>
  z.string().max(max).refine((value) => !value.includes('\u0000'), 'must not contain NUL');
const nullableText = (max: number) =>
  text(max).nullish().transform((value) => value ?? null);
const nullableInt = (max: number) =>
  z.number().int().min(0).max(max).nullish().transform((value) => value ?? null);
const nullableTimestamp = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((value) => value ?? null);

/**
 * One workload as the agent reports it: the agent-supplied subset of the
 * device_workloads columns (spec §4.1). id / device / org / runtime /
 * first_seen / last_seen / updated_at are server-owned. Strict on purpose:
 * environment, command, mounts and labels are not representable (D8).
 */
export const workloadReportItemSchema = z
  .object({
    kind: z.enum(WORKLOAD_KINDS),
    workloadId: text(128).pipe(z.string().min(1)),
    name: text(255).pipe(z.string().min(1)),
    state: z.enum(WORKLOAD_STATES),
    rawState: nullableText(40),
    imageRef: nullableText(512),
    imageRepository: nullableText(400),
    imageTag: nullableText(128),
    imageDigest: nullableText(80),
    imageId: nullableText(80),
    guestOs: nullableText(128),
    composeProject: nullableText(128),
    composeService: nullableText(128),
    composeWorkingDir: nullableText(512),
    restartPolicy: nullableText(30),
    cpuCount: nullableInt(4096),
    memoryMb: nullableInt(100_000_000),
    startedAt: nullableTimestamp,
    runtimeCreatedAt: nullableTimestamp,
  })
  .strict();
export type WorkloadReportItem = z.infer<typeof workloadReportItemSchema>;

export const workloadRuntimeReportSchema = z
  .object({
    runtime: z.enum(WORKLOAD_RUNTIMES),
    detection: z.enum(WORKLOAD_DETECTIONS),
    collection: z.enum(WORKLOAD_COLLECTIONS),
    complete: z.boolean(),
    runtimeVersion: text(64).nullable(),
    observedCount: z.number().int().min(0).max(1_000_000),
    error: text(500).nullable(),
    workloads: z.array(workloadReportItemSchema).max(WORKLOADS_MAX_PER_RUNTIME),
  })
  .strict()
  .superRefine((report, ctx) => {
    // An ok snapshot is authoritative: it advances last_success_at and a
    // complete one deletes by absence. Only an installed (present) runtime
    // that is actually enumerated can produce one; containerd is detect-only.
    if (report.collection === 'ok' && (report.detection !== 'present' || report.runtime === 'containerd')) {
      ctx.addIssue({
        code: 'custom',
        path: ['collection'],
        message: `collection ok requires detection present on an enumerated runtime (got ${report.detection} on ${report.runtime})`,
      });
    }
    const allowedKinds: readonly string[] = WORKLOAD_RUNTIME_KINDS[report.runtime];
    const seen = new Set<string>();
    report.workloads.forEach((workload, index) => {
      if (!allowedKinds.includes(workload.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workloads', index, 'kind'],
          message: `kind ${workload.kind} is not valid for runtime ${report.runtime}`,
        });
      }
      if (seen.has(workload.workloadId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workloads', index, 'workloadId'],
          message: 'duplicate workloadId within the runtime',
        });
      }
      seen.add(workload.workloadId);
    });
  });
export type WorkloadRuntimeReport = z.infer<typeof workloadRuntimeReportSchema>;

/** Body of PUT /api/v1/agents/:id/workloads (spec §6.1). */
export const workloadsReportSchema = z
  .object({
    protocolVersion: z.literal(1),
    collectedAt: z.string().datetime({ offset: true }),
    runtimes: z.array(workloadRuntimeReportSchema).max(5),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<string>();
    report.runtimes.forEach((entry, index) => {
      if (seen.has(entry.runtime)) {
        ctx.addIssue({
          code: 'custom',
          path: ['runtimes', index, 'runtime'],
          message: 'duplicate runtime entry',
        });
      }
      seen.add(entry.runtime);
    });
  });
export type WorkloadsReport = z.infer<typeof workloadsReportSchema>;

/**
 * Inline settings of the `workload_inventory` configuration feature (spec
 * §7.1). Detection always runs; these gate enumeration only (D4).
 */
export const workloadInventoryInlineSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    dockerEnabled: z.boolean().default(true),
    podmanEnabled: z.boolean().default(true),
    hypervEnabled: z.boolean().default(true),
    proxmoxEnabled: z.boolean().default(true),
    intervalMinutes: z
      .number()
      .int()
      .min(WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES)
      .max(WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES)
      .default(WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES),
  })
  .strict();
export type WorkloadInventoryInlineSettings = z.infer<typeof workloadInventoryInlineSettingsSchema>;

export const WORKLOAD_INVENTORY_DEFAULTS: WorkloadInventoryInlineSettings = {
  enabled: false,
  dockerEnabled: true,
  podmanEnabled: true,
  hypervEnabled: true,
  proxmoxEnabled: true,
  intervalMinutes: WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES,
};

/**
 * Is enumeration enabled for this runtime under these settings? The feature
 * switch must be on AND the runtime's own flag. containerd has no flag and is
 * never enumerated in v1.
 */
export function isWorkloadRuntimeEnabled(
  settings: WorkloadInventoryInlineSettings,
  runtime: WorkloadRuntime,
): boolean {
  if (!settings.enabled) return false;
  switch (runtime) {
    case 'docker':
      return settings.dockerEnabled;
    case 'podman':
      return settings.podmanEnabled;
    case 'hyperv':
      return settings.hypervEnabled;
    case 'proxmox':
      return settings.proxmoxEnabled;
    default:
      return false;
  }
}
