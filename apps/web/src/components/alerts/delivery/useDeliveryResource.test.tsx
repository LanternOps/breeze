import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import { useDeliveryResource } from './useDeliveryResource';
const fetchMock = vi.mocked(fetchWithAuth);
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
beforeEach(() => vi.clearAllMocks());
it('errors are not successful empty lists; retry can produce a real empty list', async () => {
  fetchMock.mockResolvedValueOnce(response({ error: 'down' }, 500)).mockResolvedValueOnce(response({ data: [] }));
  const hook = renderHook(() => useDeliveryResource('/alerts/delivery/rails?rail=routing'));
  expect(hook.result.current.status).toBe('loading');
  await waitFor(() => expect(hook.result.current.status).toBe('error'));
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.status).toBe('success'));
  expect(hook.result.current.data).toEqual([]);
});
it('ignores late results after changing org', async () => {
  let finish!: (res: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response({ data: [{ id: 'new' }] }));
  const hook = renderHook(({ url }) => useDeliveryResource<{ id: string }>(url), { initialProps: { url: 'old' } });
  hook.rerender({ url: 'new' });
  await waitFor(() => expect(hook.result.current.data).toEqual([{ id: 'new' }]));
  await act(async () => finish(response({ data: [{ id: 'old' }] })));
  expect(hook.result.current.data).toEqual([{ id: 'new' }]);
});
it('preserves inherited channel enabled state without inventing config', async () => {
  const inherited = [{ id: 'partner', name: 'NOC', type: 'slack', enabled: false, inherited: true }];
  fetchMock.mockResolvedValueOnce(response({ data: [], inherited }));
  const hook = renderHook(() => useDeliveryResource('channels'));
  await waitFor(() => expect(hook.result.current.status).toBe('success'));
  expect(hook.result.current.inherited).toEqual(inherited);
  expect(hook.result.current.inherited[0]).not.toHaveProperty('config');
});
it('keeps unrelated rails usable', async () => {
  fetchMock.mockImplementation(async url => response({ data: [] }, url.includes('routing') ? 500 : 200));
  const hook = renderHook(() => ({ routing: useDeliveryResource('routing'), channels: useDeliveryResource('channels') }));
  await waitFor(() => expect(hook.result.current.routing.status).toBe('error'));
  expect(hook.result.current.channels.status).toBe('success');
});
