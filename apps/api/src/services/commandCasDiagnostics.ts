import { eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands } from '../db/schema';

/**
 * BREEZE-X: turn a `device_commands` terminal compare-and-set that moved 0 rows
 * into a self-diagnosing Sentry event.
 *
 * The CAS predicate is `status IN ('pending','sent')`, so 0 rows means SOMETHING
 * ELSE already drove the row terminal. At least three writers can:
 *
 *   - the REST/WS twin (`routes/agents/commands.ts` / `routes/agentWs.ts`) —
 *     a duplicate result on the other transport: `completed`/`failed` with a
 *     real agent result;
 *   - `jobs/staleCommandReaper.ts` — fleet-wide and on a schedule, sets
 *     `status:'failed'` + `result.timedOutBy:'server'`. An agent replying just
 *     past the timeout boundary lands here;
 *   - the cancellation paths (admin/abuse, software, scripts, cisHardening,
 *     discovery, backup/restore, maintenance, playbookRetention,
 *     backup/verificationScheduled) — `cancelled`.
 *
 * Prior `status` (+ the reaper's `timedOutBy` marker) discriminates all three,
 * which is the whole point: without it the event cannot distinguish a benign
 * race from a real regression.
 */

// device_commands.status is a bare varchar(20) with no enum and no CHECK
// (db/schema/devices.ts), so the value read back is only conventionally
// bounded. Pin the known set here and map anything else to a sentinel — a tag
// value must never become an unbounded passthrough of a column.
const KNOWN_COMMAND_STATUSES = new Set([
  'pending',
  'sent',
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'expired',
]);

/** The row is gone entirely (deleted / cascade-erased between CAS and re-read). */
export const PRIOR_STATUS_MISSING = 'missing';
/** The row carries a status outside the known set — worth its own Sentry facet. */
export const PRIOR_STATUS_UNKNOWN = 'unknown';
/** The diagnostic re-read itself failed; the CAS outcome is unchanged. */
export const PRIOR_STATUS_LOOKUP_FAILED = 'lookup-failed';

/**
 * Fold `result->>'timedOutBy'` into the status string rather than spending a
 * second Sentry tag on it: `failed` from the reaper and `failed` from a
 * duplicate agent result are the same tag value otherwise.
 */
export function priorStatusTagValue(
  row: { status?: unknown; result?: unknown } | undefined,
): string {
  if (!row) return PRIOR_STATUS_MISSING;

  const status =
    typeof row.status === 'string' && KNOWN_COMMAND_STATUSES.has(row.status)
      ? row.status
      : PRIOR_STATUS_UNKNOWN;

  const result = row.result;
  const timedOutBy =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).timedOutBy
      : undefined;

  if (status === 'failed' && timedOutBy === 'server') return 'failed:server-timeout';
  return status;
}

/**
 * Re-read the command by primary key and describe the state it was already in.
 *
 * ONLY call this on the 0-row branch. This is the agent hot path under known
 * connection-pool pressure (#1105) — an unconditional extra read would cost a
 * lookup per command result for nothing. Never throws: a diagnostic must not be
 * able to change the outcome of the write it is describing.
 */
export async function commandCasPriorStatusTags(
  commandId: string,
): Promise<Record<string, string>> {
  try {
    const [row] = await db
      .select({ status: deviceCommands.status, result: deviceCommands.result })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);
    return { prior_status: priorStatusTagValue(row) };
  } catch (err) {
    console.warn('[commandCas] prior-status lookup failed:', err);
    return { prior_status: PRIOR_STATUS_LOOKUP_FAILED };
  }
}
