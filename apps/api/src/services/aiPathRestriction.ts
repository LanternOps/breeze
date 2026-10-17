/**
 * Default AI path restriction.
 *
 * The one check every AI-supplied device filesystem path passes before a tool
 * can list, read, write or scan it (`safePath` in aiToolSchemas.ts, the
 * `execute_command` file_list/file_read branch, and analyze_disk_usage's
 * normalised scan root). `aiTools.pathParams.contract.test.ts` pins that every
 * path-taking tool field goes through it or carries a written exemption.
 *
 * The check runs on the server, on the path string, before the device is
 * contacted, so it has to anticipate how the device's OS resolves that string:
 *
 * - Windows resolves a drive-less rooted path (`\Users\x`, `/Users/x`) on the
 *   current drive, strips trailing dots and spaces from names, reads
 *   `name:stream` as the named object, and accepts 8.3 short names. Rooted
 *   `/` paths are therefore checked both as POSIX paths and as `C:` paths.
 * - Both families have built-in links that reach a restricted location under
 *   another name: the Windows compatibility junctions (`Documents and
 *   Settings`, `Application Data`, `Local Settings`, `All Users`, …) and POSIX
 *   links such as `/run` = `/var/run` and macOS `/private/etc` = `/etc`. Those
 *   are resolved to their targets before matching.
 * - A relative or empty path resolves against the agent's working directory or
 *   home directory (`/`, `C:\Windows\System32`, or LocalSystem's profile under
 *   `System32\config`), so both are refused rather than guessed at.
 *
 * Links created on a device by its users or software (a junction or symlink
 * under an ordinary name) cannot be seen from here; only the agent can resolve
 * those, at open time.
 */

import { isAgentConfigPath } from '../routes/systemTools/sensitiveTargets';
import { candidateForms, isShortNameComponent, normalizePath, UNRESOLVED_FORM } from './devicePathForms';
import type { AiDeviceFileReadLevel } from '../db/schema/aiDataPolicies';

export { normalizePath };

const BLOCKED_PATH_PREFIXES = [
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc', '/sys', '/dev',
  '/root/.ssh', '/home/*/.ssh',
  '/var/run', '/var/lib/docker',
  'C:\\Windows\\System32\\config',
  'C:\\Windows\\SAM',
  'C:\\Users\\*\\AppData',
];

function matchesBlockedPrefix(form: string): boolean {
  if (form === UNRESOLVED_FORM) return true;
  return BLOCKED_PATH_PREFIXES.some((prefix) => {
    const normalizedPrefix = normalizePath(prefix);
    // Handle wildcard prefixes like /home/*/.ssh
    if (normalizedPrefix.includes('*')) {
      const parts = normalizedPrefix.split('*');
      return parts.length === 2 &&
        form.startsWith(parts[0]!) &&
        form.includes(parts[1]!);
    }
    return form.startsWith(normalizedPrefix) ||
      form === normalizedPrefix.replace(/\/$/, '');
  });
}

export const PATH_BLOCKED_MESSAGE = 'Access to this path is blocked';

/**
 * User-profile roots (AI data policy, spec 2026-10-15): refused unless the
 * tenant's device file read level is `any_with_approval`. `candidateForms`
 * already maps `D:\Users`, drive-less `\Users`, the `Documents and Settings`
 * junction, macOS `/Users/*` and image-based Linux `/var/home` onto these
 * forms, so no separate prefix is needed for any of them. `C:\Users\Public`
 * sits under `c:/users` and is covered on purpose: it is a shared drop folder
 * for every profile on the machine.
 */
const USER_PROFILE_PATH_PREFIXES = ['c:/users', '/home', '/root'];

/** Whether a NORMALIZED candidate form lies in a user-profile root (component-anchored). */
export function isUserProfilePath(normalizedForm: string): boolean {
  if (normalizedForm === UNRESOLVED_FORM) return true;
  return USER_PROFILE_PATH_PREFIXES.some((p) => normalizedForm === p || normalizedForm.startsWith(p + '/'));
}

export const USER_PROFILE_BLOCKED_MESSAGE = 'Access to user profile folders is blocked by the AI data policy';

/**
 * Why an AI-supplied device path is refused, or null when it may be used.
 * `undefined`/non-strings are refused as missing, so a caller can pass an
 * optional field straight through when the path is required.
 *
 * `opts.level` is the tenant's resolved device file read level. Without it
 * only the always-on floor applies — that is what `safePath` (schema time,
 * before the device's org is known) relies on. With `off` or
 * `no_user_profiles`, a path in a user-profile root is refused with
 * {@link USER_PROFILE_BLOCKED_MESSAGE}. The floor is checked first, so a
 * floor path keeps {@link PATH_BLOCKED_MESSAGE} at every level.
 */
export function aiPathRefusal(path: unknown, opts?: { level?: AiDeviceFileReadLevel }): string | null {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return 'Path is required';
  }
  if (path.includes('\0')) return 'Path contains null bytes';
  if (path.includes('..')) return 'Path traversal (..) not allowed';
  // Device namespace and UNC forms (\\?\, \\.\, \\host\share), checked on the
  // raw string because normalisation collapses the leading separators.
  if (/^[\\/]{2}/.test(path)) return `${PATH_BLOCKED_MESSAGE}: UNC and device namespace paths are not supported`;
  // Drive-relative (C:foo) resolves against that drive's current directory,
  // and a relative path against the agent's working directory.
  if (/^[A-Za-z]:(?![\\/])/.test(path) || !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) {
    return 'Use an absolute path (for example C:\\ProgramData\\Vendor\\Logs or /var/log)';
  }
  if (/[?*]/.test(path)) return `${PATH_BLOCKED_MESSAGE}: wildcard characters are not supported`;

  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  if (segments.some(isShortNameComponent)) {
    return `${PATH_BLOCKED_MESSAGE}: 8.3 short names are not supported, use the full name`;
  }
  // A path that is Windows by its shape must not use stream syntax or names
  // ending in a dot or space: neither is needed, and both reach an object
  // under a spelling other than its own. (POSIX names may legitimately
  // contain them, so a `/` path only has them resolved, in candidateForms.)
  if (path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    const afterDrive = /^[a-z]:/.test(normalized) ? normalized.slice(2) : normalized;
    if (afterDrive.includes(':') || afterDrive.split('/').some((seg) => /[. ]$/.test(seg))) {
      return `${PATH_BLOCKED_MESSAGE}: stream names and names ending in a dot or space are not supported`;
    }
  }

  const forms = candidateForms(normalized);
  if (forms.some((form) => matchesBlockedPrefix(form) || isAgentConfigPath(form))) {
    return PATH_BLOCKED_MESSAGE;
  }
  if (opts?.level && opts.level !== 'any_with_approval' && forms.some(isUserProfilePath)) {
    return USER_PROFILE_BLOCKED_MESSAGE;
  }
  return null;
}

export function isBlockedPath(path: string): boolean {
  return aiPathRefusal(path) !== null;
}
