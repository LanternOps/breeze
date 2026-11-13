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
import type { RetentionKnobs, RetentionTargetEntry } from '../retentionTarget';

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
