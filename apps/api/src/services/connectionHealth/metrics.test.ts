import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordZeroRecipientIncident,
  registerConnectionHealthMetrics,
  setConnectionHealthMetricsRecorder,
  ZERO_RECIPIENT_METRIC,
} from './metrics';

afterEach(() => setConnectionHealthMetricsRecorder(null));

describe('connection health metrics (spec §8 zero-recipient count)', () => {
  it('is a no-op until registered', () => {
    expect(() => recordZeroRecipientIncident('huntress')).not.toThrow();
  });

  it('counts zero-recipient incidents per known kind', async () => {
    const registry = new Registry();
    registerConnectionHealthMetrics(registry);
    recordZeroRecipientIncident('huntress');
    recordZeroRecipientIncident('huntress');
    recordZeroRecipientIncident('dns_filter');
    const text = await registry.metrics();
    expect(ZERO_RECIPIENT_METRIC).toBe('breeze_connection_health_zero_recipient_incidents_total');
    expect(text).toContain(`${ZERO_RECIPIENT_METRIC}{source_kind="huntress"} 2`);
    expect(text).toContain(`${ZERO_RECIPIENT_METRIC}{source_kind="dns_filter"} 1`);
  });

  it('folds an unregistered kind into "other" so the label set stays bounded', async () => {
    const registry = new Registry();
    registerConnectionHealthMetrics(registry);
    recordZeroRecipientIncident('probe_kind');
    expect(await registry.metrics()).toContain(`${ZERO_RECIPIENT_METRIC}{source_kind="other"} 1`);
  });

  it('registering twice on one registry reuses the counter', () => {
    const registry = new Registry();
    registerConnectionHealthMetrics(registry);
    expect(() => registerConnectionHealthMetrics(registry)).not.toThrow();
  });
});
