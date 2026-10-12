import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMonitoringConfigForDisplay, captureException } = vi.hoisted(() => ({ resolveMonitoringConfigForDisplay: vi.fn(), captureException: vi.fn() }));
vi.mock('../routes/agents/helpers', () => ({ resolveMonitoringConfigForDisplay }));
vi.mock('./sentry', () => ({ captureException }));

import { filterToActiveWatches, loadActiveWatchKeys, watchKey } from './monitoringActiveWatches';

describe('monitoringActiveWatches (#8287)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the key case-insensitively on name', () => {
    expect(watchKey('service', 'Spooler')).toBe(watchKey('service', 'spooler'));
    expect(watchKey('service', 'x')).not.toBe(watchKey('process', 'x'));
  });

  it('returns the keys of the currently resolved watches', async () => {
    resolveMonitoringConfigForDisplay.mockResolvedValue({
      check_interval_seconds: 60,
      watches: [{ watch_type: 'service', name: 'Spooler' }, { watch_type: 'process', name: 'node' }],
    });
    const keys = await loadActiveWatchKeys('dev-1');
    expect(keys).toEqual(new Set([watchKey('service', 'Spooler'), watchKey('process', 'node')]));
  });

  it('returns an empty set when resolution authoritatively finds no watches', async () => {
    resolveMonitoringConfigForDisplay.mockResolvedValue({ check_interval_seconds: 60, watches: [] });
    expect(await loadActiveWatchKeys('dev-1')).toEqual(new Set());
  });

  it('returns null (unknown → do not filter) when resolution is unresolved', async () => {
    resolveMonitoringConfigForDisplay.mockResolvedValue(null);
    expect(await loadActiveWatchKeys('dev-1')).toBeNull();
  });

  it('returns null and reports when the resolver throws', async () => {
    resolveMonitoringConfigForDisplay.mockRejectedValue(new Error('boom'));
    expect(await loadActiveWatchKeys('dev-1')).toBeNull();
    expect(captureException).toHaveBeenCalled();
  });

  it('filterToActiveWatches drops removed watches, and is a no-op for null', () => {
    const rows = [
      { watchType: 'service', name: 'gone', status: 'not_found' },
      { watchType: 'service', name: 'Spooler', status: 'running' },
    ];
    const keys = new Set([watchKey('service', 'spooler')]);
    expect(filterToActiveWatches(rows, keys).map((r) => r.name)).toEqual(['Spooler']);
    expect(filterToActiveWatches(rows, null)).toBe(rows);
  });
});
