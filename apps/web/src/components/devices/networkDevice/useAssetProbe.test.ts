import '@/lib/i18n';
import { useState } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetProbe } from './useAssetProbe';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET_ID = 'asset-1';

describe('useAssetProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('POSTs the probe and refreshes the asset on a synchronous result', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ probe: { state: 'ok', responseMs: 2.1, observedAt: 'now' } }));
    const onRefresh = vi.fn().mockResolvedValue(true);

    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    await act(async () => { await result.current.checkNow(); });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/discovery/assets/${ASSET_ID}/probe`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.checking).toBe(false);
  });

  it('surfaces NO_AGENT_IN_SITE as an inline code, not only a toast', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ code: 'NO_AGENT_IN_SITE', error: 'no agent' }, 409));
    const { result } = renderHook(() =>
      useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh: vi.fn().mockResolvedValue(true) }),
    );
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe('NO_AGENT_IN_SITE');
  });

  it('polls every 3s while the probe is pending and stops when it resolves', async () => {
    const onRefresh = vi.fn().mockResolvedValue(true);
    const pendingProbe = { state: 'pending' as const, responseMs: null, observedAt: '2026-09-16T10:00:00.000Z' };
    const { rerender } = renderHook(
      ({ probe }) => useAssetProbe({ assetId: ASSET_ID, probe, onRefresh }),
      { initialProps: { probe: pendingProbe as { state: 'pending' | 'ok'; responseMs: number | null; observedAt: string } } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).toHaveBeenCalledTimes(3);

    rerender({ probe: { state: 'ok', responseMs: 4, observedAt: '2026-09-16T10:00:09.000Z' } });
    onRefresh.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('gives up after 60s of pending and reports PROBE_TIMED_OUT', async () => {
    const onRefresh = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useAssetProbe({
        assetId: ASSET_ID,
        probe: { state: 'pending', responseMs: null, observedAt: '2026-09-16T10:00:00.000Z' },
        onRefresh,
      }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(63_000); });
    await waitFor(() => expect(result.current.errorCode).toBe('PROBE_TIMED_OUT'));
    // 60_000 / 3_000 = 20 refreshes and no more.
    expect(onRefresh).toHaveBeenCalledTimes(20);
    expect(result.current.pending).toBe(false);
  });
  it.each([
    ['PROBE_IN_FLIGHT', 409, 'PROBE_IN_FLIGHT'],
    ['ASSET_NO_IP', 422, 'ASSET_NO_IP'],
    ['ASSET_NO_SITE', 422, 'ASSET_NO_SITE'],
    ['FUTURE_CODE', 500, 'UNKNOWN'],
    ['UNAUTHORIZED', 401, null],
  ])('handles %s without duplicate feedback', async (code, status, expected) => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ code, error: 'Probe failed' }, status as number));
    const onRefresh = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe(expected);
    expect(onRefresh).toHaveBeenCalledTimes(code === 'PROBE_IN_FLIGHT' ? 1 : 0);
    expect(showToast).toHaveBeenCalledTimes(status === 401 ? 0 : 1);
  });

  it('a new pending probe restarts the 60 s budget', async () => {
    const onRefresh = vi.fn().mockResolvedValue(true);
    fetchWithAuthMock.mockResolvedValue(json({ probe: { state: 'pending' } }, 202));
    const { result } = renderHook(() => useAssetProbe({
      assetId: ASSET_ID, probe: { state: 'pending', responseMs: null, observedAt: null }, onRefresh,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(63_000); });
    expect(result.current.errorCode).toBe('PROBE_TIMED_OUT');
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.pending).toBe(true);
    onRefresh.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.errorCode).toBe('PROBE_TIMED_OUT');
    expect(result.current.pending).toBe(false);
  });

  it('does not wedge pending after giving up then receiving a 409 on retry', async () => {
    const onRefresh = vi.fn().mockResolvedValue(true);
    fetchWithAuthMock.mockResolvedValue(json({ code: 'PROBE_IN_FLIGHT', error: 'In flight' }, 409));
    const { result } = renderHook(() => useAssetProbe({
      assetId: ASSET_ID, probe: { state: 'pending', responseMs: null, observedAt: null }, onRefresh,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(63_000); });
    onRefresh.mockClear();
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe('PROBE_IN_FLIGHT');
    expect(result.current.pending).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('reports REFRESH_FAILED immediately when the saved probe cannot be read', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ probe: { state: 'pending' } }, 202));
    const onRefresh = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe('REFRESH_FAILED');
    expect(result.current.pending).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('stops after three consecutive failed refreshes, resetting the count on success', async () => {
    const onRefresh = vi.fn().mockResolvedValue(false)
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useAssetProbe({
      assetId: ASSET_ID, probe: { state: 'pending', responseMs: null, observedAt: null }, onRefresh,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.pending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(result.current.errorCode).toBe('REFRESH_FAILED');
    expect(result.current.pending).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).toHaveBeenCalledTimes(6);
  });

  it('keeps checking disabled until the saved result has been refreshed', async () => {
    let finishRefresh!: (value: boolean) => void;
    const onRefresh = vi.fn(() => new Promise<boolean>((resolve) => { finishRefresh = resolve; }));
    fetchWithAuthMock.mockResolvedValue(json({ probe: { state: 'ok' } }));
    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    let check!: Promise<void>;
    await act(async () => { check = result.current.checkNow(); });
    expect(result.current.checking).toBe(true);
    await act(async () => { finishRefresh(true); await check; });
    expect(result.current.checking).toBe(false);
  });

  it('does not report a timeout when the twentieth refresh completes the probe', async () => {
    let refreshes = 0;
    const { result } = renderHook(() => {
      const [state, setState] = useState<'pending' | 'ok'>('pending');
      return useAssetProbe({
        assetId: ASSET_ID, probe: { state, responseMs: null, observedAt: null },
        onRefresh: async () => { if (++refreshes === 20) setState('ok'); return true; },
      });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refreshes).toBe(20);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.pending).toBe(false);
  });

});
