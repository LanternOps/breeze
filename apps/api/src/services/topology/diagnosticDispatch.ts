import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  topologyDiagnosticCommandSchema,
  type TopologyDiagnosticCommand,
  type TopologyDiagnosticPlan,
  type TopologyScope,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  devices,
  topologyChangeOutbox,
  topologyCollectionSources,
  topologyDiagnosticRuns,
  topologyNodeBindings,
  topologySiteState,
} from '../../db/schema';
import {
  registerCommandRevalidation,
  type CommandRevalidationRow,
  type ClaimCancelReason,
} from '../commandClaimEligibility';
// TYPE-ONLY on purpose: `commandQueue.ts` statically imports `routes/agentWs.ts`
// and this module sits in `commandDispatch.ts`'s import closure. The runtime
// insert comes from the `commandQueueInsert.ts` leaf instead.
import type { CommandPayload } from '../commandQueue';
import { insertQueuedCommandInTransaction } from '../commandQueueInsert';
import { CommandTypes } from '../commandTypes';
import {
  TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
  type TopologyDiagnosticIntent,
  type TopologyDiagnosticIntentState,
} from './diagnosticIntent';

/**
 * Why a queued `network_diagnostic` may no longer be delivered. The transport
 * is the authenticated boundary; the plan digest is an integrity seal, never
 * authorization on its own, so every one of these is re-derived from live rows
 * at the moment of delivery rather than read out of the payload.
 */
export type TopologyCommandAuthorityDecision =
  | { allow: true; payload: TopologyDiagnosticCommand }
  | { allow: false; reason: ClaimCancelReason };

type Reader = Pick<typeof db, 'select'>;

function deny(reason: ClaimCancelReason): TopologyCommandAuthorityDecision {
  return { allow: false, reason };
}

/**
 * Read-only delivery authority for one diagnostic command (M1 Task 15). Task 18
 * extends this with run-state transitions; nothing here writes.
 *
 * Fails closed: an unknown run, a malformed payload, a moved device, a rotated
 * producer epoch or a changed site configuration all deny delivery.
 */
export async function validateTopologyCommandAuthority(
  command: CommandRevalidationRow,
  rawPayload: unknown,
  options: { now?: Date; reader?: Reader } = {},
): Promise<TopologyCommandAuthorityDecision> {
  const now = options.now ?? new Date();
  const reader = options.reader ?? db;
  const parsed = topologyDiagnosticCommandSchema.safeParse(rawPayload);
  if (!parsed.success) return deny('scope_changed');
  const payload = parsed.data;
  if (payload.commandId !== command.id) return deny('scope_changed');
  if (now.getTime() >= Date.parse(payload.plan.deadline)) return deny('expired');

  const [run] = await reader
    .select()
    .from(topologyDiagnosticRuns)
    .where(eq(topologyDiagnosticRuns.id, payload.runId))
    .limit(1);
  // Persistence-as-future-execution is refused: a command with no live parent
  // run, or one the run no longer points at, is never delivered.
  if (
    !run ||
    run.commandId !== command.id ||
    run.attemptId !== payload.attemptId ||
    run.planDigest !== payload.planDigest ||
    !['queued', 'running'].includes(run.state) ||
    run.cancelRequestedAt !== null ||
    run.deadline.getTime() <= now.getTime()
  ) {
    return deny('scope_changed');
  }

  const origin = payload.plan.origin;
  if (origin.deviceId !== command.deviceId) return deny('scope_changed');

  const [device] = await reader
    .select({ orgId: devices.orgId, siteId: devices.siteId, agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, command.deviceId))
    .limit(1);
  if (
    !device ||
    device.orgId !== run.orgId ||
    device.siteId !== run.siteId ||
    device.siteId !== origin.siteId ||
    device.agentId !== origin.agentId ||
    run.siteId !== payload.plan.scope.siteId ||
    run.orgId !== payload.plan.scope.orgId
  ) {
    return deny('scope_changed');
  }

  const [binding] = await reader
    .select({ id: topologyNodeBindings.id })
    .from(topologyNodeBindings)
    .where(
      and(
        eq(topologyNodeBindings.orgId, run.orgId),
        eq(topologyNodeBindings.siteId, run.siteId),
        eq(topologyNodeBindings.nodeId, origin.nodeId),
        eq(topologyNodeBindings.deviceId, command.deviceId),
      ),
    )
    .limit(1);
  if (!binding || binding.id !== origin.bindingId) return deny('scope_changed');

  const [source] = await reader
    .select({
      producerEpoch: topologyCollectionSources.producerEpoch,
      revokedAt: topologyCollectionSources.revokedAt,
      orgId: topologyCollectionSources.orgId,
      siteId: topologyCollectionSources.siteId,
    })
    .from(topologyCollectionSources)
    .where(eq(topologyCollectionSources.id, origin.sourceId))
    .limit(1);
  if (
    !source ||
    source.revokedAt !== null ||
    source.producerEpoch !== origin.producerEpoch ||
    source.orgId !== run.orgId ||
    source.siteId !== run.siteId
  ) {
    return deny('scope_changed');
  }

  const [state] = await reader
    .select({ settingsRevision: topologySiteState.settingsRevision })
    .from(topologySiteState)
    .where(
      and(
        eq(topologySiteState.orgId, run.orgId),
        eq(topologySiteState.siteId, run.siteId),
      ),
    )
    .limit(1);
  if (!state || state.settingsRevision.toString() !== payload.plan.settingsRevision) {
    return deny('scope_changed');
  }

  return { allow: true, payload };
}

registerCommandRevalidation(
  CommandTypes.NETWORK_DIAGNOSTIC,
  async (tx, row) => {
    const decision = await validateTopologyCommandAuthority(row, row.payload, {
      reader: tx,
    });
    return decision.allow ? null : decision.reason;
  },
);

// ---------------------------------------------------------------------------
// Dispatch (M1 Task 18)
// ---------------------------------------------------------------------------

type RunRow = typeof topologyDiagnosticRuns.$inferSelect;

const TERMINAL_RUN_STATES = ['completed', 'failed', 'cancelled', 'expired'];

/**
 * Network delivery, injected rather than imported: the socket registry lives
 * under `routes/`, and this module sits in `commandDispatch.ts`'s import
 * closure. The dispatch worker supplies the real implementation.
 *
 * Returning `false` (or not supplying one at all) is not a failure — the
 * command row stays `pending` and the agent's next heartbeat claim delivers it
 * through the same revalidation.
 */
export type TopologyDiagnosticDelivery = (input: {
  deviceId: string;
  agentId: string;
  commandId: string;
  type: string;
  payload: CommandPayload;
}) => Promise<boolean>;

export type DispatchTopologyDiagnosticRunOptions = {
  deliver?: TopologyDiagnosticDelivery;
  now?: Date;
};

/** The exact four fields `handleTopologyDiagnosticCancel` accepts — no more. */
export function topologyDiagnosticCancelPayload(run: {
  id: string;
  attemptId: string;
  commandId: string;
}): { version: 1; runId: string; attemptId: string; commandId: string } {
  return { version: 1, runId: run.id, attemptId: run.attemptId, commandId: run.commandId };
}

function commandPayloadForRun(run: RunRow, commandId: string): TopologyDiagnosticCommand {
  const plan = run.plan as TopologyDiagnosticPlan;
  return topologyDiagnosticCommandSchema.parse({
    type: CommandTypes.NETWORK_DIAGNOSTIC,
    version: 1,
    runId: run.id,
    attemptId: run.attemptId,
    commandId,
    plan,
    planDigest: run.planDigest,
    expiresAt: plan.deadline,
  });
}

function readRun(scope: TopologyScope, runId: string) {
  return db
    .select()
    .from(topologyDiagnosticRuns)
    .where(
      and(
        eq(topologyDiagnosticRuns.id, runId),
        eq(topologyDiagnosticRuns.orgId, scope.orgId),
        eq(topologyDiagnosticRuns.siteId, scope.siteId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function settleRun(
  run: RunRow,
  state: 'cancelled' | 'expired',
  failureReason: string,
  now: Date,
): Promise<void> {
  await db
    .update(topologyDiagnosticRuns)
    .set({ state, failureReason, finishedAt: now, updatedAt: now })
    .where(
      and(eq(topologyDiagnosticRuns.id, run.id), eq(topologyDiagnosticRuns.state, run.state)),
    );
}

async function setIntentState(
  runId: string,
  next: TopologyDiagnosticIntentState,
  expected?: TopologyDiagnosticIntentState,
): Promise<void> {
  await db
    .update(topologyChangeOutbox)
    .set({
      payload: sql`jsonb_set(${topologyChangeOutbox.payload}, '{state}', ${JSON.stringify(next)}::jsonb)`,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(topologyChangeOutbox.aggregateId, runId),
        eq(topologyChangeOutbox.eventKind, TOPOLOGY_DIAGNOSTIC_INTENT_EVENT),
        ...(expected
          ? [sql`${topologyChangeOutbox.payload}->>'state' = ${expected}`]
          : []),
      ),
    );
}

/**
 * Bind at most one command to a run and hand it to the agent.
 *
 * The run row's `command_id` is the single binding authority — the database
 * trigger refuses to rebind a non-null one — so a worker that crashed after the
 * insert re-enters here, finds the binding it already made and retries only the
 * delivery. Two workers racing produce one command for the same reason.
 */
export async function dispatchTopologyDiagnosticRun(
  scope: TopologyScope,
  runId: string,
  options: DispatchTopologyDiagnosticRunOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();

  const prepared = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const run = await readRun(scope, runId);
      if (!run || TERMINAL_RUN_STATES.includes(run.state)) return null;

      if (run.deadline.getTime() <= now.getTime()) {
        await settleRun(run, 'expired', 'deadline_exceeded', now);
        await setIntentState(runId, 'settled');
        return null;
      }
      if (run.cancelRequestedAt !== null) {
        if (run.commandId === null) {
          await settleRun(run, 'cancelled', 'cancelled_before_dispatch', now);
          await setIntentState(runId, 'settled');
        }
        return null;
      }
      if (run.commandId !== null) {
        return { run, commandId: run.commandId, payload: commandPayloadForRun(run, run.commandId) };
      }
      if (run.queueDeadline.getTime() <= now.getTime()) {
        await settleRun(run, 'expired', 'dispatch_timeout', now);
        await setIntentState(runId, 'settled');
        return null;
      }

      const commandId = randomUUID();
      const payload = commandPayloadForRun(run, commandId);
      const bound = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(topologyDiagnosticRuns)
          .set({ commandId, updatedAt: now })
          .where(
            and(
              eq(topologyDiagnosticRuns.id, run.id),
              isNull(topologyDiagnosticRuns.commandId),
              isNull(topologyDiagnosticRuns.cancelRequestedAt),
              eq(topologyDiagnosticRuns.state, 'queued'),
            ),
          )
          .returning();
        if (!row) return null;
        await insertQueuedCommandInTransaction(tx, {
          id: commandId,
          deviceId: run.originSnapshot.deviceId,
          type: CommandTypes.NETWORK_DIAGNOSTIC,
          payload: payload as unknown as CommandPayload,
          createdBy: run.requesterId,
        });
        return row;
      });

      if (!bound) {
        // Another worker bound first; reuse its identity rather than minting one.
        const current = await readRun(scope, runId);
        return current?.commandId
          ? {
              run: current,
              commandId: current.commandId,
              payload: commandPayloadForRun(current, current.commandId),
            }
          : null;
      }
      await setIntentState(runId, 'dispatched', 'pending');
      return { run: bound, commandId, payload };
    }, 'topology diagnostic dispatch'),
  );

  if (!prepared || !options.deliver) return;
  await options.deliver({
    deviceId: prepared.run.originSnapshot.deviceId,
    agentId: prepared.run.originSnapshot.agentId,
    commandId: prepared.commandId,
    type: CommandTypes.NETWORK_DIAGNOSTIC,
    payload: prepared.payload as unknown as CommandPayload,
  });
}

/**
 * Best-effort agent stop for a run whose command is already queued or sent.
 * The authoritative cancellation is the run row plus delivery revalidation;
 * this only shortens the window in which the agent keeps probing.
 */
async function sendTopologyDiagnosticCancel(
  scope: TopologyScope,
  runId: string,
  options: DispatchTopologyDiagnosticRunOptions,
): Promise<void> {
  const prepared = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const run = await readRun(scope, runId);
      if (!run || run.commandId === null) return null;
      const payload = topologyDiagnosticCancelPayload({
        id: run.id,
        attemptId: run.attemptId,
        commandId: run.commandId,
      });
      const cancelCommandId = randomUUID();
      await db.transaction(async (tx) => {
        await insertQueuedCommandInTransaction(tx, {
          id: cancelCommandId,
          deviceId: run.originSnapshot.deviceId,
          type: CommandTypes.NETWORK_DIAGNOSTIC_CANCEL,
          payload: payload as unknown as CommandPayload,
          createdBy: run.requesterId,
        });
      });
      await setIntentState(runId, 'cancel_sent', 'cancelling');
      return { run, cancelCommandId, payload };
    }, 'topology diagnostic cancellation dispatch'),
  );

  if (!prepared || !options.deliver) return;
  await options.deliver({
    deviceId: prepared.run.originSnapshot.deviceId,
    agentId: prepared.run.originSnapshot.agentId,
    commandId: prepared.cancelCommandId,
    type: CommandTypes.NETWORK_DIAGNOSTIC_CANCEL,
    payload: prepared.payload as unknown as CommandPayload,
  });
}

/**
 * Drain accepted dispatch intents. The outbox row, not an in-memory timer or a
 * Redis acknowledgement, is the recovery authority: a process that dies between
 * acceptance and delivery is repaired on the next tick.
 */
export async function drainTopologyDiagnosticDispatch(
  options: DispatchTopologyDiagnosticRunOptions & { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Invalid diagnostic dispatch batch');
  }

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        db
          .select()
          .from(topologyChangeOutbox)
          .where(
            and(
              eq(topologyChangeOutbox.eventKind, TOPOLOGY_DIAGNOSTIC_INTENT_EVENT),
              sql`${topologyChangeOutbox.payload}->>'state' IN ('pending','cancelling')`,
              sql`(${topologyChangeOutbox.nextAttemptAt} IS NULL OR ${topologyChangeOutbox.nextAttemptAt} <= now())`,
            ),
          )
          .orderBy(asc(topologyChangeOutbox.createdAt), asc(topologyChangeOutbox.id))
          .limit(limit),
      'topology diagnostic intent discovery',
    ),
  );

  for (const row of rows) {
    const intent = row.payload as unknown as TopologyDiagnosticIntent;
    const scope = { orgId: row.orgId, siteId: row.siteId };
    try {
      if (intent.state === 'cancelling') await sendTopologyDiagnosticCancel(scope, intent.runId, options);
      else await dispatchTopologyDiagnosticRun(scope, intent.runId, options);
    } catch (error) {
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(
          () =>
            db
              .update(topologyChangeOutbox)
              .set({
                attemptCount: sql`${topologyChangeOutbox.attemptCount}+1`,
                lastAttemptAt: new Date(),
                nextAttemptAt: new Date(Date.now() + 2_000),
                lastError: 'diagnostic_dispatch_retry_pending',
              })
              .where(eq(topologyChangeOutbox.id, row.id)),
          'topology diagnostic dispatch retry',
        ),
      );
      throw error;
    }
  }
  return rows.length;
}

