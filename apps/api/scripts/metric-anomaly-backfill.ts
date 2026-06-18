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

  console.log('[metric-anomaly-backfill] Completed.');
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
