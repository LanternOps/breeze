/**
 * Tool Catalog W4 (#5219) B3 — run-detail polling hook contract: never overlaps,
 * stops at terminal, pauses when hidden, backs off, and surfaces a paused state
 * (instead of silently freezing) after three consecutive failures.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getFlowRun: vi.fn() }));
vi.mock('./api', () => api);

import { useFlowRunPolling } from './useFlowRunPolling';

const run = (status: string) => ({ id: 'r1', status, steps: [] });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useFlowRunPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.getFlowRun.mockReset();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls every 3 s while non-terminal and stops at a terminal status', async () => {
    api.getFlowRun
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValueOnce(run('completed'));
    const { result } = renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(3);
    expect(result.current.run?.status).toBe('completed');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(3);
  });

  it('never overlaps requests: a slow response schedules no second fetch', async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    api.getFlowRun.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    api.getFlowRun.mockResolvedValue(run('running'));
    renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSlow(run('running')); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(2);
  });

  it('three consecutive failures show the paused state with last-updated time; retry resumes', async () => {
    api.getFlowRun.mockResolvedValueOnce(run('running'));
    api.getFlowRun.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const updated = result.current.lastUpdated;
    expect(updated).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.paused).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.paused).toBe(true);
    expect(result.current.lastUpdated).toBe(updated);
    const calls = api.getFlowRun.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(calls);

    api.getFlowRun.mockResolvedValue(run('running'));
    await act(async () => { result.current.retry(); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.paused).toBe(false);
    expect(api.getFlowRun).toHaveBeenCalledTimes(calls + 1);
  });

  it('pauses while the tab is hidden and refetches when it becomes visible', async () => {
    api.getFlowRun.mockResolvedValue(run('running'));
    renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    act(() => setHidden(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    await act(async () => { setHidden(false); await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(2);
  });

  it('backs off to 15 s after 5 minutes', async () => {
    api.getFlowRun.mockResolvedValue(run('running'));
    renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 4000); });
    const before = api.getFlowRun.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(before + 1);
  });

  it('unmount stops all further calls', async () => {
    api.getFlowRun.mockResolvedValue(run('running'));
    const { unmount } = renderHook(() => useFlowRunPolling('r1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getFlowRun).toHaveBeenCalledTimes(1);
  });

  it('a runId change fetches the new id', async () => {
    api.getFlowRun.mockResolvedValue(run('running'));
    const { rerender } = renderHook(({ id }) => useFlowRunPolling(id), { initialProps: { id: 'r1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenLastCalledWith('r1');
    rerender({ id: 'r2' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getFlowRun).toHaveBeenLastCalledWith('r2');
  });
});
