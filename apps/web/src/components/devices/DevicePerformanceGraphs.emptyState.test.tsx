/** Chart empty state replaces blank axes (#9029). */
import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

import DevicePerformanceGraphs from './DevicePerformanceGraphs';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));

const okJson = (payload: unknown) => ({ ok: true, json: () => Promise.resolve(payload) }) as Response;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('DevicePerformanceGraphs empty state (#9029)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue(okJson({ data: [] }));
  });

  it('says there are no samples instead of drawing empty axes, at the chart height', async () => {
    render(<DevicePerformanceGraphs deviceId="dev-1" compact />);
    const empty = await screen.findByTestId('device-performance-empty');
    expect(empty).toHaveTextContent('No samples in the last 24h');
    expect(empty.className).toContain('h-56');
    expect(document.querySelector('.recharts-responsive-container')).toBeNull();
  });

  it('adds when an offline device was last seen', async () => {
    render(<DevicePerformanceGraphs deviceId="dev-1" offlineSince={minutesAgo(25)} />);
    const empty = await screen.findByTestId('device-performance-empty');
    expect(empty).toHaveTextContent('No samples in the last 24h');
    expect(empty).toHaveTextContent('Device offline · last seen 25 minutes ago');
    expect(empty.className).toContain('h-80');
  });
});
