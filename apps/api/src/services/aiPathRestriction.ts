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

const BLOCKED_PATH_PREFIXES = [
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/proc', '/sys', '/dev',
  '/root/.ssh', '/home/*/.ssh',
  '/var/run', '/var/lib/docker',
  'C:\\Windows\\System32\\config',
  'C:\\Windows\\SAM',
  'C:\\Users\\*\\AppData',
];

/**
 * Built-in Windows links, as `c:`-form patterns and the location each one
 * reaches. Anchored at component boundaries so an ordinary folder that merely
 * shares a link's name elsewhere (`Documents\Templates`) is not affected.
 * Order matters: machine-wide links are resolved before per-profile ones.
 */
const WINDOWS_LINK_TARGETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^c:\/documents and settings(?=\/|$)/, 'c:/users'],
  [/^c:\/users\/all users(?=\/|$)/, 'c:/programdata'],
  [/^c:\/users\/default user(?=\/|$)/, 'c:/users/default'],
  [/^c:\/programdata\/application data(?=\/|$)/, 'c:/programdata'],
  // Seen by 32-bit processes only; resolves to the real System32.
  [/^c:\/windows\/sysnative(?=\/|$)/, 'c:/windows/system32'],
  [/^(c:\/users\/[^/]+)\/application data(?=\/|$)/, '$1/appdata/roaming'],
  [/^(c:\/users\/[^/]+)\/local settings(?=\/|$)/, '$1/appdata/local'],
  [
    /^(c:\/users\/[^/]+)\/(cookies|nethood|printhood|recent|sendto|start menu|templates)(?=\/|$)/,
    '$1/appdata/roaming/microsoft/windows/$2',
  ],
];

/** Built-in POSIX links (Linux `/run`, macOS `/private`, macOS home and root). */
const POSIX_LINK_TARGETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/run(?=\/|$)/, '/var/run'],
  [/^\/private\/(etc|var|tmp)(?=\/|$)/, '/$1'],
  [/^\/var\/root(?=\/|$)/, '/root'],
  [/^\/users\/([^/]+)(?=\/|$)/, '/home/$1'],
];

/** Upper-then-lower folds characters Unicode maps onto ASCII (ı → i, ſ → s). */
function foldCase(value: string): string {
  return value.toUpperCase().toLowerCase();
}

export function normalizePath(path: string): string {
  let result = foldCase(
    path
      .replace(/\\/g, '/')      // Normalize backslashes
      .replace(/\/+/g, '/'),    // Collapse redundant separators (/etc///shadow → /etc/shadow)
  );
  // Iteratively remove dot components until stable
  let prev: string;
  do {
    prev = result;
    result = result.replace(/\/\.\//g, '/').replace(/\/\.$/, '/');
  } while (result !== prev);
  return result;
}

/**
 * An NTFS 8.3 short name (`APPDAT~1`, `PROGRA~3`, `AP5E2F~1.TXT`): a base of at
 * most eight characters ending in `~<digits>`, plus an optional extension of at
 * most three. It can stand for any long name, so it cannot be checked.
 */
function isShortNameComponent(segment: string): boolean {
  const match = /^([^.]*~\d+)(?:\.([^.]*))?$/.exec(segment);
  return match !== null && match[1]!.length <= 8 && (match[2] === undefined || match[2].length <= 3);
}

/** Win32 name resolution for one component: `name:stream` and trailing dots/spaces. */
function win32Component(segment: string): string {
  return segment.replace(/:.*$/, '').replace(/[. ]+$/, '');
}

function applyLinks(form: string, links: ReadonlyArray<readonly [RegExp, string]>): string[] {
  const forms = [form];
  let current = form;
  // Every rule either shortens the path or moves it under a target no rule
  // matches again, so this settles in a few rounds; the cap only guards that.
  for (let round = 0; round < 16; round += 1) {
    const rule = links.find(([pattern]) => pattern.test(current));
    if (!rule) return forms;
    current = current.replace(rule[0], rule[1]);
    forms.push(current);
  }
  return [...forms, '\0unresolved'];
}

/** Every spelling of the target the device could resolve `normalized` to. */
function candidateForms(normalized: string): string[] {
  const forms: string[] = [normalized];
  const drive = /^[a-z]:\//.exec(normalized);
  const windowsTail = drive ? normalized.slice(2) : normalized.startsWith('/') ? normalized : null;
  if (windowsTail !== null) {
    // Any drive letter against the C: rules: a Windows install or a profile
    // folder is not guaranteed to live on C:, and a drive-less rooted path
    // resolves on the current drive.
    const windows = `c:${windowsTail.split('/').map(win32Component).join('/')}`;
    forms.push(...applyLinks(windows, WINDOWS_LINK_TARGETS));
  }
  if (!drive && normalized.startsWith('/')) forms.push(...applyLinks(normalized, POSIX_LINK_TARGETS));
  return forms;
}

function matchesBlockedPrefix(form: string): boolean {
  if (form === '\0unresolved') return true;
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
 * Why an AI-supplied device path is refused, or null when it may be used.
 * `undefined`/non-strings are refused as missing, so a caller can pass an
 * optional field straight through when the path is required.
 */
export function aiPathRefusal(path: unknown): string | null {
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
  return null;
}

export function isBlockedPath(path: string): boolean {
  return aiPathRefusal(path) !== null;
}
