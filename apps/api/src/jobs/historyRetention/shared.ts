/**
 * Shared knobs for the history retention job (#4342 W5). See `index.ts`.
 *
 * Every target in `jobs/historyRetention/` has its own `<NAME>_RETENTION_DAYS`
 * window and its own `<NAME>_RETENTION_ENFORCE` flag (default false), so an
 * operator can enable deletion one table at a time after reading that table's
 * report counts. Only the batch shape is shared.
 *
 * Env names are literals at each call site so `system/connections/envScan.ts`
 * sees them; never build one from a prefix.
 */

import { parsePositiveIntEnv } from '../retentionBatch';
import type { RetentionKnobs, RetentionTarget, RetentionTargetEntry } from '../retentionTarget';

export const LOG_PREFIX = '[HistoryRetention]';

export const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'HISTORY_RETENTION_BATCH_SIZE', 1000);
export const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'HISTORY_RETENTION_MAX_BATCHES', 100);

/** A target plus the env-resolved knobs and the flag that turns it on. */
export interface HistoryRetentionEntry extends RetentionTargetEntry {
  /** Named in the target's REPORT-ONLY log line. */
  enforceVar: string;
  /** The window cap, for the unit tests and the docs. */
  maxRetentionDays: number;
}

export function historyKnobs(retentionDays: number, enforce: boolean): RetentionKnobs {
  return { retentionDays, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES, enforce };
}

/**
 * A second-pass target (#4342 W6.c): REPORT-ONLY BY CONSTRUCTION.
 *
 * Its action is `reportOnly`, so `runRetentionTarget` only ever counts it,
 * and it has no `_ENFORCE` variable and no `enforceVar`: no env value or job
 * payload can make it delete. Only its window (`daysVar`) is tunable, so the
 * nightly count can be read at the window an operator is weighing. Giving one
 * of these a delete path is a later, separately reviewed change (Part B).
 */
export type ReportOnlyRetentionTarget = RetentionTarget & { action: { kind: 'reportOnly' } };

export interface HistoryReportOnlyEntry {
  target: ReportOnlyRetentionTarget;
  knobs: RetentionKnobs & { enforce: false };
  /** The variable that sets this target's window. */
  daysVar: string;
  /** The window cap, for the unit tests and the docs. */
  maxRetentionDays: number;
}

export function reportOnlyKnobs(retentionDays: number): RetentionKnobs & { enforce: false } {
  return { retentionDays, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES, enforce: false };
}
