import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { executionStatusEnum, scriptExecutions } from '../db/schema/scripts';
import { deviceCommands, devices } from '../db/schema/devices';
import { users } from '../db/schema/users';
import { sendCommandToAgent } from '../routes/agentWs';
import { envInt } from '../utils/envInt';
import { applyAutomationActionTerminal } from './automationActionResults';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
import { CommandTypes, insertQueuedCommandInTransaction } from './commandQueue';
import { assertDeviceExecuteAllowed } from './partnerTrust.commands';
import {
  decryptCommandForDelivery,
  terminalPayloadErasureSet,
  toAgentCommandFrame,
} from './sensitiveCommandPayload';
import { captureException } from './sentry';

/**
 * #3525 — the script cancellation state machine.
 *
 * `script_executions.status` describes what happened to the PROCESS.
 * `script_executions.cancel_state` describes what happened to the CANCEL
 * REQUEST. They are orthogonal (spec OD8-C), and the honesty contract is:
 *
 *   a row becomes `cancelled` ONLY when the stop was proven.
 *
 * Everything else reverts `status` to `cancel_prev_status` — the value it held
 * when the cancel was requested — and records why in `cancel_state`. Reverting
 * (rather than inventing a terminal `cancel_failed`) is what keeps the row
 * inside `reapStaleScriptExecutions`' `pending|queued|running` predicate, so a
 * failed cancel never strands an execution and that reaper stays untouched.
 *
 * W02 landed closer 2 of 5 (the agent's `script_cancel` ack). W02b adds the
 * REQUEST side — `cancelScriptExecution`, `deliverCancelCommand` and
 * `cancelExecutionsForRun`. The remaining four closers land in W03.
 */

/** Default SIGTERM→SIGKILL grace handed to the agent, in seconds (spec OD2-B). */
export const DEFAULT_GRACE_SECONDS = 5;
/**
 * Upper bound on a caller-supplied grace. Every downstream deadline must exceed
 * this — notably the agent's helper IPC timeout.
 */
export const MAX_GRACE_SECONDS = 30;
/**
 * How long a delivered cancel may stay unresolved before the sweep gives up on
 * it and records `unconfirmed`. Measured from DELIVERY, not from the request:
 * an undelivered cancel is the generic command reaper's problem, not this one's.
 */
// envInt, not `Number(process.env.X ?? default)`: compose maps an unset
// variable as an EMPTY STRING, and `Number('')` is 0 — which would make the
// sweep give up on every cancel the instant it was delivered (#2823 guard).
export const CANCEL_GRACE_MS = envInt('CANCEL_GRACE_MS', 90_000);

/**
 * Run `fn` in a genuine system-scoped transaction of its own.
 *
 * Load-bearing for post-commit delivery, not only for scoping. `authMiddleware`
 * wraps the WHOLE request in one `withDbAccessContext` transaction, so a bare
 * `db.transaction(...)` inside a route handler is only a SAVEPOINT — releasing
 * it commits nothing, and the `device_commands` row would still be invisible to
 * the agent's ack lookup (which reads on a fresh snapshot, `agentWs.ts`). The
 * cancel therefore has to leave the request's context to commit for real before
 * anything is sent to the device.
 *
 * That is safe here precisely because this module is the AUTHORIZATION-FREE
 * core: every caller (route, AI tool, automation fan-out) applies its own org /
 * site / permission gate first, and `cancelExecutionsForRun` deliberately keys
 * on the run id alone so a partner-wide automation is not silently truncated to
 * the caller's own org. Never widen this into a visibility decision.
 *
 * Mirrors `automationActionResults.ts`' helper of the same name; duplicated
 * locally rather than exported so that module's private surface stays private.
 */
async function inDeliberateSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** Statuses from which a cancel may be requested. */
export const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

/**
 * Clamp a caller-supplied grace into 0..MAX_GRACE_SECONDS, defaulting anything
 * absent or non-numeric. Exported so the request path and the AI tool cannot
 * drift from the value the agent is actually promised.
 */
export function clampGraceSeconds(seconds?: number | null): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return DEFAULT_GRACE_SECONDS;
  return Math.min(MAX_GRACE_SECONDS, Math.max(0, Math.floor(seconds)));
}

type CancelResolution =
  | { cancelState: 'confirmed'; proven: true }
  | { cancelState: 'unconfirmed' | 'failed'; proven: false };

/**
 * Pull the agent's structured cancellation outcome out of a command result.
 *
 * `tools.NewSuccessResult` marshals its payload into `CommandResult.Result`, so
 * the HTTP transport delivers `{ status, result: { outcome } }`; a top-level
 * `outcome` is accepted too so the shape is not load-bearing on one transport.
 */
function readOutcome(result: Record<string, unknown> | null): string {
  if (!result) return '';
  const top = result.outcome;
  if (typeof top === 'string') return top;
  const nested = result.result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const inner = (nested as Record<string, unknown>).outcome;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

/**
 * Map an agent outcome onto the OD8-C state table.
 *
 * Only `terminated` is proof. In particular:
 *  - `not_found` is NOT confirmation. An agent that restarted has an empty
 *    running-process map, and on macOS/BSD there is no Pdeathsig, so an orphan
 *    may survive. Far more often it means "the script finished a moment ago and
 *    its result is in flight" — which must resolve to the REAL outcome.
 *  - a pre-#3525 agent replies `{cancelled: true}` with no outcome after a
 *    non-blocking signal, which is a request, not a receipt.
 *  - an agent too old to know the command answers "unknown command type".
 * All three are `unconfirmed`: degraded, but honest.
 */
export function resolveCancelAckOutcome(result: Record<string, unknown> | null): CancelResolution {
  switch (readOutcome(result)) {
    case 'terminated':
      return { cancelState: 'confirmed', proven: true };
    case 'kill_failed':
      return { cancelState: 'failed', proven: false };
    default:
      return { cancelState: 'unconfirmed', proven: false };
  }
}

/**
 * Closer 2 of 5. Applies the agent's `script_cancel` ack to the execution the
 * cancel command was issued for.
 *
 * No-ops when no `cancelling` execution matches: another closer (the original
 * script result, the cancel-command expiry, or the sweep) already resolved it,
 * and this one must not resurrect a decided row. Every write is compare-and-swap
 * guarded on `status = 'cancelling'` for the same reason.
 */
export async function applyScriptCancelAck(input: {
  cancelCommandId: string;
  result: Record<string, unknown> | null;
}): Promise<void> {
  const resolution = resolveCancelAckOutcome(input.result);

  // The ack arrives on the agent transport, which carries no tenant context.
  // runOutsideDbContext escapes any caller transaction so a slow close cannot
  // hold the transport's own work open.
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.transaction(async (tx) => {
      const [execution] = await tx
        .select({
          id: scriptExecutions.id,
          cancelPrevStatus: scriptExecutions.cancelPrevStatus,
        })
        .from(scriptExecutions)
        .where(and(
          eq(scriptExecutions.cancelCommandId, input.cancelCommandId),
          eq(scriptExecutions.status, 'cancelling'),
        ))
        .limit(1)
        .for('update');

      if (!execution) return;

      const guard = and(
        eq(scriptExecutions.id, execution.id),
        eq(scriptExecutions.status, 'cancelling'),
      );

      if (resolution.proven) {
        await tx.update(scriptExecutions).set({
          status: 'cancelled',
          cancelState: 'confirmed',
          completedAt: new Date(),
          errorMessage: 'Stopped on the device',
        }).where(guard);
        return;
      }

      // REVERT. A failed cancel request does not change what happened to the
      // process. `cancel_prev_status` is written alongside the cancel, so a NULL
      // here is a broken writer, not a race — report it rather than let the
      // safety net hide a bug that could be misreporting execution history
      // fleet-wide. `running` is the safe floor because it keeps the execution
      // inside the stale-execution reaper's predicate rather than stranding it
      // in `cancelling` forever, so the revert itself still goes ahead.
      if (execution.cancelPrevStatus === null) {
        const err = new Error(
          'script_executions.cancel_prev_status was NULL on a cancelling row; reverting to running',
        );
        console.error('[scriptCancellation]', err.message, {
          executionId: execution.id,
          cancelCommandId: input.cancelCommandId,
        });
        captureException(err, undefined, {
          executionId: execution.id,
          cancelCommandId: input.cancelCommandId,
        });
      }
      await tx.update(scriptExecutions).set({
        status: execution.cancelPrevStatus ?? 'running',
        cancelState: resolution.cancelState,
      }).where(guard);
    });
  }));
}

// ===========================================================================
// The request side (#3525 W02b)
// ===========================================================================

/**
 * One value of the `execution_status` enum. Deriving it from the Drizzle enum
 * rather than widening to `string` means a consumer that switches on it — W03's
 * closers are the obvious candidates — gets exhaustiveness checking, and a
 * renamed enum value fails to compile instead of silently never matching.
 */
export type ExecutionStatus = (typeof executionStatusEnum.enumValues)[number];

/** What a cancel request resolved to. Every caller maps this, nothing else. */
export type CancelOutcome =
  /** No such execution — a race with a delete, or a bad id. */
  | { kind: 'not_found' }
  /** Terminal with no cancellation history: there is nothing left to stop. */
  | { kind: 'already_terminal'; status: ExecutionStatus }
  /** A cancel is already in flight, or already resolved. Repeat calls are safe. */
  | { kind: 'idempotent'; status: ExecutionStatus }
  /** Server-side proof: the command was still queued and was retracted. */
  | { kind: 'retracted'; executionId: string; completedAt: Date }
  /** The command already finished; its real result is the closer, not us. */
  | { kind: 'recovered'; executionId: string; commandId: string }
  /** A `script_cancel` is queued; the CALLER must deliver it post-commit. */
  | {
      kind: 'cancelling';
      executionId: string;
      cancelCommandId: string;
      deviceId: string;
      /** True when an in-flight cancel was reused, so delivery already happened. */
      alreadyQueued: boolean;
    }
  /** No paired `script` command. Absence is not proof; fail closed. */
  | { kind: 'inconsistent' };

/**
 * Probe-and-degrade for `script_executions.cancelled_by`, mirroring
 * `resolveCommandCreatedBy` (`commandQueue.ts`) and `scriptDispatch.ts`'s copy.
 *
 * The AI-agent actor id is an `ai_agents` id, not a `users` id, so stamping it
 * verbatim would raise 23503 and turn an AI-issued cancel into a 500. The true
 * actor always survives in the audit log regardless of what lands here.
 */
async function resolveCancelledBy(actorId: string | null): Promise<string | null> {
  if (!actorId) return null;
  return inDeliberateSystemContext(async () => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    return row ? actorId : null;
  });
}

/**
 * Request a stop for one script execution.
 *
 * Authorization-free by design (see `inDeliberateSystemContext`): callers gate
 * first. This never terminalises an execution as `cancelled` unless the stop is
 * PROVEN server-side, which on this path means exactly one thing — the original
 * command was still `pending` and we atomically retracted it. Everything else
 * that could stop the process has to be proven by the device, and is closed by
 * `applyScriptCancelAck` or by W03's closers.
 *
 * A `cancelling` outcome leaves delivery to the caller, deliberately: the
 * command row is committed by then, so a fast ack cannot be routed as orphaned.
 */
export async function cancelScriptExecution(input: {
  executionId: string;
  actorId: string | null;
  actorLabel: string;
  graceSeconds?: number | null;
}): Promise<CancelOutcome> {
  const grace = clampGraceSeconds(input.graceSeconds);

  // Pre-read for the device id alone: both the trust gate and the users probe
  // need it, and neither may run inside the locking transaction below.
  const [preread] = await inDeliberateSystemContext(() =>
    db
      .select({ id: scriptExecutions.id, deviceId: scriptExecutions.deviceId })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, input.executionId))
      .limit(1),
  );
  if (!preread) return { kind: 'not_found' };

  // `script_cancel` is a LIFECYCLE command type, so this is a documented no-op
  // today (`partnerTrust.commands.ts`) — a probationed partner must still be
  // able to stop a runaway script on a customer endpoint. It is called anyway
  // so that removing `script_cancel` from that list cannot silently bypass
  // trust; `scriptCancellation.registration.test.ts` pins the classification.
  await assertDeviceExecuteAllowed(preread.deviceId, CommandTypes.SCRIPT_CANCEL, input.actorId);

  const cancelledBy = await resolveCancelledBy(input.actorId);

  const outcome = await inDeliberateSystemContext(() => db.transaction(async (tx): Promise<CancelOutcome> => {
    // (1) The execution and its paired command, both FOR UPDATE.
    const [execution] = await tx
      .select({
        id: scriptExecutions.id,
        deviceId: scriptExecutions.deviceId,
        status: scriptExecutions.status,
        cancelState: scriptExecutions.cancelState,
      })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, input.executionId))
      .limit(1)
      .for('update');
    if (!execution) return { kind: 'not_found' };

    // (2) Idempotency BEFORE the CAS: a second concurrent cancel gets 200,
    // not 409, and a row that already carries cancellation history is not a
    // fresh "you're too late" either.
    if (execution.status === 'cancelling') {
      return { kind: 'idempotent', status: execution.status };
    }
    if (!(CANCELLABLE_STATUSES as readonly string[]).includes(execution.status)) {
      return execution.cancelState
        ? { kind: 'idempotent', status: execution.status }
        : { kind: 'already_terminal', status: execution.status };
    }

    // The `type = 'script'` predicate is the fix for today's collision with an
    // unrelated pending command whose payload happens to carry the same
    // executionId.
    const [command] = await tx
      .select({ id: deviceCommands.id, status: deviceCommands.status })
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.deviceId, execution.deviceId),
        eq(deviceCommands.type, CommandTypes.SCRIPT),
        sql`${deviceCommands.payload}->>'executionId' = ${input.executionId}`,
      ))
      .limit(1)
      .for('update');

    // (3d) Absence is NOT proof that nothing ran. Fail closed rather than
    // stamping a confirmed cancel we cannot justify.
    if (!command) return { kind: 'inconsistent' };

    const now = new Date();
    const cancelMeta = {
      cancelRequestedAt: now,
      cancelledBy,
      cancelPrevStatus: execution.status,
    };

    // (3a) Nothing ever reached the device — retract atomically. This is the
    // only server-side proof of a stop that exists.
    if (command.status === 'pending') {
      await tx.update(deviceCommands).set({
        status: 'cancelled',
        completedAt: now,
        // `status: 'cancelled'`, NOT the server-timeout marker: the row was
        // never delivered, so claiming a timeout would be a false statement,
        // and `commandAcceptsAgentResultCondition` only ever reopens
        // `status='failed'` rows anyway (commandResultAcceptance.ts).
        result: { status: 'cancelled', cancelled: true, cancelledBy: input.actorLabel },
        ...terminalPayloadErasureSet(),
      }).where(and(
        eq(deviceCommands.id, command.id),
        eq(deviceCommands.status, 'pending'),
      ));

      await tx.update(scriptExecutions).set({
        ...cancelMeta,
        status: 'cancelled',
        cancelState: 'confirmed',
        completedAt: now,
        errorMessage: `Cancelled by ${input.actorLabel} before the device received it`,
      }).where(and(
        eq(scriptExecutions.id, execution.id),
        inArray(scriptExecutions.status, [...CANCELLABLE_STATUSES]),
      ));
      return { kind: 'retracted', executionId: execution.id, completedAt: now };
    }

    // (3b) Reachable: ingestion terminalises `device_commands` BEFORE calling
    // the script result handler. Record that a cancel was asked for, but leave
    // `status` to the real result — queueing a cancel here would be doomed.
    if (command.status === 'completed' || command.status === 'failed' || command.status === 'cancelled') {
      await tx.update(scriptExecutions).set({ ...cancelMeta, cancelState: 'unconfirmed' })
        .where(eq(scriptExecutions.id, execution.id));
      return { kind: 'recovered', executionId: execution.id, commandId: command.id };
    }

    // (3c) The delivered case. Dedup FIRST: the execution row records the id of
    // the cancel command that actually exists, so reusing an in-flight cancel
    // can never point `cancel_command_id` at a row that was never inserted.
    const [existing] = await tx
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(and(
        eq(deviceCommands.deviceId, execution.deviceId),
        eq(deviceCommands.type, CommandTypes.SCRIPT_CANCEL),
        inArray(deviceCommands.status, ['pending', 'sent']),
        sql`${deviceCommands.payload}->>'executionId' = ${command.id}`,
      ))
      .limit(1);

    const cancelCommandId = existing?.id ?? randomUUID();

    // Transient `cancelling`; `completedAt` stays NULL so no batch counter and
    // no automation action result closes on an unproven stop.
    await tx.update(scriptExecutions).set({
      ...cancelMeta,
      status: 'cancelling',
      cancelState: 'requested',
      cancelCommandId,
    }).where(and(
      eq(scriptExecutions.id, execution.id),
      inArray(scriptExecutions.status, [...CANCELLABLE_STATUSES]),
    ));

    if (!existing) {
      await insertQueuedCommandInTransaction(tx, {
        id: cancelCommandId,
        deviceId: execution.deviceId,
        type: CommandTypes.SCRIPT_CANCEL,
        payload: {
          // THE WIRE CONTRACT (#3525 blocker). The agent keys its running-process
          // map on the ORIGINAL command's id, not on script_executions.id.
          // Getting this wrong is a silent no-op on every agent in the fleet.
          executionId: command.id,
          scriptExecutionId: execution.id,
          graceSeconds: grace,
        },
        // NULL, never `''`: the column is a nullable uuid, and an empty string
        // is `22P02 invalid input syntax for type uuid` — which would roll the
        // whole cancel back and 500 exactly the synthetic-principal caller
        // `resolveCancelledBy`'s degrade exists to keep working.
        createdBy: cancelledBy,
      });
    }

    return {
      kind: 'cancelling',
      executionId: execution.id,
      cancelCommandId,
      deviceId: execution.deviceId,
      alreadyQueued: Boolean(existing),
    };
  }));

  // (4) Only a terminal branch may close the paired automation action, and only
  // AFTER commit.
  //
  // Not a deadlock argument — the helper's own `inDeliberateSystemContext`
  // would see the ambient scope this function already established as `system`
  // and run INLINE, joining the transaction above rather than opening its own.
  // That is exactly the problem: the automation action would be closed inside
  // an as-yet-uncommitted cancel, so any later failure would silently roll back
  // a terminal transition the reconciler had already published on. Closing it
  // only once the cancel is durable keeps the two in the right order.
  if (outcome.kind === 'retracted') {
    await applyAutomationActionTerminal({
      source: 'cancellation',
      scriptExecutionId: outcome.executionId,
      terminalStatus: 'cancelled',
      error: null,
      completedAt: outcome.completedAt,
    });
  }

  return outcome;
}

/**
 * Hand a committed `script_cancel` row to a connected agent.
 *
 * MUST be called only after `cancelScriptExecution`'s transaction has committed
 * (that is why it is a separate function rather than the tail of the branch
 * above). Returns whether the frame reached the socket; `false` is NOT an
 * error — the row stays `pending` and the heartbeat / HTTP-poll delivery path
 * picks it up, which is exactly what happens for an offline device.
 */
export async function deliverCancelCommand(
  cancelCommandId: string,
  deviceId: string,
): Promise<boolean> {
  const [row] = await inDeliberateSystemContext(() =>
    db
      .select({
        id: deviceCommands.id,
        type: deviceCommands.type,
        payload: deviceCommands.payload,
        agentId: devices.agentId,
      })
      .from(deviceCommands)
      .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
      .where(eq(deviceCommands.id, cancelCommandId))
      .limit(1),
  );
  if (!row?.agentId) return false;

  const claimed = await claimPendingCommandForDelivery(cancelCommandId);
  // Lost the claim: the heartbeat path already took this row, which IS delivery.
  if (!claimed) return false;

  const deliverable = decryptCommandForDelivery({
    id: row.id,
    type: row.type,
    deviceId,
    payload: row.payload,
  });
  const sent = deliverable ? sendCommandToAgent(row.agentId, toAgentCommandFrame(deliverable)) : false;
  if (sent) return true;

  // Release rather than strand as `sent`: otherwise the eventual reaper timeout
  // misattributes a server-side send failure to agent unreachability.
  await releaseClaimedCommandDelivery(cancelCommandId, claimed.executedAt);
  console.warn('[scriptCancellation] failed to deliver script_cancel to a connected agent', {
    cancelCommandId,
    deviceId,
    decryptFailed: !deliverable,
  });
  return false;
}

/**
 * Per-kind tally of a run-wide cancel sweep. Exactly one bucket per execution.
 *
 * The buckets are split the way an operator watching a run needs them, NOT the
 * way the `CancelOutcome` union is shaped: `alreadyCancelling` is deliberately
 * separate from `noActionNeeded` because an execution whose cancel is still in
 * flight has NOT stopped, and folding the two together would let a "cancel this
 * run" summary claim work is finished while a script is still running — the
 * same dishonesty the status/cancel_state split exists to prevent.
 */
export type RunCancelTally = {
  /** A `script_cancel` went out because of THIS call. Not yet stopped. */
  requested: number;
  /** Proven stopped: the command was retracted before the device saw it. */
  retracted: number;
  /** A cancel was ALREADY in flight. Still awaiting the device; not stopped. */
  alreadyCancelling: number;
  /** Nothing left to stop: already terminal, or the command already finished. */
  noActionNeeded: number;
  /** Refused: the execution vanished, has no paired command, or threw. */
  failed: number;
};

/**
 * Cancel every still-running execution of one automation run.
 *
 * Keyed on `automation_run_id` ALONE — never on the caller's org. A
 * partner-wide automation's executions carry the DEVICE's org, so an
 * `eq(orgId, auth.orgId)` filter here would silently no-op most of the run
 * (CLAUDE.md §Partner-Wide First rule 5). The caller owns authorization.
 */
export async function cancelExecutionsForRun(input: {
  runId: string;
  actorId: string | null;
  actorLabel: string;
  graceSeconds?: number | null;
}): Promise<RunCancelTally> {
  const rows = await inDeliberateSystemContext(() =>
    db
      .select({ id: scriptExecutions.id })
      .from(scriptExecutions)
      .where(and(
        eq(scriptExecutions.automationRunId, input.runId),
        inArray(scriptExecutions.status, [...CANCELLABLE_STATUSES]),
      )),
  );

  const tally: RunCancelTally = {
    requested: 0,
    retracted: 0,
    alreadyCancelling: 0,
    noActionNeeded: 0,
    failed: 0,
  };

  for (const row of rows) {
    // One execution's failure must not abandon the rest of the run. A
    // transient deadlock on execution 3 of 20 would otherwise leave 17 devices
    // never even asked to stop, and the caller would get a rejected promise
    // instead of the tally this function promises.
    let outcome: CancelOutcome;
    try {
      outcome = await cancelScriptExecution({
        executionId: row.id,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
        graceSeconds: input.graceSeconds,
      });
    } catch (err) {
      tally.failed += 1;
      console.error('[scriptCancellation] cancel threw during a run sweep', {
        runId: input.runId,
        executionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err, undefined, { runId: input.runId, executionId: row.id });
      continue;
    }

    switch (outcome.kind) {
      case 'cancelling':
        if (outcome.alreadyQueued) {
          tally.alreadyCancelling += 1;
          break;
        }
        tally.requested += 1;
        await deliverCancelCommand(outcome.cancelCommandId, outcome.deviceId);
        break;
      case 'retracted':
        tally.retracted += 1;
        break;
      case 'idempotent':
        // `cancelling` here means another request's cancel is still awaiting
        // the device. That is NOT "nothing left to stop".
        if (outcome.status === 'cancelling') tally.alreadyCancelling += 1;
        else tally.noActionNeeded += 1;
        break;
      // `recovered` belongs with the terminal cases: the command finished, so
      // there is nothing left to stop even though the row has not closed yet.
      case 'recovered':
      case 'already_terminal':
        tally.noActionNeeded += 1;
        break;
      case 'not_found':
      case 'inconsistent':
        tally.failed += 1;
        break;
      default: {
        // A new CancelOutcome variant must be classified deliberately, not
        // land in `failed` by accident. This fails the build instead.
        const unhandled: never = outcome;
        throw new Error(
          `unhandled CancelOutcome kind: ${(unhandled as CancelOutcome).kind}`,
        );
      }
    }
  }
  return tally;
}
