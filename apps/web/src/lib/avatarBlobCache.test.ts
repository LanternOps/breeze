import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../stores/auth';

import { __resetAvatarBlobCacheForTests, useAvatarBlobUrl } from './avatarBlobCache';

vi.mock('../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

let objectUrlCounter = 0;
const createObjectURL = vi.fn(() => `blob:fake-${++objectUrlCounter}`);
const revokeObjectURL = vi.fn();

beforeEach(() => {
  objectUrlCounter = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  fetchWithAuthMock.mockReset();
  globalThis.URL.createObjectURL = createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  __resetAvatarBlobCacheForTests();
});

function makeBlobResponse(ok = true, status = ok ? 200 : 404): Response {
  return {
    ok,
    status,
    blob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
  } as unknown as Response;
}

describe('useAvatarBlobUrl', () => {
  it('returns null for null input', () => {
    const { result } = renderHook(() => useAvatarBlobUrl(null));
    expect(result.current).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('returns null for empty string input', () => {
    const { result } = renderHook(() => useAvatarBlobUrl(''));
    expect(result.current).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('fetches an internal avatar URL via fetchWithAuth and returns an object URL', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeBlobResponse());

    const { result } = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));

    await waitFor(() => {
      expect(result.current).toMatch(/^blob:fake-/);
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/v1/users/u1/avatar');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('passes through external https URLs without fetching', () => {
    const { result } = renderHook(() =>
      useAvatarBlobUrl('https://cdn.example.com/avatar.png')
    );
    expect(result.current).toBe('https://cdn.example.com/avatar.png');
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('rejects javascript: URLs (defense via sanitizeImageSrc)', () => {
    const { result } = renderHook(() => useAvatarBlobUrl('javascript:alert(1)'));
    expect(result.current).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('returns null when the internal avatar fetch fails with 404', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeBlobResponse(false, 404));

    const { result } = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));

    // Wait one tick for the effect's promise to resolve.
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    });
    expect(result.current).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('returns null when fetchWithAuth throws (network error)', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    });
    expect(result.current).toBeNull();
  });

  it('reuses the cached object URL across multiple components for the same avatar', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeBlobResponse());

    const hookA = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));
    await waitFor(() => {
      expect(hookA.result.current).toMatch(/^blob:fake-/);
    });

    const firstUrl = hookA.result.current;

    const hookB = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));
    await waitFor(() => {
      expect(hookB.result.current).toBe(firstUrl);
    });

    // Only one fetch, one createObjectURL.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('revokes the object URL when the last consumer unmounts', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeBlobResponse());

    const hookA = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));
    const hookB = renderHook(() => useAvatarBlobUrl('/api/v1/users/u1/avatar'));

    await waitFor(() => {
      expect(hookA.result.current).toMatch(/^blob:fake-/);
      expect(hookB.result.current).toMatch(/^blob:fake-/);
    });

    hookA.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    hookB.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
