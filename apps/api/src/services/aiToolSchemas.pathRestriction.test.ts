import { describe, expect, it } from 'vitest';
import { isBlockedPath, safePath, validateToolInput } from './aiToolSchemas';

/**
 * The default AI path restriction (`isBlockedPath` / `safePath`) is evaluated on
 * the path string before anything reaches the agent. Every spelling the agent's
 * OS resolves to a restricted location has to be refused here, not only the
 * canonical one:
 *
 * - Windows legacy compatibility links (`Documents and Settings`,
 *   `Application Data`, `Local Settings`, `All Users`, …) that resolve into a
 *   user's AppData, the SAM/config directory or the agent's own directory;
 * - drive-less rooted paths, which Windows resolves on the current drive;
 * - relative paths, which resolve against the agent's working directory
 *   (`/` or `C:\Windows\System32`);
 * - empty paths, which the agent reads as "my home directory" (for
 *   LocalSystem that is under `System32\config`).
 */

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

describe('isBlockedPath: Windows legacy compatibility links', () => {
  it.each([
    'C:\\Documents and Settings\\bob\\AppData\\Local',
    'C:\\Documents and Settings\\bob\\Application Data\\Mozilla\\Firefox',
    'C:\\Documents and Settings\\bob\\Local Settings\\Application Data\\Google\\Chrome',
    'C:\\Users\\bob\\Application Data\\Microsoft\\Credentials',
    'C:\\Users\\bob\\Application Data',
    'C:\\Users\\bob\\Local Settings',
    'C:\\Users\\bob\\Local Settings\\Google\\Chrome\\User Data\\Default\\Login Data',
    'C:\\Users\\bob\\Cookies',
    'C:\\Users\\bob\\Recent\\payroll.lnk',
    'C:\\Users\\bob\\SendTo',
    'C:\\Users\\bob\\Start Menu\\Programs',
    'C:\\Users\\bob\\Templates',
    'C:\\Users\\bob\\NetHood',
    'C:\\Users\\bob\\PrintHood',
    'C:\\Users\\Default User\\AppData\\Local',
    'C:\\Windows\\Sysnative\\config\\SAM',
  ])('refuses %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });

  it.each([
    // case variants
    'c:\\DOCUMENTS AND SETTINGS\\Bob\\application data',
    'C:\\users\\BOB\\LOCAL SETTINGS\\temp',
    'C:\\USERS\\bob\\aPpLiCaTiOn DaTa',
    // trailing and repeated separators
    'C:\\Users\\bob\\Local Settings\\',
    'C:/Documents and Settings/bob/Application Data/',
    'C:\\\\Users\\\\bob\\\\Application Data',
    'C:\\Users\\bob\\Local Settings\\.\\Temp',
    // any drive letter
    'D:\\Documents and Settings\\bob\\Application Data',
  ])('refuses the variant %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });

  it.each([
    'C:\\Users\\All Users\\Breeze\\secrets.yaml',
    'C:\\ProgramData\\Application Data\\Breeze\\agent.yaml',
    'C:\\Documents and Settings\\All Users\\Breeze',
    'C:\\Documents and Settings\\All Users\\Application Data\\Breeze\\secrets.yaml',
    'C:\\ProgramData\\Breeze\\secrets.yaml',
  ])('refuses the agent configuration directory reached as %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });
});

describe('isBlockedPath: drive-less rooted paths', () => {
  it.each([
    '/Users/bob/AppData/Local/Google/Chrome/User Data/Default/Login Data',
    '/users/bob/appdata',
    '/Windows/System32/config/SAM',
    '/WINDOWS/system32/CONFIG',
    '/Documents and Settings/bob/Application Data',
    '/Users/bob/Local Settings/Temp',
    '/ProgramData/Breeze/secrets.yaml',
    '\\Users\\bob\\AppData\\Local',
    '\\Windows\\System32\\config',
    '\\Documents and Settings\\bob\\Local Settings',
  ])('refuses %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });

  it.each([
    // Win32 strips trailing dots and spaces and reads `name:stream` as the
    // named object itself, so these reach AppData on a Windows target.
    '/Users/bob/AppData./Local',
    '/Users/bob/AppData /Local',
    '/Users/bob/AppData::$INDEX_ALLOCATION/Local',
    // 8.3 short names
    '/Users/BOB~1/APPDAT~1/Local',
    '/DOCUME~1/bob/APPLIC~1',
  ])('refuses the Windows-resolved spelling %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });
});

describe('isBlockedPath: empty, relative and drive-relative paths', () => {
  it.each(['', ' ', '\t', '  \n '])('refuses the empty path %j', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });

  it.each([
    'config\\SAM',
    'proc/1/environ',
    'agent.yaml',
    '.',
    '~/.ssh/id_rsa',
    ' C:\\Users\\bob\\AppData',
  ])('refuses the relative path %j', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });

  it.each([
    'C:',
    'C:Users\\bob\\AppData',
    'c:config\\SAM',
  ])('refuses the drive-relative path %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });
});

describe('isBlockedPath: other Windows spellings of a restricted location', () => {
  it.each([
    '\\\\?\\C:\\Users\\bob\\AppData\\Local',
    '\\\\.\\C:\\Users\\bob\\AppData',
    '\\\\localhost\\c$\\Users\\bob\\AppData',
    '//?/C:/Users/bob/AppData',
    '\\??\\C:\\Users\\bob\\AppData\\Local',
    'C:\\Users\\bob\\APPDAT~1\\Local',
    'C:\\PROGRA~3\\Breeze\\secrets.yaml',
    'C:\\DOCUME~1\\bob\\APPLIC~1',
    'C:\\Users\\bob\\AppData::$INDEX_ALLOCATION\\Local',
    'C:\\Users\\bob\\AppData.\\Local',
    'C:\\Users\\bob\\AppData \\Local',
    'C:\\Users\\bob\\AppData\\Local\\*',
    // Characters Unicode case mapping folds onto ASCII (dotless i, long s).
    'C:\\W\u0131ndows\\System32\\config\\SAM',
    'C:\\Windows\\\u017Fystem32\\config',
  ])('refuses %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });
});

describe('isBlockedPath: POSIX link aliases of restricted locations', () => {
  it.each([
    '/run',
    '/run/secrets/kubernetes.io/serviceaccount/token',
    '/private/etc/sudoers',
    '/private/etc/passwd',
    '/private/var/run/docker.sock',
    '/System/Volumes/Data/private/etc/sudoers',
    '/Users/bob/.ssh/id_ed25519',
    '/var/root/.ssh/id_rsa',
    '/private/var/root/.ssh',
    '/private/etc/breeze/secrets.yaml',
    // macOS: the boot volume is also mounted under /Volumes, and the data
    // volume under /System/Volumes/Data.
    '/Volumes/Macintosh HD/Users/bob/.ssh',
    '/Volumes/Macintosh HD/private/var/run',
    '/Volumes/Macintosh HD/var/root/.ssh',
    '/volumes/renamed boot disk/etc/sudoers',
    '/System/Volumes/Data/Users/bob/.ssh/config',
    // Image-based Linux (Fedora Atomic, CoreOS, bootc): /home and /root live under /var.
    '/var/home/bob/.ssh',
    '/var/roothome/.ssh/authorized_keys',
  ])('refuses %s', (path) => {
    expect(isBlockedPath(path)).toBe(true);
  });
});

describe('isBlockedPath: ordinary paths stay allowed', () => {
  it.each([
    'C:\\',
    'C:/',
    'D:\\',
    '/',
    'C:\\ProgramData\\SomeVendor\\Logs\\app.log',
    'C:\\Program Files\\Vendor\\app.log',
    'C:\\Program Files (x86)\\Vendor',
    'C:\\Users\\Public\\Documents',
    'C:\\Users\\bob',
    'C:\\Users\\bob\\Documents\\report.docx',
    // Folders that share a link's name but are not at the link's position.
    'C:\\Users\\bob\\Documents\\Recent\\notes.txt',
    'C:\\Users\\bob\\Documents\\Templates\\invoice.dotx',
    'C:\\Users\\bob\\Desktop\\Application Data backup.zip',
    'C:\\Documents and Settings',
    'C:\\Windows\\Temp\\setup.log',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Users\\bob\\Desktop\\file~name.txt',
    '/var/log/syslog',
    '/var/backups/db-2026-09-29T10:00:00Z.sql.gz',
    '/home/bob/Templates/letter.odt',
    '/home/bob/Documents/report.pdf',
    '/runner/work/log.txt',
    '/private/tmp/build.log',
    '/private/var/log/system.log',
    '/Users/bob/Documents/report.pdf',
    '/Users/bob/Library/Logs/app.log',
    '/Volumes/Backup/Projects/report.pdf',
    '/var/homework/notes.txt',
    '/opt/app/file~backup.txt',
    '/etc/hosts',
  ])('allows %s', (path) => {
    expect(isBlockedPath(path)).toBe(false);
  });
});

describe('safePath messages', () => {
  it('asks for a path when it is empty', () => {
    const result = safePath.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/required/i);
  });

  it('asks for an absolute path when it is relative', () => {
    const result = safePath.safeParse('config\\SAM');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/absolute/i);
  });

  it('reports a restricted location as blocked', () => {
    const result = safePath.safeParse('C:\\Documents and Settings\\bob\\Application Data');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/blocked/);
  });
});

describe('validateToolInput: every path-taking tool applies the restriction', () => {
  const RESTRICTED = [
    'C:\\Documents and Settings\\bob\\Application Data',
    '/Users/bob/AppData/Local',
    'C:Users\\bob\\AppData',
    '',
    '   ',
  ];

  it.each(RESTRICTED)('file_operations list refuses %j', (path) => {
    expect(validateToolInput('file_operations', { deviceId: DEVICE_ID, action: 'list', path }).success).toBe(false);
  });

  it.each(RESTRICTED)('file_operations rename refuses newPath %j', (newPath) => {
    expect(validateToolInput('file_operations', {
      deviceId: DEVICE_ID, action: 'rename', path: 'C:\\Temp\\a.txt', newPath,
    }).success).toBe(false);
  });

  it.each(RESTRICTED)('analyze_disk_usage refuses %j', (path) => {
    expect(validateToolInput('analyze_disk_usage', { deviceId: DEVICE_ID, refresh: true, path }).success).toBe(false);
  });

  it('analyze_disk_usage still accepts an omitted path (the OS root) and a volume root', () => {
    expect(validateToolInput('analyze_disk_usage', { deviceId: DEVICE_ID }).success).toBe(true);
    expect(validateToolInput('analyze_disk_usage', { deviceId: DEVICE_ID, path: 'D:\\' }).success).toBe(true);
    expect(validateToolInput('analyze_disk_usage', { deviceId: DEVICE_ID, path: '/data' }).success).toBe(true);
  });

  it.each(RESTRICTED)('disk_cleanup preview refuses %j', (path) => {
    expect(validateToolInput('disk_cleanup', { deviceId: DEVICE_ID, action: 'preview', path }).success).toBe(false);
  });

  describe.each(['file_list', 'file_read'] as const)('execute_command %s', (commandType) => {
    it.each([
      ...RESTRICTED,
      'C:\\Users\\bob\\AppData\\Local',
      'C:\\Users\\All Users\\Breeze\\secrets.yaml',
      'proc/1/environ',
    ])('refuses %j', (path) => {
      const result = validateToolInput('execute_command', { deviceId: DEVICE_ID, commandType, payload: { path } });
      expect(result.success).toBe(false);
    });

    it('refuses a missing path', () => {
      expect(validateToolInput('execute_command', { deviceId: DEVICE_ID, commandType, payload: {} }).success).toBe(false);
      expect(validateToolInput('execute_command', { deviceId: DEVICE_ID, commandType }).success).toBe(false);
    });

    it.each(['C:\\ProgramData\\SomeVendor\\Logs', '/var/log/syslog'])('accepts %s', (path) => {
      const result = validateToolInput('execute_command', { deviceId: DEVICE_ID, commandType, payload: { path } });
      expect(result).toEqual({ success: true });
    });
  });

  it('execute_command leaves non-file command types alone', () => {
    expect(validateToolInput('execute_command', { deviceId: DEVICE_ID, commandType: 'list_processes' }).success).toBe(true);
    expect(validateToolInput('execute_command', {
      deviceId: DEVICE_ID, commandType: 'event_logs_query', payload: { logName: 'System', level: 'error' },
    }).success).toBe(true);
  });
});
