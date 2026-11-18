import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));

import { RUN_POLL_MS, useRunPolling } from './useRunPolling';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const run = (state: string) => ({ data: { id: 'r-1', state, kind: 'dry_run', counters: {} } });

/** Lets the awaited fetch and json() settle under fake timers. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useRunPolling (#8313 W6)', () => {
  it('reads at once, polls every 5 s while queued or running, and stops on a terminal state', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, run('queued')))
      .mockResolvedValueOnce(json(200, run('running')))
      .mockResolvedValueOnce(json(200, run('completed')));
    const onFinished = vi.fn();
    const { result } = renderHook(() => useRunPolling('r-1', onFinished));
    await act(flush);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/ticket-imports/runs/r-1');
    expect(result.current.run?.state).toBe('queued');

    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS - 1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.run?.state).toBe('running');

    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS); await flush(); });
    expect(result.current.run?.state).toBe('completed');
    expect(onFinished).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS * 5); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not report a run it never saw active as finished', async () => {
    fetchMock.mockResolvedValueOnce(json(200, run('completed')));
    const onFinished = vi.fn();
    renderHook(() => useRunPolling('r-1', onFinished));
    await act(flush);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('stops polling on unmount', async () => {
    fetchMock.mockImplementation(async () => json(200, run('running')));
    const { unmount } = renderHook(() => useRunPolling('r-1'));
    await act(flush);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS * 3); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps trying after a failed read and stops on a 404', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'boom' })).mockResolvedValueOnce(json(404, { error: 'gone' }));
    const { result } = renderHook(() => useRunPolling('r-1'));
    await act(flush);
    expect(result.current.readFailed).toBe(true);
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS); await flush(); });
    expect(result.current.missing).toBe(true);
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS * 3); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a new run id and reads nothing without one', async () => {
    fetchMock.mockImplementation(async (url: string) => json(200, { data: { id: url.split('/').pop(), state: 'running', counters: {} } }));
    const { rerender, result } = renderHook(({ id }: { id: string | null }) => useRunPolling(id), { initialProps: { id: null as string | null } });
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS * 2); await flush(); });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ id: 'r-2' });
    await act(flush);
    expect(result.current.run?.id).toBe('r-2');
    rerender({ id: null });
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS * 2); await flush(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.run).toBeNull();
  });
});
