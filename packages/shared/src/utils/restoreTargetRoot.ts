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

const DRIVE = /^[A-Za-z]:/;
const SEPARATOR = /[\\/]/;

/**
 * Whether `targetPath` names the root of a volume or share: a drive root
 * (`C:\`, `c:/`, `C:`), a POSIX root (`/`, `//`, `/.`), a share root
 * (`\\server\share\`), or any of those through a device path (`\\?\C:\`,
 * `\\.\C:\`, `\\?\UNC\server\share`, `\\?\Volume{…}\`,
 * `\\?\GLOBALROOT\Device\HarddiskVolume3\`), with `.` and `..`
 * resolved and, for Windows paths outside the `\\?\` and `\??\` forms,
 * trailing dots and spaces dropped as Win32 does.
 */
export function isVolumeRootRestoreTarget(targetPath: string): boolean {
  const path = targetPath.trim();
  if (path === '') return false;

  let rest: string;
  let win32 = true;
  const device = /^(?:[\\/]{2}[?.][\\/]|\\\?\?\\)/.exec(path);
  if (device) {
    win32 = /^[\\/]{2}\.[\\/]/.test(path);
    const after = path.slice(device[0].length);
    if (DRIVE.test(after)) {
      rest = after.slice(2);
    } else if (/^UNC[\\/]/i.test(after)) {
      const unc = splitShare(after.slice(4));
      if (unc === null) return false;
      rest = unc;
    } else {
      // Any other device path. Resolve `.`/`..` the way the path will be
      // read before classifying it (Win32 normalises the `\\.\` form only).
      const parts = win32 ? resolveParts(after.split(SEPARATOR), true) : after.split(SEPARATOR).filter((p) => p !== '');
      const [volume, ...tail] = parts;
      if (!volume) return false;
      if (/^Volume\{[0-9a-f-]+\}$/i.test(volume)) {
        rest = tail.join('/');
      } else if (
        /^GLOBALROOT$/i.test(volume)
        && /^Device$/i.test(tail[0] ?? '')
        && /^HarddiskVolume(?:ShadowCopy)?\d+$/i.test(tail[1] ?? '')
      ) {
        rest = tail.slice(2).join('/');
      } else {
        // Every other path through the object namespace (`GLOBALROOT\??\`,
        // `Global\`, `Device\Mup`, redirectors, …) can name a drive or share
        // root in ways this check does not model: always confirm.
        return true;
      }
    }
  } else if (DRIVE.test(path)) {
    rest = path.slice(2);
  } else if (/^[\\/]{2}[^\\/]/.test(path)) {
    const unc = splitShare(path.slice(2));
    // `//x` with no share is a POSIX path (`//` is a root there).
    rest = unc ?? path;
  } else if (SEPARATOR.test(path.charAt(0))) {
    rest = path;
    win32 = path.charAt(0) === '\\'; // POSIX names keep trailing dots and spaces
  } else {
    return false; // relative: the helper refuses it anyway
  }
  return remainingComponents(rest, win32) === 0;
}

/** The path after `server\share`, or null when there is no share. */
function splitShare(path: string): string | null {
  const [server, share, ...tail] = path.split(SEPARATOR);
  if (!server || !share) return null;
  return tail.join('/');
}

function resolveParts(raw: string[], win32: boolean): string[] {
  const parts: string[] = [];
  for (const segment of raw) {
    const part = win32 && segment !== '.' && segment !== '..' ? segment.replace(/[. ]+$/, '') : segment;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts;
}

function remainingComponents(rest: string, win32: boolean): number {
  return resolveParts(rest.split(SEPARATOR), win32).length;
}
