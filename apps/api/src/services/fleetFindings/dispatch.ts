/**
 * Remediation dispatch for fleet hygiene findings.
 *
 * `createRemediationRun` is called on the request path (ambient RLS context)
 * and re-validates every requested device NOW, under the caller's current
 * auth — membership can drift between "finding was fetched" and "remediate
 * was clicked" (site grants change, a device gets decommissioned, etc.), so
 * this never trusts a client-supplied device list at face value.
 *
 * `dispatchRunChunk` and `pollRunProgress` are plain functions invoked by the
 * BullMQ worker in `jobs/fleetRemediationDispatch.ts`, which wraps each call
 * in `runOutsideDbContext(() => withSystemDbAccessContext(...))` — mirroring
 * `jobs/fleetFindings.ts`'s `processOrg`. These two functions do not manage
 * DB context themselves so they stay testable as plain functions and so the
 * context-wrapping stays centralized in one place (the worker).
 *
 * commandType mapping:
 *   - 'restart_service' -> CommandTypes.RESTART_SERVICE ('restart_service')
 *   - 'reboot'          -> literal 'reboot'. There is no CommandTypes constant
 *                          for reboot; the literal is the existing precedent
 *                          (devices/schemas.ts, commandQueue.ts's own
 *                          AUTO_AUDIT_COMMAND_TYPES list both spell it out).
 *   - 'clear_temp_files' EXCLUDED: the real disk-cleanup primitive
 *     (aiToolsFilesystem.ts's disk_cleanup tool) requires an existing
 *     filesystem snapshot + a caller-selected set of paths, dispatched as N
 *     `file_delete` commands — it has no single fire-and-forget command
 *     shape compatible with this dispatcher's one-command-per-target model.
 *   - 'script' actionKind (not a commandType) -> CommandTypes.SCRIPT ('script'),
 *     requires `scriptId`; payload built from the resolved script row,
 *     mirroring aiToolsScripts.ts's `run_script` tool.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../../db';
import { devices, scripts } from '../../db/schema';
import { deviceCommands } from '../../db/schema/devices';
import {
  fleetFindingDevices,
  fleetRemediationRunTargets,
  fleetRemediationRuns,
  type FleetRunStatus,
  type FleetTargetStatus,
} from '../../db/schema/fleetFindings';
import type { AuthContext } from '../../middleware/auth';
import { CommandTypes, queueCommandForExecution } from '../commandQueue';
import { captureException } from '../sentry';
import { getFleetFinding } from './query';

/** Real commandType values a caller may request under `actionKind: 'command'`. */
export const REMEDIATION_COMMAND_TYPE_ALLOWLIST = ['restart_service', 'reboot'] as const;
export type RemediationCommandType = (typeof REMEDIATION_COMMAND_TYPE_ALLOWLIST)[number];

interface RemediateRequestBase {
  parameters: Record<string, unknown>;
  /** Subset of finding membership; absent = all current members. */
  deviceIds?: string[];
}

/**
 * Discriminated on `actionKind` so the required companion field is part of the
 * TYPE, not a runtime branch: `scriptId` exists exactly when the action is a
 * script, `commandType` exactly when it is a command. The previous
 * `scriptId?/commandType?`-both-optional shape made every legal request
 * representable alongside four illegal ones (neither field; both fields; the
 * wrong field for the kind), which is why the service carried a hand-rolled
 * validation branch and four non-null assertions to re-derive what the type
 * should have guaranteed. The route's `z.discriminatedUnion` is the runtime
 * half of the same contract.
 */
export type RemediateRequest =
  | (RemediateRequestBase & { actionKind: 'script'; scriptId: string })
  | (RemediateRequestBase & { actionKind: 'command'; commandType: RemediationCommandType });

export type RemediationSkipReason = 'site_denied' | 'not_member' | 'decommissioned';

export interface RemediationSkippedTarget {
  deviceId: string;
  reason: RemediationSkipReason;
}

export interface CreateRemediationRunResult {
  runId: string;
  targetCount: number;
  skipped: RemediationSkippedTarget[];
  /** Extra beyond the documented shape — lets the route audit-log without a redundant re-fetch. */
  orgId: string;
}

const COMMAND_TYPE_DISPATCH_MAP: Record<RemediationCommandType, string> = {
  restart_service: CommandTypes.RESTART_SERVICE,
  reboot: 'reboot',
};

export const REMEDIATION_CHUNK_SIZE = 500;
export const REMEDIATION_TIMEOUT_MS = 30 * 60 * 1000;
export const REMEDIATION_RESULT_SUMMARY_MAX = 2000;

export class RemediationRequestError extends Error {
  constructor(message: string, public status: 400 | 403 = 400) {
    super(message);
    this.name = 'RemediationRequestError';
  }
}

export function isTerminalRunStatus(status: FleetRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'cancelled';
}

function truncateSummary(value: string): string {
  return value.length > REMEDIATION_RESULT_SUMMARY_MAX ? value.slice(0, REMEDIATION_RESULT_SUMMARY_MAX) : value;
}

interface DeviceCandidate {
  id: string;
  orgId: string;
  siteId: string;
  hostname: string;
  status: string;
  isEphemeral: boolean;
}

/**
 * Re-validates every requested device NOW, under `auth`, and inserts one
 * `fleet_remediation_run_targets` row per candidate — valid ones as
 * `pending` (ready for the dispatch worker), invalid ones as `skipped` with
 * a `skipReason` — never silently dropped. `targetCount` on the run and in
 * the return value counts ALL candidate rows (valid + skipped), matching the
 * counts invariant `pollRunProgress` maintains: `targetCount =
 * succeededCount + failedCount + skippedCount` (+ still in flight).
 *
 * Request shape is enforced by the `RemediateRequest` discriminated union and,
 * at the HTTP boundary, by the route's `z.discriminatedUnion` — this function
 * carries no hand-rolled re-validation of `scriptId`/`commandType` presence.
 */
export async function createRemediationRun(
  auth: AuthContext,
  findingId: string,
  req: RemediateRequest
): Promise<CreateRemediationRunResult> {
  // Fails closed exactly like GET /:id: null means not found, inaccessible
  // org, OR (site-restricted caller) zero in-scope members.
  const finding = await getFleetFinding(auth, findingId);
  if (!finding) {
    throw new RemediationRequestError('Finding not found or access denied', 403);
  }

  const scriptCheck = req.actionKind === 'script' ? await validateRemediationScript(req.scriptId, finding.orgId) : null;
  if (scriptCheck?.error) {
    throw new RemediationRequestError(scriptCheck.error, 400);
  }

  // Raw (unfiltered) membership — needed to distinguish "never a member"
  // (not_member) from "is a member but this caller's site grant excludes it"
  // (site_denied). getFleetFinding()'s `members` are already site-filtered,
  // which would collapse that distinction.
  const memberRows = await db
    .select({ deviceId: fleetFindingDevices.deviceId })
    .from(fleetFindingDevices)
    .where(eq(fleetFindingDevices.findingId, findingId));
  const memberIds = new Set(memberRows.map((r) => r.deviceId));

  // Dedupe: `(run_id, target_device_uuid)` is the target table's primary key,
  // so a caller-supplied `deviceIds` list with a repeated id would otherwise
  // insert two rows with the same key — the insert throws AFTER the run row
  // is already committed, leaving an orphaned run stuck in `queued` with no
  // targets and no dispatch/poll ever enqueued.
  //
  // Branch on `!== undefined`, not truthiness/length: an explicit `[]` means
  // "remediate zero devices", not "fall back to full membership". Collapsing
  // the two would let a caller who forgot to populate `deviceIds` silently
  // remediate every member of the finding instead of failing loudly (the
  // route's zod schema also rejects `[]` with `.min(1)`, but this function is
  // called directly in tests/other callers too, so the guard lives here as
  // well — defense in depth, not just at the HTTP boundary).
  const candidateIds = Array.from(new Set(req.deviceIds !== undefined ? req.deviceIds : Array.from(memberIds)));

  const deviceRows =
    candidateIds.length > 0
      ? ((await db
          .select({
            id: devices.id,
            orgId: devices.orgId,
            siteId: devices.siteId,
            hostname: devices.hostname,
            status: devices.status,
            isEphemeral: devices.isEphemeral,
          })
          .from(devices)
          .where(inArray(devices.id, candidateIds))) as DeviceCandidate[])
      : [];
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

  const skipped: RemediationSkippedTarget[] = [];
  const validTargets: DeviceCandidate[] = [];

  for (const deviceId of candidateIds) {
    if (!memberIds.has(deviceId)) {
      skipped.push({ deviceId, reason: 'not_member' });
      continue;
    }
    const device = deviceById.get(deviceId);
    // A membership row re-tenanted by the device-move trigger during its
    // pre-prune window can still reference a device whose CURRENT org has
    // moved out from under the finding. `auth.canAccessOrg` alone isn't
    // enough to catch this for a partner-scoped caller, whose accessible org
    // set spans every org under the partner — the device's new org can still
    // pass that check even though it's no longer the finding's org. Require
    // an exact match against the finding's own org.
    if (!device || device.orgId !== finding.orgId || !auth.canAccessOrg(device.orgId)) {
      skipped.push({ deviceId, reason: 'not_member' });
      continue;
    }
    if (auth.allowedSiteIds !== undefined && !auth.allowedSiteIds.includes(device.siteId)) {
      skipped.push({ deviceId, reason: 'site_denied' });
      continue;
    }
    if (device.status === 'decommissioned' || device.isEphemeral) {
      skipped.push({ deviceId, reason: 'decommissioned' });
      continue;
    }
    validTargets.push(device);
  }

  const targetCount = validTargets.length + skipped.length;
  const now = new Date();
  const status: FleetRunStatus = validTargets.length > 0 ? 'queued' : 'failed';

  const [run] = await db
    .insert(fleetRemediationRuns)
    .values({
      orgId: finding.orgId,
      findingId,
      findingRevision: finding.revision,
      actionKind: req.actionKind,
      scriptId: req.actionKind === 'script' ? req.scriptId : null,
      commandType: req.actionKind === 'command' ? req.commandType : null,
      parameterSnapshot: req.parameters ?? {},
      status,
      targetCount,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: skipped.length,
      createdBy: auth.user.id,
      completedAt: status === 'failed' ? now : null,
    })
    .returning();

  if (!run) {
    throw new RemediationRequestError('Failed to create remediation run', 400);
  }

  const targetRows = [
    ...validTargets.map((d) => ({
      runId: run.id,
      orgId: d.orgId,
      targetDeviceUuid: d.id,
      hostnameSnapshot: d.hostname,
      siteIdSnapshot: d.siteId,
      status: 'pending' as FleetTargetStatus,
    })),
    ...skipped.map((s) => {
      const d = deviceById.get(s.deviceId);
      return {
        runId: run.id,
        orgId: d?.orgId ?? finding.orgId,
        targetDeviceUuid: s.deviceId,
        hostnameSnapshot: d?.hostname ?? null,
        siteIdSnapshot: d?.siteId ?? null,
        status: 'skipped' as FleetTargetStatus,
        skipReason: s.reason,
        completedAt: now,
      };
    }),
  ];

  if (targetRows.length > 0) {
    await db.insert(fleetRemediationRunTargets).values(targetRows);
  }

  return { runId: run.id, targetCount, skipped, orgId: finding.orgId };
}

async function validateRemediationScript(
  scriptId: string,
  findingOrgId: string
): Promise<{ error?: string }> {
  const [script] = await db
    .select({ id: scripts.id, orgId: scripts.orgId })
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);

  if (!script) {
    return { error: 'Script not found' };
  }
  if (script.orgId !== null && script.orgId !== findingOrgId) {
    return { error: 'Script does not belong to an accessible organization' };
  }
  return {};
}

async function markTargetFailed(runId: string, deviceId: string, message: string): Promise<void> {
  await db
    .update(fleetRemediationRunTargets)
    .set({
      status: 'failed',
      resultSummary: truncateSummary(message),
      completedAt: new Date(),
    })
    .where(
      and(eq(fleetRemediationRunTargets.runId, runId), eq(fleetRemediationRunTargets.targetDeviceUuid, deviceId))
    );
}

/**
 * Fans out one BullMQ job's worth (<= REMEDIATION_CHUNK_SIZE) of `pending`
 * targets for `runId`, dispatching each via `queueCommandForExecution`. No
 * DB transaction wraps the loop — each target's outcome (queued/failed) is
 * committed independently as it resolves, so a mid-chunk crash leaves
 * already-dispatched targets correctly marked rather than rolled back.
 */
export async function dispatchRunChunk(runId: string, chunkIndex: number): Promise<void> {
  const [run] = await db.select().from(fleetRemediationRuns).where(eq(fleetRemediationRuns.id, runId)).limit(1);
  if (!run) {
    // Not reachable by design — the route enqueues these jobs only after the
    // run row is committed. Reaching it means the run was deleted (org
    // erasure/cascade) or the job outlived its run, and the chunk's targets
    // will never be dispatched by anything. Silence here is how that becomes
    // invisible.
    console.warn(`[fleetFindings] dispatchRunChunk: run ${runId} not found (chunk ${chunkIndex} dropped)`);
    return;
  }

  if (run.status === 'queued') {
    await db
      .update(fleetRemediationRuns)
      .set({ status: 'running', startedAt: run.startedAt ?? new Date() })
      .where(eq(fleetRemediationRuns.id, runId));
  }

  // Page over ALL of the run's targets (not just `pending` ones), ordered by
  // a stable key, then filter to `pending` in JS. Chunk boundaries must stay
  // fixed regardless of what other chunks have already done: if the WHERE
  // clause filtered to `status = 'pending'` directly, chunk 0 marking its
  // page `queued` would shrink the pending set out from under chunk 1's
  // `OFFSET 500`, silently skipping the next page of targets entirely. This
  // also makes the function idempotent under a BullMQ retry of the same
  // chunkIndex — already-`queued`/`failed` rows in the page are just skipped.
  const targets = await db
    .select()
    .from(fleetRemediationRunTargets)
    .where(eq(fleetRemediationRunTargets.runId, runId))
    .orderBy(fleetRemediationRunTargets.targetDeviceUuid)
    .limit(REMEDIATION_CHUNK_SIZE)
    .offset(chunkIndex * REMEDIATION_CHUNK_SIZE);

  const pendingTargets = targets.filter((t) => t.status === 'pending');
  if (pendingTargets.length === 0) return;

  // An unexpected throw inside the per-target loop is the same defect
  // repeated once per target; report it to Sentry once per chunk so a
  // 500-target run cannot produce 500 identical issues.
  let reportedUnexpected = false;

  let scriptPayload: { language: string; content: string; timeoutSeconds: number; runAs: string } | null = null;
  if (run.actionKind === 'script' && run.scriptId) {
    // Re-fetch under the SAME guards as validateRemediationScript at
    // creation time: non-deleted, and either org-less (system/universal
    // script) or belonging to the run's own org. Without this, a script
    // soft-deleted or moved to another org between run creation and
    // dispatch would still have its (now-stale) content read and executed
    // against every target device.
    const [script] = await db
      .select({
        orgId: scripts.orgId,
        language: scripts.language,
        content: scripts.content,
        timeoutSeconds: scripts.timeoutSeconds,
        runAs: scripts.runAs,
      })
      .from(scripts)
      .where(and(eq(scripts.id, run.scriptId), isNull(scripts.deletedAt)))
      .limit(1);
    scriptPayload = script && (script.orgId === null || script.orgId === run.orgId) ? script : null;
  }

  for (const target of pendingTargets) {
    // Claim the target atomically BEFORE dispatching: a plain SELECT-then-
    // UPDATE-after gives no protection against two concurrent workers
    // processing the same chunk (BullMQ stalled-job recovery re-running a
    // job it thinks died, or a crash mid-loop followed by a retry) — both
    // would observe the same `pending` row in their in-memory page and both
    // would call `queueCommandForExecution`, double-sending the command
    // (e.g. two reboots). The conditional UPDATE below only succeeds for
    // whichever caller gets there first; Postgres resolves the race at the
    // row level. A retry that finds the row already claimed (0 rows
    // returned) skips it — no re-dispatch, no error.
    const claimed = await db
      .update(fleetRemediationRunTargets)
      .set({ status: 'queued', queuedAt: new Date() })
      .where(
        and(
          eq(fleetRemediationRunTargets.runId, runId),
          eq(fleetRemediationRunTargets.targetDeviceUuid, target.targetDeviceUuid),
          eq(fleetRemediationRunTargets.status, 'pending')
        )
      )
      .returning({ targetDeviceUuid: fleetRemediationRunTargets.targetDeviceUuid });

    if (claimed.length === 0) {
      continue;
    }

    try {
      let type: string;
      let payload: Record<string, unknown>;

      if (run.actionKind === 'script') {
        if (!scriptPayload) {
          throw new Error('Script no longer available');
        }
        type = CommandTypes.SCRIPT;
        payload = {
          scriptId: run.scriptId,
          language: scriptPayload.language,
          content: scriptPayload.content,
          timeoutSeconds: scriptPayload.timeoutSeconds,
          runAs: scriptPayload.runAs,
          parameters: run.parameterSnapshot ?? {},
        };
      } else {
        const commandType = run.commandType as RemediationCommandType | null;
        const mapped = commandType ? COMMAND_TYPE_DISPATCH_MAP[commandType] : undefined;
        if (!mapped) {
          // Never fall back to the raw stored value. A run whose commandType
          // is not in the dispatch map is a row the allowlist should have made
          // impossible (a hand-written row, or an allowlist entry added
          // without a map entry); dispatching `run.commandType || ''` would
          // hand the agent an unknown — or empty — command type that dies
          // somewhere far from here, or worse, silently no-ops.
          throw new Error(`Unsupported command type: ${run.commandType ?? '(none)'}`);
        }
        type = mapped;
        payload = (run.parameterSnapshot ?? {}) as Record<string, unknown>;
      }

      const result = await queueCommandForExecution(target.targetDeviceUuid, type, payload, {
        userId: run.createdBy ?? undefined,
        expectedOrgId: target.orgId,
      });

      if (result.error || !result.command) {
        await markTargetFailed(runId, target.targetDeviceUuid, result.error ?? 'Failed to queue command');
        continue;
      }

      // The claim already flipped status/queuedAt; just attach the resulting
      // command id onto the now-`queued` row.
      await db
        .update(fleetRemediationRunTargets)
        .set({ deviceCommandId: result.command.id })
        .where(
          and(
            eq(fleetRemediationRunTargets.runId, runId),
            eq(fleetRemediationRunTargets.targetDeviceUuid, target.targetDeviceUuid)
          )
        );
    } catch (err) {
      // Everything the dispatcher EXPECTS to go wrong (a queue refusal, a
      // vanished script) is handled above by an explicit markTargetFailed.
      // Reaching this catch means an exception nobody planned for — a driver
      // error, a bug in the payload builder, an unsupported command type. The
      // target is still marked failed so the run terminates, but the target
      // row alone is not enough to notice a systemic failure across a whole
      // fleet run.
      console.error(
        `[fleetFindings] Unexpected error dispatching run ${runId} target ${target.targetDeviceUuid}:`,
        err
      );
      if (!reportedUnexpected) {
        reportedUnexpected = true;
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          service: 'fleetFindings.dispatchRunChunk',
          runId,
          chunkIndex: String(chunkIndex),
        });
      }
      await markTargetFailed(
        runId,
        target.targetDeviceUuid,
        err instanceof Error ? err.message : 'Failed to queue command'
      );
    }
  }
}

/**
 * Recomputes progress for one run: resolves `pending`/`queued` targets
 * against their linked `device_commands` row, times out anything that's
 * been in flight longer than REMEDIATION_TIMEOUT_MS, then recomputes the
 * run's counts + overall status. Called repeatedly (every 30s) by the
 * poll-run BullMQ job until the run reaches a terminal status.
 */
export async function pollRunProgress(runId: string): Promise<void> {
  const [run] = await db.select().from(fleetRemediationRuns).where(eq(fleetRemediationRuns.id, runId)).limit(1);
  if (!run) {
    // The poll scheduler outlived its run row (deleted run, org erasure). The
    // worker removes the scheduler on this same tick, so this is terminal for
    // the run — worth a line, because from the outside it is indistinguishable
    // from a healthy run that simply completed.
    console.warn(`[fleetFindings] pollRunProgress: run ${runId} not found — nothing to reconcile`);
    return;
  }

  const allTargets = await db
    .select()
    .from(fleetRemediationRunTargets)
    .where(eq(fleetRemediationRunTargets.runId, runId));

  const now = new Date();
  const inFlight = allTargets.filter((t) => t.status === 'pending' || t.status === 'queued');

  const commandIds = inFlight.map((t) => t.deviceCommandId).filter((id): id is string => !!id);
  const commandsById = new Map<string, { status: string; result: unknown }>();
  if (commandIds.length > 0) {
    const commandRows = await db
      .select({ id: deviceCommands.id, status: deviceCommands.status, result: deviceCommands.result })
      .from(deviceCommands)
      .where(inArray(deviceCommands.id, commandIds));
    for (const c of commandRows) commandsById.set(c.id, { status: c.status, result: c.result });
  }

  for (const target of inFlight) {
    const command = target.deviceCommandId ? commandsById.get(target.deviceCommandId) : undefined;

    // `cancelled` is terminal for a device_command too (device deleted, agent
    // deauthorized, an operator cancelling from the device page). Treating it
    // as unresolved left the target in flight until the 30-minute timeout
    // rewrote it as a bare "timeout" — losing the real reason, which the
    // command's own result text carries.
    if (command && (command.status === 'completed' || command.status === 'failed' || command.status === 'cancelled')) {
      const nextStatus: FleetTargetStatus = command.status === 'completed' ? 'succeeded' : 'failed';
      const resultSummary = truncateSummary(JSON.stringify(command.result ?? {}));
      await db
        .update(fleetRemediationRunTargets)
        .set({ status: nextStatus, resultSummary, completedAt: now })
        .where(
          and(
            eq(fleetRemediationRunTargets.runId, runId),
            eq(fleetRemediationRunTargets.targetDeviceUuid, target.targetDeviceUuid)
          )
        );
      target.status = nextStatus;
      continue;
    }

    const referenceTime = target.queuedAt ?? run.createdAt;
    if (now.getTime() - new Date(referenceTime).getTime() > REMEDIATION_TIMEOUT_MS) {
      await db
        .update(fleetRemediationRunTargets)
        .set({ status: 'failed', skipReason: 'timeout', completedAt: now })
        .where(
          and(
            eq(fleetRemediationRunTargets.runId, runId),
            eq(fleetRemediationRunTargets.targetDeviceUuid, target.targetDeviceUuid)
          )
        );
      target.status = 'failed';
    }
  }

  const succeededCount = allTargets.filter((t) => t.status === 'succeeded').length;
  const failedCount = allTargets.filter((t) => t.status === 'failed').length;
  const skippedCount = allTargets.filter((t) => t.status === 'skipped').length;
  const stillPending = run.targetCount - succeededCount - failedCount - skippedCount;

  let status: FleetRunStatus;
  if (stillPending > 0) {
    status = 'running';
  } else if (succeededCount > 0 && (failedCount > 0 || skippedCount > 0)) {
    status = 'partial';
  } else if (succeededCount > 0) {
    status = 'succeeded';
  } else {
    status = 'failed';
  }

  const nowTerminal = isTerminalRunStatus(status);

  await db
    .update(fleetRemediationRuns)
    .set({
      succeededCount,
      failedCount,
      skippedCount,
      status,
      completedAt: nowTerminal ? run.completedAt ?? now : run.completedAt ?? null,
    })
    .where(eq(fleetRemediationRuns.id, runId));
}

/** `skip_reason` (varchar(80)) stamped on a run's still-`pending` targets when `enqueueRemediationDispatch` itself fails. */
export const DISPATCH_ENQUEUE_FAILED_REASON = 'dispatch_enqueue_failed';

/**
 * Called by the route when `enqueueRemediationDispatch` throws (e.g. a Redis
 * outage) AFTER `createRemediationRun` already committed the run + its
 * `pending` targets. Without this, that run is stranded forever: `queued`/
 * `running` with no dispatch job ever enqueued and no poll job to notice.
 * Marks every still-`pending` target `skipped` (never dispatched) and
 * recomputes the run to a terminal `failed` state so it stops showing as
 * in-progress. `skipped` rather than `failed` because nothing was ever sent to
 * the device — note the converse does NOT hold: `failed` does not prove a
 * dispatch attempt happened, since `pollRunProgress` also writes `failed` for a
 * target that timed out waiting.
 */
export async function markRunDispatchFailed(
  runId: string,
  reason: string = DISPATCH_ENQUEUE_FAILED_REASON
): Promise<void> {
  const now = new Date();

  await db
    .update(fleetRemediationRunTargets)
    .set({ status: 'skipped', skipReason: reason, completedAt: now })
    .where(and(eq(fleetRemediationRunTargets.runId, runId), eq(fleetRemediationRunTargets.status, 'pending')));

  const allTargets = await db
    .select()
    .from(fleetRemediationRunTargets)
    .where(eq(fleetRemediationRunTargets.runId, runId));

  const succeededCount = allTargets.filter((t) => t.status === 'succeeded').length;
  const failedCount = allTargets.filter((t) => t.status === 'failed').length;
  const skippedCount = allTargets.filter((t) => t.status === 'skipped').length;

  await db
    .update(fleetRemediationRuns)
    .set({ status: 'failed', succeededCount, failedCount, skippedCount, completedAt: now })
    .where(eq(fleetRemediationRuns.id, runId));
}
