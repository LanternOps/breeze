/**
 * Shared spelling requirements for device filesystem paths: an absolute path
 * (`/var/log`, `C:\Logs`). UNC paths and device-namespace forms are refused,
 * as are drive-relative and relative paths. Mapped drives and mounted network
 * filesystems are reached through ordinary absolute paths and are not
 * affected. The agent applies the same rules before it touches a path
 * (agent/internal/remote/tools/fileops_pathfloor.go).
 */
export const DEVICE_PATH_BLOCKED_MESSAGE = 'Access to this path is blocked';

export function devicePathFloorRefusal(path: string): string | null {
  // A leading pair of separators (\\host\share, \\?\, \\.\) or the NT
  // pass-through prefix (\??\) names a UNC path or a device namespace.
  if (/^[\\/]{2}/.test(path) || /^[\\/]\?\?[\\/]/.test(path)) {
    return `${DEVICE_PATH_BLOCKED_MESSAGE}: UNC and device namespace paths are not supported`;
  }
  if (/^[A-Za-z]:(?![\\/])/.test(path) || !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) {
    return 'Use an absolute path (for example C:\\ProgramData\\Vendor\\Logs or /var/log)';
  }
  return null;
}
