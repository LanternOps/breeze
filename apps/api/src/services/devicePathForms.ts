/**
 * How a device's OS resolves a path string, computed server-side before the
 * device is contacted. Shared by every server-side path deny-list (the AI path
 * restriction in aiPathRestriction.ts and the agent-config-directory check in
 * routes/systemTools/sensitiveTargets.ts) so they agree on which spellings
 * reach the same object:
 *
 * - Windows resolves a drive-less rooted path (`\Users\x`, `/Users/x`) on the
 *   current drive, strips trailing dots and spaces from names, reads
 *   `name:stream` as the named object, and accepts 8.3 short names. Rooted
 *   `/` paths are therefore considered both as POSIX paths and as `C:` paths.
 * - Both families have built-in links that reach a location under another
 *   name: the Windows compatibility junctions (`Documents and Settings`,
 *   `Application Data`, `All Users`, …) and POSIX links such as `/run` =
 *   `/var/run` and macOS `/private/etc` = `/etc`. Those are resolved to their
 *   targets.
 */

/**
 * Marker form emitted when link resolution does not settle; callers must treat
 * it as matching every deny rule.
 */
export const UNRESOLVED_FORM = '\0unresolved';

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

/**
 * Built-in POSIX links and mounts that reach the same tree under another name:
 * macOS mounts the boot volume under /Volumes (any name, it can be renamed)
 * and the data volume under /System/Volumes/Data, and keeps /etc, /var and
 * root's home under /private; Linux /run is /var/run; image-based Linux
 * (Fedora Atomic, CoreOS, bootc) keeps /home and /root under /var; macOS
 * homes live in /Users.
 */
const POSIX_LINK_TARGETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/volumes\/[^/]+(?=\/|$)/, ''],
  [/^\/system\/volumes\/data(?=\/|$)/, ''],
  [/^\/private\/(etc|var|tmp)(?=\/|$)/, '/$1'],
  [/^\/run(?=\/|$)/, '/var/run'],
  [/^\/var\/root(?=\/|$)/, '/root'],
  [/^\/var\/roothome(?=\/|$)/, '/root'],
  [/^\/var\/home(?=\/|$)/, '/home'],
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
export function isShortNameComponent(segment: string): boolean {
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
  return [...forms, UNRESOLVED_FORM];
}

/** Every spelling of the target the device could resolve `normalized` to. */
export function candidateForms(normalized: string): string[] {
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

/**
 * Rewrites a Win32 device-namespace path (`\\?\C:\x`, `\\.\C:\x`,
 * `\\?\UNC\host\C$\x`) or an administrative-share path (`\\host\C$\x`) to
 * the drive path it reaches (`C:\x`). Anything else is returned unchanged.
 */
export function stripWindowsNamespacePrefix(path: string): string {
  let result = path.replace(/^[\\/]{2}[?.][\\/](?:unc[\\/])?/i, (m) => (/unc/i.test(m) ? '\\\\' : ''));
  result = result.replace(/^[\\/]{2}[^\\/]+[\\/]([a-z])\$(?=[\\/]|$)/i, '$1:');
  return result;
}
