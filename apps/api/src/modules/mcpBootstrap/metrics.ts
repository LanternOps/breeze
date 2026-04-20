/**
 * MCP bootstrap activation funnel metrics.
 *
 * Exposes `mcp_bootstrap_activations_total{status=...}` as a Prometheus
 * counter incremented on activation state transitions:
 *   - pending_email   — create_tenant minted a partner + activation token
 *   - pending_payment — admin consumed the activation email link
 *   - active          — Stripe setup_intent.succeeded webhook fired
 *   - expired         — verify_tenant observed a lapsed activation window
 *
 * Design note: the spec asks for an OTel-shaped counter. OTel isn't wired
 * up in this repo today, but `prom-client` is (see `apps/api/src/routes/metrics.ts`),
 * so we register against it. The helper is intentionally side-effect-only:
 * importing it never throws, and callers do not need to await anything.
 */
import { Counter, register } from 'prom-client';

export type ActivationStatus =
  | 'pending_email'
  | 'pending_payment'
  | 'active'
  | 'expired';

const METRIC_NAME = 'mcp_bootstrap_activations_total';

function getOrCreateCounter(): Counter<'status'> {
  const existing = register.getSingleMetric(METRIC_NAME) as
    | Counter<'status'>
    | undefined;
  if (existing) return existing;
  return new Counter({
    name: METRIC_NAME,
    help: 'Activation funnel transitions for MCP-originated tenants',
    labelNames: ['status'],
  });
}

let counter: Counter<'status'> | null = null;

export function recordActivationTransition(status: ActivationStatus): void {
  try {
    if (!counter) counter = getOrCreateCounter();
    counter.inc({ status });
  } catch {
    // Metrics must never break the request path. Swallow registry errors
    // (e.g. duplicate-registration across test reloads) silently.
  }
}
