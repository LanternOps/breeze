import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { layoutFixture } from './layoutFixtures';

// Never spins up a real GWT/WASM worker: the ELK constructor and adapter are
// mocked so this test exercises only the worker's message bridge — success
// posts the computed result, engine failure falls back deterministically.
vi.mock('elkjs/lib/elk-api', () => ({ default: vi.fn().mockImplementation(function FakeElk() { return {}; }) }));
vi.mock('./layoutAdapter', () => ({ computeTopologyLayout: vi.fn(), packTopologyLayout: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('posts the computed layout result back to the caller on success', async () => {
  const { computeTopologyLayout } = await import('./layoutAdapter');
  const request = layoutFixture();
  const result = { ...request, positions: [] };
  vi.mocked(computeTopologyLayout).mockResolvedValue(result as never);
  const postMessage = vi.fn();
  vi.stubGlobal('self', { postMessage, onmessage: null });
  await import('./layout.worker.ts');
  expect(typeof (self as unknown as { onmessage: unknown }).onmessage).toBe('function');
  await (self as unknown as { onmessage: (event: MessageEvent) => Promise<void> }).onmessage({ data: request } as MessageEvent);
  expect(postMessage).toHaveBeenCalledWith(result);
});

it('falls back to a deterministic grid pack when the ELK engine throws', async () => {
  const { computeTopologyLayout, packTopologyLayout } = await import('./layoutAdapter');
  const request = layoutFixture();
  vi.mocked(computeTopologyLayout).mockRejectedValue(new Error('engine down'));
  const fallback = { ...request, positions: [], warning: 'layout_fallback' as const };
  vi.mocked(packTopologyLayout).mockReturnValue(fallback);
  const postMessage = vi.fn();
  vi.stubGlobal('self', { postMessage, onmessage: null });
  await import('./layout.worker.ts');
  await (self as unknown as { onmessage: (event: MessageEvent) => Promise<void> }).onmessage({ data: request } as MessageEvent);
  expect(packTopologyLayout).toHaveBeenCalledWith(request, undefined, true);
  expect(postMessage).toHaveBeenCalledWith(fallback);
});
