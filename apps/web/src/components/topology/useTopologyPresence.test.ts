import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTopologyPresence } from './useTopologyPresence';
import { presenceFixture, presenceVisitor, MAIN_OFFICE } from './presenceFixtures';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const OTHER_SITE = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(fetchWithAuth).mockReset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); });

it('fetches presence for the site on mount from GET /topology/sites/:siteId/presence', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(presenceFixture({ visitors: [presenceVisitor(1)] })));
  const { result } = renderHook(() => useTopologyPresence(MAIN_OFFICE.id));
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(result.current!.visitors).toHaveLength(1);
  expect(String(vi.mocked(fetchWithAuth).mock.calls[0]![0])).toBe(`/topology/sites/${MAIN_OFFICE.id}/presence`);
});

it('refreshes every 60 seconds and keeps the last good value across a failed refresh', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(presenceFixture({ visitors: [presenceVisitor(1)] })));
  const { result } = renderHook(() => useTopologyPresence(MAIN_OFFICE.id));
  await waitFor(() => expect(result.current).not.toBeNull());
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json({ error: 'boom' }, 500));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  expect(result.current!.visitors).toHaveLength(1);
  vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  expect(result.current!.visitors).toHaveLength(1);
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(presenceFixture({ visitors: [] })));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await waitFor(() => expect(result.current!.visitors).toHaveLength(0));
});

it('never throws on a body that is not a presence response: the value stays null and the map still renders', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ some: 'graph' }));
  const { result } = renderHook(() => useTopologyPresence(MAIN_OFFICE.id));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(fetchWithAuth).toHaveBeenCalled();
  expect(result.current).toBeNull();
});

it('does not poll while the tab is hidden, and clears the value when the site changes', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(presenceFixture({ visitors: [presenceVisitor(1)] })));
  const { result, rerender } = renderHook(({ siteId }) => useTopologyPresence(siteId), { initialProps: { siteId: MAIN_OFFICE.id } });
  await waitFor(() => expect(result.current).not.toBeNull());
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(presenceFixture({ siteId: OTHER_SITE })));
  rerender({ siteId: OTHER_SITE });
  await waitFor(() => expect(result.current?.siteId).toBe(OTHER_SITE));
  expect(String(vi.mocked(fetchWithAuth).mock.calls.at(-1)![0])).toBe(`/topology/sites/${OTHER_SITE}/presence`);
});

it('does not fetch when disabled', async () => {
  const { result } = renderHook(() => useTopologyPresence(MAIN_OFFICE.id, false));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(fetchWithAuth).not.toHaveBeenCalled();
  expect(result.current).toBeNull();
});
