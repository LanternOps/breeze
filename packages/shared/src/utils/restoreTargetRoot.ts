// #12638: a file restore to a target keeps each file's full path beneath it
// (the backup helper strips the volume and joins the rest under the target),
// so a target that is the root of the volume the files came from — `C:\` for
// files from C:, `/`, a share root — writes every file back over its
// original. The request confirms that explicitly with
// `allowOverwriteOriginals`; a root target without it is refused before
// anything is dispatched. Helpers that predate the flag would otherwise
// overwrite silently, so this check is what protects them.
//
// Lexical only, and deliberately broad: the server cannot tell which volume
// the files came from, so every volume or share root needs the confirmation
// (an empty E:\ too, or a folder such as E:\Restored). The helper makes the
// exact, per-file decision.

/** RestoreResult.Code / API error code for a restore refused because it would overwrite the originals. */
export const RESTORE_WOULD_OVERWRITE_ORIGINALS = 'restore_would_overwrite_originals';

/**
 * Longest restore target accepted anywhere. Windows extended-length paths top
 * out at 32,767 UTF-16 units, the longest real path this product restores to;
 * no legitimate target is longer. Bounding the input keeps every per-character
 * check on it cheap whatever its implementation.
 */
export const RESTORE_TARGET_PATH_MAX_LENGTH = 32_767;

const SEPARATOR = /[\\/]/;
// Go's Windows filepath reads any first character before a colon as a
// drive (`1:\` is absolute there), so this does too; only a letter names a
// drive through a device prefix (DRIVE_ONLY), where anything else needs
// confirmation anyway.
const DRIVE = /^[^\\/]:/;
const DRIVE_ONLY = /^[A-Za-z]:$/;
// `\\?`, `\\.` and `\??` (either separator in every position), ending the
// path or followed by a separator: Go's filepath reads exactly these as a
// device prefix on Windows. Fixed length, anchored: no backtracking.
const DEVICE_PREFIX = /^(?:[\\/][\\/][?.]|[\\/]\?\?)(?:[\\/]|$)/;

/** The kind of device a restore target is read on. */
export type RestoreTargetHost = 'windows' | 'posix' | 'darwin';

/**
 * How a restore target is classified: the root of a volume or share; a form
 * this check cannot reduce to a folder on a local volume (a device path, a
 * share through a device prefix, a server with no share); or an ordinary
 * folder. Only `not-root` is accepted without `allowOverwriteOriginals`.
 */
export type RestoreTargetClass = 'root' | 'needs-confirmation' | 'not-root';

const RANK: Record<RestoreTargetClass, number> = { 'not-root': 0, 'needs-confirmation': 1, root: 2 };

function stricter(a: RestoreTargetClass, b: RestoreTargetClass): RestoreTargetClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Whether `targetPath` needs `allowOverwriteOriginals`: anything but an
 * ordinary folder by `classifyRestoreTarget`, read for any kind of device
 * (the route, the wizard and the AI tool check before the device is known).
 */
export function isVolumeRootRestoreTarget(targetPath: string): boolean {
  return classifyRestoreTarget(targetPath) !== 'not-root';
}

/**
 * Classifies a restore target the way the backup helper's path handling
 * reads it (Go's filepath: the volume, then the rest cleaned with `.` and
 * `..` resolved), for a device of the given kind, or with `host` omitted,
 * the strictest of the three. The cases both sides are tested against:
 * packages/shared/src/fixtures/restore-target-root-vectors.json (#12671).
 *
 * - windows: a drive root (`C:\`, `c:/`, `C:`), a share root
 *   (`\\server\share`), a volume root through a device prefix (`\\?\C:\`,
 *   `\??\C:\`, `\\?\Volume{…}\`, `\\?\GLOBALROOT\Device\HarddiskVolume3\`)
 *   with either separator anywhere in the prefix; trailing dots and spaces
 *   dropped as Win32 does outside the `\\?\` and `\??\` forms. A device
 *   path that does not reduce to a folder on a local volume (a share
 *   through `UNC`, any other device, an empty device) and a server with no
 *   share need confirmation.
 * - posix: a path starting with `/`, split on `/` only and cleaned, that
 *   leaves nothing (`/`, `//./`, `/x\y/..`).
 * - darwin: posix, and `/System/Volumes/Data` (the data volume's own path,
 *   whose firmlinked folders are the ones under `/`) read as `/`. That
 *   over-refuses slightly: not every folder under `/` is firmlinked. Any
 *   other path ending in it needs confirmation.
 *
 * Linear in the length of the target: splits and single scans only.
 */
export function classifyRestoreTarget(targetPath: string, host?: RestoreTargetHost): RestoreTargetClass {
  const path = targetPath.trim();
  if (path === '') return 'not-root';
  switch (host) {
    case 'windows':
      return windowsClass(path);
    case 'posix':
      return posixClass(path, false);
    case 'darwin':
      return posixClass(path, true);
    default:
      // darwin's reading only adds roots to posix's.
      return stricter(windowsClass(path), posixClass(path, true));
  }
}

function windowsClass(path: string): RestoreTargetClass {
  if (DEVICE_PREFIX.test(path)) return deviceClass(path);
  if (DRIVE.test(path)) return countClass(resolveParts(path.slice(2).split(SEPARATOR), true));
  if (SEPARATOR.test(path.charAt(0)) && SEPARATOR.test(path.charAt(1))) {
    // `\\server\share\…` (either separator). Go's volume is the server and
    // share; `..` does not climb above it.
    const [server, share, ...tail] = path.slice(2).split(SEPARATOR);
    if (!server || !share) return 'needs-confirmation';
    return countClass(resolveParts(tail, true));
  }
  if (SEPARATOR.test(path.charAt(0))) {
    // Rooted with no drive: the helper refuses it, but it names the current
    // drive's root when it cleans to nothing. POSIX names keep trailing dots
    // and spaces, so only a backslash-rooted path is trimmed.
    return countClass(resolveParts(path.split(SEPARATOR), path.charAt(0) === '\\'));
  }
  return 'not-root'; // relative or drive-less: the helper refuses it
}

/**
 * A path behind `\\?\`, `\\.\` or `\??\`. Go's volume is the prefix and the
 * first component (for `\\.\UNC\`, also the server and share), and the rest
 * is cleaned beneath it. Win32 also resolves `..` across a `\\.\` path's
 * device name, so that form is read both ways and the stricter one wins.
 */
function deviceClass(path: string): RestoreTargetClass {
  const win32 = path.charAt(2) === '.';
  const raw = path.slice(4).split(SEPARATOR);
  const [first, ...tail] = raw;
  let result = first ? deviceVolumeClass(first, resolveParts(tail, win32)) : 'needs-confirmation';
  if (win32) {
    const [volume, ...rest] = resolveParts(raw, true);
    result = stricter(result, volume ? deviceVolumeClass(volume, rest) : 'needs-confirmation');
  }
  return result;
}

function deviceVolumeClass(volume: string, rest: string[]): RestoreTargetClass {
  if (DRIVE_ONLY.test(volume)) return countClass(rest);
  if (/^Volume\{[0-9a-f-]+\}$/i.test(volume)) return countClass(rest);
  if (
    /^GLOBALROOT$/i.test(volume)
    && /^Device$/i.test(rest[0] ?? '')
    && /^HarddiskVolume(?:ShadowCopy)?\d+$/i.test(rest[1] ?? '')
  ) {
    return countClass(rest.slice(2));
  }
  // `UNC\…` (a share is not a local folder), `C:x`, and every other path
  // through the object namespace (`GLOBALROOT\??\`, `Global\`, `Device\Mup`,
  // raw disks, …) can name a drive or share root in ways this check does
  // not model.
  return 'needs-confirmation';
}

function posixClass(path: string, darwin: boolean): RestoreTargetClass {
  if (path.charAt(0) !== '/') return 'not-root'; // relative: the helper refuses it
  let parts = resolveParts(path.split('/'), false);
  if (!darwin) return countClass(parts);
  if (parts.length >= 3 && isDataVolumeAt(parts, 0)) parts = parts.slice(3);
  const cls = countClass(parts);
  // Another path ending in the data volume path (`/Volumes/<boot volume>`
  // is a link to /, so `/Volumes/Macintosh HD/System/Volumes/Data` is the
  // data volume too) can name the same folders: confirm.
  if (cls === 'not-root' && parts.length >= 3 && isDataVolumeAt(parts, parts.length - 3)) return 'needs-confirmation';
  return cls;
}

// macOS compares names ignoring case (the helper folds them with Unicode case
// folding); upper- then lower-casing also folds letters such as U+017F to `s`.
function foldName(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase();
}

function isDataVolumeAt(parts: string[], i: number): boolean {
  return foldName(parts[i]!) === 'system' && foldName(parts[i + 1]!) === 'volumes' && foldName(parts[i + 2]!) === 'data';
}

function countClass(parts: string[]): RestoreTargetClass {
  return parts.length === 0 ? 'root' : 'not-root';
}

/**
 * Win32 drops trailing dots and spaces. A right-to-left scan: an end-anchored
 * regex retries at every start offset and is quadratic on a long run of dots
 * or spaces followed by another character (Strix, #12654).
 */
function trimTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c !== 0x2e && c !== 0x20) break;
    end--;
  }
  return end === segment.length ? segment : segment.slice(0, end);
}

/** Components with `.` and `..` resolved; `..` at the top stays there. */
function resolveParts(raw: string[], win32: boolean): string[] {
  const parts: string[] = [];
  for (const segment of raw) {
    const part = win32 && segment !== '.' && segment !== '..' ? trimTrailingDotsAndSpaces(segment) : segment;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts;
}
