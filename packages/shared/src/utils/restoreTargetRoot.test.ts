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
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\',
    '\\\\?\\GLOBALROOT\\??\\C:\\', '\\\\?\\GLOBALROOT\\DosDevices\\C:\\', '\\\\.\\Global\\C:\\',
    '\\\\?\\GLOBALROOT\\Device\\Mup\\srv\\share\\',
    '\\\\?\\GLOBALROOT\\Device\\LanmanRedirector\\srv\\share\\restore',
    '\\\\.\\GLOBALROOT\\Device\\HarddiskVolume3\\..\\Mup\\srv\\share',
    '\\\\.\\x\\..\\C:\\', '\\\\?\\SomeOtherDevice\\restore',
    // The whole target is trimmed first: conservative for the forms (\\?\,
    // \??\) where a trailing space could name a real folder.
    '\\\\?\\C:\\ ',
  ])('%j is a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(true);
  });

  it.each([
    '', '   ', '/...', '/a ', 'C:\\restore', 'D:\\Restored\\', 'C:/restore', '/var/restore', '/restore/.',
    '\\\\?\\C:\\restore', '\\\\server\\share\\restore',
    '\\\\?\\Volume{0b6f8f8e-1111-2222-3333-444455556666}\\restore',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\restore',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy2\\restore',
    'restore', 'C:restore', '//server',
  ])('%j is not a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(false);
  });
});

// Strix on #12654: the trailing dot/space trim was an end-anchored regex that
// retried at every offset, quadratic on a long run followed by another character.
describe('isVolumeRootRestoreTarget cost (#12654)', () => {
  const time = (target: string): number => {
    const start = performance.now();
    isVolumeRootRestoreTarget(target);
    return performance.now() - start;
  };
  const cases: Array<[string, (n: number) => string]> = [
    ['spaces then a letter', (n) => `C:\\${' '.repeat(n)}x`],
    ['dots then a letter', (n) => `C:\\${'.'.repeat(n)}x`],
    ['mixed dots and spaces', (n) => `C:\\${'. '.repeat(n / 2)}x`],
    ['device-path win32 form', (n) => `\\\\.\\C:\\${' '.repeat(n)}x`],
  ];

  it.each(cases)('%s scales linearly', (_name, build) => {
    build(1000); // warm up
    time(build(1000));
    const small = Math.max(time(build(50_000)), 0.5);
    const large = time(build(200_000));
    // 4x the input: linear is ~4x; quadratic is ~16x. 10x is robust to CI noise.
    expect(large / small).toBeLessThan(10);
    expect(large).toBeLessThan(250);
  });

  it('still classifies long runs correctly', () => {
    expect(isVolumeRootRestoreTarget(`C:\\${' '.repeat(200_000)}`)).toBe(true);
    expect(isVolumeRootRestoreTarget(`C:\\${' '.repeat(200_000)}x`)).toBe(false);
  });
});

