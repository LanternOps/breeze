import { and, eq, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceRestorePointAttempts } from '../db/schema/deviceRestorePointAttempts';
import { classifyRestorePointOutcome } from '../routes/agents/schemas';
import { RESTORE_POINT_SUPERSEDED_MESSAGE } from './restorePointRequest';
import { captureException, captureMessage } from './sentry';

/**
 * Terminalise the System Restore checkpoint ledger from an agent result
 * (#4609, W06 #4757).
 *
 * Called by both result transports (routes/agentWs.ts processCommandResult and
 * routes/agents/commands.ts) ONLY after the authoritative device_commands
 * terminal compare-and-set has won, and only when the result carried a
 * `restorePoint` key -- a result without one never reaches this function.
 *
 * Rules:
 *  - UPDATE, never INSERT. The `requested` row was written at command creation
 *    (W05); a missing row means the server never asked, and an agent claim
 *    must not conjure ledger history.
 *  - Compare-and-set on status = 'requested', guarded by (org_id, device_id)
 *    and, when the command is known, by the row's command link. A replayed or
 *    duplicate frame matches 0 rows and changes nothing.
 *  - Never throws, and runs in its own system context: the agent request path
 *    is org-scoped (REST) or already committed (WS), and a ledger failure must
 *    never fail a command whose real work already completed.
 *
 * The ledger records requests and observations, never a promise that a
 * checkpoint exists or can be restored.
 */

export type RestorePointIngestResult =
  | { outcome: 'terminalised' }
  | { outcome: 'invalid'; reason: 'unknown_status' | 'malformed' }
  | {
      outcome: 'discarded';
      reason: 'no_requested_row' | 'already_terminal' | 'superseded' | 'tenant_mismatch' | 'command_mismatch';
    }
  | { outcome: 'failed' };

export interface RestorePointIngestContext {
  orgId: string;
  deviceId: string;
  /** The device_commands row the result terminalised; null when none is known. */
  deviceCommandId?: string | null;
}

const LOG_PREFIX = '[restorePointIngest]';

// Bounds for an agent-clock timestamp. Date.parse accepts years Postgres
// rejects (year 0, +275760), and a rejected write would lose the whole
// terminalisation over a cosmetic field.
const MIN_AGENT_TIMESTAMP_MS = Date.UTC(1970, 0, 1);
const MAX_AGENT_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

/** Agent clock, parsed defensively: unparseable or out of range -> null, never a throw. */
function parseAgentTimestamp(value: string): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= MIN_AGENT_TIMESTAMP_MS && ms <= MAX_AGENT_TIMESTAMP_MS
    ? new Date(ms)
    : null;
}

export async function ingestRestorePointOutcome(
  raw: unknown,
  ctx: RestorePointIngestContext,
): Promise<RestorePointIngestResult> {
  const classified = classifyRestorePointOutcome(raw);
  if (!classified.ok) {
    // requestId only if it is a plain short string; never the agent's message.
    const rawRequestId = raw && typeof raw === 'object' ? (raw as { requestId?: unknown }).requestId : undefined;
    console.warn(`${LOG_PREFIX} ignoring invalid restorePoint outcome`, {
      reason: classified.reason,
      requestId: typeof rawRequestId === 'string' ? rawRequestId.slice(0, 64) : undefined,
      deviceId: ctx.deviceId,
      deviceCommandId: ctx.deviceCommandId ?? null,
    });
    if (classified.reason === 'unknown_status') {
      // Agent/API version skew: the row stays `requested` until the API learns
      // the status, so make it alertable rather than a console line.
      captureMessage('restore-point outcome with an unknown status', {
        eventCode: 'restore_point_outcome_unknown_status',
      });
    }
    return { outcome: 'invalid', reason: classified.reason };
  }

  const outcome = classified.outcome;
  const commandId = ctx.deviceCommandId ?? null;
  const logFields = {
    requestId: outcome.requestId,
    deviceId: ctx.deviceId,
    deviceCommandId: commandId,
    status: outcome.status,
  };

  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async (): Promise<RestorePointIngestResult> => {
        const updated = await db
          .update(deviceRestorePointAttempts)
          .set({
            status: outcome.status,
            sequenceNumber: outcome.sequenceNumber !== undefined ? BigInt(outcome.sequenceNumber) : null,
            description: outcome.description ?? null,
            message: outcome.message ?? null,
            acceptedExistingPoint: outcome.status === 'existing_accepted',
            existingPointAgeMinutes: outcome.existingPointAgeMinutes ?? null,
            frequencyMinutes: outcome.frequencyMinutes ?? null,
            durationMs: outcome.durationMs,
            attemptedAt: parseAgentTimestamp(outcome.attemptedAt),
            receivedAt: new Date(),
            ...(commandId ? { deviceCommandId: commandId } : {}),
          })
          .where(and(
            eq(deviceRestorePointAttempts.requestId, outcome.requestId),
            eq(deviceRestorePointAttempts.orgId, ctx.orgId),
            eq(deviceRestorePointAttempts.deviceId, ctx.deviceId),
            // Only a non-terminal row is claimable: a replay is a no-op.
            eq(deviceRestorePointAttempts.status, 'requested'),
            // A row already bound to a different command is not this result's.
            ...(commandId
              ? [or(isNull(deviceRestorePointAttempts.deviceCommandId), eq(deviceRestorePointAttempts.deviceCommandId, commandId))]
              : []),
          ))
          .returning({ id: deviceRestorePointAttempts.id });

        if (updated.length > 0) return { outcome: 'terminalised' };

        // 0 rows: one read (system scope, by the unique request id) to say why.
        const [existing] = await db
          .select({
            orgId: deviceRestorePointAttempts.orgId,
            deviceId: deviceRestorePointAttempts.deviceId,
            status: deviceRestorePointAttempts.status,
            message: deviceRestorePointAttempts.message,
            deviceCommandId: deviceRestorePointAttempts.deviceCommandId,
          })
          .from(deviceRestorePointAttempts)
          .where(eq(deviceRestorePointAttempts.requestId, outcome.requestId))
          .limit(1);

        if (!existing) {
          // Expected for an enabled:false patch block (W05 writes no row), whose
          // agent outcome is skipped_disabled. Anything else is a request this
          // server has no record of.
          if (outcome.status === 'skipped_disabled') {
            console.info(`${LOG_PREFIX} no ledger row for a skipped_disabled outcome (expected for enabled:false)`, {
              ...logFields, reason: 'no_requested_row',
            });
          } else {
            console.warn(`${LOG_PREFIX} discarded outcome`, { ...logFields, reason: 'no_requested_row' });
            // An outcome for a request the ledger never recorded: a forged id,
            // or a creation site that stamped without writing its row.
            captureMessage('restore-point outcome for an unrecorded request', {
              eventCode: 'restore_point_outcome_unrequested',
            });
          }
          return { outcome: 'discarded', reason: 'no_requested_row' };
        }

        if (existing.orgId !== ctx.orgId || existing.deviceId !== ctx.deviceId) {
          // A device echoed another device's request id. Never log the owner.
          console.warn(`${LOG_PREFIX} discarded outcome`, { ...logFields, reason: 'tenant_mismatch' });
          captureException(new Error(`${LOG_PREFIX} restore-point outcome for a request owned by another device`), undefined, {
            restore_point_ingest: 'tenant_mismatch',
          });
          return { outcome: 'discarded', reason: 'tenant_mismatch' };
        }

        let reason: 'already_terminal' | 'superseded' | 'command_mismatch';
        if (existing.status === 'requested') reason = 'command_mismatch';
        else if (existing.status === 'failed' && existing.message === RESTORE_POINT_SUPERSEDED_MESSAGE) reason = 'superseded';
        else reason = 'already_terminal';
        console.warn(`${LOG_PREFIX} discarded outcome`, { ...logFields, reason, ledgerStatus: existing.status });
        return { outcome: 'discarded', reason };
      }),
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} ledger write failed; the command result is unaffected`, { ...logFields, err });
    captureException(err, undefined, {
      restore_point_ingest: 'write_failed',
    });
    return { outcome: 'failed' };
  }
}
