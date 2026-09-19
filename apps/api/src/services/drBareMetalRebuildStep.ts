// DR plan step `BARE_METAL_REBUILD` (bare-metal W05b, Task 7): the step
// contract, its validated config, and the per-device source resolution the
// authorization pass and the dispatcher share.
//
// Unlike every other DR step this one is NOT a device command for
// failover/failback: dispatch creates one `bare_metal_recoveries` row per group
// device and the operator boots media and types the code. Only a rehearsal
// queues a command — `bare_metal_rebuild` to the rebuild host, producing a VHDX
// per device with `identity: new`. See
// docs/superpowers/plans/backup/2026-09-18-bare-metal-w05-restore-as-vm-dr-plans.md
// Global Constraints ("DR step contract") and Tasks 7–8.
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { backupSnapshots } from '../db/schema';
import type { DrDb } from './bareMetalRecoveryService';

export const DR_STEP_BARE_METAL_REBUILD = 'BARE_METAL_REBUILD';
export const DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR = '/var/lib/breeze/rebuild/out';

export const drBareMetalRebuildConfigSchema = z.object({
  commandType: z.literal(DR_STEP_BARE_METAL_REBUILD),
  snapshotSelection: z.literal('latest_restorable').default('latest_restorable'),
  /** REQUIRED at dispatch when the execution type is `rehearsal`; ignored for failover/failback. */
  rebuildHostDeviceId: z.string().guid().optional(),
  outputDir: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => p.startsWith('/'), 'absolute path required')
    .default(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR),
  waitTimeoutMinutes: z.number().int().min(5).max(1440).default(240),
});
export type DrBareMetalRebuildConfig = z.infer<typeof drBareMetalRebuildConfigSchema>;

export function isBareMetalRebuildConfig(restoreConfig: unknown): boolean {
  return (
    !!restoreConfig
    && typeof restoreConfig === 'object'
    && !Array.isArray(restoreConfig)
    && (restoreConfig as Record<string, unknown>).commandType === DR_STEP_BARE_METAL_REBUILD
  );
}

/**
 * `restoreConfig` as every DR group write accepts it: an open record for the
 * command-type steps (their payloads are provider-specific and stay
 * unvalidated here), but a BARE_METAL_REBUILD config is parsed through the
 * strict schema and stored NORMALISED (defaults applied). A plain
 * `z.union([strict, record])` would let an invalid BARE_METAL_REBUILD config
 * fall through to the open record, so the discrimination is explicit.
 */
export const drRestoreConfigSchema = z
  .record(z.string(), z.any())
  .transform((config, ctx): Record<string, unknown> => {
    if (!isBareMetalRebuildConfig(config)) return config;
    const parsed = drBareMetalRebuildConfigSchema.safeParse(config);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  });

/**
 * The newest snapshot of `deviceId` that the bare-metal guard marked
 * restorable, or null when the device has none. The DR authorization pass
 * turns null into `resource_not_found` for the whole group; the dispatcher
 * re-resolves at dispatch time so a snapshot published between trigger and
 * dispatch is used.
 */
export async function resolveLatestRestorableSnapshotId(
  orgId: string,
  deviceId: string,
  tx?: DrDb,
): Promise<string | null> {
  // Lazy: `routes/backup/schemas.ts` imports this module for
  // drRestoreConfigSchema, and a zod module must not drag the pool in at load.
  const runner = tx ?? (await import('../db')).db;
  const [row] = await runner
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.orgId, orgId),
        eq(backupSnapshots.deviceId, deviceId),
        eq(backupSnapshots.bareMetalRestorable, true),
      ),
    )
    .orderBy(desc(backupSnapshots.timestamp))
    .limit(1);
  return row?.id ?? null;
}
