import { describe, expect, it } from 'vitest';
import { isVolumeRootRestoreTarget } from './restoreTargetRoot';

describe('isVolumeRootRestoreTarget (#12638)', () => {
  it.each([
    'C:\\', 'c:\\', 'C:', 'C:/', ' C:\\ ', 'C:\\.', 'C:\\Users\\..', 'C:\\ ', 'C:\\...',
    '/', '//', '/.', '/home/..', '/./',
    '\\\\?\\C:\\', '\\\\.\\C:\\', '//?/C:/', '\\??\\C:\\',
    '\\\\server\\share', '\\\\server\\share\\', '//server/share/',
    '\\\\?\\UNC\\server\\share\\',
    '\\\\?\\Volume{0b6f8f8e-1111-2222-3333-444455556666}\\',
    // The whole target is trimmed first: conservative for the one form
    // (\\?\) where a trailing space could name a real folder.
    '\\\\?\\C:\\ ',
  ])('%j is a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(true);
  });

  it.each([
    '', '   ', 'C:\\restore', 'D:\\Restored\\', 'C:/restore', '/var/restore', '/restore/.',
    '\\\\?\\C:\\restore', '\\\\server\\share\\restore',
    '\\\\?\\Volume{0b6f8f8e-1111-2222-3333-444455556666}\\restore',
    'restore', 'C:restore', '//server',
  ])('%j is not a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(false);
  });
});
