import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

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

describe('DevicePerformanceGraphs drill-down lazy-load', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockReturnValue(Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response));
  });

  it('does not request process-samples on mount', async () => {
    render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const calledUrls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/process-samples'))).toBe(false);
    expect(calledUrls.every((u) => u.includes('/metrics'))).toBe(true);
  });
});
