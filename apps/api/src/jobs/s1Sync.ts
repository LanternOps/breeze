import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  devices,
  deviceNetwork,
  organizations,
  s1Actions,
  s1Agents,
  s1Integrations,
  s1OrgMappings,
  s1Threats
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { decryptForColumn } from '../services/secretCrypto';
import { S1_THREAT_ACTIONS, SentinelOneClient, SentinelOneHttpError, type S1ThreatAction, type S1ActionStatus } from '../services/sentinelOne/client';
import { captureException } from '../services/sentry';
import { redactLogMessage } from '../services/logRedaction';
import { publishEvent } from '../services/eventBus';
import {
  recordS1ActionDispatch,
  recordS1ActionPollTransition,
  recordS1SyncRun
} from '../services/sentinelOne/metrics';

const { db } = dbModule;
// Opens a SHORT system DB access context for one read/write group (#1896,
// mirrors #1894). The worker no longer wraps a whole job in one context — each
// processor opens short contexts around its DB touches (a few related touches
// may share one) so SentinelOne HTTP calls and per-action loops run OUTSIDE any
// open transaction and never pin a pooled connection idle-in-transaction
// (#1105). The load-bearing invariant: HTTP/Redis work is never inside a
// context. Falls back to `fn()` when the context helper is unavailable (unit
// tests mock `../db` with `withSystemDbAccessContext: undefined`).
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
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
  partnerId: string;
  managementUrl: string;
  isActive: boolean;
  lastSyncAt: Date | null;
}

interface DeviceCandidates {
  byHostname: Map<string, string>;
  byIp: Map<string, string>;
}

interface AgentContext {
  orgId: string;
  deviceId: string | null;
}

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
  return (S1_THREAT_ACTIONS as readonly string[]).includes(value);
}

export function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Redact before truncating. S1 bearer tokens go in headers (not URL), but
  // an HTTP error message can still echo back a Cookie or Authorization
  // header — strip those before persisting to DB. For a SentinelOneHttpError
  // the `.message` is body-free by construction (status line only), so the
  // upstream response body never reaches the tenant-visible column.
  return redactLogMessage(message).slice(0, 2_000);
}

/**
 * Log full failure detail to the SERVER-SIDE log only. For an upstream HTTP
 * error this includes the (redacted) response body that we deliberately keep
 * out of the tenant-visible column (`s1_integrations.lastSyncError` /
 * `s1_actions.error`). The tenant column is written separately via
 * {@link truncateError}, which reads only the body-free `.message`.
 */
export function logSyncFailureServerSide(
  context: Record<string, unknown>,
  error: unknown
): void {
  if (error instanceof SentinelOneHttpError) {
    console.error(
      '[S1SyncJob] sync failed (upstream HTTP error)',
      JSON.stringify({
        ...context,
        status: error.status,
        // Redacted defense-in-depth: an upstream body could echo back a header.
        responseBody: redactLogMessage(error.responseBody),
      })
    );
    return;
  }
  console.error(
    '[S1SyncJob] sync failed',
    JSON.stringify({
      ...context,
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    })
  );
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
      connection: getBullMQConnection()
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
    if (isReusableState(state)) {
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
      partnerId: s1Integrations.partnerId,
      managementUrl: s1Integrations.managementUrl,
      isActive: s1Integrations.isActive,
      lastSyncAt: s1Integrations.lastSyncAt
    })
    .from(s1Integrations)
    .where(eq(s1Integrations.isActive, true));
}

/**
 * Match an S1 agent to a Breeze device by hostname (case-insensitive) then
 * by IP from any network interface. Returns null for unmatched agents, which
 * are still persisted with a null deviceId.
 */
export function resolveDeviceIdForAgent(
  agent: Record<string, unknown>,
  candidates: DeviceCandidates
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

/**
 * Load s1_org_mappings rows that have a mapped org, keyed by s1_site_id.
 * Only includes rows with non-null org_id (mirrors huntressSync loadMappedOrgIds).
 * Excludes provisional rows (s1_site_id starting with 'name:') which will be
 * reconciled by reconcileProvisionalSiteMappings before this is called.
 */
export async function mapSiteOrgIds(integrationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      s1SiteId: s1OrgMappings.s1SiteId,
      orgId: s1OrgMappings.orgId
    })
    .from(s1OrgMappings)
    .where(
      and(
        eq(s1OrgMappings.integrationId, integrationId),
        isNotNull(s1OrgMappings.orgId)
      )
    );

  const result = new Map<string, string>();
  for (const row of rows) {
    if (row.orgId) {
      result.set(row.s1SiteId, row.orgId);
    }
  }
  return result;
}

/**
 * Upsert discovered sites (derived from the fetched agent list) into s1_org_mappings.
 * Sites are keyed on (integration_id, s1_site_id). On conflict, updates s1_site_name,
 * agents_count, and last_seen_at but DOES NOT overwrite a mapped org_id with null —
 * preserving any existing mapping.
 */
export async function upsertDiscoveredSites(params: {
  integrationId: string;
  partnerId: string;
  sites: Array<{ siteId: string; siteName: string | null; count: number }>;
}): Promise<void> {
  if (params.sites.length === 0) return;

  const now = new Date();
  const values = params.sites.map((site) => ({
    integrationId: params.integrationId,
    partnerId: params.partnerId,
    s1SiteId: site.siteId,
    s1SiteName: site.siteName ?? null,
    agentsCount: site.count,
    lastSeenAt: now,
    updatedAt: now,
  }));

  await db
    .insert(s1OrgMappings)
    .values(values)
    .onConflictDoUpdate({
      target: [s1OrgMappings.integrationId, s1OrgMappings.s1SiteId],
      set: {
        s1SiteName: sql`excluded.s1_site_name`,
        agentsCount: sql`excluded.agents_count`,
        lastSeenAt: sql`excluded.last_seen_at`,
        updatedAt: sql`excluded.updated_at`,
        // partnerId is updated in case the composite FK partner changes (rare)
        partnerId: sql`excluded.partner_id`,
        // org_id is NOT included here — COALESCE preserves the existing mapped value.
        // The full formula `COALESCE(s1_org_mappings.org_id, excluded.org_id)` would
        // require a raw SET expression; omitting org_id from the set clause achieves
        // the same effect (Drizzle leaves the column unchanged on conflict update).
      }
    });
}

/**
 * For each discovered real site, find a provisional row
 * (s1_site_id = 'name:' || siteName AND metadata->>'provisional' IS TRUE) for this
 * integration and reconcile it:
 *
 * Collision rule:
 *   - If NO real row yet exists for the discovered siteId: UPDATE the provisional row
 *     → set s1_site_id to the real id, clear provisional flag, preserve org_id.
 *   - If a real row ALREADY exists (would violate the unique index): DELETE the
 *     provisional row instead (the real row wins). We do not attempt to merge org_id
 *     because: (a) the real row was presumably created with the correct org_id or is
 *     awaiting manual mapping; (b) the provisional org_id came from a name-match
 *     heuristic and should not silently overwrite a deliberately-set real mapping.
 *
 * Run this BEFORE upsertDiscoveredSites so the carried org_id survives the upsert.
 */
export async function reconcileProvisionalSiteMappings(
  integrationId: string,
  discoveredSites: Array<{ siteId: string; siteName: string }>
): Promise<void> {
  if (discoveredSites.length === 0) return;

  for (const site of discoveredSites) {
    const provisionalKey = `name:${site.siteName}`;

    // Find a provisional row for this integration + name
    const [provisionalRow] = await db
      .select({
        id: s1OrgMappings.id,
        orgId: s1OrgMappings.orgId,
      })
      .from(s1OrgMappings)
      .where(
        and(
          eq(s1OrgMappings.integrationId, integrationId),
          eq(s1OrgMappings.s1SiteId, provisionalKey),
          // Only target rows flagged as provisional
          sql`(${s1OrgMappings.metadata}->>'provisional')::boolean IS TRUE`
        )
      )
      .limit(1);

    if (!provisionalRow) continue;

    // Check whether a real row for this siteId already exists
    const [existingReal] = await db
      .select({ id: s1OrgMappings.id })
      .from(s1OrgMappings)
      .where(
        and(
          eq(s1OrgMappings.integrationId, integrationId),
          eq(s1OrgMappings.s1SiteId, site.siteId)
        )
      )
      .limit(1);

    if (existingReal) {
      // Real row already exists — delete the provisional row (real wins).
      await db
        .delete(s1OrgMappings)
        .where(eq(s1OrgMappings.id, provisionalRow.id));
    } else {
      // No real row yet — rewrite provisional row to real site id.
      await db
        .update(s1OrgMappings)
        .set({
          s1SiteId: site.siteId,
          orgId: provisionalRow.orgId, // preserve mapped org
          metadata: sql`${s1OrgMappings.metadata} - 'provisional'`,
          updatedAt: new Date(),
        })
        .where(eq(s1OrgMappings.id, provisionalRow.id));
    }
  }
}

/**
 * Resolve an S1 agent's sync target (orgId + deviceId) using the stable S1 site id.
 * Returns null if the agent has no siteId or the site is not mapped to an org.
 * A null return means the agent should be SKIPPED (counted but not written).
 */
export function resolveAgentSyncTargetById(
  agent: { siteId: string | null; computerName?: string | null; networkInterfaces?: Array<{ inet?: string[] }> },
  siteOrgIds: Map<string, string>,
  candidatesByOrg: Map<string, DeviceCandidates>
): AgentContext | null {
  if (!agent.siteId) return null;
  const orgId = siteOrgIds.get(agent.siteId);
  if (!orgId) return null;
  const candidates = candidatesByOrg.get(orgId) ?? { byHostname: new Map(), byIp: new Map() };
  return {
    orgId,
    deviceId: resolveDeviceIdForAgent(agent as Record<string, unknown>, candidates)
  };
}

async function mapDeviceCandidatesByOrg(orgIds: string[]): Promise<Map<string, DeviceCandidates>> {
  const uniqueOrgIds = Array.from(new Set(orgIds));
  if (uniqueOrgIds.length === 0) return new Map();

  const rows = await db
    .select({
      orgId: devices.orgId,
      deviceId: devices.id,
      hostname: devices.hostname,
      ipAddress: deviceNetwork.ipAddress
    })
    .from(devices)
    .leftJoin(deviceNetwork, eq(deviceNetwork.deviceId, devices.id))
    .where(inArray(devices.orgId, uniqueOrgIds));

  const byOrg = new Map<string, DeviceCandidates>();
  for (const orgId of uniqueOrgIds) {
    byOrg.set(orgId, { byHostname: new Map(), byIp: new Map() });
  }

  for (const row of rows) {
    const candidates = byOrg.get(row.orgId);
    if (!candidates) continue;
    if (row.hostname) {
      candidates.byHostname.set(row.hostname.trim().toLowerCase(), row.deviceId);
    }
    if (row.ipAddress) {
      candidates.byIp.set(row.ipAddress, row.deviceId);
    }
  }

  return byOrg;
}

async function syncAgentsForIntegration(
  integration: IntegrationForSync,
  client: SentinelOneClient
): Promise<{ fetched: number; upserted: number; skipped: number; truncated: boolean }> {
  const agentResult = await client.listAgents(integration.lastSyncAt ?? undefined);
  const fetchedAgents = agentResult.results;

  // Derive distinct sites from the fetched agent list (skip agents with no siteId).
  const siteCountMap = new Map<string, { siteName: string | null; count: number }>();
  for (const agent of fetchedAgents) {
    if (!agent.siteId) continue;
    const existing = siteCountMap.get(agent.siteId);
    if (existing) {
      existing.count += 1;
    } else {
      siteCountMap.set(agent.siteId, { siteName: agent.siteName, count: 1 });
    }
  }
  const discoveredSites = Array.from(siteCountMap.entries()).map(([siteId, info]) => ({
    siteId,
    siteName: info.siteName,
    count: info.count,
  }));

  // All writes/reads below run in ONE short system context (#1896): the
  // SentinelOne fetch above already ran OUTSIDE any context, so no transaction
  // spans the HTTP call. This is pure DB work (reconcile, upsert, lookups, batch
  // upserts), which is fine to group inside a single short-lived transaction.
  const { upserted, skipped } = await runWithSystemDbAccess(async () => {
    // Step 1: Reconcile provisional mappings BEFORE upsert so carried org_id survives.
    // Skip sites with no siteName — a null siteName can never match a provisional row
    // (which is keyed as 'name:<siteName>'), so attempting reconciliation would silently
    // miss and build a 'name:<siteId>' key that matches nothing.
    await reconcileProvisionalSiteMappings(
      integration.id,
      discoveredSites
        .filter((s): s is { siteId: string; siteName: string; count: number } => typeof s.siteName === 'string' && s.siteName.length > 0)
        .map((s) => ({ siteId: s.siteId, siteName: s.siteName }))
    );

    // Step 2: Upsert discovered sites (sets agents_count, last_seen_at; preserves org_id).
    await upsertDiscoveredSites({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      sites: discoveredSites,
    });

    // Step 3: Load the org mapping keyed by s1_site_id (only rows with mapped org_id).
    const siteOrgIds = await mapSiteOrgIds(integration.id);
    const candidatesByOrg = await mapDeviceCandidatesByOrg([...siteOrgIds.values()]);

    let upserted = 0;
    let skipped = 0;
    for (let i = 0; i < fetchedAgents.length; i += 300) {
      const batch = fetchedAgents.slice(i, i + 300);

      const values: Array<{
        orgId: string;
        integrationId: string;
        s1AgentId: string;
        deviceId: string | null;
        status: string;
        infected: boolean;
        threatCount: number;
        policyName: string | null;
        lastSeenAt: Date | null;
        metadata: Record<string, unknown>;
        updatedAt: Date;
      }> = [];

      for (const agent of batch) {
        // Resolve the agent to an org via its stable siteId (no fallback default org).
        const target = resolveAgentSyncTargetById(agent, siteOrgIds, candidatesByOrg);
        if (!target) {
          skipped += 1;
          continue;
        }
        const threatCount = Number(agent.activeThreats ?? 0);
        values.push({
          orgId: target.orgId,
          integrationId: integration.id,
          s1AgentId: agent.id,
          deviceId: target.deviceId,
          status: agent.isActive === false ? 'offline' : 'online',
          infected: agent.infected === true,
          threatCount: Number.isFinite(threatCount) ? Math.max(0, Math.round(threatCount)) : 0,
          policyName: agent.policyName ?? null,
          lastSeenAt: toDateOrNull(agent.lastSeen),
          metadata: {
            uuid: agent.uuid ?? null,
            computerName: agent.computerName ?? null,
            osName: agent.osName ?? null,
            siteName: agent.siteName ?? null,
            siteId: agent.siteId ?? null,
          },
          updatedAt: new Date()
        });
      }

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

    return { upserted, skipped };
  });

  return {
    fetched: fetchedAgents.length,
    upserted,
    skipped,
    truncated: agentResult.truncated
  };
}

async function syncThreatsForIntegration(
  integration: IntegrationForSync,
  client: SentinelOneClient
): Promise<{ fetched: number; upserted: number; skipped: number; emitted: number; emitFailures: number; truncated: boolean }> {
  const threatResult = await client.listThreats(integration.lastSyncAt ?? undefined);
  const fetchedThreats = threatResult.results;

  // Populated inside the DB context below, consumed by the publishEvent loop
  // (which runs OUTSIDE any context — Redis work must not hold a transaction).
  const threatsToEmit: Array<{ s1ThreatId: string; orgId: string; severity: string; deviceId: string | null; detectedAt: Date | null }> = [];

  // One short system context (#1896): the listThreats HTTP fetch above ran
  // OUTSIDE any context, so no transaction spans it. Group the agent-context
  // read + threat batch upserts into a single short-lived transaction.
  const { upserted, skipped } = await runWithSystemDbAccess(async () => {
    // Load agent contexts from already-synced s1_agents rows.
    // If an agent was skipped during agent sync (unmapped site), it won't appear here
    // and its threats will be skipped too — consistent with the partner-wide model.
    const agentRows = await db
      .select({
        s1AgentId: s1Agents.s1AgentId,
        orgId: s1Agents.orgId,
        deviceId: s1Agents.deviceId
      })
      .from(s1Agents)
      .where(eq(s1Agents.integrationId, integration.id));

    const agentContextByAgentId = new Map<string, AgentContext>();
    for (const row of agentRows) {
      agentContextByAgentId.set(row.s1AgentId, { orgId: row.orgId, deviceId: row.deviceId });
    }

    const emitSince = integration.lastSyncAt ?? new Date(Date.now() - (24 * 60 * 60 * 1000));

    let upserted = 0;
    let skipped = 0;
    for (let i = 0; i < fetchedThreats.length; i += 300) {
      const batch = fetchedThreats.slice(i, i + 300);
      const values: Array<{
        orgId: string;
        integrationId: string;
        deviceId: string | null;
        s1ThreatId: string;
        classification: string | null;
        severity: string;
        threatName: string | null;
        processName: string | null;
        filePath: string | null;
        mitreTactics: unknown;
        status: string;
        detectedAt: Date | null;
        resolvedAt: Date | null;
        details: unknown;
        updatedAt: Date;
      }> = [];

      for (const threat of batch) {
        const detectedAt = toDateOrNull(threat.detectedAt);
        const resolvedAt = toDateOrNull(threat.resolvedAt);
        const status = normalizeThreatStatus(threat.mitigationStatus);
        const severity = normalizeSeverity(threat.threatSeverity);

        // Resolve the threat's org via its parent agent's already-written context.
        // If the agent has no context (was skipped because its site is unmapped),
        // skip this threat too — there is no fallback "default org" in the partner-wide model.
        const agentContext = agentContextByAgentId.get(threat.agentId ?? '');
        if (!agentContext) {
          skipped += 1;
          continue;
        }

        if (status === 'active' && detectedAt && detectedAt >= emitSince) {
          threatsToEmit.push({
            s1ThreatId: threat.id,
            orgId: agentContext.orgId,
            severity,
            deviceId: agentContext.deviceId,
            detectedAt
          });
        }

        values.push({
          orgId: agentContext.orgId,
          integrationId: integration.id,
          deviceId: agentContext.deviceId,
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
        });
      }

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

    return { upserted, skipped };
  });

  let emitted = 0;
  let emitFailures = 0;
  for (const threat of dedupeThreatDetections(threatsToEmit)) {
    try {
      await publishEvent(
        's1.threat_detected',
        threat.orgId,
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
      emitFailures += 1;
      console.error('[S1SyncJob] Failed to publish s1.threat_detected:', error);
      captureException(error);
    }
  }

  return {
    fetched: fetchedThreats.length,
    upserted,
    skipped,
    emitted,
    emitFailures,
    truncated: threatResult.truncated
  };
}

// Exported for focused catch-block coverage (#1035 item 2): a unit test mocks
// the S1 client to throw a SentinelOneHttpError carrying a distinctive upstream
// body marker and asserts that the tenant-visible `s1_integrations.lastSyncError`
// column receives only the body-free status line (no marker), while the full
// (redacted) body is logged server-side. A regression swapping the column write
// back to `redactLogMessage(error.responseBody)` would otherwise pass every
// existing helper-level test.
export async function processSyncIntegration(data: SyncIntegrationJobData) {
  const [integration] = await runWithSystemDbAccess(() =>
    db
      .select({
        id: s1Integrations.id,
        partnerId: s1Integrations.partnerId,
        managementUrl: s1Integrations.managementUrl,
        apiTokenEncrypted: s1Integrations.apiTokenEncrypted,
        isActive: s1Integrations.isActive,
        lastSyncAt: s1Integrations.lastSyncAt
      })
      .from(s1Integrations)
      .where(eq(s1Integrations.id, data.integrationId))
      .limit(1)
  );

  if (!integration || !integration.isActive) {
    console.warn(`[S1SyncJob] Integration ${data.integrationId} not found or inactive; skipping sync`);
    return {
      integrationId: data.integrationId,
      skipped: true,
      fetchedAgents: 0,
      upsertedAgents: 0,
      fetchedThreats: 0,
      upsertedThreats: 0,
      emittedThreatEvents: 0
    };
  }

  const token = decryptForColumn('s1_integrations', 'api_token_encrypted', integration.apiTokenEncrypted);
  if (!token) {
    throw new Error('SentinelOne integration is missing a decryptable API token');
  }

  const client = new SentinelOneClient({
    managementUrl: integration.managementUrl,
    apiToken: token
  });

  try {
    // syncAgents/syncThreats make SentinelOne HTTP calls — run them OUTSIDE any
    // DB access context (#1896); each opens its own short context for its writes.
    const agentResult = data.syncAgents
      ? await syncAgentsForIntegration(integration, client)
      : { fetched: 0, upserted: 0, truncated: false };
    const threatResult = data.syncThreats
      ? await syncThreatsForIntegration(integration, client)
      : { fetched: 0, upserted: 0, emitted: 0, emitFailures: 0, truncated: false };

    const wasTruncated = agentResult.truncated || threatResult.truncated;
    await runWithSystemDbAccess(() =>
      db
        .update(s1Integrations)
        .set({
          lastSyncAt: new Date(),
          lastSyncStatus: wasTruncated ? 'partial' : 'success',
          lastSyncError: wasTruncated ? 'Results were truncated due to pagination limits' : null,
          updatedAt: new Date()
        })
        .where(eq(s1Integrations.id, integration.id))
    );

    return {
      integrationId: integration.id,
      fetchedAgents: agentResult.fetched,
      upsertedAgents: agentResult.upserted,
      fetchedThreats: threatResult.fetched,
      upsertedThreats: threatResult.upserted,
      emittedThreatEvents: threatResult.emitted,
      truncated: wasTruncated
    };
  } catch (error) {
    // Full detail (including the upstream response body, redacted) goes to the
    // SERVER-SIDE log only. The tenant-visible column gets a body-free message
    // via truncateError — a SentinelOneHttpError's `.message` carries no body.
    logSyncFailureServerSide({ integrationId: integration.id, partnerId: integration.partnerId }, error);
    try {
      await runWithSystemDbAccess(() =>
        db
          .update(s1Integrations)
          .set({
            lastSyncStatus: 'error',
            lastSyncError: truncateError(error),
            updatedAt: new Date()
          })
          .where(eq(s1Integrations.id, integration.id))
      );
    } catch (dbError) {
      console.error('[S1SyncJob] Failed to persist sync error status:', dbError);
      captureException(dbError);
    }
    throw error;
  }
}

async function processSyncAll(syncAgents: boolean, syncThreats: boolean) {
  const queue = getS1SyncQueue();
  // Read in a short context (#1896); the BullMQ enqueues below are Redis work
  // and run OUTSIDE any DB transaction.
  const integrations = await runWithSystemDbAccess(() => listActiveIntegrations());

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

export async function processPollActions() {
  // Read pending actions in a short context (#1896). The per-action
  // getActivityStatus HTTP calls + writes happen later, each OUTSIDE / in its
  // own short context, so no transaction spans the up-to-200-action poll loop.
  const pendingActions = await runWithSystemDbAccess(() =>
    db
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
      .limit(200)
  );

  if (pendingActions.length === 0) {
    return { polled: 0, updated: 0 };
  }

  // Resolve each action's org → partner → active integration.
  // Actions carry org_id; s1_integrations is now partner-axis (legacyOrgId is often NULL).
  // We look up partner_id via the organizations table, then fetch the active integration
  // for each distinct partner. This correctly handles partner-wide integrations whose
  // legacyOrgId is NULL (they would never be found by a legacyOrgId lookup).
  const orgIds = Array.from(new Set(pendingActions.map((row) => row.orgId)));

  // Steps 1-2 (one short context): resolve org_id → partner_id, then fetch the
  // active integration per distinct partner. Pure DB reads — grouping them in a
  // single short transaction is fine; the slow HTTP work is the per-action loop.
  const { partnerIdByOrg, partnerIntegrations } = await runWithSystemDbAccess(async () => {
    const orgRows = await db
      .select({
        id: organizations.id,
        partnerId: organizations.partnerId,
      })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));

    const partnerIdByOrg = new Map<string, string>();
    for (const row of orgRows) {
      partnerIdByOrg.set(row.id, row.partnerId);
    }

    const distinctPartnerIds = Array.from(new Set([...partnerIdByOrg.values()]));
    const partnerIntegrations = distinctPartnerIds.length > 0
      ? await db
          .select({
            partnerId: s1Integrations.partnerId,
            managementUrl: s1Integrations.managementUrl,
            apiTokenEncrypted: s1Integrations.apiTokenEncrypted,
          })
          .from(s1Integrations)
          .where(and(inArray(s1Integrations.partnerId, distinctPartnerIds), eq(s1Integrations.isActive, true)))
      : [];

    return { partnerIdByOrg, partnerIntegrations };
  });

  // Step 3: Build a reusable client per partner to avoid redundant decrypt + instantiation
  const clientByPartner = new Map<string, SentinelOneClient | null>();
  const clientErrorByPartner = new Map<string, string>();
  for (const integration of partnerIntegrations) {
    let token: string | null;
    try {
      token = decryptForColumn('s1_integrations', 'api_token_encrypted', integration.apiTokenEncrypted);
    } catch (cryptoError) {
      clientByPartner.set(integration.partnerId, null);
      clientErrorByPartner.set(integration.partnerId, `Token decryption failed: ${truncateError(cryptoError)}`);
      continue;
    }
    if (!token) {
      clientByPartner.set(integration.partnerId, null);
      clientErrorByPartner.set(integration.partnerId, 'SentinelOne integration token is missing or invalid');
      continue;
    }
    clientByPartner.set(integration.partnerId, new SentinelOneClient({
      managementUrl: integration.managementUrl,
      apiToken: token,
    }));
  }

  // Step 4: Map each org to its partner's client (multiple orgs share one client)
  const clientByOrg = new Map<string, SentinelOneClient | null>();
  const clientErrorByOrg = new Map<string, string>();
  for (const orgId of orgIds) {
    const partnerId = partnerIdByOrg.get(orgId);
    if (!partnerId) continue; // org not found in DB — leave clientByOrg undefined for this org
    if (clientByPartner.has(partnerId)) {
      clientByOrg.set(orgId, clientByPartner.get(partnerId) ?? null);
      const err = clientErrorByPartner.get(partnerId);
      if (err) clientErrorByOrg.set(orgId, err);
    }
    // If partner has no active integration, clientByOrg remains undefined for this org
    // → will hit the "No integration found" branch below
  }

  let updated = 0;
  for (const action of pendingActions) {
    if (!action.providerActionId) continue;
    const client = clientByOrg.get(action.orgId);
    const clientError = clientErrorByOrg.get(action.orgId);

    if (client === undefined) {
      // No integration found for this org
      await runWithSystemDbAccess(() =>
        db
          .update(s1Actions)
          .set({
            status: 'failed',
            error: 'Action status polling failed: no active SentinelOne integration is available for this organization',
            completedAt: new Date()
          })
          .where(eq(s1Actions.id, action.id))
      );
      recordS1ActionPollTransition('failed');
      updated += 1;
      continue;
    }

    if (!client) {
      // Client construction failed (bad token)
      await runWithSystemDbAccess(() =>
        db
          .update(s1Actions)
          .set({
            status: 'failed',
            error: `Action status polling failed: ${clientError ?? 'unknown client error'}`,
            completedAt: new Date()
          })
          .where(eq(s1Actions.id, action.id))
      );
      recordS1ActionPollTransition('failed');
      updated += 1;
      continue;
    }

    try {
      const activity = await client.getActivityStatus(action.providerActionId);
      const nextStatus = activity.status;
      const isDone = nextStatus === 'completed' || nextStatus === 'failed';
      const nextPayload = toObject(action.payload);
      nextPayload.pollFailureCount = 0;
      nextPayload.lastPollAt = new Date().toISOString();

      try {
        await runWithSystemDbAccess(() =>
          db
            .update(s1Actions)
            .set({
              status: nextStatus,
              completedAt: isDone ? new Date() : null,
              error: nextStatus === 'failed' ? truncateError(activity.details) : null,
              payload: nextPayload
            })
            .where(eq(s1Actions.id, action.id))
        );
      } catch (dbError) {
        console.error(`[S1SyncJob] Failed to persist poll result for action ${action.id}:`, dbError);
        captureException(dbError);
        // Still count the poll attempt even though DB persist failed
        recordS1ActionPollTransition(nextStatus);
        updated += 1;
        continue;
      }

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
            captureException(error);
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
            captureException(error);
          });
        }
      }
    } catch (error) {
      // Full detail (incl. redacted upstream body) → server-side log only. The
      // tenant-visible s1_actions.error is set via applyPollFailure →
      // truncateError, which reads the body-free `.message`.
      logSyncFailureServerSide({ actionId: action.id, orgId: action.orgId }, error);
      const failure = applyPollFailure(action.payload, error);
      const nextStatus: S1ActionStatus = failure.shouldFail ? 'failed' : 'in_progress';

      await runWithSystemDbAccess(() =>
        db
          .update(s1Actions)
          .set({
            status: nextStatus,
            payload: failure.payload,
            error: failure.shouldFail
              ? `Action status polling failed ${failure.failureCount} times: ${failure.error}`
              : null,
            completedAt: failure.shouldFail ? new Date() : null
          })
          .where(eq(s1Actions.id, action.id))
      );

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
      // #1896: do NOT wrap the whole job in one withSystemDbAccessContext. The
      // processors below make SentinelOne HTTP calls and loop over up to 200
      // actions; holding a single transaction across that work pinned a pooled
      // connection idle-in-transaction (#1105). Each processor opens its own
      // short context around its DB touches, with HTTP/Redis run outside.
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
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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

  const token = decryptForColumn('s1_integrations', 'api_token_encrypted', integration.apiTokenEncrypted);
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

  const token = decryptForColumn('s1_integrations', 'api_token_encrypted', integration.apiTokenEncrypted);
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
