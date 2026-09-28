import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

import DevicePerformanceGraphs from './DevicePerformanceGraphs';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));

type Deferred = { resolve: (r: Response) => void };
function deferredResponse(): { promise: Promise<Response> } & Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => { resolve = res; });
  return { promise, resolve };
}

const okJson = (payload: unknown) => ({ ok: true, json: () => Promise.resolve(payload) }) as Response;

// #7214 (paper cut #25): the 24h/7d/30d range buttons were removed from the
// DOM entirely while a load was in flight, so a user could not change the
// range mid-load (the only way to alter it again was unmount or a device
// change). They must stay mounted and clickable throughout.
describe('DevicePerformanceGraphs range buttons stay visible while loading (#7214)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('keeps the range buttons in the DOM during the initial load', async () => {
    const pending = deferredResponse();
    fetchWithAuth.mockReturnValueOnce(pending.promise);

    render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    // Still loading — the buttons must already be present.
    expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();

    pending.resolve(okJson({ data: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument());
  });
});
