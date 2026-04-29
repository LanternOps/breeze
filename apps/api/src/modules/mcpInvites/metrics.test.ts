import { describe, it, expect } from 'vitest';
import { register } from 'prom-client';
import { recordActivationTransition } from './metrics';

describe('recordActivationTransition', () => {
  it('registers the mcp_bootstrap_activations_total counter and increments per status', async () => {
    recordActivationTransition('pending_email');
    recordActivationTransition('pending_email');
    recordActivationTransition('active');
    recordActivationTransition('expired');

    const metric = register.getSingleMetric('mcp_bootstrap_activations_total');
    expect(metric).toBeDefined();

    const { values } = await (metric as any).get();
    const byStatus: Record<string, number> = {};
    for (const v of values as Array<{ labels: { status: string }; value: number }>) {
      byStatus[v.labels.status] = (byStatus[v.labels.status] ?? 0) + v.value;
    }
    expect(byStatus.pending_email).toBeGreaterThanOrEqual(2);
    expect(byStatus.active).toBeGreaterThanOrEqual(1);
    expect(byStatus.expired).toBeGreaterThanOrEqual(1);
  });

  it('is safe to import and call without a provider configured (never throws)', () => {
    expect(() => recordActivationTransition('pending_payment')).not.toThrow();
  });
});
