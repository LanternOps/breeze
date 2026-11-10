import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  indexNoticeKind,
  nextPollDelay,
  parseSnapshotIndexView,
  POLL_GIVE_UP_MS,
  useSnapshotIndexState,
} from './snapshotIndexState';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload), text: vi.fn().mockResolvedValue(JSON.stringify(payload)) }) as unknown as Response;

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('parseSnapshotIndexView', () => {
  it('reads the view the API sent', () => {
    expect(parseSnapshotIndexView({ index: { state: 'ready' } })).toEqual({ state: 'ready' });
    expect(parseSnapshotIndexView({ index: { state: 'building' } })).toEqual({ state: 'building' });
    expect(parseSnapshotIndexView({ index: { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false } }))
      .toEqual({ state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false });
  });

  it('an unavailable view with missing fields stays unavailable and offers no retry', () => {
    expect(parseSnapshotIndexView({ index: { state: 'unavailable' } }))
      .toEqual({ state: 'unavailable', failure: 'never_indexed', retryable: false, deviceLocal: false });
  });

  it('an API that predates `index` still reads honestly from manifestUnavailable', () => {
    expect(parseSnapshotIndexView({ manifestUnavailable: true, data: [] }))
      .toEqual({ state: 'unavailable', failure: 'never_indexed', retryable: false, deviceLocal: false });
    expect(parseSnapshotIndexView({ manifestUnavailable: false, data: [] })).toBeNull();
    expect(parseSnapshotIndexView({ data: [] })).toBeNull();
    expect(parseSnapshotIndexView(null)).toBeNull();
  });

  it('an unknown state is not treated as ready', () => {
    expect(parseSnapshotIndexView({ index: { state: 'from_the_future' } })).toBeNull();
  });
});

describe('indexNoticeKind', () => {
  const unavailable = (failure: string, retryable = false, deviceLocal = false) =>
    ({ state: 'unavailable', failure, retryable, deviceLocal }) as const;

  it.each([
    ['nothing while unknown', null, null],
    ['nothing when ready', { state: 'ready' } as const, null],
    ['building', { state: 'building' } as const, { message: 'building', canRetry: false }],
    ['integrity, attestation failed: no retry', unavailable('attestation_failed', true), { message: 'integrity', canRetry: false }],
    ['integrity, other bytes: no retry', unavailable('manifest_differs_from_attestation'), { message: 'integrity', canRetry: false }],
    ['device-local missing manifest: no retry', unavailable('manifest_missing', true, true), { message: 'deviceLocal', canRetry: false }],
    ['a retryable failure offers retry', unavailable('provider_error', true), { message: 'unavailable', canRetry: true }],
    ['an S3 missing manifest offers retry', unavailable('manifest_missing', true), { message: 'unavailable', canRetry: true }],
    ['a terminal failure offers no retry', unavailable('manifest_invalid'), { message: 'unavailable', canRetry: false }],
  ])('%s', (_name, view, expected) => {
    expect(indexNoticeKind(view)).toEqual(expected);
  });
});

describe('nextPollDelay', () => {
  it('backs off from 5 s to a 30 s ceiling', () => {
    expect([0, 1, 2, 3, 4, 9].map((attempt) => nextPollDelay(attempt, 0))).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });

  it('stops after ten minutes', () => {
    expect(POLL_GIVE_UP_MS).toBe(10 * 60 * 1000);
    expect(nextPollDelay(3, POLL_GIVE_UP_MS - 1000)).toBe(1000);
    expect(nextPollDelay(3, POLL_GIVE_UP_MS)).toBeNull();
    expect(nextPollDelay(3, POLL_GIVE_UP_MS + 1)).toBeNull();
  });
});

describe('useSnapshotIndexState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls while building, backing off, and stops on ready and reloads', async () => {
    const onReady = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json({ index: { state: 'building' }, data: [] }))
      .mockResolvedValueOnce(json({ index: { state: 'ready' }, data: [{ name: 'C:' }] }));
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady }));

    act(() => result.current.reportView({ state: 'building' }));
    await flush(4999);
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/backup/snapshots/snap-1/browse?limit=1');
    expect(onReady).not.toHaveBeenCalled();

    await flush(9999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.view).toEqual({ state: 'ready' });
    expect(onReady).toHaveBeenCalledTimes(1);

    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling after ten minutes and leaves the building message in place', async () => {
    fetchMock.mockImplementation(async () => json({ index: { state: 'building' }, data: [] }));
    const onReady = vi.fn();
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady }));
    act(() => result.current.reportView({ state: 'building' }));

    await flush(POLL_GIVE_UP_MS + 60_000);
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(5);
    expect(result.current.view).toEqual({ state: 'building' });

    await flush(10 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(result.current.view).toEqual({ state: 'building' });
    expect(onReady).not.toHaveBeenCalled();
  });

  it('a build that fails moves to the honest state and stops polling, without reloading', async () => {
    const onReady = vi.fn();
    fetchMock.mockResolvedValueOnce(json({ index: { state: 'unavailable', failure: 'manifest_invalid', retryable: false, deviceLocal: false }, data: [] }));
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady }));
    act(() => result.current.reportView({ state: 'building' }));
    await flush(5000);
    expect(result.current.view).toMatchObject({ state: 'unavailable', failure: 'manifest_invalid' });
    expect(onReady).not.toHaveBeenCalled();
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a poll that errors keeps polling and keeps the building message', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ index: { state: 'ready' }, data: [] }));
    const onReady = vi.fn();
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady }));
    act(() => result.current.reportView({ state: 'building' }));
    await flush(5000);
    expect(result.current.view).toEqual({ state: 'building' });
    await flush(10_000);
    expect(result.current.view).toEqual({ state: 'building' });
    await flush(20_000);
    expect(result.current.view).toEqual({ state: 'ready' });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('changing the snapshot forgets the state, stops the old poll, and a late answer for the old snapshot is dropped', async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const onReady = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useSnapshotIndexState({ snapshotId: id, onReady }), { initialProps: { id: 'snap-1' } });
    act(() => result.current.reportView({ state: 'building' }));
    await flush(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ id: 'snap-2' });
    expect(result.current.view).toBeNull();
    await act(async () => { answer(json({ index: { state: 'ready' }, data: [] })); });
    await flush(120_000);
    expect(onReady).not.toHaveBeenCalled();
    expect(result.current.view).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retry posts the rebuild through runAction and polls again', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/file-index/rebuild')) return json({ index: { state: 'building' } }, 202);
      return json({ index: { state: 'building' }, data: [] });
    });
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady: vi.fn() }));
    act(() => result.current.reportView({ state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false }));

    await act(async () => { await result.current.retry(); });

    expect(fetchMock).toHaveBeenCalledWith('/backup/snapshots/snap-1/file-index/rebuild', { method: 'POST' });
    expect(result.current.view).toEqual({ state: 'building' });
    await flush(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a retry inside the rebuild cooldown (429) toasts through runAction and leaves the state in place (#11180)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "This snapshot's file list was rebuilt recently. Try again in a few minutes.", code: 'RATE_LIMITED', retryAfterSeconds: 420 }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '420' } },
    ));
    const view = { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false } as const;
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady: vi.fn() }));
    act(() => result.current.reportView(view));

    await act(async () => { await result.current.retry(); });

    expect(result.current.view).toEqual(view);
    expect(result.current.retrying).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    // The server's reason, not the generic localized RATE_LIMITED headline (#11280).
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: "This snapshot's file list was rebuilt recently. Try again in a few minutes.",
    }));
  });

  it('a cooldown 429 without a usable reason falls back to the localized rate-limit copy (#11280)', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'RATE_LIMITED', error: '  ' }, 429));
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady: vi.fn() }));
    act(() => result.current.reportView({ state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false }));

    await act(async () => { await result.current.retry(); });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Too many requests — try again shortly' }));
  });

  it('a retry the API refuses toasts through runAction and leaves the honest state in place', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "This snapshot failed its integrity check, so its file list can't be rebuilt.", code: 'attestation_failed' }, 409));
    const view = { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false } as const;
    const { result } = renderHook(() => useSnapshotIndexState({ snapshotId: 'snap-1', onReady: vi.fn() }));
    act(() => result.current.reportView(view));

    await act(async () => { await result.current.retry(); });

    expect(result.current.view).toEqual(view);
    expect(result.current.retrying).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
