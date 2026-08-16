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
      cfAccessLogin: { enabled: false },
      registration: { enabled: false },
      softwarePackages: { uploadsEnabled: true },
      loaded: false,
    });
  });

  // Package uploads gate is deliberately FAIL-OPEN (opposite of registration):
  // a missing field (older API) or unreachable /config must never gray out
  // uploads that would work — worst case the user hits the routes' own 503.
  it('softwarePackages.uploadsEnabled false only when /config says false', async () => {
    fetchMock.mockResolvedValueOnce(res({ softwarePackages: { uploadsEnabled: false } }));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().softwarePackages).toEqual({ uploadsEnabled: false });
  });

  it('softwarePackages.uploadsEnabled stays open when /config omits the field (older API)', async () => {
    fetchMock.mockResolvedValueOnce(res({ features: { billing: true, support: true } }));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().softwarePackages).toEqual({ uploadsEnabled: true });
  });

  it('softwarePackages.uploadsEnabled stays open when /config is unreachable', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().softwarePackages).toEqual({ uploadsEnabled: true });
    errSpy.mockRestore();
  });

  it('loads features from /config', async () => {
    fetchMock.mockResolvedValueOnce(
      res({ features: { billing: true, support: true } })
    );
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().features).toEqual({ billing: true, support: true });
    expect(useFeaturesStore.getState().loaded).toBe(true);
  });

  it('loads runtime registration flag from /config (#1308)', async () => {
    fetchMock.mockResolvedValueOnce(res({ registration: { enabled: true } }));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().registration).toEqual({ enabled: true });
  });

  it('defaults registration.enabled to false when /config omits it', async () => {
    fetchMock.mockResolvedValueOnce(res({ features: { billing: true, support: true } }));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState().registration).toEqual({ enabled: false });
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
