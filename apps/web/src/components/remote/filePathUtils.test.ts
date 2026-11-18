import { describe, expect, it } from 'vitest';
import {
  buildBreadcrumbs,
  getInitialFilePath,
  getParentPath,
  getPathRoot,
  isPathRoot,
  isWindowsPath,
  joinRemotePath,
  validateFolderName
} from './filePathUtils';

describe('isWindowsPath', () => {
  it('detects drive letter paths', () => {
    expect(isWindowsPath('C:\\')).toBe(true);
    expect(isWindowsPath('C:/Users')).toBe(true);
    expect(isWindowsPath('D:')).toBe(true);
  });

  it('detects UNC paths', () => {
    expect(isWindowsPath('\\\\server\\share')).toBe(true);
  });

  it('rejects POSIX paths', () => {
    expect(isWindowsPath('/usr/local')).toBe(false);
    expect(isWindowsPath('/')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isWindowsPath('')).toBe(false);
  });
});

describe('getPathRoot', () => {
  it('returns drive root for Windows paths', () => {
    expect(getPathRoot('C:\\Users\\Todd')).toBe('C:\\');
    expect(getPathRoot('D:')).toBe('D:\\');
  });

  it('returns \\\\ for UNC paths', () => {
    expect(getPathRoot('\\\\server\\share')).toBe('\\\\');
  });

  it('returns / for POSIX paths', () => {
    expect(getPathRoot('/var/log')).toBe('/');
  });
});

describe('isPathRoot', () => {
  it('identifies Windows root paths', () => {
    expect(isPathRoot('C:\\')).toBe(true);
    expect(isPathRoot('C:')).toBe(true);
  });

  it('identifies POSIX root', () => {
    expect(isPathRoot('/')).toBe(true);
  });

  it('returns false for non-root paths', () => {
    expect(isPathRoot('/tmp')).toBe(false);
    expect(isPathRoot('C:\\Users')).toBe(false);
  });

  it('treats empty string as root', () => {
    expect(isPathRoot('')).toBe(true);
  });

  it('handles UNC root', () => {
    expect(isPathRoot('\\\\')).toBe(true);
  });
});

describe('getParentPath', () => {
  it('computes parent paths for Windows paths', () => {
    expect(getParentPath('C:\\Users\\Todd\\Documents')).toBe('C:\\Users\\Todd');
    expect(getParentPath('C:\\Users\\Todd')).toBe('C:\\Users');
    expect(getParentPath('C:\\Users')).toBe('C:\\');
    expect(getParentPath('C:\\')).toBe('C:\\');
    expect(getParentPath('C:')).toBe('C:\\');
  });

  it('computes parent paths for POSIX paths', () => {
    expect(getParentPath('/Users/todd/Documents')).toBe('/Users/todd');
    expect(getParentPath('/Users/todd')).toBe('/Users');
    expect(getParentPath('/Users')).toBe('/');
    expect(getParentPath('/')).toBe('/');
  });

  it('returns / for empty string', () => {
    expect(getParentPath('')).toBe('/');
  });

  it('handles trailing separators', () => {
    expect(getParentPath('/Users/todd/')).toBe('/Users');
    expect(getParentPath('C:\\Users\\Todd\\')).toBe('C:\\Users');
  });

  it('handles UNC paths', () => {
    expect(getParentPath('\\\\server\\share\\folder')).toBe('\\\\server\\share');
    expect(getParentPath('\\\\server\\share')).toBe('\\\\server');
  });

  it('handles mixed-separator Windows paths', () => {
    expect(getParentPath('C:/Users/Todd')).toBe('C:\\Users');
  });

  it('handles paths with duplicate separators', () => {
    expect(getParentPath('//Users//todd')).toBe('/Users');
  });
});

describe('joinRemotePath', () => {
  it('joins using correct separator', () => {
    expect(joinRemotePath('C:\\Users', 'Todd')).toBe('C:\\Users\\Todd');
    expect(joinRemotePath('C:\\', 'Windows')).toBe('C:\\Windows');
    expect(joinRemotePath('/Users', 'todd')).toBe('/Users/todd');
    expect(joinRemotePath('/', 'tmp')).toBe('/tmp');
  });

  it('handles base with trailing separator', () => {
    expect(joinRemotePath('/Users/', 'todd')).toBe('/Users/todd');
    expect(joinRemotePath('C:\\Users\\', 'Todd')).toBe('C:\\Users\\Todd');
  });

  it('rejects path traversal segments', () => {
    expect(() => joinRemotePath('/Users', '..')).toThrow('Invalid path segment');
    expect(() => joinRemotePath('/Users', '.')).toThrow('Invalid path segment');
  });

  it('rejects names containing separators', () => {
    expect(() => joinRemotePath('/Users', 'sub/dir')).toThrow('Invalid path segment');
    expect(() => joinRemotePath('C:\\Users', 'sub\\dir')).toThrow('Invalid path segment');
  });

  it('rejects empty name', () => {
    expect(() => joinRemotePath('/Users', '')).toThrow('Invalid path segment');
  });

  it('rejects null bytes', () => {
    expect(() => joinRemotePath('/Users', 'file\0.txt')).toThrow('Invalid path segment');
  });
});

describe('buildBreadcrumbs', () => {
  it('builds Windows breadcrumbs with full navigation paths', () => {
    const breadcrumbs = buildBreadcrumbs('C:\\Users\\Todd\\Documents');

    expect(breadcrumbs.rootLabel).toBe('C:\\');
    expect(breadcrumbs.rootPath).toBe('C:\\');
    expect(breadcrumbs.segments).toEqual([
      { label: 'Users', path: 'C:\\Users' },
      { label: 'Todd', path: 'C:\\Users\\Todd' },
      { label: 'Documents', path: 'C:\\Users\\Todd\\Documents' }
    ]);
  });

  it('builds POSIX breadcrumbs with full navigation paths', () => {
    const breadcrumbs = buildBreadcrumbs('/Users/todd/Documents');

    expect(breadcrumbs.rootLabel).toBe('/');
    expect(breadcrumbs.rootPath).toBe('/');
    expect(breadcrumbs.segments).toEqual([
      { label: 'Users', path: '/Users' },
      { label: 'todd', path: '/Users/todd' },
      { label: 'Documents', path: '/Users/todd/Documents' }
    ]);
  });

  it('handles root-only POSIX path', () => {
    const breadcrumbs = buildBreadcrumbs('/');

    expect(breadcrumbs.rootLabel).toBe('/');
    expect(breadcrumbs.rootPath).toBe('/');
    expect(breadcrumbs.segments).toEqual([]);
  });

  it('handles root-only Windows path', () => {
    const breadcrumbs = buildBreadcrumbs('C:\\');

    expect(breadcrumbs.rootLabel).toBe('C:\\');
    expect(breadcrumbs.rootPath).toBe('C:\\');
    expect(breadcrumbs.segments).toEqual([]);
  });

  it('handles mixed-separator Windows path', () => {
    const breadcrumbs = buildBreadcrumbs('C:/Users/Todd');

    expect(breadcrumbs.rootLabel).toBe('C:\\');
    expect(breadcrumbs.rootPath).toBe('C:\\');
    expect(breadcrumbs.segments).toEqual([
      { label: 'Users', path: 'C:\\Users' },
      { label: 'Todd', path: 'C:\\Users\\Todd' }
    ]);
  });

  it('handles UNC paths', () => {
    const breadcrumbs = buildBreadcrumbs('\\\\server\\share\\folder');

    expect(breadcrumbs.rootLabel).toBe('\\\\');
    expect(breadcrumbs.rootPath).toBe('\\\\');
    expect(breadcrumbs.segments).toEqual([
      { label: 'server', path: '\\\\server' },
      { label: 'share', path: '\\\\server\\share' },
      { label: 'folder', path: '\\\\server\\share\\folder' }
    ]);
  });

  it('handles empty string as POSIX root', () => {
    const breadcrumbs = buildBreadcrumbs('');

    expect(breadcrumbs.rootLabel).toBe('/');
    expect(breadcrumbs.rootPath).toBe('/');
    expect(breadcrumbs.segments).toEqual([]);
  });

  it('collapses duplicate POSIX separators', () => {
    const breadcrumbs = buildBreadcrumbs('//Users//todd');

    expect(breadcrumbs.rootLabel).toBe('/');
    expect(breadcrumbs.segments).toEqual([
      { label: 'Users', path: '/Users' },
      { label: 'todd', path: '/Users/todd' }
    ]);
  });
});

describe('getInitialFilePath', () => {
  it('returns C:\\ for windows', () => {
    expect(getInitialFilePath('windows')).toBe('C:\\');
  });

  it('returns /Users for macos', () => {
    expect(getInitialFilePath('macos')).toBe('/Users');
  });

  it('returns /home for linux', () => {
    expect(getInitialFilePath('linux')).toBe('/home');
  });
});

describe('validateFolderName', () => {
  const POSIX = '/data';
  const WINDOWS = 'C:\\Users';

  it('accepts an ordinary name on either platform', () => {
    expect(validateFolderName('Reports 2026', POSIX, [])).toBeNull();
    expect(validateFolderName('Reports 2026', WINDOWS, [])).toBeNull();
  });

  it.each(['a/b', 'a\\b', '/', '\\', '.', '..', 'a\u0000b', 'a\nb'])('refuses %j on either platform', (name) => {
    expect(validateFolderName(name, POSIX, [])).toBe('invalid');
    expect(validateFolderName(name, WINDOWS, [])).toBe('invalid');
  });

  it.each(['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'trailing.'])(
    'refuses %j on Windows, where the file system does, and allows it elsewhere',
    (name) => {
      expect(validateFolderName(name, WINDOWS, [])).toBe('invalid');
      expect(validateFolderName(name, POSIX, [])).toBeNull();
    },
  );

  // Mirrors isReservedWindowsName in agent/internal/remote/tools/software_install_archive.go.
  it.each([
    'con', 'CON', 'Prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9', 'com0', 'lpt0',
    'con.txt', 'nul.tar.gz', 'conin$', 'CONOUT$', 'com\u00b9', 'lpt\u00b3', 'con ',
    'trailing ',
  ])('refuses the Windows reserved/trailing-space name %j on Windows, allows it on POSIX', (name) => {
    expect(validateFolderName(name, WINDOWS, [])).toBe('invalid');
    expect(validateFolderName(name, POSIX, [])).toBeNull();
  });

  it.each(['console', 'com10', 'lpt', 'com', 'auxiliary', 'nulled', 'my con'])(
    'allows the look-alike %j on Windows',
    (name) => {
      expect(validateFolderName(name, WINDOWS, [])).toBeNull();
    },
  );

  it('treats a name that differs only by case as taken on Windows, not on POSIX', () => {
    expect(validateFolderName('reports', WINDOWS, ['Reports'])).toBe('exists');
    expect(validateFolderName('reports', POSIX, ['Reports'])).toBeNull();
    expect(validateFolderName('Reports', POSIX, ['Reports'])).toBe('exists');
  });

  it.each(['macos', 'darwin'])('treats a case-only difference as taken on %s, whose default volume ignores case', (osType) => {
    expect(validateFolderName('reports', '/Users/tech', ['Reports'], osType)).toBe('exists');
  });

  it('keeps Windows rules off a macOS path', () => {
    expect(validateFolderName('a:b', '/Users/tech', [], 'macos')).toBeNull();
  });

  it('reports an invalid name ahead of a clash', () => {
    expect(validateFolderName('..', POSIX, ['..'])).toBe('invalid');
  });
});
