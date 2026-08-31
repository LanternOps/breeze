#!/usr/bin/env tsx
import { closeDb } from '../src/db';
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

  // No context wrap (#4276): rollupDeviceMetricsRange owns one short-lived
  // labeled context per statement, and each escapes any ambient context — an
  // outer wrap here would do no work, just pin an idle-in-transaction
  // connection for the whole (up to 31-day) pass, and a mid-pass
  // idle_in_transaction_session_timeout would fail the script on COMMIT after
  // every inner statement had already committed.
  const result = await rollupDeviceMetricsRange({
    orgId: options.orgId,
    from: options.from,
    to: options.to,
    expectedSampleSeconds: options.expectedSampleSeconds,
  });

  if (result.skipped) {
    // Feature flag off for this org — no rollups were written. Warn loudly on stderr
    // so an operator does not mistake a no-op for a completed backfill.
    console.warn('[metric-rollup-backfill] SKIPPED: metric rollups are disabled for this org; nothing written.');
  } else {
    console.log('[metric-rollup-backfill] Completed.');
  }
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
