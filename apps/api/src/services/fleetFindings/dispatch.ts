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
 *     mirroring aiToolsScripts.ts's `run_script` tool. RESTRICTED to scripts
 *     whose parameters are all `runtime`-sourced — see
 *     {@link REMEDIATION_BOUND_PARAMETER_ERROR}.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../../db';
import { sqlTimestamp } from '../../db/sqlValues';
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
import { terminalPayloadErasureSet } from '../sensitiveCommandPayload';
import { captureException } from '../sentry';
import { hasTenantVariableBoundParameters } from '../sourcedParameters';
import { getFleetFinding } from './query';

/** Real commandType values a caller may request under `actionKind: 'command'`. */
export const REMEDIATION_COMMAND_TYPE_ALLOWLIST = ['restart_service', 'reboot'] as const;
export type RemediationCommandType = (typeof REMEDIATION_COMMAND_TYPE_ALLOWLIST)[number];

/**
 * #3409 PR4c-2. Fleet remediation is the FOURTH script-dispatch path and the
 * only one that does not go through `dispatchScriptToDevice`
 * (`services/scriptDispatch.ts`) — it owns its own bulk target/result model,
 * so it never calls `resolveSourcedParameters`, never opens the tenant
 * variable scope, and never seals a `secretEnvEnvelope`. A script declaring a
 * bound (non-`runtime`) parameter therefore cannot be dispatched from here
 * without silently running with that binding UNRESOLVED — `BREEZE_VAR_*`
 * unset, `BREEZE_PARAM_*` empty, and no error anywhere. For a `tenantSecret`
 * that is the exact silent-wrong-run PR4c exists to prevent, so this path
 * refuses the script instead, at run creation AND again at dispatch.
 */
export const REMEDIATION_BOUND_PARAMETER_ERROR =
  'Scripts with server-resolved parameters (variables, secrets, device fields) cannot be used for fleet remediation yet';

/**
 * Does this script declare ANY parameter whose value the SERVER must resolve?
 *
 * `hasTenantVariableBoundParameters` (`services/sourcedParameters.ts`, the one
 * authority) answers this for the two variable-backed sources; `builtin` and
 * `deviceCustomField` are equally unresolvable on this path, so they are
 * folded in with the same deliberately-tolerant element-by-element scan. A
 * `source` that is present but not the string `'runtime'` counts as bound even
 * when the rest of the element fails to parse — a binding we cannot READ must
 * never be downgraded to "the caller may supply it".
 */
function hasServerResolvedParameters(parameters: unknown): boolean {
  if (hasTenantVariableBoundParameters(parameters)) return true;
  if (!Array.isArray(parameters)) return false;
  return parameters.some((element) => {
    if (element === null || typeof element !== 'object') return false;
    const source = (element as { source?: unknown }).source;
    return typeof source === 'string' && source !== 'runtime';
  });
}

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
  | (RemediateRequestBase & {
      actionKind: 'script';
      scriptId: string;
      /**
       * Operator-chosen run context for this run (#4888). Absent = use the
       * script's saved default, which is what every run did before the Fix
       * flow's picker stopped throwing this value away. 'elevated' is
       * deliberately absent from the union, mirroring `executeScriptSchema`:
       * elevation stays a property of the saved script, never a launch-time
       * choice.
       */
      runAs?: 'system' | 'user';
    })
  | (RemediateRequestBase & { actionKind: 'command'; commandType: RemediationCommandType });

export type RemediationSkipReason = 'site_denied' | 'not_member' | 'decommissioned' | 'unreachable';

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

/**
 * Rows per target INSERT. Drizzle emits roughly 8 bind parameters per row here
 * (the union of keys across the valid and skipped shapes), so 500 keeps a
 * statement near 4,000 parameters — comfortably inside Postgres's 65,535
 * int16 ceiling, which a single un-chunked insert would breach past ~8,100
 * targets.
 */
const TARGET_INSERT_CHUNK_SIZE = 500;

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class RemediationRequestError extends Error {
  constructor(message: string, public status: 400 | 403 = 400) {
    super(message);
    this.name = 'RemediationRequestError';
  }
}

export function isTerminalRunStatus(status: FleetRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'cancelled';
}

/**
 * THE single writer of `fleet_remediation_runs`' roll-up columns
 * (`succeeded_count` / `failed_count` / `skipped_count`) and of the derived
 * run `status`/`completed_at`. Every path that terminalizes a target must call
 * this afterwards.
 *
 * Previously the roll-up was recomputed only by `pollRunProgress`, on its 30s
 * scheduler, from an in-memory target snapshot it had read at the top of the
 * function. Two consequences, both shipped:
 *
 *  1. `dispatchRunChunk`'s `markTargetSkipped`/`markTargetFailed` wrote the
 *     target row and nothing else, so between a chunk finishing and the next
 *     poll tick the run's counts read stale — typically all zeros. The web UI
 *     was patched to count target rows itself (#3633), but every other
 *     consumer (the `GET /fleet-findings/runs/:runId` and `GET
 *     /fleet-findings/:id/runs` responses, AI tools, reports) still read the
 *     stale columns. This is issue #3637.
 *  2. The poll's snapshot could not see a concurrently-running chunk's writes,
 *     so it wrote a *lower* count back over a fresher one.
 *
 * The fix is an ABSOLUTE recompute from the target rows — not a per-transition
 * `count = count + 1`. Increments would be wrong here: `markTargetFailed` can
 * legitimately fire twice for one target under a BullMQ chunk retry, so a
 * relative write double-counts, and any drift an increment introduces is
 * permanent. An absolute recompute is idempotent, self-correcting, and repairs
 * rows that historical drift already corrupted. It is also *cheaper* than the
 * increment design the issue considered and rejected: one run-wide write per
 * chunk rather than one per target.
 *
 * `SELECT ... FOR UPDATE` before the aggregate is load-bearing, not defensive
 * ceremony. Under READ COMMITTED the `UPDATE`'s subquery reads a snapshot taken
 * at *statement* start, so without the lock two recomputes can interleave and
 * the one that started earlier can overwrite the newer result with older
 * counts — which would, in the worst case, reopen a run the poll worker had
 * already terminalized and unscheduled, stranding it in `running` forever.
 * Taking the row lock first forces the aggregate's snapshot to be taken after
 * any competing recompute has committed.
 *
 * In-flight is counted directly (`pending`/`queued`) rather than derived as
 * `target_count - succeeded - failed - skipped`. Deriving it from the
 * denormalized `target_count` would defeat the point of a self-correcting
 * recompute: a `target_count` that is too high pins the run in `running`
 * forever, one that is too low terminalizes it while targets are still live.
 *
 * `status <> 'cancelled'` because cancellation is an operator decision about
 * the run, not a fact about its targets — a recompute must never resurrect a
 * cancelled run.
 */
export async function recalculateRunRollup(runId: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM fleet_remediation_runs WHERE id = ${runId}::uuid FOR UPDATE`);

    await tx.execute(sql`
      UPDATE fleet_remediation_runs AS r
      SET succeeded_count = agg.succeeded,
          failed_count = agg.failed,
          skipped_count = agg.skipped,
          status = CASE
            WHEN agg.in_flight > 0 THEN 'running'
            WHEN agg.succeeded > 0 AND (agg.failed > 0 OR agg.skipped > 0) THEN 'partial'
            WHEN agg.succeeded > 0 THEN 'succeeded'
            ELSE 'failed'
          END,
          completed_at = CASE
            WHEN agg.in_flight > 0 THEN r.completed_at
            ELSE COALESCE(r.completed_at, ${sqlTimestamp(now)})
          END
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
          COUNT(*) FILTER (WHERE status IN ('pending', 'queued'))::int AS in_flight
        FROM fleet_remediation_run_targets
        WHERE run_id = ${runId}::uuid
      ) AS agg
      WHERE r.id = ${runId}::uuid AND r.status <> 'cancelled'
    `);
  });
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

  // Run row and target rows must land together. Previously the run was
  // committed on its own and the targets inserted afterwards, so any failure of
  // the second statement stranded the run forever: `queued`, `targetCount > 0`,
  // zero target rows, and no dispatch or poll job to ever reconcile it. The
  // target insert was also a single un-chunked multi-row statement over a
  // candidate set that is the finding's entire membership when `deviceIds` is
  // omitted — past roughly 8,100 rows that exceeds Postgres's 65,535 bind
  // parameter limit and throws, which is precisely the fleet scale this
  // feature exists for. Chunked inside one transaction, both failure modes
  // become an ordinary rollback.
  const run = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(fleetRemediationRuns)
      .values({
        orgId: finding.orgId,
        findingId,
        findingRevision: finding.revision,
        actionKind: req.actionKind,
        scriptId: req.actionKind === 'script' ? req.scriptId : null,
        commandType: req.actionKind === 'command' ? req.commandType : null,
        // #4888 — pinned at creation, exactly like scriptId/parameterSnapshot,
        // so a later edit to the script row cannot retroactively change the
        // context the operator authorised. NULL keeps the historical
        // behaviour: fall back to the script's saved default at dispatch.
        runAs: req.actionKind === 'script' ? req.runAs ?? null : null,
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

    if (!inserted) {
      throw new RemediationRequestError('Failed to create remediation run', 400);
    }

    const targetRows = [
      ...validTargets.map((d) => ({
        runId: inserted.id,
        orgId: d.orgId,
        targetDeviceUuid: d.id,
        hostnameSnapshot: d.hostname,
        siteIdSnapshot: d.siteId,
        status: 'pending' as FleetTargetStatus,
      })),
      ...skipped.map((s) => {
        const d = deviceById.get(s.deviceId);
        return {
          runId: inserted.id,
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

    for (const chunk of chunkArray(targetRows, TARGET_INSERT_CHUNK_SIZE)) {
      await tx.insert(fleetRemediationRunTargets).values(chunk);
    }

    return inserted;
  });

  return { runId: run.id, targetCount, skipped, orgId: finding.orgId };
}

async function validateRemediationScript(
  scriptId: string,
  findingOrgId: string
): Promise<{ error?: string }> {
  const [script] = await db
    .select({ id: scripts.id, orgId: scripts.orgId, parameters: scripts.parameters })
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);

  if (!script) {
    return { error: 'Script not found' };
  }
  if (script.orgId !== null && script.orgId !== findingOrgId) {
    return { error: 'Script does not belong to an accessible organization' };
  }
  // Refuse at CREATION so the caller gets a 400 they can act on, rather than a
  // run that queues and then fails every target. See
  // REMEDIATION_BOUND_PARAMETER_ERROR for why this path cannot resolve them.
  if (hasServerResolvedParameters(script.parameters)) {
    return { error: REMEDIATION_BOUND_PARAMETER_ERROR };
  }
  return {};
}

/**
 * An offline device is not a remediation failure — nothing was attempted on
 * it. Recording it as `failed` made the headline aggregate flow report mostly
 * failures on any real fleet, where a large share of devices is offline at
 * dispatch time, and buried the genuine failures among them. `skipped` with
 * an explicit reason keeps `succeeded + failed + skipped` honest and leaves
 * the run summary readable.
 *
 * These targets are terminal for THIS run; re-running the remediation from
 * the finding is the retry path. A per-run "retry unreachable targets"
 * affordance is deliberately out of scope here.
 */
async function markTargetSkipped(runId: string, deviceId: string, reason: RemediationSkipReason): Promise<void> {
  await db
    .update(fleetRemediationRunTargets)
    .set({
      status: 'skipped',
      skipReason: reason,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(fleetRemediationRunTargets.runId, runId),
        eq(fleetRemediationRunTargets.targetDeviceUuid, deviceId),
        // Same claim discipline as the dispatch path: only a still-`pending`
        // row may be skipped, so a concurrent worker that already claimed and
        // dispatched this target cannot have its live command overwritten.
        eq(fleetRemediationRunTargets.status, 'pending')
      )
    );
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
      and(
        eq(fleetRemediationRunTargets.runId, runId),
        eq(fleetRemediationRunTargets.targetDeviceUuid, deviceId),
        // Same claim discipline as `markTargetSkipped`. Every caller reaches
        // here having just won the `pending -> queued` claim, so the row is
        // `queued` — but a BullMQ retry of the same chunk can replay this
        // helper against a row another attempt already terminalized. Without
        // the guard that replay rewrites a `succeeded` target as `failed`,
        // which the roll-up then faithfully reports.
        inArray(fleetRemediationRunTargets.status, ['pending', 'queued'])
      )
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
    // CAS on `status = 'queued'`, not a bare id match. Several chunks for the
    // same run execute concurrently and each read `queued` in its own SELECT
    // above; with an id-only predicate a chunk that stalls between its read
    // and its write can land `running` on top of a status the poll has since
    // moved to terminal, un-finishing a completed run. Only the first chunk to
    // get here wins, which is also what makes `startedAt` a stable value
    // rather than whichever writer was last.
    await db
      .update(fleetRemediationRuns)
      .set({ status: 'running', startedAt: run.startedAt ?? new Date() })
      .where(and(eq(fleetRemediationRuns.id, runId), eq(fleetRemediationRuns.status, 'queued')));
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
  if (pendingTargets.length === 0) {
    // Still reconcile. A chunk finds nothing pending when every target in its
    // page was already dispatched (a retry) or was written `skipped` at
    // creation time — the latter is the all-skipped run, whose counts would
    // otherwise sit stale until the first poll tick 30s later.
    await recalculateRunRollup(runId);
    return;
  }

  // Resolve liveness for the whole chunk up front. `queueCommandForExecution`
  // rejects a non-online device with a plain error string, which
  // `markTargetFailed` then recorded as a hard failure; classifying on that
  // string would be brittle, and attempting the enqueue at all is wasted work.
  // One bounded query (the chunk is <= REMEDIATION_CHUNK_SIZE) instead.
  const liveness = new Map<string, string>();
  for (const row of await db
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(
      inArray(
        devices.id,
        pendingTargets.map((t) => t.targetDeviceUuid)
      )
    )) {
    liveness.set(row.id, row.status);
  }

  // An unexpected throw inside the per-target loop is the same defect
  // repeated once per target; report it to Sentry once per chunk so a
  // 500-target run cannot produce 500 identical issues.
  let reportedUnexpected = false;

  let scriptPayload: { language: string; content: string; timeoutSeconds: number; runAs: string } | null = null;
  // Why the reason is a variable: a script that GAINED a bound parameter since
  // run creation is unavailable to this path for a different reason than one
  // that was deleted or re-tenanted, and "Script no longer available" would
  // send the operator looking for a deletion that never happened.
  let scriptUnavailableReason = 'Script no longer available';
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
        parameters: scripts.parameters,
      })
      .from(scripts)
      .where(and(eq(scripts.id, run.scriptId), isNull(scripts.deletedAt)))
      .limit(1);
    if (script && (script.orgId === null || script.orgId === run.orgId)) {
      // Defence in depth for #3409 PR4c-2: `validateRemediationScript` already
      // refused this script at creation, but the re-fetch exists precisely
      // because the row can be EDITED in between — and adding a bound
      // parameter is the edit that turns an accepted run into one that would
      // dispatch with the binding unresolved. Fail the targets loudly instead.
      if (hasServerResolvedParameters(script.parameters)) {
        scriptUnavailableReason = REMEDIATION_BOUND_PARAMETER_ERROR;
      } else {
        scriptPayload = script;
      }
    }
  }

  for (const target of pendingTargets) {
    // Classify offline before claiming, so an unreachable device is never
    // flipped to `queued` and then walked back. A device missing from the
    // liveness map was deleted between run creation and dispatch — also not
    // reachable, and `fleet_remediation_run_targets.target_device_uuid` is a
    // snapshot with no FK, so this is expected rather than exceptional.
    const deviceStatus = liveness.get(target.targetDeviceUuid);
    if (deviceStatus !== 'online') {
      await markTargetSkipped(runId, target.targetDeviceUuid, 'unreachable');
      continue;
    }

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
          throw new Error(scriptUnavailableReason);
        }
        type = CommandTypes.SCRIPT;
        // #3409 PR4c-2: `parameters` here is the caller's snapshot verbatim —
        // this path has no server-side resolution and NO secret envelope, so
        // only runtime-sourced scripts ever reach it (guarded twice above).
        // Adding a bound parameter to this payload requires routing the path
        // through `dispatchScriptToDevice` first, not a resolver call here.
        payload = {
          scriptId: run.scriptId,
          language: scriptPayload.language,
          content: scriptPayload.content,
          timeoutSeconds: scriptPayload.timeoutSeconds,
          // #4888 — the operator's choice, pinned on the run at creation,
          // wins over the script's saved default. Before this the picker
          // rendered a System / logged-in-user select and the answer was
          // dropped on the floor (`_runAs` in FixPickerModal.tsx), so a
          // remediation always ran in whatever context the script row
          // happened to carry. `?? scriptPayload.runAs` is what keeps every
          // pre-#4888 run (run_as NULL) behaving identically.
          runAs: run.runAs ?? scriptPayload.runAs,
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

  // ONE run-wide write per chunk, after the per-target loop — never inside it.
  // This is the fix for #3637: without it the run's roll-up columns stay at
  // their creation-time values until the next 30s poll tick, so every consumer
  // other than the web UI (which counts target rows itself since #3633) reads
  // stale counts for that whole window.
  await recalculateRunRollup(runId);
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

  // Classify in memory first, then flush set-based. This used to issue one
  // UPDATE per in-flight target, serially, every 30 seconds — on a
  // multi-thousand-target run a single tick could outlast its own interval and
  // the poll would never catch up with the fleet it is meant to be tracking.
  const resolved: { deviceId: string; status: FleetTargetStatus; summary: string }[] = [];
  const timedOut: string[] = [];
  // device_command ids for timed-out targets whose command is still `pending`
  // (never delivered) — cancelled below so a late-reconnecting agent can't run
  // a remediation the run already gave up on.
  const timedOutCommandIds: string[] = [];

  for (const target of inFlight) {
    const command = target.deviceCommandId ? commandsById.get(target.deviceCommandId) : undefined;

    // `cancelled` is terminal for a device_command too (device deleted, agent
    // deauthorized, an operator cancelling from the device page). Treating it
    // as unresolved left the target in flight until the 30-minute timeout
    // rewrote it as a bare "timeout" — losing the real reason, which the
    // command's own result text carries.
    if (command && (command.status === 'completed' || command.status === 'failed' || command.status === 'cancelled')) {
      const nextStatus: FleetTargetStatus = command.status === 'completed' ? 'succeeded' : 'failed';
      resolved.push({
        deviceId: target.targetDeviceUuid,
        status: nextStatus,
        summary: truncateSummary(JSON.stringify(command.result ?? {})),
      });
      continue;
    }

    const referenceTime = target.queuedAt ?? run.createdAt;
    if (now.getTime() - new Date(referenceTime).getTime() > REMEDIATION_TIMEOUT_MS) {
      // A command still `pending` was never delivered — cancel it (below) so an
      // agent that reconnects after the run timed out can't claim and run it. A
      // command already `sent` is in the agent's hands and can't be recalled;
      // its target still times out here, and surfacing that honestly is a
      // documented follow-up (#3302).
      if (target.deviceCommandId && command?.status === 'pending') {
        timedOutCommandIds.push(target.deviceCommandId);
      }
      timedOut.push(target.targetDeviceUuid);
    }
  }

  // Each resolved target carries its own `resultSummary`, so they cannot
  // collapse into one uniform SET — join against a VALUES list instead. Both
  // `status` and `result_summary` are varchar/text (not PG enums), so no cast
  // is needed beyond the uuid on the join key.
  for (const chunk of chunkArray(resolved, TARGET_INSERT_CHUNK_SIZE)) {
    // Every VALUES column is cast explicitly: the parameters are untyped, and
    // Postgres cannot infer a column type for a bare `$n` inside a VALUES list.
    const values = sql.join(
      chunk.map((r) => sql`(${r.deviceId}::uuid, ${r.status}::text, ${r.summary}::text)`),
      sql`, `
    );
    await db.execute(sql`
      UPDATE fleet_remediation_run_targets AS t
      SET status = v.status, result_summary = v.summary, completed_at = ${sqlTimestamp(now)}
      FROM (VALUES ${values}) AS v(device_id, status, summary)
      WHERE t.run_id = ${runId}
        AND t.target_device_uuid = v.device_id
        AND t.status IN ('pending', 'queued')
    `);
  }

  // Cancel the still-queued commands for timed-out targets BEFORE terminalizing
  // those targets. Ordering matters for crash safety: a timed-out target is
  // dropped from the next tick's `inFlight` set (only pending/queued targets are
  // reconciled), so if the process died AFTER the target write but BEFORE the
  // cancel, the pending command would be orphaned and a late-reconnecting agent
  // could still run it — the exact bug. Cancelling first is recoverable: a crash
  // after the cancel leaves the target in flight, and the next poll observes the
  // now-`cancelled` command and reconciles the target via the terminal-status
  // branch above. The `status = 'pending'` predicate also makes this race-safe
  // against claimPendingCommandForDelivery (a CAS on the same predicate): if the
  // agent claims first (pending → sent) this matches 0 rows and never clobbers
  // an in-flight delivery; if we cancel first, the agent's later claim matches 0.
  for (const chunk of chunkArray(timedOutCommandIds, TARGET_INSERT_CHUNK_SIZE)) {
    await db
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: now,
        result: { cancelReason: 'remediation_run_timeout' },
        // Terminal writers must scrub sensitive payload keys (enforced by
        // terminalPayloadErasure.coverage.test.ts) — a cancelled command's
        // payload is no longer needed.
        ...terminalPayloadErasureSet(),
      })
      .where(and(inArray(deviceCommands.id, chunk), eq(deviceCommands.status, 'pending')));
  }

  // Timeouts are uniform, so one statement per chunk covers them.
  for (const chunk of chunkArray(timedOut, TARGET_INSERT_CHUNK_SIZE)) {
    await db
      .update(fleetRemediationRunTargets)
      .set({ status: 'failed', skipReason: 'timeout', completedAt: now })
      .where(
        and(
          eq(fleetRemediationRunTargets.runId, runId),
          inArray(fleetRemediationRunTargets.targetDeviceUuid, chunk),
          // Both flush statements above classify from `inFlight`, a snapshot
          // read at the top of this function. A dispatch chunk running
          // concurrently can terminalize one of those rows in between, and
          // without this predicate the flush overwrites that real outcome with
          // a stale verdict — corrupting exactly the target rows the roll-up
          // is then recomputed from.
          inArray(fleetRemediationRunTargets.status, ['pending', 'queued'])
        )
      );
  }

  // Recompute from the committed target rows, NOT from `allTargets` — that
  // snapshot was read before the flushes above and cannot see a concurrent
  // dispatch chunk's writes, so counting it wrote a stale roll-up back over a
  // fresher one. The shared helper is now the only writer of these columns.
  await recalculateRunRollup(runId, now);
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

  // The two branches this replaced hand-rolled the same derivation the shared
  // helper performs, and reached the same answers:
  //
  //  - Partial enqueue (`upsertJobScheduler` succeeded and `addBulk` landed
  //    some chunks, so real commands went to real devices): those targets are
  //    still `queued`, the helper counts them as in-flight and holds the run at
  //    `running` without stamping `completed_at`. Forcing the run terminal here
  //    would make the poll scheduler remove itself on its next tick without
  //    ever reconciling them. The poll still owns convergence.
  //  - Nothing dispatched: every target is now `skipped`, no successes, so the
  //    helper derives `failed` — the previous hard-coded value.
  //
  // One behaviour does change, deliberately: when some targets had already
  // succeeded before the enqueue failure, the run is now `partial` rather than
  // a blanket `failed`. `partial` is the truthful reading of those target rows,
  // and it is what a run reaching the same target state by any other path
  // already reports.
  await recalculateRunRollup(runId, now);
}
