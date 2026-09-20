import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { useFilesystemSnapshot } from './useFilesystemSnapshot';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const snapshot = (over: Record<string, unknown> = {}) => ({
  id: 'snap-1',
  capturedAt: '2026-09-19T10:00:00.000Z',
  trigger: 'on_demand',
  partial: false,
  scanPath: 'C:\\',
  summary: { filesScanned: 10 },
  ...over,
});

function routeByUrl(map: Record<string, Response>): void {
  fetchMock.mockImplementation((url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    return Promise.resolve(key ? map[key] : json({}, 500));
  });
}

describe('useFilesystemSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the snapshot for the selected scan path and returns it', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot?.id).toBe('snap-1');
    const snapshotUrl = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/filesystem?path='));
    // The path must be encoded — a raw `C:\` in a query string is not a URL.
    expect(snapshotUrl).toBe('/devices/dev-1/filesystem?path=C%3A%5C');
  });

  it('treats a 404 as "no snapshot for this path", not as an error', async () => {
    routeByUrl({
      '/filesystem?path=': json({ error: 'No filesystem analysis available yet' }, 404),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'D:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('derives threshold events from the command list', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({
        data: [
          { id: 'c1', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T09:00:00Z', payload: { trigger: 'threshold', path: 'C:\\' } },
          { id: 'c2', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T08:00:00Z', payload: { trigger: 'on_demand' } },
        ],
      }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.thresholdEvents.map((e) => e.id)).toEqual(['c1']);
  });

  it('surfaces a non-404 failure as a localized error string', async () => {
    routeByUrl({
      '/filesystem?path=': json({ error: 'boom' }, 500),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.snapshot).toBeNull();
  });

  it('re-fetches when the selected scan path changes and never mixes the two', async () => {
    routeByUrl({
      'path=C%3A%5C': json({ data: snapshot({ id: 'snap-c' }) }),
      'path=D%3A%5C': json({ data: snapshot({ id: 'snap-d', scanPath: 'D:\\' }) }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFilesystemSnapshot('dev-1', path),
      { initialProps: { path: 'C:\\' } },
    );
    await waitFor(() => expect(result.current.snapshot?.id).toBe('snap-c'));

    rerender({ path: 'D:\\' });
    await waitFor(() => expect(result.current.snapshot?.id).toBe('snap-d'));
  });

  it('aborts the in-flight request on unmount instead of setting state afterwards', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      // Never resolves: the only way this test can pass is a real abort.
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    expect(signals.every((s) => s.aborted)).toBe(false);

    act(() => { unmount(); });

    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('reload(silent) refreshes without flipping loading back on', async () => {
    routeByUrl({
      '/filesystem?path=': json({ data: snapshot() }),
      '/commands?limit=': json({ data: [] }),
    });

    const { result } = renderHook(() => useFilesystemSnapshot('dev-1', 'C:\\'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockClear();
    await act(async () => { await result.current.reload({ silent: true }); });

    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });
});
