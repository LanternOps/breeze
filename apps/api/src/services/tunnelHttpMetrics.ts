/**
 * Network Proxy outcome counter by mode (spec 2026-10-06 §9: auth failures,
 * admission refusals and dispatch failures by mode). Leaf module: prom-client
 * plus the shared registry only, so either route file can import it.
 */
import { Counter } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export const TUNNEL_HTTP_REQUESTS_METRIC = 'tunnel_http_requests_total';

export const TUNNEL_HTTP_MODES = ['path', 'host'] as const;
export type TunnelHttpMode = (typeof TUNNEL_HTTP_MODES)[number];

export const TUNNEL_HTTP_OUTCOMES = [
  'proxied',
  'auth_failed',
  'admission_refused',
  'gate_denied',
  'rate_limited',
  'budget_unavailable',
  'dispatch_failed',
  'host_rejected',
  'internal_error',
] as const;
export type TunnelHttpOutcome = (typeof TUNNEL_HTTP_OUTCOMES)[number];

const tunnelHttpRequests: Counter<'mode' | 'outcome'> =
  (metricsRegistry.getSingleMetric(TUNNEL_HTTP_REQUESTS_METRIC) as Counter<'mode' | 'outcome'> | undefined)
  ?? new Counter({
    name: TUNNEL_HTTP_REQUESTS_METRIC,
    help: 'Network Proxy requests by mode (path|host) and outcome',
    labelNames: ['mode', 'outcome'] as const,
    registers: [metricsRegistry],
  });

// Pre-seed every series at 0 so rate()/alerts see a zero, not an absent series.
for (const mode of TUNNEL_HTTP_MODES) {
  for (const outcome of TUNNEL_HTTP_OUTCOMES) tunnelHttpRequests.inc({ mode, outcome }, 0);
}

export function recordTunnelHttpOutcome(mode: TunnelHttpMode, outcome: TunnelHttpOutcome): void {
  tunnelHttpRequests.inc({ mode, outcome });
}
