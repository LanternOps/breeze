import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from './auth';
import { useFeaturesStore } from './featuresStore';

const fetchMock = vi.mocked(fetchWithAuth);

const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('featuresStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFeaturesStore.setState({
      features: { billing: false, support: false },
      loaded: false,
    });
  });

  it('loads features from /config', async () => {
    fetchMock.mockResolvedValueOnce(
      res({ features: { billing: true, support: true } })
    );
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().features).toEqual({ billing: true, support: true });
    expect(useFeaturesStore.getState().loaded).toBe(true);
  });

  it('leaves defaults on fetch failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().features).toEqual({ billing: false, support: false });
    expect(useFeaturesStore.getState().loaded).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('leaves defaults and logs on non-ok response', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(res({}, false, 500));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().features).toEqual({ billing: false, support: false });
    expect(useFeaturesStore.getState().loaded).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips fetch once loaded', async () => {
    fetchMock.mockResolvedValueOnce(res({ features: { billing: true, support: false } }));
    await useFeaturesStore.getState().load();
    await useFeaturesStore.getState().load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coerces missing fields to false', async () => {
    fetchMock.mockResolvedValueOnce(res({}));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().features).toEqual({ billing: false, support: false });
  });
});
