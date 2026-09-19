/**
 * Script Monitor Worker (#5291 W04)
 *
 * DESIGN — this is the DISPATCH half of the `script` monitor kind; the
 * BREACH/VERDICT half is `alertConditions/handlers/scriptMonitor.ts`. Unlike
 * every other monitor kind (evaluated against data the agent already
 * reports, or an agent-delivered watch), a `script` monitor's evidence does
 * not exist until something runs the probe script — this worker is that
 * "something". It never decides breach/no-breach itself; it only keeps
 * `script_executions` freshly populated for the handler to read. The two
 * halves are deliberately decoupled through that table, not a shared
 * in-memory object, so neither has to assume anything about the other's
 * schedule.
 *
 * DEVICE RESOLUTION is DEVICE-first only, via `resolveMonitorsForDevice`.
 * `alertService.getApplicableRules` faces the identical "which devices does
 * this compiled monitor rule apply to" problem for EVALUATION and solves it
 * the same way: enumerate candidate devices, then ask the resolver whether
 * this monitor is the winner for each one. There is no monitor-first
 * ("which devices does monitor X apply to") index anywhere in this
 * codebase; building one here would be a SECOND resolution algorithm that
 * could drift from the resolver's winner-per-monitor / override semantics
 * (config-policy attachment, closest-wins-per-monitor, parent inheritance).
 *
 * KNOWN INEFFICIENCY: O(candidate devices x resolveMonitorsForDevice's own
 * work) per tick, per monitor — every device in a monitor's owning org(s)
 * gets its FULL monitor set resolved just to check whether one monitor is a
 * winner for it. Acceptable given the monitor cadence (5-1440 minutes,
 * scriptKind's own schema) and the partner fan-out cap below; flagged for
 * the same treatment `monitorWorker.ts` already gives network-monitor
 * partner fan-out if this becomes hot.
 *
 * OVERRIDES: a config-policy attachment can override `intervalMinutes` /
 * `timeoutSeconds` per device (scriptKind.overridableKeys) — see
 * `alertService.ts`'s own `applyOverrides(spec, base, effective.overrides)`
 * call on the EVALUATION side. This worker mirrors that on the DISPATCH
 * side: using the monitor's raw, un-overridden `intervalMinutes` here would
 * desync the two — a device overridden to a SHORTER interval would still
 * only get re-probed on the monitor's baseline cadence, so the handler's
 * staleness window (3x the EFFECTIVE interval) would go stale well before
 * this worker ever dispatches again.
 *
 * REGISTRATION: `initializeMonitorScriptWorker` / `shutdownMonitorScriptWorker`
 * below are wired into `services/workerRegistry.ts` (which decides which
 * process role actually starts a worker) and `jobs/workerReadinessManifest.ts`
 * (which CI asserts covers every `attachWorkerObservability` name). Both edits
 * have to land in the SAME change as the `Worker` itself or
 * workerReadinessCoverage.test.ts / workerReadinessManifest.test.ts fail.
 */
import { Queue, Worker } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as dbModule from '../db';
import { devices, monitorDefinitions, organizations, scriptExecutions, scripts } from '../db/schema';
import { dispatchScriptToDevice } from '../services/scriptDispatch';
import { resolveMonitorsForDevice } from '../services/monitors/monitorResolver';
import { applyOverrides } from '../services/monitors/kinds';
import { scriptKind } from '../services/monitors/kinds/script';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { assertQueueJobName } from '../services/bullmqValidation';
import { withQueueMeta, type QueueActorMeta } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
// Same pattern as monitorWorker.ts: a background worker legitimately reads
// under system scope (never the request-path escalation CLAUDE.md forbids).
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Mirrors monitorWorker.ts's PARTNER_FANOUT_ORG_LIMIT: one misconfigured
// partner-wide script monitor must not be able to flood a single tick with
// thousands of per-device dispatch attempts.
const PARTNER_FANOUT_ORG_LIMIT = 500;

export interface ScriptMonitorTickResult {
  monitorsConsidered: number;
  devicesConsidered: number;
  dispatched: number;
  /** Not due yet, disabled for this device, or dispatchScriptToDevice's own skip (offline/maintenance/decommissioned/etc). */
  skipped: number;
  errors: number;
}

type CandidateDevice = Pick<
  typeof devices.$inferSelect,
  'id' | 'orgId' | 'osType' | 'status' | 'agentId' | 'hostname' | 'siteId' | 'customFields'
>;

/**
 * The orgs a `script` monitor row must be evaluated against: itself, for an
 * org-owned row; every org under its partner, for a partner-wide row (Partner
 * Wide First — CLAUDE.md). Mirrors `monitorWorker.ts`'s identical fan-out for
 * partner-wide network monitors, including the same safety cap.
 */
async function resolveCandidateOrgIds(monitor: {
  id: string;
  orgId: string | null;
  partnerId: string | null;
}): Promise<string[]> {
  if (monitor.orgId) return [monitor.orgId];
  if (!monitor.partnerId) {
    // monitor_definitions_one_owner_chk is supposed to make this unreachable.
    // "Should never happen" is exactly the category this wave stopped trusting
    // silently: unlogged, the monitor would drop out of every tick forever.
    console.warn(
      `[monitorScriptWorker] Monitor ${monitor.id} has neither org nor partner owner; skipping`,
    );
    return [];
  }

  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, monitor.partnerId));

  if (rows.length > PARTNER_FANOUT_ORG_LIMIT) {
    console.error(
      `[monitorScriptWorker] Partner-wide monitor ${monitor.id} fans out to ${rows.length} orgs (> ${PARTNER_FANOUT_ORG_LIMIT}); skipping`,
    );
    return [];
  }
  return rows.map((r) => r.id);
}

/**
 * Whether this device's last dispatch attempt for this monitor is old enough
 * to redispatch. Throttles on `createdAt` (when the dispatch was INITIATED),
 * not `completedAt` — an in-flight run (`completedAt IS NULL`) must still
 * count as "recently dispatched" so this worker never fires a second probe
 * on top of one that just hasn't finished yet. This is a separate question
 * from the scriptMonitor condition handler's own staleness check (which
 * reads `completedAt` and asks "is the newest VERDICT too old"); throttling
 * dispatch and judging staleness are different concerns read off different
 * columns of the same table on purpose.
 */
async function isDeviceDueForProbe(
  monitorId: string,
  deviceId: string,
  intervalMinutes: number,
): Promise<boolean> {
  const [latest] = await db
    .select({ createdAt: scriptExecutions.createdAt })
    .from(scriptExecutions)
    .where(and(eq(scriptExecutions.monitorId, monitorId), eq(scriptExecutions.deviceId, deviceId)))
    .orderBy(desc(scriptExecutions.createdAt))
    .limit(1);

  if (!latest) return true;
  const ageMs = Date.now() - latest.createdAt.getTime();
  return ageMs >= intervalMinutes * 60_000;
}

/**
 * One tick: dispatch the `script` monitor's probe to every device it
 * currently applies to and is due on. Exported bare (no BullMQ) so it is
 * fully testable — see the REGISTRATION NOTE above for why this file stops
 * short of wiring a `Worker` around it.
 */
export async function processScriptMonitorTick(): Promise<ScriptMonitorTickResult> {
  return runWithSystemDbAccess(async () => {
    const result: ScriptMonitorTickResult = {
      monitorsConsidered: 0,
      devicesConsidered: 0,
      dispatched: 0,
      skipped: 0,
      errors: 0,
    };

    const monitorRows = await db
      .select()
      .from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.kind, 'script'), eq(monitorDefinitions.enabled, true)));

    for (const monitor of monitorRows) {
      result.monitorsConsidered++;

      let authoredCondition: ReturnType<(typeof scriptKind)['conditionSchema']['parse']>;
      try {
        authoredCondition = scriptKind.conditionSchema.parse(monitor.condition);
      } catch (err) {
        console.error('[monitorScriptWorker] invalid script monitor condition', {
          monitorId: monitor.id,
          error: err,
        });
        result.errors++;
        continue;
      }

      const orgIds = await resolveCandidateOrgIds(monitor);
      if (orgIds.length === 0) {
        // Either an ownerless row or a fan-out over the cap — both are logged
        // above, and both are operational problems rather than "nothing to do",
        // so the tick result must not report them as a clean zero.
        result.errors++;
        continue;
      }

      const deviceRows: CandidateDevice[] = await db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          osType: devices.osType,
          status: devices.status,
          agentId: devices.agentId,
          hostname: devices.hostname,
          siteId: devices.siteId,
          customFields: devices.customFields,
        })
        .from(devices)
        .where(inArray(devices.orgId, orgIds));

      for (const device of deviceRows) {
        result.devicesConsidered++;

        // Winner-per-monitor resolution (device-first, see header). A
        // disabled-for-this-device winner (an explicit override lower in
        // the hierarchy) contributes no dispatch, same as it contributes no
        // alert rule on the evaluation side. A device that vanished between
        // the query above and here (raced a delete) resolves as
        // `device_missing`, not a fabricated "zero monitors" — same
        // no-dispatch outcome for this tick either way (#5677).
        const resolution = await resolveMonitorsForDevice(device.id);
        const match =
          resolution.kind === 'resolved'
            ? resolution.monitors.find((m) => m.monitorId === monitor.id)
            : undefined;
        if (!match || !match.enabled) {
          result.skipped++;
          continue;
        }

        let effectiveCondition: typeof authoredCondition;
        try {
          effectiveCondition = applyOverrides(scriptKind, authoredCondition, match.overrides);
        } catch (err) {
          console.error('[monitorScriptWorker] override merge failed validation', {
            monitorId: monitor.id,
            deviceId: device.id,
            error: err,
          });
          result.errors++;
          continue;
        }

        const due = await isDeviceDueForProbe(monitor.id, device.id, effectiveCondition.intervalMinutes);
        if (!due) {
          result.skipped++;
          continue;
        }

        const [scriptRow] = await db.select().from(scripts).where(eq(scripts.id, effectiveCondition.scriptId)).limit(1);
        if (!scriptRow) {
          console.error('[monitorScriptWorker] monitor references a missing script', {
            monitorId: monitor.id,
            scriptId: effectiveCondition.scriptId,
          });
          result.errors++;
          continue;
        }

        // Offline devices, maintenance windows, and decommissioning are ALL
        // already handled inside dispatchScriptToDevice — never re-checked
        // here. A refusal there (any `ok: false` code) is an ordinary skip
        // from this worker's point of view, not an error.
        const dispatchResult = await dispatchScriptToDevice({
          device,
          source: { kind: 'saved', script: scriptRow },
          parameters: effectiveCondition.parameters,
          triggerType: 'monitor',
          monitorId: monitor.id,
          timeoutSeconds: effectiveCondition.timeoutSeconds,
        });

        if (dispatchResult.ok) {
          result.dispatched++;
        } else {
          result.skipped++;
        }
      }
    }

    return result;
  });
}


// ---------------------------------------------------------------------------
// BullMQ wiring
// ---------------------------------------------------------------------------

const MONITOR_SCRIPT_QUEUE = 'monitor-scripts';
/**
 * The tick cadence, NOT the probe cadence. A `script` monitor's own
 * `intervalMinutes` (5-1440) is enforced per device by `isDeviceDueForProbe`;
 * this only decides how often we look. One minute keeps the floor honest
 * without making the sweep hot.
 */
const TICK_EVERY_MS = 60 * 1000;

const SCRIPT_MONITOR_TICK_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitorScript:tick',
};

let monitorScriptQueue: Queue | null = null;

function getMonitorScriptQueue(): Queue {
  if (!monitorScriptQueue) {
    monitorScriptQueue = createInstrumentedQueue(MONITOR_SCRIPT_QUEUE);
  }
  return monitorScriptQueue;
}

async function scheduleScriptMonitorTick(): Promise<void> {
  const queue = getMonitorScriptQueue();

  // Re-registering a repeatable job with a changed `every` leaves the OLD
  // schedule running alongside the new one, so clear ours first.
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'monitor-script-tick') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'monitor-script-tick',
    withQueueMeta({ type: 'monitor-script-tick' as const }, SCRIPT_MONITOR_TICK_META),
    {
      repeat: { every: TICK_EVERY_MS },
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    },
  );

  console.log('[monitorScriptWorker] Scheduled repeatable script-monitor tick (every 60s)');
}

let monitorScriptWorkerInstance: Worker | null = null;

export async function initializeMonitorScriptWorker(): Promise<void> {
  try {
    monitorScriptWorkerInstance = new Worker(
      MONITOR_SCRIPT_QUEUE,
      async (job) => {
        assertQueueJobName(MONITOR_SCRIPT_QUEUE, job, 'monitor-script-tick');
        return processScriptMonitorTick();
      },
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(monitorScriptWorkerInstance, 'monitorScriptWorker');

    monitorScriptWorkerInstance.on('error', (error) => {
      console.error('[monitorScriptWorker] Worker error:', error);
    });
    monitorScriptWorkerInstance.on('failed', (job, error) => {
      console.error(`[monitorScriptWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleScriptMonitorTick();

    console.log('[monitorScriptWorker] Script monitor worker initialized');
  } catch (error) {
    console.error('[monitorScriptWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorScriptWorker(): Promise<void> {
  if (monitorScriptWorkerInstance) {
    await monitorScriptWorkerInstance.close();
    monitorScriptWorkerInstance = null;
  }
  if (monitorScriptQueue) {
    await monitorScriptQueue.close();
    monitorScriptQueue = null;
  }
  console.log('[monitorScriptWorker] Script monitor worker shut down');
}
