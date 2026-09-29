import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands } from '../db/schema';
import {
  RESULT_PROCESSING_FAILED_RESULT_STATUS,
  commandAcceptsAgentResultCondition,
} from './commandResultAcceptance';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

/**
 * Operator-facing reason stored on a parked row. Fixed text on purpose: the
 * underlying exception (a Postgres error, a Redis timeout) can quote row
 * values, and `device_commands.result` is readable by anyone with
 * `scripts:read` — the detail goes to Sentry, not here.
 */
export const RESULT_PROCESSING_FAILED_MESSAGE =
  'The agent reported a result, but the server could not record it. Run the command again.';

/**
 * #3530 — park a command whose agent result could not be persisted.
 *
 * Called by both ingest transports AFTER the transaction that held the
 * terminal compare-and-set and the per-type persistence rolled back. The row
 * is still in whatever acceptable state it was in before (pending/sent, a
 * server-timeout marker, …); this moves it to top-level `failed` so the
 * history and every `waitForCommandResult` caller see an honest outcome
 * rather than a command that is still "running", and stamps
 * {@link RESULT_PROCESSING_FAILED_RESULT_STATUS} so a resubmitted result is
 * accepted and reprocessed (see commandAcceptsAgentResultCondition).
 *
 * The agent's own reported fields (exitCode, stdout, stderr, error) are kept —
 * they are what the operator needs to see — and its status is preserved as
 * `agentStatus`. Guarded by the same acceptance predicate as the ingest CAS,
 * so it can never overwrite a result that a concurrent writer did record.
 *
 * Runs in the caller's DB context: device_commands has no RLS, and the caller
 * decides whether that is the request transaction (REST, after its savepoint
 * rolled back) or a fresh system context (WebSocket).
 *
 * @returns true when the row was parked; false when it no longer accepted a
 *   result (another writer won, or it was cancelled meanwhile).
 */
export async function markCommandResultProcessingFailed(input: {
  commandId: string;
  deviceId: string;
  targetRole: string;
  /** What buildStoredCommandResult produced for this result. */
  storedResult: Record<string, unknown>;
  failedAt?: Date;
}): Promise<boolean> {
  const failedAt = input.failedAt ?? new Date();
  const agentError = input.storedResult.error;
  const rows = await db
    .update(deviceCommands)
    .set({
      status: 'failed',
      completedAt: failedAt,
      result: {
        ...input.storedResult,
        status: RESULT_PROCESSING_FAILED_RESULT_STATUS,
        agentStatus: input.storedResult.status ?? null,
        processingFailedAt: failedAt.toISOString(),
        processingError: RESULT_PROCESSING_FAILED_MESSAGE,
        // Never replace the agent's own failure reason; fill the field only
        // when the agent gave none, so a `failed` row is never reasonless.
        error: typeof agentError === 'string' && agentError.length > 0
          ? agentError
          : RESULT_PROCESSING_FAILED_MESSAGE,
      },
      // Same erasure as every other terminal writer. A resubmitted result for
      // this row is therefore exact-redacted against no command secrets — the
      // same limitation #3607's timeout reopen already has; the heuristic pass
      // still runs.
      ...terminalPayloadErasureSet(),
    })
    .where(
      and(
        eq(deviceCommands.id, input.commandId),
        eq(deviceCommands.deviceId, input.deviceId),
        eq(deviceCommands.targetRole, input.targetRole),
        commandAcceptsAgentResultCondition(),
      ),
    )
    .returning({ id: deviceCommands.id });
  return rows.length > 0;
}
