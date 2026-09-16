import { beforeEach, describe, expect, it } from 'vitest';
import {
  incrementSyncAction,
  incrementSyncCapacityRejected,
  renderMetrics,
  resetMetrics,
  setSigninLimiterTokens,
  setSyncInFlight,
  setTotalInFlight,
} from './metrics';

const SERIES = [
  'm365_sync_actions_total',
  'm365_sync_capacity_rejected_total',
  'm365_sync_in_flight',
  'm365_in_flight_total',
  'm365_signin_limiter_tokens',
  'm365_signin_events_limiter_tokens',
];

describe('executor metrics registry', () => {
  beforeEach(() => resetMetrics());

  it('renders every contracted series, gauges at zero included', () => {
    const text = renderMetrics();
    for (const name of SERIES) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('m365_sync_in_flight 0');
    expect(text).toContain('m365_in_flight_total 0');
    expect(text).toContain('m365_signin_limiter_tokens 0');
  });

  it('accumulates counters per label set', () => {
    incrementSyncAction('m365.sync.users', 'ok');
    incrementSyncAction('m365.sync.users', 'ok');
    incrementSyncAction('m365.sync.users', 'graph_throttled');
    incrementSyncCapacityRejected('sync');
    const text = renderMetrics();
    expect(text).toContain('m365_sync_actions_total{action="m365.sync.users",outcome="ok"} 2');
    expect(text).toContain('m365_sync_actions_total{action="m365.sync.users",outcome="graph_throttled"} 1');
    expect(text).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
  });

  it('sets gauges to the last value, not a running total', () => {
    setSyncInFlight(3);
    setSyncInFlight(1);
    setTotalInFlight(9);
    setSigninLimiterTokens(2);
    const text = renderMetrics();
    expect(text).toContain('m365_sync_in_flight 1');
    expect(text).toContain('m365_in_flight_total 9');
    expect(text).toContain('m365_signin_limiter_tokens 2');
  });

  it('emits only registered series, one sample per line', () => {
    incrementSyncCapacityRejected('interactive');
    incrementSyncAction('m365.sync.ca_policies', 'error');
    for (const line of renderMetrics().split('\n').filter((l) => l && !l.startsWith('#'))) {
      const name = line.split(/[{ ]/)[0]!;
      expect(SERIES).toContain(name);
      expect(line).toMatch(/ [0-9]+$/);
    }
  });
});
