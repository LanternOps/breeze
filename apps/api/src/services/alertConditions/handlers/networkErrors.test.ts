import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getRecentMetricsMock } = vi.hoisted(() => ({ getRecentMetricsMock: vi.fn() }));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock };
});

import { networkErrorsHandler } from './networkErrors';

const NOW = new Date('2026-09-26T12:00:00.000Z');

type Iface = { name: string; inErrors: number; outErrors: number };

/**
 * A deviceMetrics row `minutesAgo` before NOW. Interface error counters are the
 * agent's CUMULATIVE since-boot counters (gopsutil Errin/Errout) — not
 * per-interval counts.
 */
function row(minutesAgo: number, ifaces: Iface[] | null) {
  return {
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
    interfaceStats: ifaces,
  } as never;
}

/** getRecentMetrics returns newest first. */
function setRows(...rows: never[]) {
  getRecentMetricsMock.mockResolvedValue(rows);
}

describe('networkErrorsHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getRecentMetricsMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('counts the increase of cumulative counters, not their sum across samples', async () => {
    setRows(
      row(0, [{ name: 'eth0', inErrors: 1005, outErrors: 0 }]),
      row(2, [{ name: 'eth0', inErrors: 1002, outErrors: 0 }]),
      row(4, [{ name: 'eth0', inErrors: 1000, outErrors: 0 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 10, windowMinutes: 5 },
      'dev-1'
    );
    // Old behaviour summed 1000+1002+1005 = 3007 and fired on any long-lived box.
    expect(result.actualValue).toBe(5);
    expect(result.passed).toBe(false);
  });

  it('fires when errors in the window exceed the threshold', async () => {
    setRows(
      row(0, [{ name: 'eth0', inErrors: 150, outErrors: 40 }]),
      row(4, [{ name: 'eth0', inErrors: 100, outErrors: 30 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'total', operator: 'gt', value: 50, windowMinutes: 5 },
      'dev-1'
    );
    expect(result.actualValue).toBe(60);
    expect(result.passed).toBe(true);
  });

  it('uses the newest sample at or before the window start as the baseline', async () => {
    // Window is 5 min. The 7-min-old sample is the baseline, so errors that
    // accrued between it and the first in-window sample are counted too.
    setRows(
      row(0, [{ name: 'eth0', inErrors: 30, outErrors: 0 }]),
      row(3, [{ name: 'eth0', inErrors: 25, outErrors: 0 }]),
      row(7, [{ name: 'eth0', inErrors: 10, outErrors: 0 }]),
      row(9, [{ name: 'eth0', inErrors: 0, outErrors: 0 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 100, windowMinutes: 5 },
      'dev-1'
    );
    expect(getRecentMetricsMock).toHaveBeenCalledWith('dev-1', 10);
    expect(result.actualValue).toBe(20);
  });

  it('treats a counter that went backwards as a reset (reboot) and counts from zero', async () => {
    setRows(
      row(0, [{ name: 'eth0', inErrors: 4, outErrors: 0 }]),
      row(2, [{ name: 'eth0', inErrors: 900, outErrors: 0 }]),
      row(4, [{ name: 'eth0', inErrors: 890, outErrors: 0 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 100, windowMinutes: 5 },
      'dev-1'
    );
    expect(result.actualValue).toBe(14);
  });

  it('filters by interface name and tracks each interface independently', async () => {
    setRows(
      row(0, [{ name: 'eth0', inErrors: 10, outErrors: 0 }, { name: 'wlan0', inErrors: 500, outErrors: 0 }]),
      row(4, [{ name: 'eth0', inErrors: 8, outErrors: 0 }, { name: 'wlan0', inErrors: 100, outErrors: 0 }]),
    );
    const eth0 = await networkErrorsHandler.evaluate(
      { type: 'network_errors', interfaceName: 'eth0', errorType: 'in', operator: 'gt', value: 50 },
      'dev-1'
    );
    const all = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 50 },
      'dev-1'
    );
    expect(eth0.actualValue).toBe(2);
    expect(eth0.passed).toBe(false);
    expect(all.actualValue).toBe(402);
    expect(all.passed).toBe(true);
  });

  it('sums same-named interfaces within a sample instead of diffing them against each other', async () => {
    // Two unnamed adapters in each sample. Keyed naively, the second would be
    // diffed against the first from the SAME sample (500 vs 10 → fake errors).
    setRows(
      row(0, [{ name: '', inErrors: 12, outErrors: 0 }, { name: '', inErrors: 503, outErrors: 0 }]),
      row(4, [{ name: '', inErrors: 10, outErrors: 0 }, { name: '', inErrors: 500, outErrors: 0 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 100 },
      'dev-1'
    );
    expect(result.actualValue).toBe(5);
    expect(result.passed).toBe(false);
  });

  it('skips samples without interface stats and accepts string timestamps', async () => {
    setRows(
      { timestamp: new Date(NOW.getTime()).toISOString(), interfaceStats: [{ name: 'eth0', inErrors: 40, outErrors: 0 }] } as never,
      row(2, null),
      { timestamp: new Date(NOW.getTime() - 4 * 60_000).toISOString(), interfaceStats: [{ name: 'eth0', inErrors: 25, outErrors: 0 }] } as never,
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 10 },
      'dev-1'
    );
    expect(result.actualValue).toBe(15);
    expect(result.passed).toBe(true);
  });

  it('reports no data when fewer than two samples carry the interface', async () => {
    setRows(row(0, [{ name: 'eth0', inErrors: 5000, outErrors: 0 }]));
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 10 },
      'dev-1'
    );
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('reports no data when the named interface never appears', async () => {
    setRows(
      row(0, [{ name: 'eth0', inErrors: 50, outErrors: 0 }]),
      row(4, [{ name: 'eth0', inErrors: 0, outErrors: 0 }]),
    );
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', interfaceName: 'eth9', errorType: 'in', operator: 'gt', value: 10 },
      'dev-1'
    );
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('reports no data when there are no samples', async () => {
    setRows();
    const result = await networkErrorsHandler.evaluate(
      { type: 'network_errors', errorType: 'in', operator: 'gt', value: 10 },
      'dev-1'
    );
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });
});
