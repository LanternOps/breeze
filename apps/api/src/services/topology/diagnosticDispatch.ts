import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  topologyProbeTargets,
  topologySiteState,
} from '../../db/schema';
import {
  registerCommandRevalidation,
  type CommandRevalidationRow,
  type ClaimCancelReason,
  type RevalidationHoldReason,
} from '../commandClaimEligibility';
// TYPE-ONLY on purpose: `commandQueue.ts` imports `commandDispatch.ts`, which
// side-effect-imports this module, so a runtime edge back to `commandQueue.ts`
// would be an import cycle. The runtime insert comes from the
// `commandQueueInsert.ts` leaf instead.
import type { CommandPayload } from '../commandQueue';
import { insertQueuedCommandInTransaction } from '../commandQueueInsert';
import { CommandTypes } from '../commandTypes';
import { getPermissionAuthorityVersion } from '../permissions';
import {
  revalidateTopologyRequesterAuthority,
  runRequiresRequesterRevalidation,
  topologyRequesterAuthoritySchema,
} from './diagnosticTraceAuthority';
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
  | { allow: false; reason: ClaimCancelReason; hold?: never }
  /** Neither delivered nor cancelled: the requester's version was not prepared (#11358). */
  | { allow: false; hold: RevalidationHoldReason; reason?: never };

type Reader = Pick<typeof db, 'select'>;

/** Requester user id → permission-authority version (`null`: unavailable), resolved before the claim locked rows. */
export type TopologyRequesterPermissionVersions = ReadonlyMap<string, string | null>;

/**
 * Where the requester's permission version comes from (#11358). A claim passes
 * the map its prepare half resolved, because it holds `device_commands` row
 * locks and must not wait on Redis. `'live'` reads Redis, and only a caller
 * outside a claim may pass it. Required, so an in-lock caller cannot fall back
 * to a live read by leaving it out.
 */
export type TopologyRequesterPermissionSource = TopologyRequesterPermissionVersions | 'live';

function deny(reason: ClaimCancelReason): TopologyCommandAuthorityDecision {
  return { allow: false, reason };
}

/**
 * A `permissionVersion` lookup that answers only from `versions` and never
 * reads Redis. A requester missing from the map resolves to `null` (so the
 * revalidation denies at that step) and is recorded in `missed`; the caller
 * turns that denial into a hold.
 */
function preparedPermissionVersionLookup(versions: TopologyRequesterPermissionVersions) {
  const missed = new Set<string>();
  const lookup = async (userId: string): Promise<string | null> => {
    if (versions.has(userId)) return versions.get(userId) ?? null;
    missed.add(userId);
    return null;
  };
  return { lookup, missed };
}

/**
 * Read-only delivery authority for one diagnostic command (M1 Task 15). Task 18
 * extends this with run-state transitions; nothing here writes.
 *
 * Fails closed: an unknown run, a malformed payload, a moved device, a rotated
 * producer epoch or a changed site configuration all deny delivery.
 *
 * `permissionVersions` (#11358): the delivery claim runs this while it holds
 * `device_commands` row locks. It therefore passes the map from
 * {@link resolveTopologyRequesterPermissionVersions}, which runs before the
 * lock, and Redis is never read here. A requester missing from the map answers
 * `{ hold: 'revalidation_unprepared' }`, and the claim leaves the row pending
 * for the next claim. A requester is missing when the preparation did not
 * cover the row: the row arrived after the read, fell past the prepare row
 * limit, or the type's preparer failed.
 */
export async function validateTopologyCommandAuthority(
  command: CommandRevalidationRow,
  rawPayload: unknown,
  options: { now?: Date; reader?: Reader; permissionVersions: TopologyRequesterPermissionSource },
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

  // M3-D7: fence on what THIS plan executes, not on any settings revision —
  // an unrelated settings write must not strand every in-flight diagnostic.
  // The plan's `settingsRevision` stays as provenance.
  const [state] = await reader
    .select({ effectiveSettings: topologySiteState.effectiveSettings })
    .from(topologySiteState)
    .where(
      and(
        eq(topologySiteState.orgId, run.orgId),
        eq(topologySiteState.siteId, run.siteId),
      ),
    )
    .limit(1);
  if (!state) return deny('scope_changed');
  if (!(await planConfigurationCurrent(reader, run, payload.plan, state.effectiveSettings))) {
    return deny('scope_changed');
  }

  // M3-D13: the REQUESTER's live authority, not only the origin's — for a
  // routed trace and for a scheduled policy occurrence (whose requester is the
  // arming actor, and whose policy must still be armed at the same revision).
  // Partner trust is already evaluated by the generic claim.
  if (runRequiresRequesterRevalidation(run)) {
    // The check order is unchanged: a malformed or changed requester still
    // denies before any version is needed.
    const prepared = options.permissionVersions === 'live' ? null : preparedPermissionVersionLookup(options.permissionVersions);
    const denial = await revalidateTopologyRequesterAuthority({
      reader,
      run,
      ...(prepared && { permissionVersion: prepared.lookup }),
    });
    if (prepared && prepared.missed.size > 0) return { allow: false, hold: 'revalidation_unprepared' };
    if (denial) return deny(denial === 'authority_unavailable' ? 'authority_unavailable' : 'scope_changed');
  }

  return { allow: true, payload };
}

/**
 * Delivery's lock-free half (#11358). Returns the current permission version
 * of every requester whose frozen authority one of these diagnostics checks at
 * delivery. It is read BEFORE the claim locks any `device_commands` row; it is
 * registered as the revalidation's prepare half. The in-lock half then compares
 * against this map and never waits on Redis.
 *
 * This is the read the in-lock check used to make, moved earlier. Redis is not
 * transactional with Postgres, so no read fences a version bump that lands
 * after it. The unfenced window now starts at this pre-lock read rather than
 * at the in-lock check. Result publication re-checks the version live.
 *
 * A `null` value (Redis unavailable) is kept, and the in-lock half denies on
 * it (`authority_unavailable`), as it did when it read live. Runs are read by
 * id only. The in-lock half re-reads each run with its full fence, and a
 * version resolved here for a run it then refuses goes unused.
 */
export async function resolveTopologyRequesterPermissionVersions(
  reader: Reader,
  payloads: ReadonlyArray<unknown>,
): Promise<TopologyRequesterPermissionVersions> {
  const runIds = new Set<string>();
  for (const payload of payloads) {
    const parsed = topologyDiagnosticCommandSchema.safeParse(payload);
    if (parsed.success) runIds.add(parsed.data.runId);
  }
  if (runIds.size === 0) return new Map();
  const runs = await reader
    .select({
      recipeId: topologyDiagnosticRuns.recipeId,
      policyId: topologyDiagnosticRuns.policyId,
      requesterAuthority: topologyDiagnosticRuns.requesterAuthority,
    })
    .from(topologyDiagnosticRuns)
    .where(inArray(topologyDiagnosticRuns.id, [...runIds]));
  const userIds = new Set<string>();
  for (const run of runs) {
    if (!runRequiresRequesterRevalidation(run)) continue;
    // An authority that does not parse is denied in-lock before any version is needed.
    const frozen = topologyRequesterAuthoritySchema.safeParse(run.requesterAuthority);
    if (frozen.success) userIds.add(frozen.data.userId);
  }
  return new Map(await Promise.all(
    [...userIds].map(async (userId) => [userId, await getPermissionAuthorityVersion(userId)] as const),
  ));
}

/**
 * Every configured target the plan pins must still be the same live,
 * enabled revision, and outbound probing must not have been withdrawn from
 * the compiled configuration. Observed gateway/resolver destinations carry
 * their own origin/evidence fences above.
 */
export async function planConfigurationCurrent(
  reader: Reader,
  run: { orgId: string; siteId: string },
  plan: TopologyDiagnosticPlan,
  effectiveSettings: unknown,
): Promise<boolean> {
  const pinned = plan.destinations.flatMap((destination) =>
    destination.target.kind === 'configured_target'
      ? [{ id: destination.target.targetId, revision: destination.target.targetRevision }]
      : []);
  if (!pinned.length) return true;
  const configuration = (effectiveSettings as { configuration?: { outboundEnabled?: unknown } } | null)?.configuration;
  if (configuration !== undefined && configuration.outboundEnabled !== true) return false;
  const rows = await reader
    .select({ id: topologyProbeTargets.id, revision: topologyProbeTargets.revision, enabled: topologyProbeTargets.enabled, deletedAt: topologyProbeTargets.deletedAt })
    .from(topologyProbeTargets)
    .where(and(
      eq(topologyProbeTargets.orgId, run.orgId),
      eq(topologyProbeTargets.siteId, run.siteId),
      inArray(topologyProbeTargets.id, pinned.map((target) => target.id)),
    ));
  const live = new Map(rows.map((row) => [row.id, row]));
  return pinned.every((target) => {
    const row = live.get(target.id);
    return !!row && row.enabled && row.deletedAt === null && row.revision.toString() === target.revision;
  });
}

const NO_VERSIONS: TopologyRequesterPermissionVersions = new Map();

/**
 * Two halves (#11358). The prepare half resolves the requesters' permission
 * versions from Redis before the claim locks any `device_commands` row. The
 * in-lock half compares against them. If a diagnostic needs a requester version
 * that was not prepared (no preparation at all, or that requester missing), it
 * is held for the next claim. A diagnostic that needs no requester version
 * never waits on the preparation.
 */
registerCommandRevalidation(
  CommandTypes.NETWORK_DIAGNOSTIC,
  async (tx, row, versions: TopologyRequesterPermissionVersions | undefined) => {
    const decision = await validateTopologyCommandAuthority(row, row.payload, {
      reader: tx,
      permissionVersions: versions ?? NO_VERSIONS,
    });
    if (decision.allow) return null;
    return decision.hold !== undefined ? { hold: decision.hold } : decision.reason;
  },
  (reader, rows) => resolveTopologyRequesterPermissionVersions(reader, rows.map((row) => row.payload)),
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
  state: 'cancelled' | 'expired' | 'completed',
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
      // An accepted plan with no steps (`target_not_configured`, `outbound_disabled`,
      // `gateway_not_observed`, …) has nothing for an agent to execute. Minting a
      // command for it would put a payload on the wire that can only sit until its
      // deadline, so the run settles here and never reaches a device.
      if (run.plan.steps.length === 0) {
        await settleRun(run, 'completed', run.plan.reasons[0] ?? 'plan_not_executable', now);
        await setIntentState(runId, 'settled');
        return null;
      }
      if (run.queueDeadline.getTime() <= now.getTime()) {
        await settleRun(run, 'expired', 'dispatch_timeout', now);
        await setIntentState(runId, 'settled');
        return null;
      }
      // M3-D13: enqueue is a live-authority boundary. A revoked requester (or
      // a disarmed policy) never gets a command minted on its behalf.
      if (runRequiresRequesterRevalidation(run)) {
        const denial = await revalidateTopologyRequesterAuthority({ reader: db, run, checkTrust: true, requirePartnerFlags: true });
        if (denial) {
          await settleRun(run, 'cancelled', `authority_${denial}`.slice(0, 64), now);
          await setIntentState(runId, 'settled');
          return null;
        }
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

