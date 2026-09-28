import { describe, expect, it } from 'vitest';
import {
  REBUILD_DEFAULT_OUTPUT_DIR_LINUX,
  REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS,
  defaultRebuildOutputDir,
  isAbsoluteRebuildPath,
  isAbsoluteVhdxPath,
  rebuildPathMatchesOs,
} from './rebuildPaths';

// Mirrors apps/api/src/services/bareMetalRebuildSchemas.ts isAbsoluteRebuildPath
// and routes/backup/schemas.ts rebuildVhdxOutputPathSchema (W06d). The web
// bundle never imports server code, so the table below is the parity contract.
describe('isAbsoluteRebuildPath', () => {
  it.each([
    ['/var/lib/breeze/rebuild/out', true],
    ['C:\\ProgramData\\Breeze\\rebuild\\out', true],
    ['d:\\images', true],
    ['\\\\server\\share\\out', false],
    ['\\\\?\\C:\\out', false],
    ['C:/images', false],
    ['C:images', false],
    ['\\images', false],
    ['relative/out', false],
    ['', false],
    ['/srv/\0x', false],
  ])('%j → %s', (path, expected) => {
    expect(isAbsoluteRebuildPath(path)).toBe(expected);
  });
});

describe('isAbsoluteVhdxPath', () => {
  it.each([
    ['/srv/rebuild/dev-1.vhdx', true],
    ['/srv/rebuild/DEV-1.VHDX', true],
    ['C:\\images\\x.vhdx', true],
    ['  C:\\images\\x.vhdx  ', true],
    ['\\\\server\\share\\x.vhdx', false],
    ['C:/images/x.vhdx', false],
    ['C:\\images\\x.txt', false],
    ['/srv/rebuild/dev-1.img', false],
    ['/.vhdx', false],
    ['C:\\.vhdx', false],
    ['relative.vhdx', false],
  ])('%j → %s', (path, expected) => {
    expect(isAbsoluteVhdxPath(path)).toBe(expected);
  });
});

describe('rebuildPathMatchesOs', () => {
  it('requires a drive-letter path on a Windows host and a POSIX path on a Linux host', () => {
    expect(rebuildPathMatchesOs('C:\\images\\x.vhdx', 'windows')).toBe(true);
    expect(rebuildPathMatchesOs('/srv/x.vhdx', 'windows')).toBe(false);
    expect(rebuildPathMatchesOs('/srv/x.vhdx', 'linux')).toBe(true);
    expect(rebuildPathMatchesOs('C:\\images\\x.vhdx', 'linux')).toBe(false);
  });

  it('does not judge a path when the host OS is unknown', () => {
    expect(rebuildPathMatchesOs('C:\\images\\x.vhdx', null)).toBe(true);
    expect(rebuildPathMatchesOs('/srv/x.vhdx', undefined)).toBe(true);
  });
});

describe('defaultRebuildOutputDir', () => {
  it('mirrors the API per-OS defaults', () => {
    expect(REBUILD_DEFAULT_OUTPUT_DIR_LINUX).toBe('/var/lib/breeze/rebuild/out');
    expect(REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS).toBe('C:\\ProgramData\\Breeze\\rebuild\\out');
    expect(defaultRebuildOutputDir('windows')).toBe(REBUILD_DEFAULT_OUTPUT_DIR_WINDOWS);
    expect(defaultRebuildOutputDir('linux')).toBe(REBUILD_DEFAULT_OUTPUT_DIR_LINUX);
    expect(defaultRebuildOutputDir(null)).toBe(REBUILD_DEFAULT_OUTPUT_DIR_LINUX);
  });
});
