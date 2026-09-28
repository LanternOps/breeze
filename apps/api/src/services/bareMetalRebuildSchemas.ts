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
 * Optional Hyper-V VM creation after a Windows VHDX rebuild (VM-restore path
 * only; DR rehearsals stop at the VHDX). Field names match the agent's
 * `hyperVPayload` json tags. No network adapter unless `switchName` is set.
 * Only valid for a Windows rebuild host — enforced by the caller, which knows
 * the host (`hyperv_requires_windows_host`, 400).
 */
export const hypervOptionsSchema = z
  .object({
    vmName: z.string().min(1).max(100),
    switchName: z.string().min(1).max(200).optional(),
    memoryMb: z.number().int().min(512).optional(),
    cpuCount: z.number().int().min(1).optional(),
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
