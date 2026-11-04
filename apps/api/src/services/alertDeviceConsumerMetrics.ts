/** Device-only alert consumers must make refused runs visible in worker scrapes. */
import { Counter } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

// IDs and owner refs belong in logs, never in metric labels.
const skipped = new Counter({
  name: 'alert_device_consumer_skipped_total',
  help: 'Device-only alert consumers skipped because the alert has no device',
  labelNames: ['consumer'] as const,
  registers: [metricsRegistry],
});

export function recordAlertDeviceConsumerSkipped(consumer: 'automation' | 'flow'): void {
  skipped.inc({ consumer });
}
