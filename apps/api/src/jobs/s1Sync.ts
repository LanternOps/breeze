import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  devices,
  deviceNetwork,
  s1Actions,
  s1Agents,
  s1Integrations,
  s1Threats
} from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { decryptSecret } from '../services/secretCrypto';
import { SentinelOneClient, type S1ThreatAction } from '../services/sentinelOne/client';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import {
  recordS1ActionDispatch,
  recordS1ActionPollTransition,
  recordS1SyncRun
} from '../services/sentinelOne/metrics';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[S1SyncJob] withSystemDbAccessContext is unavailable');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const S1_SYNC_QUEUE = 's1-sync';
const AGENT_SYNC_EVERY_MS = 15 * 60 * 1000;
const THREAT_SYNC_EVERY_MS = 5 * 60 * 1000;
const ACTION_POLL_EVERY_MS = 60 * 1000;
const DEFAULT_JOB_ATTEMPTS = 3;
const DEFAULT_JOB_BACKOFF_MS = 2_000;
const MAX_ACTION_POLL_FAILURES = 5;

interface SyncIntegrationJobData {
  type: 'sync-integration';
  integrationId: string;
  syncAgents: boolean;
  syncThreats: boolean;
}

interface SyncAllAgentsJobData {
  type: 'sync-all-agents';
}

interface SyncAllThreatsJobData {
  type: 'sync-all-threats';
}

interface PollActionsJobData {
  type: 'poll-actions';
}

type S1SyncJobData =
  | SyncIntegrationJobData
  | SyncAllAgentsJobData
  | SyncAllThreatsJobData
  | PollActionsJobData;

let s1SyncQueue: Queue<S1SyncJobData> | null = null;
let s1SyncWorker: Worker<S1SyncJobData> | null = null;

interface IntegrationForSync {
  id: string;
  orgId: string;
  managementUrl: string;
  apiTokenEncrypted: string;
  isActive: boolean;
  lastSyncAt: Date | null;
}

type S1ActionStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function toDateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeSeverity(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.includes('critical')) return 'critical';
  if (normalized.includes('high')) return 'high';
  if (normalized.includes('medium')) return 'medium';
  if (normalized.includes('low')) return 'low';
  return 'unknown';
}

export function normalizeThreatStatus(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized.includes('resolved')
    || normalized.includes('mitigated')
    || normalized.includes('clean')
    || normalized.includes('closed')
  ) {
    return 'resolved';
  }
  if (normalized.includes('quarantine')) return 'quarantined';
  if (normalized.includes('in_progress') || normalized.includes('pending')) return 'in_progress';
  return 'active';
}

function isThreatAction(value: string): value is S1ThreatAction {
  return value === 'kill' || value === 'quarantine' || value === 'rollback';
}

function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 2_000);
}

export function dedupeThreatDetections<T extends { s1ThreatId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.s1ThreatId)) continue;
    seen.add(row.s1ThreatId);
    deduped.push(row);
  }
  return deduped;
}

export function applyPollFailure(
  payload: unknown,
  error: unknown,
  maxFailures = MAX_ACTION_POLL_FAILURES
): {
  payload: Record<string, unknown>;
  shouldFail: boolean;
  failureCount: number;
  error: string;
} {
  const current = toObject(payload);
  const priorCountRaw = Number(current.pollFailureCount ?? 0);
  const priorCount = Number.isFinite(priorCountRaw) ? Math.max(0, Math.round(priorCountRaw)) : 0;
  const failureCount = priorCount + 1;
  const errorMessage = truncateError(error);

  current.pollFailureCount = failureCount;
  current.lastPollError = errorMessage;
  current.lastPollAt = new Date().toISOString();

  return {
    payload: current,
    shouldFail: failureCount >= maxFailures,
    failureCount,
    error: errorMessage
  };
}

function getS1SyncQueue(): Queue<S1SyncJobData> {
  if (!s1SyncQueue) {
    s1SyncQueue = new Queue<S1SyncJobData>(S1_SYNC_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return s1SyncQueue;
}

async function addUniqueJob(
  queue: Queue<S1SyncJobData>,
  name: string,
  data: S1SyncJobData,
  jobId: string,
  opts: Omit<JobsOptions, 'jobId'> = {}
): Promise<string> {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (
      state === 'active'
      || state === 'waiting'
      || state === 'delayed'
      || state === 'waiting-children'
      || state === 'prioritized'
    ) {
      return String(existing.id);
    }
    await existing.remove().catch((err) => {
      console.warn(`[S1SyncJob] Failed to remove stale job ${jobId}:`, err instanceof Error ? err.message : err);
    });
  }

  const job = await queue.add(name, data, {
    jobId,
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: DEFAULT_JOB_BACKOFF_MS
    },
    ...opts
  });
  return String(job.id);
}

async function listActiveIntegrations(): Promise<IntegrationForSync[]> {
  return db
    .select({
      id: s1Integrations.id,
      orgId: s1Integrations.orgId,
      managementUrl: s1Integrations.managementUrl,
      apiTokenEncrypted: s1Integrations.apiTokenEncrypted,
      isActive: s1Integrations.isActive,
      lastSyncAt: s1Integrations.lastSyncAt
    })
    .from(s1Integrations)
    .where(eq(s1Integrations.isActive, true));
}

async function mapDeviceCandidates(orgId: string): Promise<{
  byHostname: Map<string, string>;
  byIp: Map<string, string>;
}> {
  const rows = await db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      ipAddress: deviceNetwork.ipAddress
    })
    .from(devices)
    .leftJoin(deviceNetwork, eq(deviceNetwork.deviceId, devices.id))
    .where(eq(devices.orgId, orgId));

  const byHostname = new Map<string, string>();
  const byIp = new Map<string, string>();

  for (const row of rows) {
    if (row.hostname) {
      byHostname.set(row.hostname.trim().toLowerCase(), row.deviceId);
    }
    if (row.ipAddress) {
      byIp.set(row.ipAddress, row.deviceId);
    }
  }

  return { byHostname, byIp };
}

function resolveDeviceIdForAgent(
  agent: Record<string, unknown>,
  candidates: { byHostname: Map<string, string>; byIp: Map<string, string> }
): string | null {
  const hostname = typeof agent.computerName === 'string'
    ? agent.computerName.trim().toLowerCase()
    : null;

  if (hostname && candidates.byHostname.has(hostname)) {
    return candidates.byHostname.get(hostname) ?? null;
  }

  if (Array.isArray(agent.networkInterfaces)) {
    for (const iface of agent.networkInterfaces) {
      if (!iface || typeof iface !== 'object') continue;
      const inet = (iface as { inet?: unknown }).inet;
      if (!Array.isArray(inet)) continue;
      for (const ip of inet) {
        if (typeof ip !== 'string') continue;
        const deviceId = candidates.byIp.get(ip);
        if (deviceId) return deviceId;
      }
    }
  }

  return null;
}

async function syncAgentsForIntegration(
  integration: IntegrationForSync,
  client: SentinelOneClient
): Promise<{ fetched: number; upserted: number }> {
  const candidates = await mapDeviceCandidates(integration.orgId);
  const fetchedAgents = await client.listAgents(integration.lastSyncAt ?? undefined);

  let upserted = 0;
  for (let i = 0; i < fetchedAgents.length; i += 300) {
    const batch = fetchedAgents.slice(i, i + 300);

    const values = batch.map((agent) => {
      const resolvedDeviceId = resolveDeviceIdForAgent(agent as unknown as Record<string, unknown>, candidates);
      const threatCount = Number(agent.activeThreats ?? 0);
      return {
        orgId: integration.orgId,
        integrationId: integration.id,
        s1AgentId: agent.id,
        deviceId: resolvedDeviceId,
        status: agent.isActive === false ? 'offline' : 'online',
        infected: agent.infected === true,
        threatCount: Number.isFinite(threatCount) ? Math.max(0, Math.round(threatCount)) : 0,
        policyName: agent.policyName ?? null,
        lastSeenAt: toDateOrNull(agent.lastSeen),
        metadata: {
          uuid: agent.uuid ?? null,
          computerName: agent.computerName ?? null,
          osName: agent.osName ?? null,
          siteName: agent.siteName ?? null
        },
        updatedAt: new Date()
      };
    });

    if (values.length === 0) continue;

    const inserted = await db
      .insert(s1Agents)
      .values(values)
      .onConflictDoUpdate({
        target: [s1Agents.integrationId, s1Agents.s1AgentId],
        set: {
          orgId: sql`excluded.org_id`,
          integrationId: sql`excluded.integration_id`,
          deviceId: sql`excluded.device_id`,
          status: sql`excluded.status`,
          infected: sql`excluded.infected`,
          threatCount: sql`excluded.threat_count`,
          policyName: sql`excluded.policy_name`,
          lastSeenAt: sql`excluded.last_seen_at`,
          metadata: sql`excluded.metadata`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .returning({ id: s1Agents.id });

    upserted += inserted.length;
  }

  return {
    fetched: fetchedAgents.length,
    upserted
  };
}

async function syncThreatsForIntegration(
  integration: IntegrationForSync,
  client: SentinelOneClient
): Promise<{ fetched: number; upserted: number; emitted: number }> {
  const fetchedThreats = await client.listThreats(integration.lastSyncAt ?? undefined);
  const agentRows = await db
    .select({
      s1AgentId: s1Agents.s1AgentId,
      deviceId: s1Agents.deviceId
    })
    .from(s1Agents)
    .where(eq(s1Agents.integrationId, integration.id));

  const deviceIdByAgentId = new Map<string, string | null>();
  for (const row of agentRows) {
    deviceIdByAgentId.set(row.s1AgentId, row.deviceId);
  }

  const emitSince = integration.lastSyncAt ?? new Date(Date.now() - (24 * 60 * 60 * 1000));
  const threatsToEmit: Array<{ s1ThreatId: string; severity: string; deviceId: string | null; detectedAt: Date | null }> = [];

  let upserted = 0;
  for (let i = 0; i < fetchedThreats.length; i += 300) {
    const batch = fetchedThreats.slice(i, i + 300);
    const values = batch.map((threat) => {
      const detectedAt = toDateOrNull(threat.detectedAt);
      const resolvedAt = toDateOrNull(threat.resolvedAt);
      const status = normalizeThreatStatus(threat.mitigationStatus);
      const severity = normalizeSeverity(threat.threatSeverity);

      if (status === 'active' && detectedAt && detectedAt >= emitSince) {
        threatsToEmit.push({
          s1ThreatId: threat.id,
          severity,
          deviceId: deviceIdByAgentId.get(threat.agentId ?? '') ?? null,
          detectedAt
        });
      }

      return {
        orgId: integration.orgId,
        integrationId: integration.id,
        deviceId: deviceIdByAgentId.get(threat.agentId ?? '') ?? null,
        s1ThreatId: threat.id,
        classification: threat.classification ?? null,
        severity,
        threatName: threat.threatName ?? null,
        processName: threat.processName ?? null,
        filePath: threat.filePath ?? null,
        mitreTactics: threat.mitreTechniques ?? null,
        status,
        detectedAt,
        resolvedAt,
        details: threat,
        updatedAt: new Date()
      };
    });

    if (values.length === 0) continue;

    const inserted = await db
      .insert(s1Threats)
      .values(values)
      .onConflictDoUpdate({
        target: [s1Threats.integrationId, s1Threats.s1ThreatId],
        set: {
          orgId: sql`excluded.org_id`,
          integrationId: sql`excluded.integration_id`,
          deviceId: sql`excluded.device_id`,
          classification: sql`excluded.classification`,
          severity: sql`excluded.severity`,
          threatName: sql`excluded.threat_name`,
          processName: sql`excluded.process_name`,
          filePath: sql`excluded.file_path`,
          mitreTactics: sql`excluded.mitre_tactics`,
          status: sql`excluded.status`,
          detectedAt: sql`excluded.detected_at`,
          resolvedAt: sql`excluded.resolved_at`,
          details: sql`excluded.details`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .returning({ id: s1Threats.id });

    upserted += inserted.length;
  }

  let emitted = 0;
  for (const threat of dedupeThreatDetections(threatsToEmit)) {
    try {
      await publishEvent(
        's1.threat_detected',
        integration.orgId,
        {
          integrationId: integration.id,
          s1ThreatId: threat.s1ThreatId,
          severity: threat.severity,
          deviceId: threat.deviceId,
          detectedAt: threat.detectedAt?.toISOString() ?? null
        },
        's1-sync-worker'
      );
      emitted += 1;
    } catch (error) {
      console.error('[S1SyncJob] Failed to publish s1.threat_detected:', error);
    }
  }

  return {
    fetched: fetchedThreats.length,
    upserted,
    emitted
  };
}

async function processSyncIntegration(data: SyncIntegrationJobData) {
  const [integration] = await db
    .select({
      id: s1Integrations.id,
      orgId: s1Integrations.orgId,
      managementUrl: s1Integrations.managementUrl,
      apiTokenEncrypted: s1Integrations.apiTokenEncrypted,
      isActive: s1Integrations.isActive,
      lastSyncAt: s1Integrations.lastSyncAt
    })
    .from(s1Integrations)
    .where(eq(s1Integrations.id, data.integrationId))
    .limit(1);

  if (!integration || !integration.isActive) {
    return {
      integrationId: data.integrationId,
      fetchedAgents: 0,
      upsertedAgents: 0,
      fetchedThreats: 0,
      upsertedThreats: 0,
      emittedThreatEvents: 0
    };
  }

  const token = decryptSecret(integration.apiTokenEncrypted);
  if (!token) {
    throw new Error('SentinelOne integration is missing a decryptable API token');
  }

  const client = new SentinelOneClient({
    managementUrl: integration.managementUrl,
    apiToken: token
  });

  try {
    const [agentResult, threatResult] = await Promise.all([
      data.syncAgents ? syncAgentsForIntegration(integration, client) : Promise.resolve({ fetched: 0, upserted: 0 }),
      data.syncThreats ? syncThreatsForIntegration(integration, client) : Promise.resolve({ fetched: 0, upserted: 0, emitted: 0 })
    ]);

    await db
      .update(s1Integrations)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: 'success',
        lastSyncError: null,
        updatedAt: new Date()
      })
      .where(eq(s1Integrations.id, integration.id));

    return {
      integrationId: integration.id,
      fetchedAgents: agentResult.fetched,
      upsertedAgents: agentResult.upserted,
      fetchedThreats: threatResult.fetched,
      upsertedThreats: threatResult.upserted,
      emittedThreatEvents: threatResult.emitted
    };
  } catch (error) {
    await db
      .update(s1Integrations)
      .set({
        lastSyncStatus: 'error',
        lastSyncError: truncateError(error),
        updatedAt: new Date()
      })
      .where(eq(s1Integrations.id, integration.id));
    throw error;
  }
}

async function processSyncAll(syncAgents: boolean, syncThreats: boolean) {
  const queue = getS1SyncQueue();
  const integrations = await listActiveIntegrations();

  await Promise.all(
    integrations.map((integration) => addUniqueJob(
      queue,
      'sync-integration',
      {
        type: 'sync-integration',
        integrationId: integration.id,
        syncAgents,
        syncThreats
      },
      `s1-sync-integration:${integration.id}:${syncAgents ? 'agents' : 'none'}:${syncThreats ? 'threats' : 'none'}`,
      { removeOnComplete: true, removeOnFail: true }
    ))
  );

  return { queued: integrations.length };
}

async function processPollActions() {
  const pendingActions = await db
    .select({
      id: s1Actions.id,
      orgId: s1Actions.orgId,
      deviceId: s1Actions.deviceId,
      action: s1Actions.action,
      payload: s1Actions.payload,
      providerActionId: s1Actions.providerActionId
    })
    .from(s1Actions)
    .where(
      and(
        inArray(s1Actions.status, ['queued', 'in_progress']),
        isNotNull(s1Actions.providerActionId)
      )
    )
    .limit(200);

  if (pendingActions.length === 0) {
    return { polled: 0, updated: 0 };
  }

  const orgIds = Array.from(new Set(pendingActions.map((row) => row.orgId)));
  const integrations = await db
    .select({
      orgId: s1Integrations.orgId,
      managementUrl: s1Integrations.managementUrl,
      apiTokenEncrypted: s1Integrations.apiTokenEncrypted
    })
    .from(s1Integrations)
    .where(and(inArray(s1Integrations.orgId, orgIds), eq(s1Integrations.isActive, true)));

  const integrationByOrg = new Map<string, { managementUrl: string; apiTokenEncrypted: string }>();
  for (const integration of integrations) {
    integrationByOrg.set(integration.orgId, {
      managementUrl: integration.managementUrl,
      apiTokenEncrypted: integration.apiTokenEncrypted
    });
  }

  let updated = 0;
  for (const action of pendingActions) {
    if (!action.providerActionId) continue;
    const integration = integrationByOrg.get(action.orgId);
    if (!integration) {
      await db
        .update(s1Actions)
        .set({
          status: 'failed',
          error: 'Action status polling failed: no active SentinelOne integration is available for this organization',
          completedAt: new Date()
        })
        .where(eq(s1Actions.id, action.id));
      recordS1ActionPollTransition('failed');
      updated += 1;
      continue;
    }

    const token = decryptSecret(integration.apiTokenEncrypted);
    if (!token) {
      await db
        .update(s1Actions)
        .set({
          status: 'failed',
          error: 'Action status polling failed: SentinelOne integration token is missing or invalid',
          completedAt: new Date()
        })
        .where(eq(s1Actions.id, action.id));
      recordS1ActionPollTransition('failed');
      updated += 1;
      continue;
    }

    try {
      const client = new SentinelOneClient({
        managementUrl: integration.managementUrl,
        apiToken: token
      });

      const activity = await client.getActivityStatus(action.providerActionId);
      const nextStatus = activity.status;
      const isDone = nextStatus === 'completed' || nextStatus === 'failed';
      const nextPayload = toObject(action.payload);
      nextPayload.pollFailureCount = 0;
      nextPayload.lastPollAt = new Date().toISOString();

      await db
        .update(s1Actions)
        .set({
          status: nextStatus,
          completedAt: isDone ? new Date() : null,
          error: nextStatus === 'failed' ? truncateError(activity.details) : null,
          payload: nextPayload
        })
        .where(eq(s1Actions.id, action.id));

      recordS1ActionPollTransition(nextStatus);
      updated += 1;

      if (nextStatus === 'completed') {
        if (action.action === 'isolate') {
          await publishEvent(
            's1.device_isolated',
            action.orgId,
            {
              actionId: action.id,
              deviceId: action.deviceId,
              providerActionId: action.providerActionId
            },
            's1-sync-worker'
          ).catch((error) => {
            console.error('[S1SyncJob] Failed to publish s1.device_isolated:', error);
          });
        } else {
          await publishEvent(
            's1.threat_action_completed',
            action.orgId,
            {
              actionId: action.id,
              action: action.action,
              deviceId: action.deviceId,
              providerActionId: action.providerActionId
            },
            's1-sync-worker'
          ).catch((error) => {
            console.error('[S1SyncJob] Failed to publish s1.threat_action_completed:', error);
          });
        }
      }
    } catch (error) {
      console.error('[S1SyncJob] Action status polling failed:', error);
      const failure = applyPollFailure(action.payload, error);
      const nextStatus: S1ActionStatus = failure.shouldFail ? 'failed' : 'in_progress';

      await db
        .update(s1Actions)
        .set({
          status: nextStatus,
          payload: failure.payload,
          error: failure.shouldFail
            ? `Action status polling failed ${failure.failureCount} times: ${failure.error}`
            : null,
          completedAt: failure.shouldFail ? new Date() : null
        })
        .where(eq(s1Actions.id, action.id));

      recordS1ActionPollTransition(nextStatus);
      updated += 1;
    }
  }

  return {
    polled: pendingActions.length,
    updated
  };
}

function createS1SyncWorker(): Worker<S1SyncJobData> {
  return new Worker<S1SyncJobData>(
    S1_SYNC_QUEUE,
    async (job: Job<S1SyncJobData>) => {
      return runWithSystemDbAccess(async () => {
        const start = Date.now();
        const syncType = job.data.type;
        switch (job.data.type) {
          case 'sync-integration': {
            try {
              const result = await processSyncIntegration(job.data);
              recordS1SyncRun(syncType, 'success', Date.now() - start);
              return result;
            } catch (error) {
              recordS1SyncRun(syncType, 'failure', Date.now() - start);
              throw error;
            }
          }
          case 'sync-all-agents': {
            try {
              const result = await processSyncAll(true, false);
              recordS1SyncRun(syncType, 'success', Date.now() - start);
              return result;
            } catch (error) {
              recordS1SyncRun(syncType, 'failure', Date.now() - start);
              throw error;
            }
          }
          case 'sync-all-threats': {
            try {
              const result = await processSyncAll(false, true);
              recordS1SyncRun(syncType, 'success', Date.now() - start);
              return result;
            } catch (error) {
              recordS1SyncRun(syncType, 'failure', Date.now() - start);
              throw error;
            }
          }
          case 'poll-actions': {
            try {
              const result = await processPollActions();
              recordS1SyncRun(syncType, 'success', Date.now() - start);
              return result;
            } catch (error) {
              recordS1SyncRun(syncType, 'failure', Date.now() - start);
              throw error;
            }
          }
          default: {
            recordS1SyncRun(syncType, 'failure', Date.now() - start);
            throw new Error(`Unknown S1 sync job type: ${(job.data as { type?: string }).type ?? 'unknown'}`);
          }
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 4
    }
  );
}

async function scheduleRepeatJob(
  name: 'sync-all-agents' | 'sync-all-threats' | 'poll-actions',
  everyMs: number,
  data: SyncAllAgentsJobData | SyncAllThreatsJobData | PollActionsJobData
): Promise<void> {
  const queue = getS1SyncQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const repeatable of repeatables) {
    if (repeatable.name === name) {
      await queue.removeRepeatableByKey(repeatable.key);
    }
  }

  await queue.add(
    name,
    data,
    {
      repeat: { every: everyMs },
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: {
        type: 'exponential',
        delay: DEFAULT_JOB_BACKOFF_MS
      },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 }
    }
  );
}

export async function scheduleS1Sync(integrationId?: string): Promise<string> {
  const queue = getS1SyncQueue();

  if (integrationId) {
    return addUniqueJob(
      queue,
      'sync-integration',
      {
        type: 'sync-integration',
        integrationId,
        syncAgents: true,
        syncThreats: true
      },
      `s1-sync-integration:${integrationId}:full`,
      { removeOnComplete: true, removeOnFail: true }
    );
  }

  return addUniqueJob(
    queue,
    'sync-all-threats',
    { type: 'sync-all-threats' },
    's1-sync-all-manual',
    { removeOnComplete: true, removeOnFail: true }
  );
}

export async function scheduleS1ActionPoll(): Promise<string> {
  const queue = getS1SyncQueue();
  return addUniqueJob(
    queue,
    'poll-actions',
    { type: 'poll-actions' },
    's1-poll-actions-manual',
    { removeOnComplete: true, removeOnFail: true }
  );
}

export async function initializeS1SyncJob(): Promise<void> {
  s1SyncWorker = createS1SyncWorker();

  s1SyncWorker.on('error', (error) => {
    console.error('[S1SyncJob] Worker error:', error);
    captureException(error);
  });

  s1SyncWorker.on('failed', (job, error) => {
    console.error(`[S1SyncJob] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await Promise.all([
    scheduleRepeatJob('sync-all-agents', AGENT_SYNC_EVERY_MS, { type: 'sync-all-agents' }),
    scheduleRepeatJob('sync-all-threats', THREAT_SYNC_EVERY_MS, { type: 'sync-all-threats' }),
    scheduleRepeatJob('poll-actions', ACTION_POLL_EVERY_MS, { type: 'poll-actions' })
  ]);

  await scheduleS1Sync();

  console.log('[S1SyncJob] SentinelOne sync worker initialized');
}

export async function shutdownS1SyncJob(): Promise<void> {
  if (s1SyncWorker) {
    await s1SyncWorker.close();
    s1SyncWorker = null;
  }

  if (s1SyncQueue) {
    await s1SyncQueue.close();
    s1SyncQueue = null;
  }

  console.log('[S1SyncJob] SentinelOne sync worker shut down');
}

export async function dispatchS1ThreatAction(
  integrationId: string,
  action: S1ThreatAction,
  threatIds: string[]
): Promise<{ providerActionId: string | null; raw: unknown }> {
  const [integration] = await db
    .select({
      managementUrl: s1Integrations.managementUrl,
      apiTokenEncrypted: s1Integrations.apiTokenEncrypted
    })
    .from(s1Integrations)
    .where(eq(s1Integrations.id, integrationId))
    .limit(1);

  if (!integration) {
    throw new Error('SentinelOne integration not found');
  }

  const token = decryptSecret(integration.apiTokenEncrypted);
  if (!token) {
    throw new Error('SentinelOne integration token is missing or invalid');
  }

  const client = new SentinelOneClient({
    managementUrl: integration.managementUrl,
    apiToken: token
  });
  try {
    const result = await client.runThreatAction(action, threatIds);
    recordS1ActionDispatch(`threat_${action}`, result.activityId ? 'accepted' : 'untracked');
    return {
      providerActionId: result.activityId,
      raw: result.raw
    };
  } catch (error) {
    recordS1ActionDispatch(`threat_${action}`, 'failed');
    throw error;
  }
}

export async function dispatchS1Isolation(
  integrationId: string,
  agentIds: string[],
  isolate = true
): Promise<{ providerActionId: string | null; raw: unknown }> {
  const [integration] = await db
    .select({
      managementUrl: s1Integrations.managementUrl,
      apiTokenEncrypted: s1Integrations.apiTokenEncrypted
    })
    .from(s1Integrations)
    .where(eq(s1Integrations.id, integrationId))
    .limit(1);

  if (!integration) {
    throw new Error('SentinelOne integration not found');
  }

  const token = decryptSecret(integration.apiTokenEncrypted);
  if (!token) {
    throw new Error('SentinelOne integration token is missing or invalid');
  }

  const client = new SentinelOneClient({
    managementUrl: integration.managementUrl,
    apiToken: token
  });

  try {
    const result = await client.isolateAgents(agentIds, isolate);
    recordS1ActionDispatch(isolate ? 'isolate' : 'unisolate', result.activityId ? 'accepted' : 'untracked');
    return {
      providerActionId: result.activityId,
      raw: result.raw
    };
  } catch (error) {
    recordS1ActionDispatch(isolate ? 'isolate' : 'unisolate', 'failed');
    throw error;
  }
}

export { isThreatAction };
