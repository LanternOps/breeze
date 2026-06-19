#!/usr/bin/env tsx
import { closeDb, withSystemDbAccessContext } from '../src/db';
import { detectMetricAnomaliesRange } from '../src/services/metricAnomalies';
import { parseMetricAnomalyBackfillArgs } from './metric-anomaly-backfill.lib';

async function main(): Promise<void> {
  const options = parseMetricAnomalyBackfillArgs(process.argv.slice(2));
  const summary = {
    orgId: options.orgId,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
  };

  if (options.dryRun) {
    console.log('[metric-anomaly-backfill] Dry run; no anomalies written.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await withSystemDbAccessContext(() =>
    detectMetricAnomaliesRange({
      orgId: options.orgId,
      from: options.from,
      to: options.to,
    })
  );

  if (result.skipped) {
    // Feature flag off for this org — no anomalies were written. Warn loudly on stderr
    // so an operator does not mistake a no-op for a completed backfill.
    console.warn('[metric-anomaly-backfill] SKIPPED: metric anomaly detection is disabled for this org; nothing written.');
  } else {
    console.log('[metric-anomaly-backfill] Completed.');
  }
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error('[metric-anomaly-backfill] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
