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
import { backupSnapshots } from '../db/schema/backup';
import type { DrDb } from './bareMetalRecoveryService';
// Pool-free leaf (imports only zod): this module must stay lazy on ../db.
import { isAbsoluteRebuildPath, resolveSnapshotPlatform, type SnapshotPlatform } from './bareMetalRebuildSchemas';
import { findCredentialShapedKeyPath } from './drStoredCredentialKeys';

export const DR_STEP_BARE_METAL_REBUILD = 'BARE_METAL_REBUILD';
export const DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX = '/var/lib/breeze/rebuild/out';
export const DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS = 'C:\\ProgramData\\Breeze\\rebuild\\out';
/**
 * The value a stored config carries when the operator left `outputDir` unset
 * (configs are stored normalised, defaults applied). It stays the Linux
 * default so every already-stored config keeps matching it; dispatch maps it
 * to the rebuild host's own default through `defaultRebuildOutputDir` (W06d).
 */
export const DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR = DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX;

/** The rebuild host's default VHDX output directory, by `devices.osType`. */
export function defaultRebuildOutputDir(osType: string): string {
  return osType === 'windows' ? DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS : DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR_LINUX;
}

/**
 * Joins a file name onto an output dir with the dir's own separator: `\` for
 * a drive-letter dir, `/` otherwise. Trailing separators are collapsed so the
 * result never carries a doubled one.
 */
export function joinRebuildOutputPath(outputDir: string, file: string): string {
  const sep = /^[A-Za-z]:\\/.test(outputDir) ? '\\' : '/';
  const trimmed = sep === '\\' ? outputDir.replace(/\\+$/, '') : outputDir.replace(/\/+$/, '');
  return `${trimmed}${sep}${file}`;
}

/**
 * The step's default wait budget: how long a recovery may stay non-terminal
 * before `drExecutionService` marks the device `timeout` and cancels it. It
 * equals the reaper ceiling for the `bare_metal_rebuild` command itself
 * (`WHOLE_MACHINE_RESTORE_TIMEOUT_MS`, 24 h), so by default the step never
 * cancels a rebuild that its own command would still let run (#7087). The old
 * 240 cancelled large rehearsals: a Windows whole-machine rebuild of 133k
 * files / 20.6 GB took 5h23m in the lab. A stuck rebuild is caught earlier by
 * the helper's own stall watchdog (#6664), not by this budget.
 *
 * Configs are stored normalised, so plans saved before this change keep the
 * `240` they stored until an operator edits the step.
 */
export const DR_BARE_METAL_REBUILD_DEFAULT_WAIT_TIMEOUT_MINUTES = 1440;

export const drBareMetalRebuildConfigSchema = z.object({
  commandType: z.literal(DR_STEP_BARE_METAL_REBUILD),
  snapshotSelection: z.literal('latest_restorable').default('latest_restorable'),
  /** REQUIRED at dispatch when the execution type is `rehearsal`; ignored for failover/failback. */
  rebuildHostDeviceId: z.string().guid().optional(),
  outputDir: z
    .string()
    .min(1)
    .max(1024)
    .refine(isAbsoluteRebuildPath, 'absolute path required (POSIX or a Windows drive letter, no UNC)')
    // Still the Linux value when unset; dispatch resolves it per host OS.
    .default(DR_BARE_METAL_REBUILD_DEFAULT_OUTPUT_DIR),
  waitTimeoutMinutes: z.number().int().min(5).max(1440).default(DR_BARE_METAL_REBUILD_DEFAULT_WAIT_TIMEOUT_MINUTES),
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
 *
 * No step may store credential material — a storage destination
 * (`providerConfig`), a password, a key, a bearer token — anywhere in the
 * config: the plan is long-lived tenant data, and its payload is copied into
 * every command the step queues. Storage destinations are resolved from the
 * step's snapshot when the command is delivered instead.
 */
export const drRestoreConfigSchema = z
  .record(z.string(), z.any())
  .transform((config, ctx): Record<string, unknown> => {
    const credentialPath = findCredentialShapedKeyPath(config);
    if (credentialPath) {
      ctx.addIssue({
        code: 'custom',
        path: credentialPath,
        message:
          'Credentials cannot be stored in a DR plan. Storage destinations are resolved from the step snapshot when the step runs.',
      });
      return z.NEVER;
    }
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

/**
 * Same selection as `resolveLatestRestorableSnapshotId`, plus the snapshot's
 * layout platform — for the one caller that needs it: the dispatcher's
 * rebuild-host platform match (W06d). The authorization pass only needs
 * existence and keeps the bare-id resolver, so its callers never change.
 */
export async function resolveLatestRestorableSnapshot(
  orgId: string,
  deviceId: string,
  tx?: DrDb,
): Promise<{ id: string; platform: SnapshotPlatform | null } | null> {
  // Lazy for the same reason as resolveLatestRestorableSnapshotId.
  const runner = tx ?? (await import('../db')).db;
  const [row] = await runner
    .select({ id: backupSnapshots.id, layoutManifest: backupSnapshots.layoutManifest })
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
  if (!row) return null;
  return { id: row.id, platform: resolveSnapshotPlatform(row.layoutManifest) };
}
