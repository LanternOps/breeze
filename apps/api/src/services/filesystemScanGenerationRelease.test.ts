import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, clearMock } = vi.hoisted(() => ({ selectMock: vi.fn(), clearMock: vi.fn() }));

vi.mock('../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...(a as [])) } }));
vi.mock('./filesystemAnalysis', () => ({
  clearFilesystemScanGeneration: (...a: unknown[]) => clearMock(...(a as [])),
}));

import { releaseFilesystemScanGenerationForCommand } from './filesystemScanGenerationRelease';

const chain = (rows: unknown[]) => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });

describe('releaseFilesystemScanGenerationForCommand', () => {
  beforeEach(() => vi.resetAllMocks());

  it('clears the normalized volume path conditioned on the command id', async () => {
    selectMock.mockReturnValue(chain([{ osType: 'windows' }]));
    await releaseFilesystemScanGenerationForCommand({ id: 'cmd-1', deviceId: 'dev-1', payload: { path: 'c:/' } }, 'timeout');
    expect(clearMock).toHaveBeenCalledWith('dev-1', 'C:\\', 'cmd-1');
  });

  it('falls back to the OS root when the payload has no path', async () => {
    selectMock.mockReturnValue(chain([{ osType: 'windows' }]));
    await releaseFilesystemScanGenerationForCommand({ id: 'cmd-1', deviceId: 'dev-1', payload: null }, 'timeout');
    expect(clearMock).toHaveBeenCalledWith('dev-1', 'C:\\', 'cmd-1');
  });

  it('warns and releases nothing when the device row is gone', async () => {
    selectMock.mockReturnValue(chain([]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await releaseFilesystemScanGenerationForCommand({ id: 'cmd-1', deviceId: 'dev-1', payload: {} }, 'timeout');
    expect(clearMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
