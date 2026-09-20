import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { CommandPollAbortedError, useCommandPoll } from './useCommandPoll';

const fetchMock = vi.mocked(fetchWithAuth);

const commandResponse = (status: string, result?: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: { id: 'cmd-1', status, result } }) }) as unknown as Response;

describe('useCommandPoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves as soon as the command completes and exposes the last status', async () => {
    fetchMock
      .mockResolvedValueOnce(commandResponse('pending'))
      .mockResolvedValueOnce(commandResponse('completed'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    let settled = false;
    await act(async () => {
      const promise = result.current.poll('cmd-1', 60_000).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_500);
      await promise;
    });

    expect(settled).toBe(true);
    expect(result.current.status).toBe('completed');
  });

  it('backs off between polls rather than hammering a fixed interval', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    act(() => { void result.current.poll('cmd-1', 60_000).catch(() => undefined); });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 2s, then 3s, then 4.5s — not 2s forever.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects with the command\u2019s own error when it fails', async () => {
    fetchMock.mockResolvedValueOnce(commandResponse('failed', { error: 'scanner exploded' }));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    await expect(
      act(async () => { await result.current.poll('cmd-1', 60_000); }),
    ).rejects.toThrow('scanner exploded');
  });

  it('rejects once the wall-clock budget is exhausted', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result } = renderHook(() => useCommandPoll('dev-1'));

    let rejection: unknown;
    act(() => { void result.current.poll('cmd-1', 5_000).catch((e) => { rejection = e; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('still running');
  });

  it('stops polling and rejects with CommandPollAbortedError on unmount', async () => {
    fetchMock.mockResolvedValue(commandResponse('running'));

    const { result, unmount } = renderHook(() => useCommandPoll('dev-1'));

    let rejection: unknown;
    act(() => { void result.current.poll('cmd-1', 600_000).catch((e) => { rejection = e; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const callsBeforeUnmount = fetchMock.mock.calls.length;

    act(() => { unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The defining assertion (spec §2 defect 9): no request may be issued
    // after the component that started the loop has gone.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
    expect(rejection).toBeInstanceOf(CommandPollAbortedError);
  });

  it('passes an AbortSignal to every request and aborts it on unmount', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(commandResponse('running'));
    });

    const { result, unmount } = renderHook(() => useCommandPoll('dev-1'));
    act(() => { void result.current.poll('cmd-1', 600_000).catch(() => undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(signals.length).toBeGreaterThan(0);
    act(() => { unmount(); });
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('reset() clears the exposed status', async () => {
    fetchMock.mockResolvedValueOnce(commandResponse('completed'));
    const { result } = renderHook(() => useCommandPoll('dev-1'));

    await act(async () => { await result.current.poll('cmd-1', 60_000); });
    expect(result.current.status).toBe('completed');

    act(() => { result.current.reset(); });
    expect(result.current.status).toBeNull();
  });
});
