import { describe, it, expect } from 'vitest';
import { formatBandwidthTick } from './DevicePerformanceGraphs';

// #7214 (paper cut #25): the bandwidth y-axis printed duplicate labels
// ("… 1M 2M 2M") because maximumFractionDigits: 0 rounded distinct nearby
// tick values (e.g. 1.4M, 1.6M, 2.1M) onto the same integer string.
describe('formatBandwidthTick (#7214)', () => {
  it('does not collapse distinct nearby megabyte-scale ticks onto the same label', () => {
    const labels = [1_400_000, 1_600_000, 2_100_000].map(formatBandwidthTick);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('still renders whole numbers cleanly at larger magnitudes', () => {
    expect(formatBandwidthTick(50_000_000)).toBe('50M');
    expect(formatBandwidthTick(0)).toBe('0');
  });
});
