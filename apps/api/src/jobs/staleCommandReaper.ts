import { Job, Queue, Worker } from 'bullmq';
import { and, eq, lt, sql, inArray, isNotNull } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import {
  deviceCommands,
  scriptExecutions,
  scriptExecutionBatches,
  scripts,
  patchJobs,
  patchJobResults,
  deployments,
  deploymentDevices,
  softwareDeployments,
  deploymentResults,
  remoteSessions,
  restoreJobs,
  backupJobs,
  devices,
  organizations,
  partners,
  STALE_BACKUP_REAP_MARKER,
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { getCommandTimeoutMs, EXCLUDED_COMMAND_TYPES, SCRIPT_GRACE_BUFFER_MS } from '../services/commandTimeouts';
import { UNINSTALL_REASON_DEVICE_REMOVE } from '../services/deviceUninstallDrain';
import { captureException } from '../services/sentry';
import { recordBackupCommandTimeout, recordRestoreTimeout } from '../services/backupMetrics';
import { revokeViewerSession } from '../services/viewerTokenRevocation';
import { backupHelperSupportsQueue } from '../services/backupHelperCapabilities';
import { queueBackupStopCommand, CommandTypes } from '../services/commandQueue';
import { envInt } from '../utils/envInt';

import { terminalPayloadErasureSet } from '../services/sensitiveCommandPayload';
import { applyAutomationActionTerminal } from '../services/automationActionResults';
import { CANCEL_GRACE_MS } from '../services/scriptCancellation';
import { SERVER_TIMEOUT_RESULT_STATUS } from '../services/commandResultAcceptance';
import { createAuditLogAsync } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../services/auditEvents';
import { recordCancelUnconfirmed } from '../services/scriptCancellationMetrics';
const QUEUE_NAME = 'stale-command-reaper';
const REAP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
// Per-run cap (env-tunable). Was a hardcoded 200 which silently truncated the
// reaper above ~200 stale items per type — see scaling audit 2026-05-17. The
// per-row update logic still runs sequentially inside JS to preserve metrics
// and propagation side-effects; this just lets us cover more rows per cycle.
//
// `STALE_REAPER_MAX_PER_RUN=0` means UNLIMITED (matches the convention
// `alertWorker` + `offlineDetector` adopt in this PR). Passing `.limit(0)`
// to drizzle disables the limit clause is NOT a Postgres semantic —
// `.limit(0)` returns zero rows, which would silently disable the
// reaper. Normalize to `Number.MAX_SAFE_INTEGER` so the consistent
// "cap=0 == unlimited" knob actually behaves that way here.
//
// Exported (and pure) so the mapping is testable without re-importing this
// module: the env read stays at module scope, only the derivation moves.
export function resolveMaxReapPerRun(raw: number): number {
  if (raw > 0) return raw;
  if (raw === 0) return Number.MAX_SAFE_INTEGER;
  return 5000; // negative falls back to the default rather than disabling the reaper
}

const MAX_REAP_PER_RUN = resolveMaxReapPerRun(envInt('STALE_REAPER_MAX_PER_RUN', 5000));
const SHORTEST_TIMEOUT_MS = 5 * 60 * 1000; // conservative SQL pre-filter

// Backup-related command types — used to guard backup-specific Prometheus metrics
const BACKUP_COMMAND_TYPES = new Set([
  'backup_run', 'backup_stop', 'backup_restore', 'backup_verify',
  'backup_test_restore', 'backup_cleanup', 'vm_restore_from_backup',
  'vm_instant_boot', 'bmr_recover', 'mssql_backup', 'mssql_restore',
  'hyperv_backup', 'hyperv_restore',
]);

// Deployment/patch stale thresholds
const DEPLOYMENT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Software deployment (`deployment_results`) stale thresholds — §1.5 of the
// 2026-07-28 software-deployment-visibility plan. Exported for tests.
//
// Tier 1 (delivered but silent): 55 min sits above the agent's own hard
// ceilings (15 min download + 30 min install,
// agent/internal/remote/tools/software_install.go:22-26), so the server only
// declares a timeout after the agent's ceilings have provably lapsed.
export const SOFTWARE_INSTALL_TIMEOUT_MS = 55 * 60 * 1000;
// Tier 2 (queued for an offline device, never delivered): the queued
// device_commands row may legitimately wait for the device to reconnect, so
// it gets a much longer leash before the deployment expires.
export const SOFTWARE_QUEUED_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const REMOTE_SESSION_PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const REMOTE_SESSION_ACTIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (zombie safety net)

// Backup job orphan/stall reconciliation thresholds.
const BACKUP_STALL_TIMEOUT_MS = 15 * 60 * 1000;      // progress-capable agent went silent
const BACKUP_OFFLINE_GRACE_MS = 10 * 60 * 1000;      // device offline mid-job (covers reboot)
const BACKUP_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // legacy agents: no progress signal exists
const BACKUP_PENDING_TIMEOUT_MS = 60 * 60 * 1000;    // dispatch enqueued but never flipped/failed

// Mirrors DEFAULT_OFFLINE_THRESHOLD_MINUTES in jobs/offlineDetector.ts (not
// exported from there). Same condition shape: a device counts as offline
// once it's flipped to 'offline', OR it's still marked online/updating but
// hasn't heartbeat-ed in this long — i.e. disconnected but the async
// offline-detection sweep hasn't caught up yet.
const OFFLINE_DETECTOR_DEFAULT_THRESHOLD_MINUTES = 5;

function isDeviceOfflineForReap(status: string | null | undefined, lastSeenAt: Date | null | undefined): boolean {
  if (status === 'offline') return true;
  if (status !== 'online' && status !== 'updating') return false;
  if (!lastSeenAt) return false;
  const thresholdTime = Date.now() - OFFLINE_DETECTOR_DEFAULT_THRESHOLD_MINUTES * 60 * 1000;
  return lastSeenAt.getTime() < thresholdTime;
}

type ReaperJobData = { type: 'reap-stale-commands'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[StaleCommandReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access');
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

export async function propagateTimedOutDeviceCommand(params: {
  commandId: string;
  payload: Record<string, unknown> | null;
  errorMsg: string;
  completedAt: Date;
}): Promise<void> {
  const { commandId, payload, errorMsg, completedAt } = params;

  await db
    .update(restoreJobs)
    .set({
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
        'error', ${errorMsg}::text,
        'result', jsonb_build_object(
          'status', 'failed',
          'error', ${errorMsg}::text,
          'timedOutBy', 'server'
        )
      )`,
    })
    .where(
      and(
        eq(restoreJobs.commandId, commandId),
        inArray(restoreJobs.status, ['pending', 'running']),
      ),
    );

  const drExecutionId =
    payload && typeof payload.drExecutionId === 'string' && payload.drExecutionId.trim().length > 0
      ? payload.drExecutionId
      : null;

  if (!drExecutionId) {
    return;
  }

  const { enqueueDrExecutionReconcile } = await import('./drExecutionWorker');
  await enqueueDrExecutionReconcile(drExecutionId, 0);
}

// ── Reap functions ────────────────────────────────────────────────

export async function reapStaleDeviceCommands(): Promise<number> {
  const now = Date.now();
  const conservativeCutoff = new Date(now - SHORTEST_TIMEOUT_MS);
  const excludedTypes = [...EXCLUDED_COMMAND_TYPES];

  // Build WHERE conditions, guarding against empty exclusion set
  const whereConditions = [
    inArray(deviceCommands.status, ['pending', 'sent']),
    lt(deviceCommands.createdAt, conservativeCutoff),
  ];
  if (excludedTypes.length > 0) {
    whereConditions.push(
      sql`${deviceCommands.type} NOT IN (${sql.join(
        excludedTypes.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  }

  // #2774 — a drain-window self_uninstall must outlive the 30-minute command
  // timeout: the whole point of the `offboarding` state is waiting (up to
  // OFFBOARDING_DRAIN_WINDOW_HOURS) for offline devices to come collect it.
  // Scoped to tenants CURRENTLY offboarding, deliberately NOT a blanket
  // self_uninstall exemption: abuse-queued uninstalls (partner `suspended`)
  // must keep expiring, or an abuse suspension reversed days later would
  // deliver stale uninstalls to a reinstated fleet. The offboarding drain
  // reaper cancels these rows itself (with a never-drained report) when the
  // window closes, so they cannot linger past the drain either.
  //
  // #3986 Task 10 — a SECOND, independent arm for the device-remove drain
  // (deviceUninstallDrain.ts). Three features queue a self_uninstall row:
  // device remove (this arm), tenant offboarding (the arm above), and abuse
  // suspension (routes/admin/abuse.ts, no status filter — it queues
  // self_uninstall onto already-decommissioned devices too). The exemption
  // below therefore keys on the explicit `device_remove` reason PLUS an
  // unexpired deadline, never on devices.status alone: a status-only or
  // bare-self_uninstall predicate would sweep up the abuse rows, hold them
  // for the drain window, and on un-suspension deliver a fleet-wide
  // uninstall to a reinstated customer. This arm deliberately does NOT
  // reuse the EXISTS/JOIN above — that join is INNER on partners, so an org
  // with partner_id IS NULL silently drops out of the EXISTS (a known gap
  // in the offboarding arm) — this arm needs no join at all, so it can't
  // inherit that bug. When the deadline passes the row reaps normally, the
  // device stops satisfying the drain predicate, and agentAuth's 30-minute
  // window reverts to a hard 403 on its own; no new sweeper needed.
  //
  // NULL-SAFETY (`COALESCE(..., FALSE)`) IS LOAD-BEARING, NOT DEFENSIVE POLISH.
  // Both halves of the device-remove arm are NULL for exactly the rows this
  // exemption must never cover: `NULL @> ARRAY['device_remove']` is NULL (not
  // false), and `NULL > now()` is NULL. `TRUE AND NULL AND NULL` is NULL, so
  // the whole disjunction goes NULL and `NOT NULL` is NULL — and a NULL WHERE
  // term does not match, which drops the row from the reaper's candidate set
  // ENTIRELY. Unguarded, that inverts the arm's meaning for every
  // reason-less self_uninstall: abuse.ts's fleet-wide suspension rows and
  // every row predating the provenance column would become permanently
  // un-reapable, sit `pending` forever, and deliver on the first heartbeat
  // after an un-suspension — precisely the incident this arm's own comment
  // says it prevents. Caught by deviceUninstallDrain.integration.test.ts's
  // incident guard; a compiled-SQL unit assertion cannot see it, because the
  // clause SHAPE is correct and only Postgres's three-valued evaluation of it
  // is not.
  // DELIBERATE PREDICATE DRIFT, recorded so nobody "fixes" it into a bug:
  // this arm omits the `devices.status = 'decommissioned'` conjunct that
  // `isDeviceUninstallDraining` (services/deviceUninstallDrain.ts) requires,
  // so it is strictly LOOSER than the auth-side predicate. That is safe, and
  // the safe direction is the only one available here:
  //
  //   - Looser here means a row can be EXEMPT from reaping while the device
  //     is not (yet, or any longer) `decommissioned`. Exemption only leaves a
  //     `pending` row alive; it never grants authentication or delivery. The
  //     narrower auth predicate still 403s such a device, and the row's own
  //     deadline still expires it, so the exemption self-closes with no
  //     sweeper.
  //   - Tighter here would be the dangerous direction: the reaper would time
  //     out a self_uninstall that `agentAuth` is still holding a live drain
  //     window open for, and the removed machine would authenticate for the
  //     rest of the window with nothing left to collect — the uninstall
  //     silently never delivered.
  //
  // The set where they differ is empty in practice anyway: only
  // `queueDeviceUninstall` writes the `device_remove` reason, and it runs
  // inside the caller's decommission transaction, so a row carrying that
  // reason and a future deadline belongs to a `decommissioned` device. A
  // restore strips BOTH the reason and the deadline in one UPDATE (see
  // `releaseDeviceRemoveReason`), which drops the row out of this arm at the
  // same instant it drops out of the auth predicate. Joining `devices` here
  // purely to re-derive that would add a per-row join to the hot reaper scan
  // for no reachable behaviour change.
  whereConditions.push(
    sql`NOT COALESCE((
      (
        ${deviceCommands.type} = 'self_uninstall'
        AND EXISTS (
          SELECT 1
          FROM ${devices}
          JOIN ${organizations} ON ${organizations.id} = ${devices.orgId}
          JOIN ${partners} ON ${partners.id} = ${organizations.partnerId}
          WHERE ${devices.id} = ${deviceCommands.deviceId}
            AND (${organizations.status} = 'offboarding' OR ${partners.status} = 'offboarding')
        )
      )
      OR (
        ${deviceCommands.type} = 'self_uninstall'
        AND ${deviceCommands.uninstallReasons} @> ARRAY[${UNINSTALL_REASON_DEVICE_REMOVE}]::text[]
        AND ${deviceCommands.deviceRemoveExpiresAt} > now()
      )
    ), FALSE)`,
  );

  const staleCommands = await db
    .select({
      id: deviceCommands.id,
      type: deviceCommands.type,
      status: deviceCommands.status,
      payload: deviceCommands.payload,
      createdAt: deviceCommands.createdAt,
      executedAt: deviceCommands.executedAt,
    })
    .from(deviceCommands)
    .where(and(...whereConditions))
    .orderBy(deviceCommands.createdAt)
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  for (const cmd of staleCommands) {
    const timeoutMs = getCommandTimeoutMs(
      cmd.type,
      cmd.payload as Record<string, unknown> | null,
    );
    const referenceTime = cmd.status === 'sent' && cmd.executedAt
      ? cmd.executedAt.getTime()
      : cmd.createdAt.getTime();

    if (now - referenceTime < timeoutMs) continue;

    const errorMsg = cmd.status === 'sent'
      ? `Server-side timeout: no response from agent after ${Math.round(timeoutMs / 60000)} minutes`
      : `Command expired: agent never received the command (${Math.round(timeoutMs / 60000)} min timeout)`;

    const completedAt = new Date();

    const updated = await db
      .update(deviceCommands)
      .set({
        status: 'failed',
        completedAt,
        result: { status: 'timeout', error: errorMsg, timedOutBy: 'server' },
        ...terminalPayloadErasureSet(),
      })
      .where(
        and(
          eq(deviceCommands.id, cmd.id),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ),
      )
      .returning({ id: deviceCommands.id });

    if (updated.length === 0) continue;

    reaped++;
    await applyAutomationActionTerminal({
      source: 'reaper',
      commandId: updated[0]!.id,
      terminalStatus: 'timed_out',
      error: errorMsg,
      completedAt,
    });
    if (BACKUP_COMMAND_TYPES.has(cmd.type)) {
      recordBackupCommandTimeout(cmd.type, 'reaper');
    }
    if (cmd.type === 'backup_restore' || cmd.type === 'vm_restore_from_backup' || cmd.type === 'vm_instant_boot' || cmd.type === 'bmr_recover') {
      recordRestoreTimeout(cmd.type);
    }

    try {
      await propagateTimedOutDeviceCommand({
        commandId: cmd.id,
        payload: (cmd.payload as Record<string, unknown> | null) ?? null,
        errorMsg,
        completedAt,
      });
    } catch (error) {
      console.error(`[StaleCommandReaper] Failed to propagate stale command ${cmd.id}:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (staleCommands.length === MAX_REAP_PER_RUN) {
    console.warn(`[StaleCommandReaper] deviceCommands hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return reaped;
}

export async function reapStaleScriptExecutions(): Promise<number> {
  // #3190: this used to be a flat `300s + 5min grace` for every execution,
  // ignoring the script's own `timeoutSeconds`. That is wrong in both
  // directions: a legitimately long script was reaped and reported as stale
  // while it was still running correctly, and a short-timeout script sat
  // pending far past its own contract.
  //
  // The deadline now comes from the script row, through the same
  // `getCommandTimeoutMs` used by the device-command reaper above — one source
  // of truth for "how long may a script take", rather than a second copy that
  // can drift from it.
  //
  // The SQL pre-filter uses the grace buffer alone as a conservative floor:
  // `timeoutSeconds` is a non-negative integer, so every per-script deadline is
  // at least SCRIPT_GRACE_BUFFER_MS and nothing younger than that can be due.
  // Rows selected here are re-checked per row below against their own script's
  // deadline, mirroring reapStaleDeviceCommands.
  const conservativeCutoff = new Date(Date.now() - SCRIPT_GRACE_BUFFER_MS);

  const staleExecs = await db
    .select({
      id: scriptExecutions.id,
      status: scriptExecutions.status,
      scriptId: scriptExecutions.scriptId,
      createdAt: scriptExecutions.createdAt,
      startedAt: scriptExecutions.startedAt,
      timeoutSeconds: scripts.timeoutSeconds,
    })
    .from(scriptExecutions)
    .innerJoin(scripts, eq(scripts.id, scriptExecutions.scriptId))
    .where(
      and(
        inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
        lt(scriptExecutions.createdAt, conservativeCutoff),
      ),
    )
    .orderBy(scriptExecutions.createdAt)
    .limit(MAX_REAP_PER_RUN);

  const now = Date.now();
  let reaped = 0;

  for (const exec of staleExecs) {
    // The per-row deadline must use the script's own value too. Leaving this
    // check on a fixed constant would keep enforcing the old floor and make
    // the fix inert for exactly the short-timeout case #3190 describes.
    const timeoutMs = getCommandTimeoutMs(CommandTypes.SCRIPT, {
      timeoutSeconds: exec.timeoutSeconds,
    });
    const referenceTime = exec.status === 'running' && exec.startedAt
      ? exec.startedAt.getTime()
      : exec.createdAt.getTime();

    if (now - referenceTime < timeoutMs) continue;

    // #3097: this lookup used to happen AFTER the update, purely to find the
    // batch. It runs first now because it also answers whether the agent
    // actually replied.
    //
    // Script results submitted over the HTTP path never reach `script_executions`
    // (only agentWs registers `script: handleScriptResult`), so the row stays
    // pending and lands here — where the reaper stamped it `timeout` with
    // "no response from agent". That claim is false whenever a terminal
    // `device_commands` row exists: the agent DID respond, the result simply was
    // not mirrored. On one live instance 89 executions read `timeout` while their
    // command had completed successfully with captured output.
    //
    // This does not persist the result — that belongs with the shared-handler
    // work. It stops the reaper asserting something it cannot know, and records
    // the outcome the command actually reached.
    const relatedCmd = await db
      .select({
        payload: deviceCommands.payload,
        status: deviceCommands.status,
        result: deviceCommands.result,
      })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.type, 'script'),
          sql`${deviceCommands.payload}->>'executionId' = ${exec.id}`,
        ),
      )
      .limit(1);

    const cmd = relatedCmd[0];
    const cmdIsTerminal = cmd?.status === 'completed' || cmd?.status === 'failed';
    const cmdResultStatus = (cmd?.result as Record<string, unknown> | null | undefined)?.status;
    // Mirror handleScriptResult's mapping so a reaped row agrees with what the
    // WS path would have written for the same command.
    const reapedStatus: 'timeout' | 'completed' | 'failed' = !cmdIsTerminal
      ? 'timeout'
      : cmd?.status === 'completed' && cmdResultStatus !== 'failed' && cmdResultStatus !== 'timeout'
        ? 'completed'
        : 'failed';
    const reapedError = cmdIsTerminal
      ? 'Agent result was delivered but never recorded on this execution; recovered from the device command (#3097)'
      : 'Server-side timeout: no response from agent';

    const scriptCompletedAt = new Date();
    const updated = await db
      .update(scriptExecutions)
      .set({
        status: reapedStatus,
        completedAt: scriptCompletedAt,
        errorMessage: reapedError,
      })
      .where(
        and(
          eq(scriptExecutions.id, exec.id),
          inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
        ),
      )
      .returning({ id: scriptExecutions.id });

    if (updated.length === 0) continue;
    reaped++;

    await applyAutomationActionTerminal({
      source: 'reaper',
      scriptExecutionId: updated[0]!.id,
      terminalStatus: reapedStatus === 'completed'
        ? 'succeeded'
        : reapedStatus === 'failed'
          ? 'failed'
          : 'timed_out',
      error: reapedError,
      completedAt: scriptCompletedAt,
    });

    // Batch attribution reuses the row fetched above (same query, one round-trip).
    const batchId = (cmd?.payload as Record<string, unknown>)?.batchId as string | undefined;
    if (batchId) {
      // Atomic: increment counter + check completion in a transaction
      await db.transaction(async (tx) => {
        // A recovered success must not be counted as a batch failure — that was
        // the same false claim one level up.
        await tx
          .update(scriptExecutionBatches)
          .set(
            reapedStatus === 'completed'
              ? { devicesCompleted: sql`${scriptExecutionBatches.devicesCompleted} + 1` }
              : { devicesFailed: sql`${scriptExecutionBatches.devicesFailed} + 1` },
          )
          .where(eq(scriptExecutionBatches.id, batchId));

        const [batch] = await tx
          .select({
            devicesTargeted: scriptExecutionBatches.devicesTargeted,
            devicesCompleted: scriptExecutionBatches.devicesCompleted,
            devicesFailed: scriptExecutionBatches.devicesFailed,
          })
          .from(scriptExecutionBatches)
          .where(eq(scriptExecutionBatches.id, batchId));

        if (batch && batch.devicesCompleted + batch.devicesFailed >= batch.devicesTargeted) {
          await tx
            .update(scriptExecutionBatches)
            .set({
              status: batch.devicesFailed > 0 ? 'failed' : 'completed',
              completedAt: new Date(),
            })
            .where(eq(scriptExecutionBatches.id, batchId));
        }
      });
    }
  }

  return reaped;
}

/** Audit action written when the sweep gives up on a cancel (spec OD3-A). */
export const CANCEL_UNCONFIRMED_AUDIT_ACTION = 'script.execution.cancel.unconfirmed';

/**
 * #3525 closers 4 and 5 — cancel-command expiry and the cancellation sweep.
 *
 * Owns the `cancelling` state EXCLUSIVELY. `reapStaleScriptExecutions` above is
 * deliberately blind to it (its predicate is `pending|queued|running` and stays
 * that way), because the two reapers answer different questions: that one asks
 * "did the script finish in time", this one asks "did the cancel REQUEST get
 * resolved". Widening the first to cover `cancelling` would make a failed
 * cancel look like a failed script.
 *
 * Nothing here terminalises a row as `cancelled` — only proof does, and proof
 * arrives through the agent's ack (`applyScriptCancelAck`) or the original
 * script result. This sweep only ever REVERTS `status` to the value the
 * execution held when the cancel was requested and records `unconfirmed`. That
 * hands ownership straight back to `reapStaleScriptExecutions`, whose predicate
 * the reverted status is inside, so a failed cancel can never strand a row.
 *
 * Three ways a cancel gets resolved here:
 *
 *  - the cancel command reached a terminal status (closer 4 — its own 2-hour
 *    LONG_TIMEOUT tier expired it, or an ack landed that resolved nothing);
 *  - it was DELIVERED more than `CANCEL_GRACE_MS` ago (closer 5). The clock
 *    starts at delivery (`device_commands.executed_at`), never at the request:
 *    losing the WS connection does not kill the agent or its script, so a
 *    cancel queued against an offline device is still deliverable on reconnect
 *    and must not be given up on early;
 *  - the cancel command row is GONE. `script_executions.cancel_command_id` is a
 *    bare uuid precisely because command rows are reaped independently, and
 *    once the row is gone neither of the two clocks above can ever fire again.
 *    Bounded by `cancel_requested_at` so that the write window between stamping
 *    an execution `cancelling` and its command row becoming visible cannot
 *    revert a cancel that is still being dispatched.
 */
export async function reapStaleCancellations(): Promise<number> {
  const rows = await db
    .select({
      executionId: scriptExecutions.id,
      deviceId: scriptExecutions.deviceId,
      orgId: scriptExecutions.orgId,
      prevStatus: scriptExecutions.cancelPrevStatus,
      cancelCommandId: scriptExecutions.cancelCommandId,
      cancelRequestedAt: scriptExecutions.cancelRequestedAt,
      cmdStatus: deviceCommands.status,
      cmdExecutedAt: deviceCommands.executedAt,
    })
    .from(scriptExecutions)
    .leftJoin(deviceCommands, eq(deviceCommands.id, scriptExecutions.cancelCommandId))
    .where(eq(scriptExecutions.status, 'cancelling'))
    .limit(MAX_REAP_PER_RUN);

  const now = Date.now();
  let reaped = 0;

  for (const row of rows) {
    const cmdTerminal = row.cmdStatus === 'failed'
      || row.cmdStatus === 'completed'
      || row.cmdStatus === 'cancelled';
    const deliveredLongAgo = row.cmdExecutedAt !== null
      && now - row.cmdExecutedAt.getTime() >= CANCEL_GRACE_MS;
    // A left-join miss: no command row exists for this cancel any more (or one
    // was never written). A NULL `cancel_requested_at` on a `cancelling` row is
    // already broken data — resolve it rather than let it sit forever.
    const orphaned = row.cmdStatus === null
      && (row.cancelRequestedAt === null || now - row.cancelRequestedAt.getTime() >= CANCEL_GRACE_MS);
    // An undelivered `pending` cancel has not started its clock. Its own
    // 2-hour tier will expire it, and that arrives here as `cmdTerminal`.
    if (!cmdTerminal && !deliveredLongAgo && !orphaned) continue;

    // Compare-and-swap on `cancelling`: if the agent's ack or the original
    // script result landed between the SELECT and here, that closer owns the
    // outcome and this sweep must claim nothing — no revert, no command close,
    // no audit row, no metric.
    const updated = await db
      .update(scriptExecutions)
      .set({
        // `running` is the safe floor for a NULL prev status: it keeps the row
        // inside reapStaleScriptExecutions' predicate rather than stranding it.
        status: row.prevStatus ?? 'running',
        cancelState: 'unconfirmed',
      })
      .where(and(
        eq(scriptExecutions.id, row.executionId),
        eq(scriptExecutions.status, 'cancelling'),
      ))
      .returning({ id: scriptExecutions.id });

    if (updated.length === 0) continue;
    reaped++;

    // `cmdStatus !== null` excludes the orphan arm: the join already proved
    // there is no command row left to close.
    if (row.cancelCommandId && row.cmdStatus !== null && !cmdTerminal) {
      // Close the still-open cancel command with the ONLY marker
      // `commandResultAcceptance` reopens (`failed` + `result.status =
      // 'timeout'`), so a late ack from a slow device still lands instead of
      // being rejected as a result for a closed command.
      await db
        .update(deviceCommands)
        .set({
          status: 'failed',
          completedAt: new Date(),
          result: {
            status: SERVER_TIMEOUT_RESULT_STATUS,
            error: 'Cancellation not acknowledged within the grace window',
            timedOutBy: 'server',
          },
          ...terminalPayloadErasureSet(),
        })
        .where(and(
          eq(deviceCommands.id, row.cancelCommandId),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ));
    }

    // OD3-A: the row field (`cancel_state`) plus an audit event plus a metric.
    // Deliberately NO device alert and NO captureException — an unacknowledged
    // cancel is an operational condition (agent offline, script already gone,
    // agent too old to know the command), not a code defect. Paging on it would
    // train the on-call to ignore the signal.
    await createAuditLogAsync({
      orgId: row.orgId,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: CANCEL_UNCONFIRMED_AUDIT_ACTION,
      resourceType: 'script_execution',
      resourceId: row.executionId,
      details: {
        deviceId: row.deviceId,
        cancelCommandId: row.cancelCommandId,
        revertedTo: row.prevStatus,
      },
      result: 'success',
      initiatedBy: 'schedule',
    });
    recordCancelUnconfirmed();
  }

  if (reaped > 0) {
    console.warn(`[StaleCommandReaper] Reverted ${reaped} unacknowledged script cancellation(s) to cancel_state 'unconfirmed'`);
  }

  return reaped;
}

async function reapStalePatchJobResults(): Promise<number> {
  const cutoff = new Date(Date.now() - DEPLOYMENT_TIMEOUT_MS);

  const staleResults = await db
    .select({
      id: patchJobResults.id,
      jobId: patchJobResults.jobId,
    })
    .from(patchJobResults)
    .where(
      and(
        inArray(patchJobResults.status, ['pending', 'running']),
        lt(patchJobResults.createdAt, cutoff),
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  const reapedPerJob = new Map<string, number>();

  for (const result of staleResults) {
    const updated = await db
      .update(patchJobResults)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Server-side timeout: no response from agent',
      })
      .where(
        and(
          eq(patchJobResults.id, result.id),
          inArray(patchJobResults.status, ['pending', 'running']),
        ),
      )
      .returning({ id: patchJobResults.id });

    if (updated.length > 0) {
      reaped++;
      reapedPerJob.set(result.jobId, (reapedPerJob.get(result.jobId) ?? 0) + 1);
    }
  }

  // Update parent patch job counters (increment by actual count, not 1)
  for (const [jobId, count] of reapedPerJob) {
    await db.transaction(async (tx) => {
      await tx
        .update(patchJobs)
        .set({
          devicesFailed: sql`${patchJobs.devicesFailed} + ${count}`,
        })
        .where(eq(patchJobs.id, jobId));

      // Check if job is now complete
      const remainingActive = await tx
        .select({ id: patchJobResults.id })
        .from(patchJobResults)
        .where(
          and(
            eq(patchJobResults.jobId, jobId),
            inArray(patchJobResults.status, ['pending', 'running']),
          ),
        )
        .limit(1);

      if (remainingActive.length === 0) {
        const [jobStats] = await tx
          .select({ devicesFailed: patchJobs.devicesFailed })
          .from(patchJobs)
          .where(eq(patchJobs.id, jobId));

        await tx
          .update(patchJobs)
          .set({
            status: (jobStats?.devicesFailed ?? 0) > 0 ? 'failed' : 'completed',
            completedAt: new Date(),
          })
          .where(
            and(
              eq(patchJobs.id, jobId),
              inArray(patchJobs.status, ['scheduled', 'running']),
            ),
          );
      }
    });
  }

  return reaped;
}

async function reapStaleDeploymentDevices(): Promise<number> {
  const cutoff = new Date(Date.now() - DEPLOYMENT_TIMEOUT_MS);

  // Fetch stale devices: running with old startedAt, OR pending with null startedAt
  // (join to parent deployment for createdAt fallback when startedAt is null)
  const staleDevices = await db
    .select({
      id: deploymentDevices.id,
      deploymentId: deploymentDevices.deploymentId,
    })
    .from(deploymentDevices)
    .innerJoin(deployments, eq(deployments.id, deploymentDevices.deploymentId))
    .where(
      and(
        inArray(deploymentDevices.status, ['pending', 'running']),
        sql`COALESCE(${deploymentDevices.startedAt}, ${deployments.createdAt}) < ${cutoff.toISOString()}`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  const affectedDeploymentIds = new Set<string>();

  for (const dev of staleDevices) {
    const updated = await db
      .update(deploymentDevices)
      .set({
        status: 'failed',
        completedAt: new Date(),
        result: { error: 'Server-side timeout: no response from agent', timedOutBy: 'server' },
      })
      .where(
        and(
          eq(deploymentDevices.id, dev.id),
          inArray(deploymentDevices.status, ['pending', 'running']),
        ),
      )
      .returning({ id: deploymentDevices.id });

    if (updated.length > 0) {
      reaped++;
      affectedDeploymentIds.add(dev.deploymentId);
    }
  }

  // Recompute parent deployment status
  for (const deploymentId of affectedDeploymentIds) {
    const remainingActive = await db
      .select({ id: deploymentDevices.id })
      .from(deploymentDevices)
      .where(
        and(
          eq(deploymentDevices.deploymentId, deploymentId),
          inArray(deploymentDevices.status, ['pending', 'running']),
        ),
      )
      .limit(1);

    if (remainingActive.length === 0) {
      // Check if any device actually succeeded
      const [stats] = await db
        .select({
          failedCount: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'failed')`,
          totalCount: sql<number>`count(*)`,
        })
        .from(deploymentDevices)
        .where(eq(deploymentDevices.deploymentId, deploymentId));

      const allFailed = stats && stats.failedCount === stats.totalCount;

      await db
        .update(deployments)
        .set({
          status: allFailed ? 'failed' : 'completed',
          completedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.id, deploymentId),
            inArray(deployments.status, ['pending', 'running', 'paused', 'downloading', 'installing']),
          ),
        );
    }
  }

  return reaped;
}

/**
 * Reap stale System-A software deployment result rows (`deployment_results`)
 * that the agent result path will never terminate on its own. Two tiers:
 *
 *  Tier 1 (delivered but silent): the install command provably reached the
 *  agent — WS-dispatched directly (`device_command_id` NULL) or the linked
 *  `device_commands` row is 'sent'/'completed' — and the parent deployment's
 *  `dispatched_at` is older than SOFTWARE_INSTALL_TIMEOUT_MS.
 *
 *  Tier 2 (queued, never delivered): the linked `device_commands` row is
 *  still 'pending' (device offline, waiting to reconnect). Spared until
 *  `dispatched_at` is older than SOFTWARE_QUEUED_EXPIRY_MS, then failed AND
 *  the queued command is cancelled so it can't fire on a later reconnect.
 *
 * Rows whose deployment has `dispatched_at` NULL (scheduled, not yet
 * dispatched) are NEVER candidates — the SQL filter excludes them.
 *
 * A linked command in a terminal state ('failed'/'cancelled') or whose row
 * has vanished matches neither tier's delivery proof; those fall through to
 * the Tier 2 expiry as a backstop so the result row can't zombie forever
 * (the guarded command-cancel is a no-op for non-pending rows).
 */
export async function reapStaleSoftwareDeploymentResults(): Promise<number> {
  const now = Date.now();
  const timeoutCutoff = new Date(now - SOFTWARE_INSTALL_TIMEOUT_MS);

  // Conservative SQL pre-filter at the Tier 1 cutoff (the tighter of the
  // two); per-row tier logic below applies the precise threshold. Mirrors
  // the SHORTEST_TIMEOUT_MS pattern used elsewhere in this file.
  const candidates = await db
    .select({
      id: deploymentResults.id,
      deviceCommandId: deploymentResults.deviceCommandId,
      dispatchedAt: softwareDeployments.dispatchedAt,
      commandStatus: deviceCommands.status,
    })
    .from(deploymentResults)
    .innerJoin(softwareDeployments, eq(softwareDeployments.id, deploymentResults.deploymentId))
    .leftJoin(deviceCommands, eq(deviceCommands.id, deploymentResults.deviceCommandId))
    .where(
      and(
        eq(deploymentResults.status, 'pending'),
        isNotNull(softwareDeployments.dispatchedAt),
        lt(softwareDeployments.dispatchedAt, timeoutCutoff),
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;

  for (const row of candidates) {
    // Never reap a not-yet-dispatched (scheduled) deployment's rows.
    // The SQL filter already excludes these; keep the guard for defense.
    if (!row.dispatchedAt) continue;

    const dispatchedAgoMs = now - row.dispatchedAt.getTime();

    const delivered =
      row.deviceCommandId === null ||
      row.commandStatus === 'sent' ||
      row.commandStatus === 'completed';

    let errorMessage: string;
    if (delivered) {
      // Tier 1 — the SQL filter already applies this cutoff; re-check per
      // row (precise-threshold-in-JS pattern used elsewhere in this file).
      if (dispatchedAgoMs < SOFTWARE_INSTALL_TIMEOUT_MS) continue;
      errorMessage = 'Server-side timeout: no response from agent';
    } else {
      // Tier 2 — queued for an offline device (or delivery unprovable):
      // spare until the queued-expiry window lapses.
      if (dispatchedAgoMs < SOFTWARE_QUEUED_EXPIRY_MS) continue;
      errorMessage = 'Device did not come online before the deployment expired';
    }

    const completedAt = new Date();

    // Guarded on status='pending' so a concurrent real result always wins.
    const updated = await db
      .update(deploymentResults)
      .set({
        status: 'failed',
        completedAt,
        errorMessage,
      })
      .where(
        and(
          eq(deploymentResults.id, row.id),
          eq(deploymentResults.status, 'pending'),
        ),
      )
      .returning({ id: deploymentResults.id });

    if (updated.length === 0) continue;
    reaped++;

    await applyAutomationActionTerminal({
      source: 'reaper',
      deploymentResultId: updated[0]!.id,
      terminalStatus: 'timed_out',
      error: errorMessage,
      completedAt,
    });

    // Tier 2: cancel the still-queued device_commands row so the install
    // can't fire when the device eventually reconnects. Guarded on
    // status='pending' — if the agent claimed it mid-reap, leave it be.
    if (!delivered && row.deviceCommandId) {
      try {
        await db
          .update(deviceCommands)
          .set({
            status: 'cancelled',
            completedAt,
            result: {
              status: 'cancelled',
              error: errorMessage,
              cancelledBy: 'stale-command-reaper',
            },
            ...terminalPayloadErasureSet(),
          })
          .where(
            and(
              eq(deviceCommands.id, row.deviceCommandId),
              eq(deviceCommands.status, 'pending'),
            ),
          );
      } catch (error) {
        console.error(
          `[StaleCommandReaper] Failed to cancel queued command ${row.deviceCommandId} for expired deployment result ${row.id}:`,
          error,
        );
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return reaped;
}

async function reapStaleRemoteSessions(): Promise<number> {
  const pendingCutoff = new Date(Date.now() - REMOTE_SESSION_PENDING_TIMEOUT_MS);
  const activeCutoff = new Date(Date.now() - REMOTE_SESSION_ACTIVE_TIMEOUT_MS);

  // Pending/connecting sessions older than 10 minutes
  const pendingResult = await db
    .update(remoteSessions)
    .set({
      status: 'disconnected',
      endedAt: new Date(),
      errorMessage: 'Session timed out: connection was never established',
    })
    .where(
      and(
        inArray(remoteSessions.status, ['pending', 'connecting']),
        lt(remoteSessions.createdAt, pendingCutoff),
      ),
    )
    .returning({ id: remoteSessions.id });

  // Zombie active sessions older than 24 hours
  const activeResult = await db
    .update(remoteSessions)
    .set({
      status: 'disconnected',
      endedAt: new Date(),
      errorMessage: 'Session timed out: exceeded maximum session duration',
    })
    .where(
      and(
        eq(remoteSessions.status, 'active'),
        lt(remoteSessions.startedAt, activeCutoff),
        isNotNull(remoteSessions.startedAt),
      ),
    )
    .returning({ id: remoteSessions.id });

  // Revoke viewer tokens for every session we just force-disconnected so a
  // lingering (up to 2h) viewer token can't resurrect it via /viewer/offer (#5).
  // The agent's max-session-duration timer is the authoritative teardown for the
  // live peer-to-peer stream of a zombie session (when a max-session-duration
  // policy is set; default 8h) (#2).
  const reapedIds = [...pendingResult, ...activeResult].map((r) => r.id);
  await Promise.all(
    reapedIds.map((id) =>
      revokeViewerSession(id).catch((err) =>
        console.warn('[reaper] viewer revoke failed', id, err)
      )
    )
  );

  return pendingResult.length + activeResult.length;
}

/**
 * Fail a stale/orphaned `backup_jobs` row, guarded so a concurrent terminal
 * transition (the real result arriving mid-reap) always wins. Appends to any
 * existing errorLog rather than clobbering it.
 */
async function reapBackupJobRow(
  jobId: string,
  existingErrorLog: string | null | undefined,
  errorMsg: string,
): Promise<boolean> {
  const now = new Date();
  // Stamp the reaper marker so the result-persistence path can later recognize a
  // "failed-because-reaped" job and still record a late-but-genuine `completed`
  // result (flipping failed→completed) instead of stranding its snapshot — see
  // STALE_BACKUP_REAP_MARKER / FIX 7 in backupResultPersistence.ts.
  const markedMsg = `${STALE_BACKUP_REAP_MARKER} ${errorMsg}`;
  const errorLog = existingErrorLog ? `${existingErrorLog}\n${markedMsg}` : markedMsg;

  const updated = await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorLog,
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        inArray(backupJobs.status, ['pending', 'running']),
      ),
    )
    .returning({ id: backupJobs.id });

  return updated.length > 0;
}

/**
 * Reap orphaned/stalled `backup_jobs` rows the normal WS result path will
 * never terminate on its own: a silently-dead agent (stall), a device that
 * went offline mid-upload, a legacy agent with no progress signal at all
 * (absolute cap), or a dispatch that never flipped out of `pending`.
 *
 * A `running` job is reaped when ANY of:
 *  A (stall):    lastProgressAt is set and stale past BACKUP_STALL_TIMEOUT_MS
 *  B (offline):  the owning device is offline (see isDeviceOfflineForReap)
 *                AND coalesce(lastProgressAt, startedAt) is stale past
 *                BACKUP_OFFLINE_GRACE_MS
 *  C (absolute): no progress signal was ever reported (legacy agent) and
 *                startedAt is stale past BACKUP_ABSOLUTE_TIMEOUT_MS
 *
 * A `pending` job is reaped when createdAt is stale past
 * BACKUP_PENDING_TIMEOUT_MS (dispatch never completed).
 *
 * Per reaped running job on an online device: best-effort
 * queueBackupStopCommand so a live-but-silent agent stops uploading.
 */
export async function reapStaleBackupJobs(): Promise<number> {
  const now = Date.now();
  let reaped = 0;

  // Conservative SQL pre-filter on the loosest (smallest) of the three
  // running-job thresholds; precise per-row logic below picks the actual
  // rule (mirrors the SHORTEST_TIMEOUT_MS pattern used elsewhere in this
  // file) — precise filtering happens in JS either way, so this only bounds
  // the candidate set size.
  const conservativeCutoff = new Date(now - BACKUP_OFFLINE_GRACE_MS);

  const runningCandidates = await db
    .select({
      id: backupJobs.id,
      deviceId: backupJobs.deviceId,
      lastProgressAt: backupJobs.lastProgressAt,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      errorLog: backupJobs.errorLog,
      deviceStatus: devices.status,
      deviceLastSeenAt: devices.lastSeenAt,
    })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(
      and(
        eq(backupJobs.status, 'running'),
        // Fall back to createdAt so a `running` row with BOTH last_progress_at
        // and started_at NULL is still a candidate (createdAt is NOT NULL) —
        // otherwise COALESCE(null, null) is NULL, the `< cutoff` is never true,
        // and the row is an unreapable zombie.
        sql`COALESCE(${backupJobs.lastProgressAt}, ${backupJobs.startedAt}, ${backupJobs.createdAt}) < ${conservativeCutoff.toISOString()}`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  for (const job of runningCandidates) {
    if (reaped >= MAX_REAP_PER_RUN) break;

    // createdAt is NOT NULL, so progressRef is always defined even for a row
    // whose last_progress_at and started_at are both NULL (the zombie case).
    const progressRef = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
    if (!progressRef) continue;

    const deviceOffline = isDeviceOfflineForReap(job.deviceStatus, job.deviceLastSeenAt);

    let errorMsg: string | null = null;
    if (job.lastProgressAt && now - job.lastProgressAt.getTime() > BACKUP_STALL_TIMEOUT_MS) {
      errorMsg = 'Backup stalled: no progress reported for 15 minutes';
    } else if (deviceOffline && now - progressRef.getTime() > BACKUP_OFFLINE_GRACE_MS) {
      errorMsg = 'Device went offline during backup';
    } else if (!job.lastProgressAt && now - progressRef.getTime() > BACKUP_ABSOLUTE_TIMEOUT_MS) {
      // No progress signal ever (legacy agent) OR a zombie with no started_at —
      // reap on the absolute cap against progressRef (started_at ?? createdAt).
      errorMsg = 'Backup timed out (no completion after 24h)';
    }

    if (!errorMsg) continue;

    const wasReaped = await reapBackupJobRow(job.id, job.errorLog, errorMsg);
    if (!wasReaped) continue; // concurrent terminal transition won the race
    reaped++;

    if (!deviceOffline) {
      try {
        await queueBackupStopCommand(job.deviceId, { jobId: job.id });
      } catch (err) {
        console.warn(`[StaleCommandReaper] Failed to queue backup_stop for reaped backup job ${job.id}:`, err);
      }
    }
  }

  const pendingCutoff = new Date(now - BACKUP_PENDING_TIMEOUT_MS);
  // Queued acknowledgements / progress keep a `pending` job alive by bumping
  // last_progress_at WITHOUT promoting it to `running`, so a pending job that is
  // still receiving progress pings is alive and must NOT be reaped on createdAt
  // alone. Spare any pending job whose last_progress_at is recent (within the
  // stall window).
  const pendingProgressCutoff = new Date(now - BACKUP_STALL_TIMEOUT_MS);
  const pendingCandidates = await db
    .select({
      id: backupJobs.id,
      deviceId: backupJobs.deviceId,
      errorLog: backupJobs.errorLog,
      createdAt: backupJobs.createdAt,
      lastProgressAt: backupJobs.lastProgressAt,
      deviceStatus: devices.status,
      deviceLastSeenAt: devices.lastSeenAt,
      deviceBackupVersion: devices.backupVersion,
    })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(
      and(
        eq(backupJobs.status, 'pending'),
        lt(backupJobs.createdAt, pendingCutoff),
        sql`(${backupJobs.lastProgressAt} IS NULL OR ${backupJobs.lastProgressAt} < ${pendingProgressCutoff.toISOString()})`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  for (const job of pendingCandidates) {
    if (reaped >= MAX_REAP_PER_RUN) break;
    if (now - job.createdAt.getTime() < BACKUP_PENDING_TIMEOUT_MS) continue;
    // A pending job still being kept alive by recent progress pings is not dead.
    if (job.lastProgressAt && now - job.lastProgressAt.getTime() < BACKUP_STALL_TIMEOUT_MS) continue;

    const wasReaped = await reapBackupJobRow(job.id, job.errorLog, 'Backup dispatch never completed');
    if (!wasReaped) continue;
    reaped++;

    // Pending can now mean admitted to the helper FIFO. Reconcile the helper
    // too, otherwise a stale waiter runs after its row failed and produces an
    // orphaned backup. The job ID keeps the stop from touching another
    // workload on the device — but only a queue-capable helper honours it; a
    // pre-queue helper treats every backup_stop as device-wide and would kill
    // whatever is actually running. So send it when either the persisted
    // admission ack proves the helper speaks the protocol, or the device's
    // reported helper version does (covers an ack lost on the agent WS).
    const deviceOffline = isDeviceOfflineForReap(job.deviceStatus, job.deviceLastSeenAt);
    const helperQueues = !!job.lastProgressAt || backupHelperSupportsQueue(job.deviceBackupVersion);
    if (deviceOffline || !helperQueues) {
      if (!deviceOffline) {
        console.warn(`[StaleCommandReaper] Reaped pending backup job ${job.id} without helper reconciliation (helper ${job.deviceBackupVersion ?? 'unknown'} predates the execution queue)`);
      }
      continue;
    }
    try {
      await queueBackupStopCommand(job.deviceId, { jobId: job.id });
    } catch (err) {
      console.warn(`[StaleCommandReaper] Failed to cancel queued backup job ${job.id}:`, err);
    }
  }

  if (reaped > 0) {
    console.log(`[StaleCommandReaper] Reaped ${reaped} stale/orphaned backup jobs`);
  }

  return reaped;
}

// ── Worker & queue management ─────────────────────────────────────

/**
 * The reaper's domains, in run order. Module-scope and exported so the set is
 * assertable without constructing a BullMQ worker — a domain that exists but is
 * never registered reaps nothing, and that omission is invisible to every test
 * of the function itself.
 *
 * `scriptCancellations` runs AFTER `scriptExecutions` on purpose: a cancel it
 * reverts lands back in the `pending|queued|running` predicate, and the next
 * cycle (not this one) is where the script reaper should judge its deadline.
 */
export const REAPER_DOMAINS = [
  ['deviceCommands', reapStaleDeviceCommands],
  ['scriptExecutions', reapStaleScriptExecutions],
  ['scriptCancellations', reapStaleCancellations],
  ['patchJobResults', reapStalePatchJobResults],
  ['deploymentDevices', reapStaleDeploymentDevices],
  ['softwareDeploymentResults', reapStaleSoftwareDeploymentResults],
  ['remoteSessions', reapStaleRemoteSessions],
  ['backupJobs', reapStaleBackupJobs],
] as const;

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (job: Job<ReaperJobData>) => {
      const results: Record<string, number> = {};

      const domains = REAPER_DOMAINS;

      // Each domain runs in its own transaction so a failure in one
      // doesn't abort the Postgres transaction for the others.
      for (const [name, fn] of domains) {
        try {
          results[name] = await runWithSystemDbAccess(fn);
        } catch (err) {
          console.error(`[StaleCommandReaper] Error reaping ${name}:`, err);
          captureException(err instanceof Error ? err : new Error(String(err)));
          results[name] = -1;
        }
      }

      const total = Object.values(results).filter((n) => n > 0).reduce((a, b) => a + b, 0);
      if (total > 0) {
        console.log(
          `[StaleCommandReaper] Reaped ${total} stale items:`,
          Object.entries(results)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}=${n}`)
            .join(', '),
        );
      }

      // Log and escalate failures
      const failures = Object.entries(results).filter(([, n]) => n === -1);
      if (failures.length > 0) {
        console.error(
          `[StaleCommandReaper] ${failures.length}/${domains.length} domains failed:`,
          failures.map(([k]) => k).join(', '),
        );
      }
      if (failures.length === domains.length) {
        throw new Error(`All reaper domains failed: ${failures.map(([k]) => k).join(', ')}`);
      }

      return results;
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  // Remove any existing repeatable jobs (in case interval changed)
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-stale-commands') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'reap-stale-commands',
    { type: 'reap-stale-commands', queuedAt: new Date().toISOString() },
    {
      jobId: 'stale-command-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeStaleCommandReaper(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[StaleCommandReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[StaleCommandReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[StaleCommandReaper] Initialized');
}

export async function shutdownStaleCommandReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try { await worker.close(); } catch (err) {
      console.error('[StaleCommandReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try { await queue.close(); } catch (err) {
      console.error('[StaleCommandReaper] Error closing queue:', err);
    }
  }
}
