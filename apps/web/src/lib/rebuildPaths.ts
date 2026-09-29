/**
 * Rebuild-engine path rules shared by Restore-as-VM and the DR plan editor
 * (bare-metal W06d). The web bundle never imports API server code, so these
 * mirror the API by hand — keep them in sync with:
 *   - `isAbsoluteRebuildPath` in apps/api/src/services/bareMetalRebuildSchemas.ts
 *   - `rebuildVhdxOutputPathSchema` in apps/api/src/routes/backup/schemas.ts
 *   - `defaultRebuildOutputDir` in apps/api/src/services/drBareMetalRebuildStep.ts
 */

export type RebuildHostOs = 'linux' | 'windows';

export const REBUILD_DEFAULT_OUTPUT_DIR_LINUX = '/var/lib/breeze/rebuild/out';
export const REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS = 'C:\\ProgramData\\Breeze\\rebuild\\out';

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\\/;

/**
 * Absolute on the rebuild host: a POSIX `/…` path or a Windows drive-letter
 * `X:\…` path. UNC / extended-length (`\\…`), drive-relative (`C:x`),
 * root-relative (`\x`), forward-slash drive (`C:/x`) and NUL-carrying paths
 * are refused — the same rule the API applies.
 */
export function isAbsoluteRebuildPath(path: string): boolean {
  if (path.includes('\0')) return false;
  if (path.startsWith('\\\\')) return false;
  return path.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE.test(path);
}

/** An absolute rebuild path naming a `.vhdx` file (suffix case-insensitive, as
 * on the API), with a non-empty file name before the suffix. */
export function isAbsoluteVhdxPath(path: string): boolean {
  const trimmed = path.trim();
  if (!isAbsoluteRebuildPath(trimmed) || !trimmed.toLowerCase().endsWith('.vhdx')) return false;
  const base = trimmed.slice(0, -'.vhdx'.length);
  return !base.endsWith('/') && !base.endsWith('\\');
}

/**
 * Whether an (already absolute) path is written for the host's OS: a
 * drive-letter path on Windows, a POSIX path on Linux. The API does not check
 * this pairing — the agent fails it at run time — so the UI catches it first.
 * An unknown host OS is not judged.
 */
export function rebuildPathMatchesOs(path: string, os: string | null | undefined): boolean {
  const trimmed = path.trim();
  if (os === 'windows') return WINDOWS_DRIVE_ABSOLUTE.test(trimmed);
  if (os === 'linux') return trimmed.startsWith('/');
  return true;
}

/** The rebuild host's default VHDX output directory, by device `osType`. */
export function defaultRebuildOutputDir(os: string | null | undefined): string {
  return os === 'windows' ? REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS : REBUILD_DEFAULT_OUTPUT_DIR_LINUX;
}
