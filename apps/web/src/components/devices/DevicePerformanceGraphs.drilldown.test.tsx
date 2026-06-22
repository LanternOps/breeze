import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

import DevicePerformanceGraphs, { resolveDrilldownAt } from './DevicePerformanceGraphs';

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

// resolveDrilldownAt is the shared click→timestamp resolver every chart (line +
// both area charts) routes through, so this guards the #1722 wiring against a
// regression that would silently make the charts un-drillable again.
describe('resolveDrilldownAt', () => {
  it('returns the activeLabel timestamp when a data point is clicked', () => {
    expect(resolveDrilldownAt({ activeLabel: '2026-06-13T12:00:00.000Z' })).toBe('2026-06-13T12:00:00.000Z');
  });

  it('coerces a numeric activeLabel to a string', () => {
    expect(resolveDrilldownAt({ activeLabel: 1718280000000 })).toBe('1718280000000');
  });

  it('returns null when the click lands off a data point (null state / missing activeLabel)', () => {
    expect(resolveDrilldownAt(null)).toBeNull();
    expect(resolveDrilldownAt({})).toBeNull();
    expect(resolveDrilldownAt({ activeLabel: undefined })).toBeNull();
  });
});
