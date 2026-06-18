#!/usr/bin/env tsx
import { closeDb, withSystemDbAccessContext } from '../src/db';
import { rollupDeviceMetricsRange } from '../src/services/metricRollups';
import { parseMetricRollupBackfillArgs } from './metric-rollup-backfill.lib';

async function main(): Promise<void> {
  const options = parseMetricRollupBackfillArgs(process.argv.slice(2));
  const summary = {
    orgId: options.orgId,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    expectedSampleSeconds: options.expectedSampleSeconds ?? null,
  };

  if (options.dryRun) {
    console.log('[metric-rollup-backfill] Dry run; no rollups written.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await withSystemDbAccessContext(() =>
    rollupDeviceMetricsRange({
      orgId: options.orgId,
      from: options.from,
      to: options.to,
      expectedSampleSeconds: options.expectedSampleSeconds,
    })
  );

  console.log('[metric-rollup-backfill] Completed.');
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error('[metric-rollup-backfill] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
