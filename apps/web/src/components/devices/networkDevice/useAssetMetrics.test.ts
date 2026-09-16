import '@/lib/i18n';

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetMetrics } from './useAssetMetrics';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const series = [{ oid: '1.3.6.1.2.1.2.2.1.10.1', instance: '1', name: 'ifInOctets', points: [['2026-09-16T10:00:00.000Z', 42]] }];

describe('useAssetMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the query from the range, with an ISO window and the mapped bucket', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    renderHook(() => useAssetMetrics({ assetId: 'a1', oid: '1.3.6.1.2.1.2.2.1.10.1', range: '7d' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('/monitoring/assets/a1/metrics');
    expect(url).toContain(`oid=${encodeURIComponent('1.3.6.1.2.1.2.2.1.10.1')}`);
    expect(url).toContain('bucket=1h');
    expect(url).not.toContain('delta=');

    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const from = new Date(params.get('from')!).getTime();
    const to = new Date(params.get('to')!).getTime();
    expect(Number.isNaN(from)).toBe(false);
    // 7d ± a second of clock drift between the two Date constructions.
    expect(to - from).toBeGreaterThan(604_800_000 - 1_000);
    expect(to - from).toBeLessThan(604_800_000 + 1_000);
  });

  it('maps each range to its own bucket', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    for (const [range, bucket] of [['24h', '5m'], ['7d', '1h'], ['30d', '1d']] as const) {
      fetchWithAuthMock.mockClear();
      renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range }));
      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
      expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain(`bucket=${bucket}`);
    }
  });

  it('asks for reset-aware deltas when delta is set', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h', delta: true }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain('delta=1');
  });

  it('honours an explicit window and bucket over the range', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    renderHook(() =>
      useAssetMetrics({ assetId: 'a1', oid: 'x', range: '7d', windowMs: 8 * 86_400_000, bucket: '1d', delta: true }),
    );
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('bucket=1d');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const span = new Date(params.get('to')!).getTime() - new Date(params.get('from')!).getTime();
    expect(span).toBeGreaterThan(8 * 86_400_000 - 1_000);
  });

  it('does not fetch at all when no OID is selected', async () => {
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: null, range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(result.current.series).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns the series on success', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toEqual(series);
  });

  it('surfaces the cap message from a 400 instead of rendering an empty chart', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ error: 'Range exceeds the 90-day cap' }, 400));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '30d' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('90-day');
    expect(result.current.series).toEqual([]);
  });

  it('ignores a superseded response when the range changes mid-flight', async () => {
    let resolveFirst!: (value: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    fetchWithAuthMock.mockReturnValueOnce(firstPromise as unknown as Promise<Response>);

    const { result, rerender } = renderHook(
      ({ range }: { range: '24h' | '7d' }) => useAssetMetrics({ assetId: 'a1', oid: 'x', range }),
      { initialProps: { range: '24h' as '24h' | '7d' } },
    );

    const laterSeries = [{ oid: 'x', instance: '', name: 'later', points: [['2026-09-16T11:00:00.000Z', 7]] }];
    fetchWithAuthMock.mockResolvedValueOnce(json({ series: laterSeries }));
    rerender({ range: '7d' });
    await waitFor(() => expect(result.current.series).toEqual(laterSeries));

    // The stale 24h response lands last and must be dropped: switching
    // 24h → 7d → 24h is one click each, and the wrong window painting last is
    // indistinguishable from real data.
    await act(async () => {
      resolveFirst(json({ series: [{ oid: 'x', instance: '', name: 'stale', points: [] }] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.series).toEqual(laterSeries);
  });

  it('refetches on reload without changing the query', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstUrl = fetchWithAuthMock.mock.calls[0][0] as string;

    act(() => result.current.reload());

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const secondUrl = fetchWithAuthMock.mock.calls[1][0] as string;
    expect(secondUrl.split('&from=')[0]).toBe(firstUrl.split('&from=')[0]);
  });
});

  it('returns truncatedSeries and clears it when a new request starts', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ series, truncatedSeries: true }));
    const { result, rerender } = renderHook(
      ({ oid }) => useAssetMetrics({ assetId: 'a1', oid, range: '24h' }),
      { initialProps: { oid: 'x' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.truncatedSeries).toBe(true);
    fetchWithAuthMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    rerender({ oid: 'y' });
    expect(result.current.truncatedSeries).toBe(false);
  });
