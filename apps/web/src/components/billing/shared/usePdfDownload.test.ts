import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePdfDownload } from './usePdfDownload';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../../lib/runAction';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../lib/runAction', () => ({ handleActionError: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const errMock = vi.mocked(handleActionError);

const blobResponse = (): Response =>
  ({ ok: true, status: 200, blob: vi.fn().mockResolvedValue(new Blob(['%PDF'])) }) as unknown as Response;

describe('usePdfDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom lacks these blob-URL primitives.
    Object.assign(window.URL, {
      createObjectURL: vi.fn().mockReturnValue('blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('fetches the path, downloads via a blob-URL anchor, and revokes it', async () => {
    fetchMock.mockResolvedValue(blobResponse());
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { result } = renderHook(() => usePdfDownload({ path: '/invoices/inv-1/pdf', filename: 'INV-1.pdf' }));
    await act(async () => { await result.current.download(); });

    expect(fetchMock).toHaveBeenCalledWith('/invoices/inv-1/pdf');
    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    clickSpy.mockRestore();
  });

  it('exposes a downloading flag that clears after completion', async () => {
    fetchMock.mockResolvedValue(blobResponse());
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { result } = renderHook(() => usePdfDownload({ path: '/p', filename: 'f.pdf' }));
    expect(result.current.downloading).toBe(false);
    await act(async () => { await result.current.download(); });
    await waitFor(() => expect(result.current.downloading).toBe(false));
  });

  it('redirects to login on 401 without attempting a download', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    const { result } = renderHook(() => usePdfDownload({ path: '/p', filename: 'f.pdf' }));
    await act(async () => { await result.current.download(); });
    expect(navMock).toHaveBeenCalledWith('/login', { replace: true });
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('surfaces a non-OK response through handleActionError', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const { result } = renderHook(() => usePdfDownload({ path: '/p', filename: 'f.pdf', errorMessage: 'nope' }));
    await act(async () => { await result.current.download(); });
    expect(errMock).toHaveBeenCalledWith(expect.any(Error), 'nope');
  });
});
