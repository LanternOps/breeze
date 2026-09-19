import { describe, expect, it } from 'vitest';
import { normalizeScanPath, osRootScanPath } from './scanPath';

describe('osRootScanPath', () => {
  it('is the C: volume root on Windows and / everywhere else', () => {
    expect(osRootScanPath('windows')).toBe('C:\\');
    expect(osRootScanPath('macos')).toBe('/');
    expect(osRootScanPath('linux')).toBe('/');
  });

  it('treats an unknown or missing OS as POSIX rather than guessing Windows', () => {
    expect(osRootScanPath(null)).toBe('/');
    expect(osRootScanPath(undefined)).toBe('/');
    expect(osRootScanPath('freebsd')).toBe('/');
  });
});

describe('normalizeScanPath — Windows', () => {
  it('upper-cases the drive letter and keeps the trailing separator on a volume root', () => {
    expect(normalizeScanPath('windows', 'c:\\')).toBe('C:\\');
    expect(normalizeScanPath('windows', 'C:\\')).toBe('C:\\');
    expect(normalizeScanPath('windows', 'd:/')).toBe('D:\\');
    // A bare drive with no separator is the volume root, not a relative path.
    expect(normalizeScanPath('windows', 'c:')).toBe('C:\\');
  });

  it('converts separators, collapses repeats, and drops a trailing separator below the root', () => {
    expect(normalizeScanPath('windows', 'c:/Users//todd/')).toBe('C:\\Users\\todd');
    expect(normalizeScanPath('windows', 'C:\\\\Windows\\\\Temp\\\\')).toBe('C:\\Windows\\Temp');
  });

  it('preserves the case of everything that is not the drive letter', () => {
    expect(normalizeScanPath('windows', 'c:\\Users\\Todd\\AppData')).toBe('C:\\Users\\Todd\\AppData');
  });

  it('resolves . and .. the way path.win32.normalize would', () => {
    expect(normalizeScanPath('windows', 'C:\\a\\.\\b')).toBe('C:\\a\\b');
    expect(normalizeScanPath('windows', 'C:\\a\\b\\..\\c')).toBe('C:\\a\\c');
    // An absolute path cannot climb above its own volume root.
    expect(normalizeScanPath('windows', 'C:\\a\\..\\..\\..')).toBe('C:\\');
  });

  it('keeps exactly two leading separators on a UNC path so the volume filter can see it', () => {
    expect(normalizeScanPath('windows', '\\\\fileserver\\share\\')).toBe('\\\\fileserver\\share');
    expect(normalizeScanPath('windows', '//fileserver//share')).toBe('\\\\fileserver\\share');
  });

  it('falls back to the OS root for an empty or whitespace-only path', () => {
    expect(normalizeScanPath('windows', '')).toBe('C:\\');
    expect(normalizeScanPath('windows', '   ')).toBe('C:\\');
  });
});

describe('normalizeScanPath — POSIX', () => {
  it('keeps the root as the one path that ends in a separator', () => {
    expect(normalizeScanPath('linux', '/')).toBe('/');
    expect(normalizeScanPath('macos', '///')).toBe('/');
  });

  it('collapses repeated separators and drops the trailing one', () => {
    expect(normalizeScanPath('linux', '//var//tmp/')).toBe('/var/tmp');
    expect(normalizeScanPath('macos', '/Users/todd/')).toBe('/Users/todd');
  });

  it('is case-preserving — macOS volume names are not lower-cased', () => {
    expect(normalizeScanPath('macos', '/Volumes/Backup Drive')).toBe('/Volumes/Backup Drive');
  });

  it('resolves . and .. the way path.posix.normalize would', () => {
    expect(normalizeScanPath('linux', '/opt/./app')).toBe('/opt/app');
    expect(normalizeScanPath('linux', '/opt/app/../data')).toBe('/opt/data');
    expect(normalizeScanPath('linux', '/opt/../..')).toBe('/');
  });

  it('falls back to the OS root for an empty path', () => {
    expect(normalizeScanPath('linux', '')).toBe('/');
    expect(normalizeScanPath('linux', '  ')).toBe('/');
  });
});

describe('normalizeScanPath — the property the database key depends on', () => {
  it('is idempotent: normalising an already-normalised path changes nothing', () => {
    const cases: Array<[string, string]> = [
      ['windows', 'c:/Users//todd/'],
      ['windows', '\\\\fileserver\\share\\'],
      ['windows', 'd:'],
      ['linux', '//var//tmp/'],
      ['macos', '/Volumes/Backup Drive/'],
      ['linux', '/'],
    ];
    for (const [osType, raw] of cases) {
      const once = normalizeScanPath(osType, raw);
      expect(normalizeScanPath(osType, once)).toBe(once);
    }
  });

  it('collapses the case variants that defect 6 is about onto ONE key', () => {
    const keys = new Set([
      normalizeScanPath('windows', 'c:\\'),
      normalizeScanPath('windows', 'C:\\'),
      normalizeScanPath('windows', 'C:/'),
      normalizeScanPath('windows', 'c:'),
    ]);
    expect([...keys]).toEqual(['C:\\']);
  });

  it('keeps two different volumes on two different keys', () => {
    expect(normalizeScanPath('windows', 'd:\\')).not.toBe(normalizeScanPath('windows', 'c:\\'));
    expect(normalizeScanPath('linux', '/data')).not.toBe(normalizeScanPath('linux', '/'));
  });
});
