import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { chunkIds, READINESS_BATCH_SIZE, READINESS_CONCURRENCY, useAccountReadiness } from './useAccountReadiness';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const CAPS = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false };
const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const requestedIds = (call: number) => new URL(String(fetchMock.mock.calls[call][0]), 'http://x').searchParams.get('orgIds')!.split(',');
const body = (orgIds: string[], mode: 'native' | 'external' | 'off' = 'native') => ({
  partnerId: 'p1',
  capabilities: CAPS,
  serviceManagementMode: mode,
  orgs: orgIds.map((orgId) => ({
    orgId, type: 'customer', status: 'active',
    setup: { sites: 1, devices: 1, lastSeenAt: null, policyAssigned: true },
    account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
  })),
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(handleSessionExpired).mockReset();
});

describe('chunkIds', () => {
  it('splits into batches of 200', () => {
    expect(chunkIds(ids(450)).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(READINESS_BATCH_SIZE).toBe(200);
    expect(READINESS_CONCURRENCY).toBe(2);
  });
});

describe('useAccountReadiness', () => {
  it('requests one batch per 200 ids, fills rows per batch and lands on ready', async () => {
    fetchMock.mockImplementation(async (input) => jsonResponse(body(new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(','))));
    const all = ids(250);
    const { result } = renderHook(() => useAccountReadiness(all));
    expect(result.current.status).toBe('loading');
    expect(result.current.rowState.get(all[0])).toBe('pending');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedIds(0)).toHaveLength(200);
    expect(requestedIds(1)).toHaveLength(50);
    expect(result.current.byOrg.size).toBe(250);
    expect(result.current.rowState.get(all[249])).toBe('ready');
    expect(result.current.capabilities).toEqual(CAPS);
    expect(result.current.mode).toBe('native');
  });

  it('never has more than two batches in flight', async () => {
    const holds: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { holds.push(resolve); }));
    const all = ids(1000); // 5 batches
    const { result } = renderHook(() => useAccountReadiness(all));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { holds[0](jsonResponse(body(requestedIds(0)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => { holds[1](jsonResponse(body(requestedIds(1)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => { holds[2](jsonResponse(body(requestedIds(2)))); holds[3](jsonResponse(body(requestedIds(3)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    await act(async () => { holds[4](jsonResponse(body(requestedIds(4)))); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.byOrg.size).toBe(1000);
  });

  it('latest-wins: a response for a superseded id set is discarded', async () => {
    const holds: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { holds.push(resolve); }));
    const first = ids(2);
    const second = ['ffffffff-0000-4000-8000-000000000001'];
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useAccountReadiness(list), { initialProps: { list: first } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ list: second });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.rowState.get(first[0])).toBeUndefined();

    await act(async () => { holds[1](jsonResponse(body(second))); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { holds[0](jsonResponse(body(first))); }); // the stale one resolves last
    expect(result.current.byOrg.has(first[0])).toBe(false);
    expect(result.current.byOrg.has(second[0])).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('a failed batch marks only its rows failed, reports partial, and retry re-requests only that batch', async () => {
    const all = ids(250);
    fetchMock.mockImplementation(async (input) => {
      const requested = new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(',');
      return requested.length === 50 && fetchMock.mock.calls.length <= 2 ? jsonResponse({ error: 'boom' }, false, 500) : jsonResponse(body(requested));
    });
    const { result } = renderHook(() => useAccountReadiness(all));
    await waitFor(() => expect(result.current.status).toBe('partial'));
    expect(result.current.rowState.get(all[0])).toBe('ready');
    expect(result.current.rowState.get(all[249])).toBe('failed');
    expect(result.current.byOrg.size).toBe(200);

    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestedIds(2)).toHaveLength(50);
    expect(result.current.byOrg.size).toBe(250);
  });

  it('a thrown fetch counts as a failed batch, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useAccountReadiness(ids(1)));
    await waitFor(() => expect(result.current.status).toBe('partial'));
  });

  it('hands a 401 to handleSessionExpired', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, false, 401));
    renderHook(() => useAccountReadiness(ids(1)));
    await waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
  });

  it('decrements inFlight on the 401 branch so a concurrent successful batch still lands on ready, not a wedged loading', async () => {
    const all = ids(250); // splits into a 200-chunk and a 50-chunk, run concurrently (READINESS_CONCURRENCY=2)
    fetchMock.mockImplementation(async (input) => {
      const requested = new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(',');
      if (requested.length === 200) return jsonResponse({ error: 'Unauthorized' }, false, 401);
      return jsonResponse(body(requested));
    });
    const { result } = renderHook(() => useAccountReadiness(all));
    await waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
    // Without the inFlight decrement on the unauthorized branch, this never
    // resolves: inFlight is stuck above 0 and status is wedged at 'loading'.
    await waitFor(() => expect(result.current.status).not.toBe('loading'));
    expect(result.current.status).toBe('ready');
    expect(result.current.rowState.get(all[249])).toBe('ready'); // the 50-chunk that succeeded
  });

  it('marks a requested id absent from the response as failed, not ready', async () => {
    const all = ids(2);
    fetchMock.mockImplementation(async (input) => {
      const requested = new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(',');
      return jsonResponse(body([requested[0]])); // omits the second requested id
    });
    const { result } = renderHook(() => useAccountReadiness(all));
    await waitFor(() => expect(result.current.rowState.get(all[0])).toBe('ready'));
    expect(result.current.rowState.get(all[1])).toBe('failed');
    expect(result.current.byOrg.has(all[0])).toBe(true);
    expect(result.current.byOrg.has(all[1])).toBe(false);
  });

  it('the same ids in a different order (a manual reorder) do not refetch', async () => {
    fetchMock.mockImplementation(async (input) => jsonResponse(body(new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(','))));
    const all = ids(3);
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useAccountReadiness(list), { initialProps: { list: all } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ list: [...all].reverse() });
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('ready');
  });

  it('is idle with no ids', () => {
    const { result } = renderHook(() => useAccountReadiness([]));
    expect(result.current.status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
