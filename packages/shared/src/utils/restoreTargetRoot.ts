// #12638: a file restore to a target keeps each file's full path beneath it
// (the backup helper strips the volume and joins the rest under the target),
// so a target that is a volume root — `C:\`, `/`, a share root — writes every
// file back over the original it was backed up from. The request says so
// explicitly with `allowOverwriteOriginals`; a root target without it is
// refused before anything is dispatched. Helpers that predate the flag would
// otherwise overwrite silently, so this check is what protects them.
//
// Lexical only, and deliberately broad: the server cannot see the device's
// disks, so any spelling of a volume root counts, whichever volume the
// snapshot came from (an empty E:\ needs the flag too, or a folder such as
// E:\Restored). The helper makes the exact, per-file decision.

const DRIVE = /^[A-Za-z]:/;
const SEPARATOR = /[\\/]/;

/**
 * Whether `targetPath` names the root of a volume or share: a drive root
 * (`C:\`, `c:/`, `C:`), a POSIX root (`/`, `//`, `/.`), a share root
 * (`\\server\share\`), or any of those through a device path (`\\?\C:\`,
 * `\\.\C:\`, `\\?\UNC\server\share`, `\\?\Volume{…}\`), with `.` and `..`
 * resolved and, outside the `\\?\` form, trailing dots and spaces dropped
 * as Windows does.
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
      // A volume GUID or other device path: its first component is the volume.
      const [volume, ...tail] = after.split(SEPARATOR);
      if (!volume) return false;
      rest = tail.join('/');
    }
  } else if (DRIVE.test(path)) {
    rest = path.slice(2);
  } else if (/^[\\/]{2}[^\\/]/.test(path)) {
    const unc = splitShare(path.slice(2));
    // `//x` with no share is a POSIX path (`//` is a root there).
    rest = unc ?? path;
  } else if (SEPARATOR.test(path.charAt(0))) {
    rest = path;
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

function remainingComponents(rest: string, win32: boolean): number {
  const parts: string[] = [];
  for (const raw of rest.split(SEPARATOR)) {
    const part = win32 && raw !== '.' && raw !== '..' ? raw.replace(/[. ]+$/, '') : raw;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length;
}
