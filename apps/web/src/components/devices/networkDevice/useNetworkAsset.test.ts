import '@/lib/i18n';

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useNetworkAsset } from './useNetworkAsset';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const ASSET_ID = 'asset-1';

const baseAsset = {
  id: ASSET_ID,
  assetType: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  ipAddress: '10.0.0.2',
};

describe('useNetworkAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces reachability, probe, nicVendor and siteTimezone on extras', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            ...baseAsset,
            siteTimezone: 'America/Chicago',
            nicVendor: 'LEXMARK INTERNATIONAL, INC.',
            reachability: {
              state: 'responding',
              source: 'snmp',
              observedAt: '2026-09-16T10:00:00.000Z',
              lastKnown: null,
              detail: { snmp: { state: 'ok', observedAt: '2026-09-16T10:00:00.000Z', consecutiveFailures: 0 } },
            },
            probe: { state: 'ok', responseMs: 3.2, observedAt: '2026-09-16T09:59:00.000Z' },
          },
        }),
      )
      .mockResolvedValue(makeJsonResponse({ data: [] }));

    const { result } = renderHook(() => useNetworkAsset(ASSET_ID));

    await waitFor(() => expect(result.current.asset).toBeTruthy());
    expect(result.current.extras.siteTimezone).toBe('America/Chicago');
    expect(result.current.extras.nicVendor).toBe('LEXMARK INTERNATIONAL, INC.');
    expect(result.current.extras.reachability?.state).toBe('responding');
    expect(result.current.extras.reachability?.source).toBe('snmp');
    expect(result.current.extras.probe?.responseMs).toBe(3.2);
  });

  it('leaves the four new fields null when the API omits them (W01 not yet deployed)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
      .mockResolvedValue(makeJsonResponse({ data: [] }));

    const { result } = renderHook(() => useNetworkAsset(ASSET_ID));

    await waitFor(() => expect(result.current.asset).toBeTruthy());
    expect(result.current.extras.siteTimezone).toBeNull();
    expect(result.current.extras.reachability).toBeNull();
    expect(result.current.extras.probe).toBeNull();
    expect(result.current.extras.nicVendor).toBeNull();
  });

  // #reviewFix4: fetchDevices had no stale-response guard, so a slower
  // earlier call could resolve after a later one and clobber it with older
  // data.
  it('keeps the later device list when two overlapping fetchDevices calls resolve out of order', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });

    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset })) // initial asset load
      .mockReturnValueOnce(firstPromise as unknown as Promise<Response>); // mount's fetchDevices call (slow)

    const { result } = renderHook(() => useNetworkAsset(ASSET_ID));

    await waitFor(() => expect(result.current.asset).toBeTruthy());

    // Second, overlapping fetchDevices call — started while the first is
    // still in flight.
    fetchWithAuthMock.mockReturnValueOnce(secondPromise as unknown as Promise<Response>);
    void result.current.fetchDevices();

    // Resolve the SECOND (later) call first, with its own list.
    resolveSecond(makeJsonResponse({ data: [{ id: 'dev-2', displayName: 'Later', status: 'online' }] }));
    await waitFor(() =>
      expect(result.current.devices).toEqual([{ id: 'dev-2', name: 'Later', online: true }]),
    );

    // Then resolve the FIRST (earlier, now-stale) call with a different list.
    // It must be ignored — the later list must survive. Resolving/flushing
    // must be wrapped in `act` for renderHook's `result.current` to reflect
    // the (would-be, pre-fix) stale update at all.
    await act(async () => {
      resolveFirst(makeJsonResponse({ data: [{ id: 'dev-1', displayName: 'Earlier', status: 'online' }] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.devices).toEqual([{ id: 'dev-2', name: 'Later', online: true }]);
  });
});

it('returns true for a successful refresh and false on failure while preserving the asset', async () => {
  fetchWithAuthMock.mockImplementation(async (url) => makeJsonResponse(url.startsWith('/discovery/') ? { data: baseAsset } : { data: [] }));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { result } = renderHook(() => useNetworkAsset(ASSET_ID));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    expect(await result.current.fetchAsset({ background: true })).toBe(true);
  });
  const previous = result.current.asset;
  fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false));
  await act(async () => {
    expect(await result.current.fetchAsset({ background: true })).toBe(false);
  });
  expect(result.current.asset).toBe(previous);
  expect(warning).toHaveBeenCalledWith('[network-device] background refresh failed', ASSET_ID, expect.any(Error));
  warning.mockRestore();
});
