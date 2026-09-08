#!/usr/bin/env tsx
import { closeDb } from '../src/db';
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

  // No outer `withSystemDbAccessContext` (#5283): `detectMetricAnomaliesRange`
  // opens a fresh system-scoped transaction per detection stage. Wrapping it
  // here would have every stage early-return into this one ambient transaction
  // and silently rebuild the single long-lived transaction the split exists to
  // eliminate.
  const result = await detectMetricAnomaliesRange({
    orgId: options.orgId,
    from: options.from,
    to: options.to,
  });

  // A skip is no longer synonymous with "flag off" (#5283) — it also covers a
  // run that lost the org advisory lock or exceeded its wait bounds. Naming the
  // reason matters here: "disabled" tells an operator to change a setting,
  // while "locked" tells them to re-run, and the old message asserted the first
  // for both.
  const incomplete = result.stages.filter((stage) => stage.outcome !== 'completed');
  if (result.skipped) {
    const reason = result.skippedReason ?? 'unknown';
    const explanation = reason === 'ml-disabled'
      ? 'metric anomaly detection is disabled for this org'
      : reason === 'locked'
        ? 'another detection run holds this org\'s advisory lock — re-run once it finishes'
        : 'every detection stage exceeded its wait bound — re-run, and check for lock contention on metric_rollups';
    console.warn(`[metric-anomaly-backfill] SKIPPED (${reason}): ${explanation}; nothing written.`);
  } else if (incomplete.length > 0) {
    console.warn(
      `[metric-anomaly-backfill] PARTIAL: ${result.statements} stage(s) committed, `
        + `${incomplete.map((stage) => `${stage.stage}=${stage.outcome}`).join(', ')}. Re-run to cover the rest.`,
    );
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
