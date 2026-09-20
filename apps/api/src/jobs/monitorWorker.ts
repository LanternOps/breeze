/**
 * Network Monitor Worker
 *
 * BullMQ worker that dispatches network check commands to agents
 * and processes results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { networkMonitors, networkMonitorResults, devices, networkMonitorAlertRules, alerts, discoveredAssets, organizations } from '../db/schema';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { isReusableState } from '../services/bullmqUtils';
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import { buildMonitorCommand } from '../services/monitorCommands';
import { isCooldownActive, setCooldown } from '../services/alertCooldown';
import { resolveAlert, createSourcedAlert } from '../services/alertService';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  monitorQueueJobDataSchema,
  type MonitorQueueJobData,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';
import { redactOptionalSecretText, redactSecretsDeep } from '../services/secretRedaction';
import { monitorRequestUrl, readTlsObservation, tlsObservationUpdate } from '../services/monitors/tlsObservation';
import { selectMonitorExecutor } from '../services/networkExecutorSelection';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const MONITOR_QUEUE = 'monitors';

let monitorQueue: Queue | null = null;

export function getMonitorQueue(): Queue {
  if (!monitorQueue) {
    monitorQueue = createInstrumentedQueue(MONITOR_QUEUE);
  }
  return monitorQueue;
}

// Job data types

interface CheckMonitorJobData {
  type: 'check-monitor';
  monitorId: string;
  orgId: string;
}

export interface MonitorCheckResult {
  monitorId: string;
  checkId?: string;
  status: 'online' | 'offline' | 'degraded';
  responseMs: number;
  statusCode?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface ProcessCheckResultJobData {
  type: 'process-check-result';
  monitorId: string;
  result: MonitorCheckResult;
  /** #5291 W04 - the org the probe ran for (the reporting device's org). */
  orgId?: string;
  /** #5291 W04 - the device that ran the probe. */
  deviceId?: string;
}

interface MonitorSchedulerJobData {
  type: 'monitor-scheduler';
}

type MonitorJobData = MonitorQueueJobData;

const MONITOR_ALERT_COOLDOWN_MINUTES = 5;
/** #5291 W04 - fan-out cap for one partner-wide network check, per tick. */
const PARTNER_FANOUT_ORG_LIMIT = 500;
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

const MONITOR_DISPATCH_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitor:check-monitor',
};

const MONITOR_RESULT_META: QueueActorMeta = {
  actorType: 'agent',
  actorId: null,
  source: 'route:agentWs:monitor-result',
};

const MONITOR_REPEATABLE_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitor:scheduler',
};

function createMonitorWorker(): Worker<MonitorJobData> {
  return new Worker<MonitorJobData>(
    MONITOR_QUEUE,
    async (job: Job<MonitorJobData>) => {
      const data = parseQueueJobData(MONITOR_QUEUE, job, monitorQueueJobDataSchema);
      switch (data.type) {
        case 'monitor-scheduler':
          assertQueueJobName(MONITOR_QUEUE, job, 'monitor-scheduler');
          // Self-manages its DB context: reads due monitors in a SHORT context,
          // then runs the Redis enqueue loop OUTSIDE any transaction. A blanket
          // wrap here would pin a pooled connection idle-in-transaction for the
          // whole enqueue loop (~20s on the EU fleet), starving the pool (#1105).
          return await processScheduler();
        case 'check-monitor':
          // NOT wrapped in runWithSystemDbAccess here (final-review fix,
          // #4084/#1105): processCheckMonitor calls the agentCommandRelay
          // facade (isAgentConnectedAnywhere, dispatchCommandToAgent — Redis/WS
          // I/O), and manages its own short-lived system DB context around
          // just its reads, closing it before that I/O runs.
          assertQueueJobName(MONITOR_QUEUE, job, 'check-monitor');
          return await processCheckMonitor(data);
        case 'process-check-result':
          return await runWithSystemDbAccess(() => {
            assertQueueJobName(MONITOR_QUEUE, job, 'process-check-result');
            return processCheckResult(data);
          });
        default:
          throw new Error(`Unknown job type: ${(data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

/**
 * Outcome of the check-monitor read phase (#1105 final-review fix, #4084).
 * Discriminated so the monitor-missing / inactive / ok branches read the
 * cause off the type rather than off guard order.
 */
type CheckMonitorInputs =
  | { status: 'monitor-missing' }
  | { status: 'inactive' }
  // #5291 W04 - the job named an org that is neither the monitor's own org nor
  // an org under its partner. A forged or stale queue payload must not be able
  // to run one tenant's check against another tenant's device.
  | { status: 'org-mismatch' }
  | { status: 'ok'; monitor: typeof networkMonitors.$inferSelect; agentId: string | null };

/**
 * #5291 W04 - the ONE org a check-monitor job runs for.
 *
 * For an org-owned monitor that is `monitor.orgId` and the job must agree. For
 * a partner-wide monitor (`org_id NULL`) the scheduler fanned one job out per
 * org under `monitor.partnerId`, so the running org comes from the JOB and is
 * verified here against the partner before any device is selected.
 *
 * Returns false on any mismatch - and on a lookup MISS, which is a deny: an
 * org row that cannot be read under the worker's own context is not evidence
 * of membership.
 */
async function jobOrgIsAuthorized(
  monitor: { orgId: string | null; partnerId: string | null },
  jobOrgId: string,
): Promise<boolean> {
  if (monitor.orgId !== null) return monitor.orgId === jobOrgId;
  if (!monitor.partnerId) return false;
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, jobOrgId), eq(organizations.partnerId, monitor.partnerId)))
    .limit(1);
  return !!org;
}

/**
 * Phase 1 of a check-monitor job: read the monitor row and select the
 * execution agent inside ONE short system DB context. Nothing here talks to
 * Redis or the agent WebSocket, so the pooled connection is released before
 * the connectivity check and dispatch (#1105).
 */
async function loadCheckMonitorInputs(data: CheckMonitorJobData, selectedAgentId?: string): Promise<CheckMonitorInputs> {
  const [monitor] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, data.monitorId))
    .limit(1);

  if (!monitor) {
    return { status: 'monitor-missing' };
  }

  if (!monitor.isActive) {
    return { status: 'inactive' };
  }

  if (!(await jobOrgIsAuthorized(monitor, data.orgId))) {
    return { status: 'org-mismatch' };
  }

  // The probe device comes from the RUNNING org (data.orgId), never from
  // monitor.orgId - which is NULL for a partner-wide check and would silently
  // match no device at all.
  const agentId = await selectExecutionAgentForMonitor({ orgId: data.orgId, assetId: monitor.assetId, siteId: monitor.siteId }, selectedAgentId);
  return { status: 'ok', monitor, agentId };
}

export async function processCheckMonitor(data: CheckMonitorJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  // Phase 1 — the monitor read and agent selection inside ONE short system DB
  // context, which then CLOSES.
  const inputs = await runWithSystemDbAccess(() => loadCheckMonitorInputs(data));

  switch (inputs.status) {
    case 'monitor-missing':
      console.error(`[MonitorWorker] Monitor ${data.monitorId} not found`);
      return { dispatched: false, agentId: null };
    case 'inactive':
      console.log(`[MonitorWorker] Monitor ${data.monitorId} is inactive, skipping check`);
      return { dispatched: false, agentId: null };
    case 'org-mismatch':
      console.warn(
        `[MonitorWorker] Dropping check job for monitor ${data.monitorId}: org ${data.orgId} is neither its own org nor an org under its partner`
      );
      return { dispatched: false, agentId: null };
  }

  const { agentId } = inputs;

  // Phase 2 — connectivity check and the agent WebSocket dispatch, both with
  // NO DB context open (#1105). dispatchCommandToAgent does Redis/WS I/O via
  // the agentCommandRelay facade; holding a transaction across it is what
  // pinned pooled connections idle-in-transaction.
  if (!agentId || !(await isAgentConnectedAnywhere(agentId))) {
    console.warn(`[MonitorWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  // Revalidate after connectivity I/O, in a fresh short DB context. Pin the
  // previous executor so a changed scope cannot silently select a replacement.
  const current = await runWithSystemDbAccess(() => loadCheckMonitorInputs(data, agentId));
  if (current.status !== 'ok' || current.agentId !== agentId) {
    return { dispatched: false, agentId: null };
  }
  const command = buildMonitorCommand(current.monitor);
  const outcome = await dispatchCommandToAgent(agentId, command, { priority: 'probe' });

  if (outcome.status !== 'sent') {
    console.error(`[MonitorWorker] Check dispatch ${outcome.status} for agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[MonitorWorker] Check dispatched to agent ${agentId} for monitor ${data.monitorId} (${outcome.via})`);
  return { dispatched: true, agentId };
}

function parseNumericThreshold(threshold: string | null | undefined): number | null {
  if (typeof threshold !== 'string' || threshold.trim().length === 0) return null;
  const parsed = Number(threshold);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Kept as a named export because monitorWorker.test.ts and
 * monitorWorker.dbcontext.test.ts assert on it directly. The rules now live in
 * services/networkExecutorSelection.ts, shared with routes/monitors.ts and the
 * manual probe (spec §5).
 */
export async function selectExecutionAgentForMonitor(
  monitor: { orgId: string; assetId: string | null; siteId?: string | null },
  agentId?: string,
): Promise<string | null> {
  const pick = await selectMonitorExecutor(monitor, { agentId });
  return 'agentId' in pick ? pick.agentId : null;
}

async function resolveMonitorAlertDevice(
  monitor: {
    /** The RUNNING org (#5291 W04), not necessarily the definition's owner. */
    orgId: string;
    assetId: string | null;
  }
): Promise<string | null> {
  let preferredSiteId: string | null = null;

  if (monitor.assetId) {
    const [asset] = await db
      .select({
        linkedDeviceId: discoveredAssets.linkedDeviceId,
        siteId: discoveredAssets.siteId
      })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, monitor.assetId), eq(discoveredAssets.orgId, monitor.orgId)))
      .limit(1);

    if (asset?.linkedDeviceId) {
      return asset.linkedDeviceId;
    }

    preferredSiteId = asset?.siteId ?? null;
  }

  if (preferredSiteId) {
    const [siteDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.orgId, monitor.orgId),
        eq(devices.isEphemeral, false),
        eq(devices.siteId, preferredSiteId)
      ))
      .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
      .limit(1);

    if (siteDevice?.id) {
      return siteDevice.id;
    }
  }

  const [orgDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, monitor.orgId), eq(devices.isEphemeral, false)))
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(1);

  return orgDevice?.id ?? null;
}

function getMonitorAlertConditionState(
  rule: typeof networkMonitorAlertRules.$inferSelect,
  result: MonitorCheckResult,
  monitor: { consecutiveFailures: number; name: string; target: string; monitorType: string }
): { matched: boolean; detail: string } {
  switch (rule.condition) {
    case 'offline':
      return {
        matched: result.status === 'offline',
        detail: `Monitor ${monitor.name} is offline`
      };
    case 'degraded':
      return {
        matched: result.status === 'degraded',
        detail: `Monitor ${monitor.name} is degraded`
      };
    case 'response_time_gt': {
      const threshold = parseNumericThreshold(rule.threshold);
      return {
        matched: threshold !== null && result.responseMs > threshold,
        detail: `Response time ${result.responseMs}ms exceeded threshold ${threshold ?? 'n/a'}ms`
      };
    }
    case 'consecutive_failures_gt': {
      const threshold = parseNumericThreshold(rule.threshold);
      return {
        matched: threshold !== null && monitor.consecutiveFailures > threshold,
        detail: `Consecutive failures ${monitor.consecutiveFailures} exceeded threshold ${threshold ?? 'n/a'}`
      };
    }
    default:
      return { matched: false, detail: `Unsupported monitor condition ${rule.condition}` };
  }
}

async function evaluateMonitorAlertRules(
  monitor: typeof networkMonitors.$inferSelect,
  result: MonitorCheckResult,
  /**
   * #5291 W04 - the org this check RAN for. Equals `monitor.orgId` for an
   * org-owned monitor; for a partner-wide one it is the fanned-out org, and
   * `monitor.orgId` is NULL. Every device, dedupe and alert read below uses
   * this, never the definition owner.
   */
  runningOrgId: string,
): Promise<void> {
  const rules = await db
    .select()
    .from(networkMonitorAlertRules)
    .where(and(
      eq(networkMonitorAlertRules.monitorId, monitor.id),
      eq(networkMonitorAlertRules.isActive, true)
    ));

  if (rules.length === 0) return;

  const alertDeviceId = await resolveMonitorAlertDevice({ orgId: runningOrgId, assetId: monitor.assetId });
  if (!alertDeviceId) {
    console.warn(`[MonitorWorker] Skipping alert evaluation for monitor ${monitor.id}: no device context available`);
    return;
  }

  for (const rule of rules) {
    const condition = getMonitorAlertConditionState(rule, result, monitor);
    const matchingAlerts = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(
        eq(alerts.orgId, runningOrgId),
        eq(alerts.deviceId, alertDeviceId),
        inArray(alerts.status, ['active', 'acknowledged']),
        sql`${alerts.context}->>'source' = 'network_monitor'`,
        sql`${alerts.context}->>'monitorId' = ${monitor.id}`,
        sql`${alerts.context}->>'alertRuleId' = ${rule.id}`
      ));

    if (condition.matched && matchingAlerts.length > 0) {
      continue;
    }

    if (!condition.matched) {
      for (const existingAlert of matchingAlerts) {
        await resolveAlert(
          existingAlert.id,
          `Auto-resolved after monitor ${monitor.name} recovered from ${rule.condition}`
        );
      }
      continue;
    }

    if (await isCooldownActive(rule.id, alertDeviceId)) {
      continue;
    }

    const title = `${monitor.name} ${rule.condition.replace(/_/g, ' ')}`;
    const message = rule.message
      ?? `${condition.detail}. Target: ${monitor.target}. Status: ${result.status}.`;

    // #5241: route through the shared create+publish path. A raw
    // `db.insert(alerts)` here left the alert visible only in the inbox —
    // notifications, escalation, automations and AI verdicts all hang off the
    // `alert.triggered` event this publishes. Dedupe/cooldown stay above,
    // keyed on the monitor alert rule rather than an `alertRules` row.
    const alertId = await createSourcedAlert({
      deviceId: alertDeviceId,
      // Alert rows always take the DEVICE's org. `runningOrgId` IS that org:
      // resolveMonitorAlertDevice only returns devices in it, and for a
      // partner-wide monitor it is the org the job fanned out to, never the
      // (NULL) definition owner. #5291 W04.
      orgId: runningOrgId,
      severity: rule.severity,
      title,
      message,
      context: {
        source: 'network_monitor',
        monitorId: monitor.id,
        alertRuleId: rule.id,
        monitorType: monitor.monitorType,
        target: monitor.target,
        status: result.status,
        responseMs: result.responseMs,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
        threshold: rule.threshold ?? null
      },
      publisher: 'monitor-worker',
      // `source` is supplied by createSourcedAlert from `context.source`.
      eventPayload: {
        monitorId: monitor.id,
        alertRuleId: rule.id,
        monitorType: monitor.monitorType,
        target: monitor.target
      }
    });

    if (!alertId) {
      // Insert produced no row, so nothing was published. Leave the cooldown
      // unset so the next check retries instead of silently swallowing the
      // breach for the whole cooldown window.
      console.error(
        `[MonitorWorker] Failed to create alert for monitor ${monitor.id} rule ${rule.id}; will retry on next check`
      );
      continue;
    }

    await setCooldown(rule.id, alertDeviceId, MONITOR_ALERT_COOLDOWN_MINUTES);
  }
}

export async function recordMonitorCheckResult(
  monitorId: string,
  result: MonitorCheckResult,
  /**
   * #5291 W04 - who actually ran the probe. The reporting agent's device and
   * ITS org, which for a partner-wide monitor is the fanned-out org rather
   * than the (NULL) definition owner. Optional so an in-flight queue payload
   * enqueued before this wave still records; when absent the monitor's own
   * org is used, which is correct for every org-owned monitor.
   */
  reporter?: { orgId?: string | null; deviceId?: string | null },
): Promise<void> {
  // #2434 chokepoint: monitor check results arrive from agents (the WS
  // Redis-down direct path AND the BullMQ process-check-result path both
  // funnel here). The free-text `error` and the raw `details` blob are
  // persisted to network_monitor_results / network_monitors.lastError /
  // alert details and surfaced in the web UI — redact secrets once at entry
  // so every write below (results insert, monitor state, alert evaluation)
  // is covered.
  result = {
    ...result,
    error: redactOptionalSecretText(result.error),
    details: result.details != null
      ? redactSecretsDeep(result.details) as Record<string, unknown>
      : result.details,
  };
  const now = new Date();

  // Resolve the org the result belongs to BEFORE the insert. The reporter
  // carries it on both normal paths, but the Redis-down direct path
  // (agentWs.ts) resolves it from a live `devices` read that can miss if the
  // device row was removed mid-session — and an org-owned monitor's result
  // written with org_id NULL is invisible to every org-scoped reader, i.e. it
  // silently disappears from that customer's history. Falling back to the
  // monitor's own org is exact for an org-owned monitor; a partner-wide one
  // genuinely has no org to fall back to and is handled below.
  let runningOrgId = reporter?.orgId ?? null;
  if (!runningOrgId) {
    const [owner] = await db
      .select({ orgId: networkMonitors.orgId })
      .from(networkMonitors)
      .where(eq(networkMonitors.id, monitorId))
      .limit(1);
    runningOrgId = owner?.orgId ?? null;
  }

  // Use a transaction to keep results table and monitor state in sync
  await db.transaction(async (tx) => {
    // Write to results table
    await tx.insert(networkMonitorResults).values({
      monitorId,
      // Worker-created child rows take the DEVICE's org (#5291 W04), with the
      // monitor's own org as the fallback resolved above. NULL here means the
      // monitor is partner-wide AND the reporter carried no device org, which
      // is the one case where there is genuinely no tenant to attribute to.
      orgId: runningOrgId,
      deviceId: reporter?.deviceId ?? null,
      status: result.status,
      responseMs: result.responseMs ?? null,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      details: result.details ?? null,
      timestamp: now
    });

    // #5754 provenance guard. Only read when the result actually carries an
    // observation, so every icmp/dns/tcp check keeps its current statement
    // count. `FOR UPDATE` is what makes it a guard rather than a hint: a
    // concurrent `PATCH /monitors/:id` either commits first (and we read its
    // new URL, so this stale result is dropped) or blocks until we commit
    // (and its own tls reset then clears whatever we wrote). Without the lock
    // the read could be taken just before an edit lands and the check would
    // pass on data that is already stale.
    let tlsGuard: { expectedRequestUrl?: string | null; monitorId: string } = { monitorId };
    if (readTlsObservation(result.details)) {
      const [current] = await tx
        .select({ target: networkMonitors.target, config: networkMonitors.config })
        .from(networkMonitors)
        .where(eq(networkMonitors.id, monitorId))
        .for('update')
        .limit(1);
      // A missing row means the monitor was deleted mid-flight; `null` still
      // fails the equality check, so the observation is dropped.
      tlsGuard = {
        monitorId,
        expectedRequestUrl: current ? monitorRequestUrl(current) : null,
      };
    }

    // Update monitor state
    const isFailure = result.status === 'offline';
    const updateSet: Record<string, unknown> = {
      lastChecked: now,
      lastStatus: result.status,
      lastResponseMs: result.responseMs ?? null,
      lastError: result.error ?? null,
      updatedAt: now,
      // #5754: the TLS observation joins THIS updateSet rather than a second
      // statement, so the certificate reading and the check it came from can
      // never disagree. The fragment is empty for any result carrying no
      // `sslState` — every icmp/dns/tcp check, and every agent predating the
      // wave — so those never clear a good observation. It is written on the
      // `network_monitors` DEFINITION row, so for a partner-wide monitor
      // (org_id NULL, fanned out to many orgs) the last reporting org wins;
      // harmless today because loadExpiringCerts reads org-owned rows only.
      ...tlsObservationUpdate(result.details, now, tlsGuard),
    };

    if (isFailure) {
      updateSet.consecutiveFailures = sql`${networkMonitors.consecutiveFailures} + 1`;
    } else {
      updateSet.consecutiveFailures = 0;
    }

    await tx
      .update(networkMonitors)
      .set(updateSet)
      .where(eq(networkMonitors.id, monitorId));
  });

  const [monitor] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, monitorId))
    .limit(1);

  if (!monitor) return;

  // A partner-wide monitor owns no org, so if the reporter carried none either
  // there is nothing to attribute an alert to - skip rather than guess a tenant.
  if (!runningOrgId) {
    console.warn(
      `[MonitorWorker] Skipping alert evaluation for partner-wide monitor ${monitor.id}: result carried no reporting org`
    );
    return;
  }

  await evaluateMonitorAlertRules(monitor, result, runningOrgId);
}

async function processCheckResult(data: ProcessCheckResultJobData): Promise<{
  resultWritten: boolean;
}> {
  // #5291 W04 - a payload enqueued before this wave carries neither orgId nor
  // deviceId. Resolve the org from the monitor then; for an org-owned monitor
  // that IS the running org, and a partner-wide monitor cannot have such a
  // payload because it did not exist before this wave.
  let orgId = data.orgId ?? null;
  if (!orgId) {
    const [owner] = await runWithSystemDbAccess(() =>
      db
        .select({ orgId: networkMonitors.orgId })
        .from(networkMonitors)
        .where(eq(networkMonitors.id, data.monitorId))
        .limit(1)
    );
    orgId = owner?.orgId ?? null;
  }

  await recordMonitorCheckResult(data.monitorId, data.result, { orgId, deviceId: data.deviceId ?? null });

  console.log(`[MonitorWorker] Result recorded for monitor ${data.monitorId}: ${data.result.status}`);
  return { resultWritten: true };
}

/**
 * Every (monitor, org) pair due for a check right now (#5291 W04).
 *
 * Split out of `processScheduler` so the fan-out can be proven against REAL
 * Postgres under REAL RLS without a Redis/BullMQ stack — see
 * networkMonitorPartnerRls.integration.test.ts. Pure reads, no side effects.
 */
export async function selectDueMonitorJobs(
  now: Date = new Date(),
): Promise<Array<{ monitorId: string; orgId: string }>> {
  // Read due monitors inside a short system DB context, then let it CLOSE. The
  // caller's enqueue loop is pure Redis/BullMQ work; holding the context across
  // it would pin a pooled connection idle-in-transaction for the whole loop,
  // starving the connection pool (#1105).
  const dueMonitors = await runWithSystemDbAccess(() =>
    db
      .select({
        id: networkMonitors.id,
        orgId: networkMonitors.orgId,
        partnerId: networkMonitors.partnerId,
        pollingInterval: networkMonitors.pollingInterval,
        lastChecked: networkMonitors.lastChecked
      })
      .from(networkMonitors)
      .where(
        and(
          eq(networkMonitors.isActive, true),
          sql`(${networkMonitors.lastChecked} IS NULL OR ${networkMonitors.lastChecked} + make_interval(secs => ${networkMonitors.pollingInterval}) <= ${now.toISOString()})`
        )
      )
  );

  if (dueMonitors.length === 0) return [];

  // #5291 W04 - expand each due monitor into the orgs it must run FOR. An
  // org-owned row is itself; a partner-wide row (org_id NULL) fans out one job
  // per org under its partner. Without this a partner-wide row would enqueue
  // `orgId: null` and every downstream read would match nothing SILENTLY.
  const partnerIds = [...new Set(
    dueMonitors.filter((m) => m.orgId === null && m.partnerId).map((m) => m.partnerId as string)
  )];
  const orgsByPartner = new Map<string, string[]>();
  if (partnerIds.length > 0) {
    const rows = await runWithSystemDbAccess(() =>
      db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(inArray(organizations.partnerId, partnerIds))
    );
    for (const row of rows) {
      if (!row.partnerId) continue;
      const list = orgsByPartner.get(row.partnerId) ?? [];
      list.push(row.id);
      orgsByPartner.set(row.partnerId, list);
    }
  }

  const jobs: Array<{ monitorId: string; orgId: string }> = [];
  for (const monitor of dueMonitors) {
    if (monitor.orgId !== null) {
      jobs.push({ monitorId: monitor.id, orgId: monitor.orgId });
      continue;
    }
    if (!monitor.partnerId) {
      console.warn(`[MonitorWorker] Monitor ${monitor.id} has neither org nor partner owner; skipping`);
      continue;
    }
    const orgIds = orgsByPartner.get(monitor.partnerId) ?? [];
    if (orgIds.length > PARTNER_FANOUT_ORG_LIMIT) {
      // One misconfigured partner-wide check must not be able to flood the
      // queue with thousands of jobs every polling interval.
      console.error(
        `[MonitorWorker] Partner-wide monitor ${monitor.id} fans out to ${orgIds.length} orgs (> ${PARTNER_FANOUT_ORG_LIMIT}); skipping`
      );
      continue;
    }
    for (const orgId of orgIds) jobs.push({ monitorId: monitor.id, orgId });
  }

  return jobs;
}

export async function processScheduler(): Promise<{ enqueued: number }> {
  const jobs = await selectDueMonitorJobs();
  if (jobs.length === 0) return { enqueued: 0 };

  // Phase 2 — enqueue checks with NO DB context open (pure Redis/BullMQ).
  let enqueued = 0;
  for (const job of jobs) {
    try {
      await enqueueMonitorCheck(job.monitorId, job.orgId);
      enqueued++;
    } catch (err) {
      console.error(`[MonitorWorker] Failed to enqueue check for monitor ${job.monitorId}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[MonitorWorker] Scheduler enqueued ${enqueued} monitor checks`);
  }
  return { enqueued };
}

export async function enqueueMonitorCheck(
  monitorId: string,
  orgId: string,
  meta: QueueActorMeta = MONITOR_DISPATCH_META,
): Promise<string> {
  const queue = getMonitorQueue();
  // #5291 W04 — the org is PART OF THE KEY. A partner-wide monitor fans out one
  // job per org under the partner in a single scheduler tick; with a
  // monitor-only key the first org's job would still be `waiting` when the
  // second org's call arrived, `isReusableState` would return that job id, and
  // orgs 2..N would silently never be enqueued at all — the exact no-error
  // no-op class this wave exists to remove. The key was correct before W04,
  // when one network_monitors row was always exactly one org.
  const stableJobId = `monitor-check-${monitorId}-${orgId}`;
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id as string;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    }
  }

  const job = await queue.add(
    'check-monitor',
    monitorQueueJobDataSchema.parse(withQueueMeta({ type: 'check-monitor', monitorId, orgId }, meta)),
    {
      jobId: stableJobId,
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

export async function enqueueMonitorCheckResult(
  monitorId: string,
  result: MonitorCheckResult,
  meta: QueueActorMeta = MONITOR_RESULT_META,
  /** #5291 W04 - the reporting device and ITS org; stamped on the result row. */
  reporter?: { orgId?: string | null; deviceId?: string | null },
): Promise<string> {
  const queue = getMonitorQueue();
  const stableJobId = result.checkId ? `monitor-result-${result.checkId}` : null;
  if (stableJobId) {
    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        return existing.id as string;
      }
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }
  }
  const job = await queue.add(
    'process-check-result',
    monitorQueueJobDataSchema.parse(
      withQueueMeta({
        type: 'process-check-result',
        monitorId,
        result,
        ...(reporter?.orgId ? { orgId: reporter.orgId } : {}),
        ...(reporter?.deviceId ? { deviceId: reporter.deviceId } : {}),
      }, meta)
    ),
    {
      ...(stableJobId ? { jobId: stableJobId } : {}),
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

async function scheduleMonitorPolling(): Promise<void> {
  const queue = getMonitorQueue();

  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'monitor-scheduler') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'monitor-scheduler',
    monitorQueueJobDataSchema.parse(
      withQueueMeta({ type: 'monitor-scheduler' as const }, MONITOR_REPEATABLE_META)
    ),
    {
      repeat: { every: 30 * 1000 },
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[MonitorWorker] Scheduled repeatable monitor scheduler (every 30s)');
}

let monitorWorkerInstance: Worker<MonitorJobData> | null = null;

export async function initializeMonitorWorker(): Promise<void> {
  try {
    monitorWorkerInstance = createMonitorWorker();
    attachWorkerObservability(monitorWorkerInstance, 'monitorWorker');

    monitorWorkerInstance.on('error', (error) => {
      console.error('[MonitorWorker] Worker error:', error);
    });

    monitorWorkerInstance.on('failed', (job, error) => {
      console.error(`[MonitorWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleMonitorPolling();

    console.log('[MonitorWorker] Monitor worker initialized');
  } catch (error) {
    console.error('[MonitorWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorWorker(): Promise<void> {
  if (monitorWorkerInstance) {
    await monitorWorkerInstance.close();
    monitorWorkerInstance = null;
  }
  if (monitorQueue) {
    await monitorQueue.close();
    monitorQueue = null;
  }
  console.log('[MonitorWorker] Monitor worker shut down');
}
