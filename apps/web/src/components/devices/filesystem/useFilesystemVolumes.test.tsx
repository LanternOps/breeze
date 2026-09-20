import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../../stores/auth';
import { useFilesystemVolumes, type FilesystemVolume } from './useFilesystemVolumes';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const volume = (scanPath: string, isOsRoot: boolean): FilesystemVolume => ({
  mountPoint: scanPath, scanPath, fsType: 'NTFS',
  totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot,
  scanState: null, latestSnapshot: null,
});

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('useFilesystemVolumes', () => {
  it('loads the volumes for the device on mount', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ data: [volume('C:\\', true), volume('D:\\', false)] }));

    const { result } = renderHook(() => useFilesystemVolumes('device-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
    expect(result.current.error).toBeUndefined();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/device-1/filesystem/volumes',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('surfaces a failure instead of silently rendering an empty picker', async () => {
    fetchWithAuthMock.mockResolvedValue(
      { ok: false, status: 500, json: vi.fn().mockResolvedValue({ error: 'boom' }) } as unknown as Response,
    );

    const { result } = renderHook(() => useFilesystemVolumes('device-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.volumes).toEqual([]);
  });

  it('aborts the in-flight request on unmount so the poll cannot outlive the component (defect 9)', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return jsonResponse({ data: [] });
    });

    const { unmount, result } = renderHook(() => useFilesystemVolumes('device-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('reload refetches and replaces the list', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [volume('C:\\', true)] }));
    const { result } = renderHook(() => useFilesystemVolumes('device-1'));
    await waitFor(() => expect(result.current.volumes).toHaveLength(1));

    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [volume('C:\\', true), volume('D:\\', false)] }));
    await act(async () => { await result.current.reload(); });

    expect(result.current.volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
  });
});
