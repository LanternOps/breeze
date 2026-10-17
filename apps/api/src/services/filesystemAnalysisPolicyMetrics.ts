/**
 * #8509 — automatic `filesystem_analysis` triggers skipped because the
 * device's effective remote-tools policy is off.
 *
 * A LEAF module (prom-client + the registry only), like
 * `scriptCancellationMetrics.ts`, so any role can import it. A skip is an
 * operator's configuration doing its job, not a defect: it is a counter and a
 * throttled log line, deliberately not a Sentry capture.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

export type FilesystemAutoTrigger = 'threshold' | 'auto_resume';

const skippedTotal = new Counter({
  name: 'breeze_filesystem_analysis_auto_trigger_skipped_total',
  help: 'Automatic filesystem_analysis scans/continuations skipped because remote tools are disabled by policy',
  labelNames: ['trigger'] as const,
  registers: [metricsRegistry],
});

export function recordFilesystemAutoTriggerSkipped(trigger: FilesystemAutoTrigger): void {
  skippedTotal.inc({ trigger });
}
