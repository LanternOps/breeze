import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDeviceAttentionCounts,
  loadDeviceAttentionCounts,
  useDeviceAttentionCounts,
} from './deviceAttentionCounts';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const zeroAlerts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

/** Answer every request with counts for the ids it asked for, keyed off the URL. */
function answerWith(countsFor: (id: string) => unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    const ids = decodeURIComponent(new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',');
    const counts: Record<string, unknown> = {};
    for (const id of ids) {
      const c = countsFor(id);
      if (c) counts[id] = c;
    }
    return json({ counts });
  });
}

function requestedIds(callIndex: number): string[] {
  const url = fetchMock.mock.calls[callIndex]![0] as string;
  return decodeURIComponent(new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',');
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchDeviceAttentionCounts', () => {
  it('asks the batch endpoint once for every id and normalises the counts', async () => {
    fetchMock.mockResolvedValue(
      json({ counts: { a: { alerts: { critical: '2', high: 1 }, tickets: '3' } } }),
    );
    const counts = await fetchDeviceAttentionCounts(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/devices/attention-counts?ids=a,b');
    expect(counts).toEqual({ a: { alerts: { ...zeroAlerts, critical: 2, high: 1 }, tickets: 3 } });
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, false, 400));
    await expect(fetchDeviceAttentionCounts(['a'])).rejects.toThrow(/400/);
  });
});

describe('loadDeviceAttentionCounts', () => {
  it('coalesces concurrent callers into one request', async () => {
    answerWith((id) => ({ alerts: zeroAlerts, tickets: id === 'b' ? 1 : 0 }));
    const [first, second] = await Promise.all([
      loadDeviceAttentionCounts(['a']),
      loadDeviceAttentionCounts(['b', 'a']),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedIds(0).sort()).toEqual(['a', 'b']);
    expect(Object.keys(first)).toEqual(['a']);
    expect(second.b!.tickets).toBe(1);
  });

  it('splits more than 100 ids into requests of at most 100', async () => {
    answerWith(() => null);
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await loadDeviceAttentionCounts(ids);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((_, i) => requestedIds(i).length);
    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });
});

describe('useDeviceAttentionCounts', () => {
  it('fetches the rendered ids once, then only ids it has not seen', async () => {
    answerWith((id) => (id === 'a' ? { alerts: { ...zeroAlerts, high: 1 }, tickets: 0 } : null));
    const { result, rerender } = renderHook(({ ids }) => useDeviceAttentionCounts(ids, true), {
      initialProps: { ids: ['a', 'b'] },
    });
    expect(result.current('a')).toEqual({ status: 'loading' });

    await waitFor(() => expect(result.current('a').status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current('a')).toEqual({ status: 'ready', counts: { alerts: { ...zeroAlerts, high: 1 }, tickets: 0 } });
    expect(result.current('b')).toEqual({ status: 'ready', counts: null });

    // Same rows, new array identity: no new request.
    rerender({ ids: ['a', 'b'] });
    // Page change: only the new id is requested.
    rerender({ ids: ['b', 'c'] });
    await waitFor(() => expect(result.current('c').status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedIds(1)).toEqual(['c']);
  });

  it('does not fetch while disabled', async () => {
    answerWith(() => null);
    const { result } = renderHook(() => useDeviceAttentionCounts(['a'], false));
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current('a')).toEqual({ status: 'loading' });
  });

  it('marks ids as errored and warns once on failure, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(json({}, false, 500));
    const { result } = renderHook(() => useDeviceAttentionCounts(['a', 'b'], true));
    await waitFor(() => expect(result.current('a').status).toBe('error'));
    expect(result.current('b')).toEqual({ status: 'error' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
