import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

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

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };

function deferredResponse(): { promise: Promise<Response> } & Deferred {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okJson = (payload: unknown) => ({ ok: true, json: () => Promise.resolve(payload) }) as Response;
const signalOf = (callIndex: number) => (fetchWithAuth.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.signal;

// Issue #4513: the device page's graphs fetch kept running after the page
// island unmounted (org switch / soft navigation), holding a browser
// connection and an API worker for a response nobody would render.
describe('DevicePerformanceGraphs request lifecycle (#4513)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('passes an AbortSignal and aborts the in-flight metrics request on unmount', async () => {
    const pending = deferredResponse();
    fetchWithAuth.mockReturnValueOnce(pending.promise);

    const { unmount } = render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    const signal = signalOf(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the previous device request and ignores its late response', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    fetchWithAuth.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { rerender, container } = render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    rerender(<DevicePerformanceGraphs deviceId="dev-2" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(signalOf(0)?.aborted).toBe(true);
    expect(String(fetchWithAuth.mock.calls[1][0])).toContain('/devices/dev-2/metrics');

    // dev-1's response lands after dev-2's request started: it must not end
    // dev-2's loading state (or render dev-1's series under dev-2).
    await act(async () => {
      first.resolve(okJson({ data: [] }));
    });
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => {
      second.resolve(okJson({ data: [] }));
    });
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull());
  });

  it('does not surface an aborted request as a load error', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    fetchWithAuth.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { rerender, container } = render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    rerender(<DevicePerformanceGraphs deviceId="dev-2" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.reject(new DOMException('Aborted', 'AbortError'));
    });
    expect(container.querySelector('.text-destructive')).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});
