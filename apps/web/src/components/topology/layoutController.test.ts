import { afterEach, expect, it, vi } from 'vitest';
import { TopologyLayoutController, type LayoutWorker } from './layoutController';
import { layoutFixture } from './layoutFixtures';
import { packTopologyLayout } from './layoutAdapter';
afterEach(() => vi.useRealTimers());
it('discards stale responses and terminates superseded workers', async () => {
  const workers: LayoutWorker[] = [];
  const controller = new TopologyLayoutController(() => { const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null }; workers.push(worker); return worker; });
  const request = layoutFixture(), first = controller.run(request);
  const secondRequest = { ...request, requestId: 'second' }, second = controller.run(secondRequest);
  expect(await first).toBeNull(); expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(controller.accept({ ...packTopologyLayout(secondRequest), graphRevision: 'obsolete' })).toBe(false);
  workers[1].onmessage!.call(workers[1] as Worker, { data: packTopologyLayout(secondRequest) } as MessageEvent);
  expect((await second)?.requestId).toBe('second'); expect(workers[1].terminate).toHaveBeenCalledOnce();
});
it('terminates the worker at three seconds and exposes fallback warning', async () => {
  vi.useFakeTimers(); const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
  const controller = new TopologyLayoutController(() => worker); const pending = controller.run(layoutFixture());
  await vi.advanceTimersByTimeAsync(3000); expect((await pending)?.warning).toBe('layout_fallback'); expect(worker.terminate).toHaveBeenCalledOnce();
});
