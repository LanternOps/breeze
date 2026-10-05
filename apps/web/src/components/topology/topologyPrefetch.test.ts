import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./topologyApi', () => ({ topologyApi: { settings: vi.fn(async () => ({ ok: true })), graph: vi.fn(async () => ({ ok: true })) } }));
import { topologyApi } from './topologyApi';
import { clearTopologyPrefetch, prefetchTopologyGraph, prefetchTopologySettings, takePrefetchedGraph, takePrefetchedSettings } from './topologyPrefetch';

const SITE = '11111111-1111-4111-8111-111111111111';
afterEach(() => { clearTopologyPrefetch(); vi.useRealTimers(); vi.clearAllMocks(); window.location.hash = ''; });

it('starts a read once per key and hands it to exactly one consumer', async () => {
  prefetchTopologySettings(SITE); prefetchTopologySettings(SITE);
  expect(topologyApi.settings).toHaveBeenCalledTimes(1);
  await expect(takePrefetchedSettings(SITE)).resolves.toEqual({ ok: true });
  expect(takePrefetchedSettings(SITE)).toBeUndefined();
});

it('lets an untaken read expire after 15 s', () => {
  vi.useFakeTimers();
  prefetchTopologyGraph(SITE, 'overview');
  vi.advanceTimersByTime(15_001);
  expect(takePrefetchedGraph(SITE, 'overview')).toBeUndefined();
});

it('never prefetches the physical view (its availability is not known yet) and keys graph reads by view', () => {
  window.location.hash = `#topology/site/${SITE}/view/physical`;
  prefetchTopologyGraph(SITE);
  expect(topologyApi.graph).not.toHaveBeenCalled();
  prefetchTopologyGraph(SITE, 'logical');
  expect(takePrefetchedGraph(SITE, 'overview')).toBeUndefined();
  expect(takePrefetchedGraph(SITE, 'logical')).toBeDefined();
});

it('a taken read that failed rejects for its consumer', async () => {
  vi.mocked(topologyApi.settings).mockRejectedValueOnce(new Error('denied'));
  prefetchTopologySettings(SITE);
  await expect(takePrefetchedSettings(SITE)).rejects.toThrow('denied');
});

it('clearing drops every pending read (org switch)', () => {
  prefetchTopologySettings(SITE);
  clearTopologyPrefetch();
  expect(takePrefetchedSettings(SITE)).toBeUndefined();
});
