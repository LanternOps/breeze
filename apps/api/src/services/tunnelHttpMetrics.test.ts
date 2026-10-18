import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import { TUNNEL_HTTP_REQUESTS_METRIC, recordTunnelHttpOutcome } from './tunnelHttpMetrics';

async function value(mode: string, outcome: string): Promise<number | undefined> {
  const metric = await metricsRegistry.getSingleMetric(TUNNEL_HTTP_REQUESTS_METRIC)?.get();
  return metric?.values.find((v) => v.labels.mode === mode && v.labels.outcome === outcome)?.value;
}

describe('tunnel_http_requests_total', () => {
  it('is pre-seeded at zero for every mode × outcome and counts by mode', async () => {
    expect(TUNNEL_HTTP_REQUESTS_METRIC).toBe('tunnel_http_requests_total');
    expect(await value('host', 'admission_refused')).toBe(0);
    expect(await value('path', 'dispatch_failed')).toBe(0);
    recordTunnelHttpOutcome('host', 'proxied');
    recordTunnelHttpOutcome('host', 'proxied');
    recordTunnelHttpOutcome('path', 'auth_failed');
    expect(await value('host', 'proxied')).toBe(2);
    expect(await value('path', 'auth_failed')).toBe(1);
    expect(await value('path', 'proxied')).toBe(0);
  });
});
