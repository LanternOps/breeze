import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../stores/auth';
import { useDeviceIsolation } from './useDeviceIsolation';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const data = { episodes: [{ id: 'episode-1', state: 'verified' }], startEligibility: { allowed: false, reason: 'feature_disabled' } };
beforeEach(() => vi.clearAllMocks());
it('retains recovery state on refresh failure', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(JSON.stringify(data)));
  const { result } = renderHook(() => useDeviceIsolation('device-1'));
  await waitFor(() => expect(result.current.data).toEqual(data));
  vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('offline'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.data).toEqual(data);
});
it('ignores a late response for the previous device', async () => {
  let complete!: (response: Response) => void;
  vi.mocked(fetchWithAuth).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const { result, rerender } = renderHook(({ id }) => useDeviceIsolation(id), { initialProps: { id: 'device-1' } });
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(JSON.stringify({ ...data, episodes: [] })));
  rerender({ id: 'device-2' });
  await waitFor(() => expect(result.current.data?.episodes).toEqual([]));
  await act(async () => complete(new Response(JSON.stringify(data))));
  expect(result.current.data?.episodes).toEqual([]);
});
it('does not fetch without execute permission', () => {
  renderHook(() => useDeviceIsolation('device-1', false));
  expect(fetchWithAuth).not.toHaveBeenCalled();
});
