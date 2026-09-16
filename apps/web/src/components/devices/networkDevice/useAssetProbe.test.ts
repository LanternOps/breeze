import '@/lib/i18n';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetProbe } from './useAssetProbe';
import { fetchWithAuth } from '../../../stores/auth';

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
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    await act(async () => { await result.current.checkNow(); });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/discovery/assets/${ASSET_ID}/probe`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.checking).toBe(false);
  });

  it('surfaces NO_AGENT_IN_SITE as an inline code, not only a toast', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ code: 'NO_AGENT_IN_SITE', error: 'no agent' }, 409));
    const { result } = renderHook(() =>
      useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh: vi.fn() }),
    );
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe('NO_AGENT_IN_SITE');
  });

  it('polls every 3s while the probe is pending and stops when it resolves', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
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
    const onRefresh = vi.fn().mockResolvedValue(undefined);
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
});
