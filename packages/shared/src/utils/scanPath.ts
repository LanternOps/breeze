/**
 * Scan-path normalisation for multi-volume filesystem analysis
 * (disk cleanup v2 spec §4).
 *
 * `device_filesystem_snapshots.scan_path` and the `(device_id, scan_path)`
 * primary key of `device_filesystem_scan_state` are keyed on the NORMALISED
 * form, so every producer and every reader has to agree byte for byte. `c:\`
 * and `C:\` are the same volume; keying them separately IS defect 6 — a
 * lower-cased drive never resumes its own checkpoint, and a `D:\` scan lands
 * on top of the `C:\` baseline.
 *
 * THIS MODULE IMPORTS NOTHING, on purpose. It is reachable from
 * `@breeze/shared`'s root barrel, which `apps/web` bundles, and
 * `browserSafeBarrel.test.ts` fails any module in that closure which imports a
 * Node builtin — `node:path` included. The rules below are the subset of
 * `path.win32.normalize` / `path.posix.normalize` that scan paths need,
 * implemented over plain strings.
 *
 * Rules (spec §4):
 *   Windows — separators become `\`, repeats collapse, the drive letter is
 *   upper-cased, and a trailing `\` survives ONLY on a volume root (`C:\`,
 *   `D:\`). A UNC path keeps exactly two leading separators so the volumes
 *   filter can recognise and refuse it.
 *   POSIX  — repeats collapse, `.`/`..` resolve, and a trailing `/` survives
 *   only on `/` itself.
 * Case below the drive letter is PRESERVED on both: `/Users` and `/users` are
 * different directories on a case-sensitive volume, and folding them would
 * silently merge two scans.
 */

export type ScanPathOsType = 'windows' | 'macos' | 'linux';

function isWindowsOs(osType: unknown): boolean {
  return osType === 'windows';
}

/**
 * Resolves `.` and `..` over already-split segments.
 *
 * An ABSOLUTE path cannot climb above its own root, so a leading `..` is
 * dropped — that is what both `path` implementations do, and it is the safe
 * reading for a scan root. A relative path keeps its leading `..` so the
 * caller still sees what was asked for and can refuse it.
 */
function resolveSegments(segments: readonly string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
        continue;
      }
      if (absolute) continue;
      out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** The volume root a device scans when the caller names no path. */
export function osRootScanPath(osType: unknown): string {
  return isWindowsOs(osType) ? 'C:\\' : '/';
}

function normalizePosixScanPath(raw: string): string {
  const absolute = raw.startsWith('/');
  const segments = resolveSegments(raw.split('/'), absolute);
  if (segments.length === 0) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

function normalizeWindowsScanPath(raw: string): string {
  const slashed = raw.replace(/\//g, '\\');

  // UNC (`\\server\share`). The volumes service refuses these outright — they
  // are another machine's disk — so normalising rather than rejecting here
  // keeps that decision in exactly one place.
  if (slashed.startsWith('\\\\')) {
    const segments = resolveSegments(slashed.slice(2).split('\\'), true);
    return `\\\\${segments.join('\\')}`;
  }

  const driveMatch = /^([A-Za-z]):(.*)$/.exec(slashed);
  if (driveMatch) {
    const drive = driveMatch[1]!.toUpperCase();
    const rest = driveMatch[2]!;
    const absolute = rest.startsWith('\\');
    const segments = resolveSegments(rest.split('\\'), absolute);
    // `C:` and `C:\` are both the volume root; a drive-relative path
    // (`C:foo`) cannot be a scan root, so it is normalised absolute.
    if (segments.length === 0) return `${drive}:\\`;
    return `${drive}:\\${segments.join('\\')}`;
  }

  const absolute = slashed.startsWith('\\');
  const segments = resolveSegments(slashed.split('\\'), absolute);
  if (segments.length === 0) return absolute ? '\\' : '.';
  return `${absolute ? '\\' : ''}${segments.join('\\')}`;
}

/**
 * The stored/queried form of a scan path. Always call this before writing
 * `scan_path`, before reading by it, and before putting a path in a
 * `filesystem_analysis` command payload.
 */
export function normalizeScanPath(osType: unknown, path: string): string {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (raw.length === 0) return osRootScanPath(osType);
  return isWindowsOs(osType) ? normalizeWindowsScanPath(raw) : normalizePosixScanPath(raw);
}
