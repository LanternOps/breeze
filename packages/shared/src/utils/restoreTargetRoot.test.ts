import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRestoreTarget,
  isVolumeRootRestoreTarget,
  type RestoreTargetClass,
  type RestoreTargetHost,
} from './restoreTargetRoot';

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
    // A server with no share.
    '//server',
  ])('%j is a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(true);
  });

  it.each([
    '', '   ', '/...', '/a ', 'C:\\restore', 'D:\\Restored\\', 'C:/restore', '/var/restore', '/restore/.',
    '\\\\?\\C:\\restore', '\\\\server\\share\\restore',
    '\\\\?\\Volume{0b6f8f8e-1111-2222-3333-444455556666}\\restore',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\restore',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy2\\restore',
    'restore', 'C:restore',
  ])('%j is not a volume root', (target) => {
    expect(isVolumeRootRestoreTarget(target)).toBe(false);
  });
});

// Strix on #12654: the trailing dot/space trim was an end-anchored regex that
// retried at every offset, quadratic on a long run followed by another character.
describe('isVolumeRootRestoreTarget cost (#12654)', () => {
  // Best of three: one GC pause or scheduler stall on a loaded runner must
  // not read as superlinear growth.
  const time = (target: string): number => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      isVolumeRootRestoreTarget(target);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const cases: Array<[string, (n: number) => string]> = [
    ['spaces then a letter', (n) => `C:\\${' '.repeat(n)}x`],
    ['dots then a letter', (n) => `C:\\${'.'.repeat(n)}x`],
    ['mixed dots and spaces', (n) => `C:\\${'. '.repeat(n / 2)}x`],
    ['device-path win32 form', (n) => `\\\\.\\C:\\${' '.repeat(n)}x`],
    // #12671: the separator-insensitive device prefix, the POSIX reading
    // (split on / only), share and device-volume forms and the macOS rule.
    ['NT prefix with forward slashes', (n) => `/??/C:/${'a/'.repeat(n / 2)}x`],
    ['long run of separators', (n) => `/${'/'.repeat(n)}x`],
    ['long chain of parents', (n) => `/x${'/..'.repeat(n / 3)}/y`],
    ['backslashes in a POSIX name', (n) => `/x${'\\'.repeat(n)}/..`],
    ['device prefix then a long tail', (n) => `//./${'.\\'.repeat(n / 2)}x`],
    ['share then a long tail', (n) => `\\\\srv\\share${'\\. '.repeat(n / 3)}x`],
    ['GLOBALROOT then parents', (n) => `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3${'\\x\\..'.repeat(n / 5)}`],
    ['data volume prefix then a long tail', (n) => `/System/Volumes/Data/${'a/'.repeat(n / 2)}x`],
    ['mount points within mount points', (n) => `/Volumes/x${'/Volumes/x'.repeat(n / 10)}/y`],
    ['data volume paths within mount points', (n) => `${'/Volumes/x/System/Volumes/Data'.repeat(n / 30)}/y`],
    ['colons after a drive', (n) => `C:\\${'a:'.repeat(n / 2)}x`],
    ['whitespace around a target', (n) => `${' '.repeat(n / 2)}C:\\x${' '.repeat(n / 2)}`],
    ['a long tail under /proc', (n) => `/proc/self/root/${'a/'.repeat(n / 2)}x`],
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


type VectorCase = {
  target: string;
  expect: Record<RestoreTargetHost, RestoreTargetClass>;
  note: string;
};

// #12671: the cases the backup helper's guard is tested against too
// (agent/internal/backup/restore_target_vectors_test.go).
const vectors: VectorCase[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/restore-target-root-vectors.json'), 'utf8'),
).cases;
const RANK: Record<RestoreTargetClass, number> = { 'not-root': 0, 'needs-confirmation': 1, root: 2 };
const HOSTS: RestoreTargetHost[] = ['windows', 'posix', 'darwin'];

describe('classifyRestoreTarget shared vectors (#12671)', () => {
  it('has the shared cases', () => {
    expect(vectors.length).toBeGreaterThan(100);
    for (const host of HOSTS) {
      for (const cls of ['root', 'not-root'] as const) {
        expect(vectors.some((v) => v.expect[host] === cls)).toBe(true);
      }
    }
  });

  it.each(vectors.map((v) => [v.target, v] as const))('%j', (_target, v) => {
    for (const host of HOSTS) {
      expect({ host, cls: classifyRestoreTarget(v.target, host) }).toEqual({ host, cls: v.expect[host] });
    }
    // With the device unknown (every caller today), the strictest reading.
    const strictest = HOSTS.map((h) => v.expect[h]).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
    expect(classifyRestoreTarget(v.target)).toBe(strictest);
    expect(isVolumeRootRestoreTarget(v.target)).toBe(strictest !== 'not-root');
  });

  it('accepts every ordinary folder in the cases without confirmation', () => {
    const folders = vectors.filter((v) => HOSTS.every((h) => v.expect[h] === 'not-root'));
    expect(folders.length).toBeGreaterThan(20);
    for (const v of folders) expect(isVolumeRootRestoreTarget(v.target)).toBe(false);
  });
});
