// Bare-metal W06d (Task 20): the pool-free leaf shared by every place that
// validates a rebuild request. `routes/backup/schemas.ts`,
// `drBareMetalRebuildStep.ts` and `aiToolSchemasBackup.ts` import this eagerly
// and must stay pool-free at load, so this module imports ONLY `zod` — never
// `../db`, and never `bareMetalRebuildCommand.ts` (→ commandQueue → live pool).
// `bareMetalRebuildSchemas.test.ts` pins that.
import { z } from 'zod';

/**
 * A rebuild target path is absolute on the rebuild host: a POSIX `/…` path or
 * a Windows drive-letter path `X:\…`. UNC and extended-length paths (`\\…`)
 * are refused — a rebuild writes to storage local to the rebuild host, never a
 * network share — as are drive-relative (`C:x`), root-relative (`\x`) and
 * forward-slash drive paths (`C:/x`), and any path carrying a NUL byte.
 */
export function isAbsoluteRebuildPath(p: string): boolean {
  if (p.includes('\0')) return false;
  if (p.startsWith('\\\\')) return false;
  return p.startsWith('/') || /^[A-Za-z]:\\/.test(p);
}

/**
 * A rebuild path's style must match the rebuild host's OS: a drive-letter
 * path only on a Windows host, a POSIX path only on a non-Windows one. The
 * helper would otherwise refuse the target (or write somewhere odd) only
 * after the recovery rows exist and the command has been queued.
 */
export function rebuildPathMatchesHostOs(p: string, hostOsType: string | null | undefined): boolean {
  return /^[A-Za-z]:\\/.test(p) === (hostOsType === 'windows');
}

/**
 * Optional Hyper-V VM creation after a Windows VHDX rebuild (VM-restore path
 * only; DR rehearsals stop at the VHDX). Field names match the agent's
 * `hyperVPayload` json tags. No network adapter unless `switchName` is set.
 * Only valid for a Windows rebuild host — enforced by the caller, which knows
 * the host (`hyperv_requires_windows_host`, 400).
 */
// C0 controls, DEL and C1 controls — the agent's refuseControlChars
// (unicode.IsControl) refuses the same set.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// Hyper-V Gen2 ceilings, mirrored by the agent's ValidateCreateVMRequest
// (maxCreateVMMemoryMB / maxCreateVMCPUCount): 12 TiB of startup memory in a
// multiple of 2 MB, and 240 virtual processors.
const HYPERV_MAX_MEMORY_MB = 12 * 1024 * 1024;
const HYPERV_MAX_CPU_COUNT = 240;

export const hypervOptionsSchema = z
  .object({
    vmName: z.string().min(1).max(100).refine((s) => !CONTROL_CHARS.test(s), { message: 'vmName must not contain a control character' }),
    switchName: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !CONTROL_CHARS.test(s), { message: 'switchName must not contain a control character' })
      .optional(),
    memoryMb: z.number().int().min(512).max(HYPERV_MAX_MEMORY_MB).multipleOf(2).optional(),
    cpuCount: z.number().int().min(1).max(HYPERV_MAX_CPU_COUNT).optional(),
  })
  .strict()
  .optional();
export type HypervOptions = NonNullable<z.infer<typeof hypervOptionsSchema>>;

export type SnapshotPlatform = 'linux' | 'windows';

/** resolveSnapshotPlatform reads layout_manifest.platform defensively: an
 * absent manifest, an absent platform field, or a value outside the known
 * set all resolve to null rather than throwing. Recovery creation stores the
 * null (older snapshots captured before the layout package shipped
 * `platform` must still create a boot-media recovery); the rebuild-dispatch
 * paths refuse it as `snapshot_not_bare_metal_restorable`. */
export function resolveSnapshotPlatform(layoutManifest: unknown): SnapshotPlatform | null {
  if (!layoutManifest || typeof layoutManifest !== 'object') return null;
  const platform = (layoutManifest as { platform?: unknown }).platform;
  return platform === 'linux' || platform === 'windows' ? platform : null;
}
