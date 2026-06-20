import { Job, type JobsOptions, Queue, Worker } from 'bullmq';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  devices,
  huntressAgents,
  huntressIncidents,
  huntressIntegrations,
  huntressOrgMappings,
} from '../db/schema';
import {
  HuntressClient,
  parseHuntressWebhookPayload,
  type HuntressAgentRecord,
  type HuntressIncidentRecord,
  type HuntressOrganizationRecord,
} from '../services/huntressClient';
import { publishEvent } from '../services/eventBus';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { captureException } from '../services/sentry';
import { decryptSecret } from '../services/secretCrypto';
import { HUNTRESS_OFFLINE_STATUSES, HUNTRESS_RESOLVED_STATUSES } from '../services/huntressConstants';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[HuntressSync] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const HUNTRESS_SYNC_QUEUE = 'huntress-sync';
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const EVENT_PUBLISH_CONCURRENCY = 10;

interface SyncAllJobData {
  type: 'sync-all';
}

interface SyncIntegrationJobData {
  type: 'sync-integration';
  integrationId: string;
}

type HuntressSyncJobData = SyncAllJobData | SyncIntegrationJobData;

export interface HuntressSyncResult {
  integrationId: string;
  fetchedAgents: number;
  fetchedIncidents: number;
  upsertedAgents: number;
  createdIncidents: number;
  updatedIncidents: number;
  discoveredOrganizations?: number;
  skippedUnmappedAgents?: number;
  skippedUnmappedIncidents?: number;
}

let huntressSyncQueue: Queue<HuntressSyncJobData> | null = null;
let huntressSyncWorker: Worker<HuntressSyncJobData> | null = null;

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    output.push(items.slice(i, i + size));
  }
  return output;
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = cursor++;
        if (current >= items.length) return;
        await worker(items[current]!);
      }
    })
  );
}

function normalizeHostname(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function toComparableDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isOfflineAgentStatus(status: string | null): boolean {
  if (!status) return false;
  return (HUNTRESS_OFFLINE_STATUSES as readonly string[]).some(s => status.includes(s));
}

function isResolvedIncidentStatus(status: string): boolean {
  return (HUNTRESS_RESOLVED_STATUSES as readonly string[]).includes(status);
}

async function addUniqueJob(
  queue: Queue<HuntressSyncJobData>,
  name: string,
  data: HuntressSyncJobData,
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
      console.warn(`[HuntressSync] Failed to remove stale job ${jobId}, proceeding with re-add:`, err);
    });
  }

  const created = await queue.add(name, data, {
    jobId,
    ...opts,
  });
  return String(created.id);
}

export function getHuntressSyncQueue(): Queue<HuntressSyncJobData> {
  if (!huntressSyncQueue) {
    huntressSyncQueue = new Queue<HuntressSyncJobData>(HUNTRESS_SYNC_QUEUE, {
      connection: getBullMQConnection()
    });
  }
  return huntressSyncQueue;
}

async function mapDevicesByHostname(
  orgId: string,
  candidateHostnames: string[]
): Promise<Map<string, string>> {
  const normalizedCandidates = Array.from(
    new Set(
      candidateHostnames
        .map((value) => normalizeHostname(value))
        .filter((value): value is string => Boolean(value))
    )
  );
  if (normalizedCandidates.length === 0) {
    return new Map();
  }

  const rows = (
    await Promise.all(
      chunk(normalizedCandidates, 500).map(async (hostnameChunk) => {
        return db
          .select({
            id: devices.id,
            hostname: devices.hostname,
            displayName: devices.displayName,
          })
          .from(devices)
          .where(
            and(
              eq(devices.orgId, orgId),
              or(
                inArray(sql<string>`lower(${devices.hostname})`, hostnameChunk),
                inArray(sql<string>`lower(${devices.displayName})`, hostnameChunk)
              )
            )
          );
      })
    )
  ).flat();

  const byHostname = new Map<string, string>();
  for (const row of rows) {
    const hostnames = [normalizeHostname(row.hostname), normalizeHostname(row.displayName)];
    for (const hostname of hostnames) {
      if (!hostname || byHostname.has(hostname)) continue;
      byHostname.set(hostname, row.id);
    }
  }
  return byHostname;
}

function collectCandidateHostnames(
  agents: HuntressAgentRecord[],
  incidents: HuntressIncidentRecord[]
): string[] {
  const values = new Set<string>();
  for (const agent of agents) {
    const hostname = normalizeHostname(agent.hostname);
    if (hostname) values.add(hostname);
  }
  for (const incident of incidents) {
    const hostname = normalizeHostname(incident.hostname);
    if (hostname) values.add(hostname);
  }
  return Array.from(values);
}

function huntressOrgIdForRecord(record: { organizationId: string | null }): string | null {
  return record.organizationId?.trim() || null;
}

function countByOrgId<T extends { organizationId: string | null }>(rows: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const orgId = huntressOrgIdForRecord(row);
    if (!orgId) continue;
    counts.set(orgId, (counts.get(orgId) ?? 0) + 1);
  }
  return counts;
}

function mergeDiscoveredOrganizations(input: {
  organizations: HuntressOrganizationRecord[];
  agents: HuntressAgentRecord[];
  incidents: HuntressIncidentRecord[];
}): HuntressOrganizationRecord[] {
  const byOrgId = new Map<string, HuntressOrganizationRecord>();
  const agentCounts = countByOrgId(input.agents);
  const incidentCounts = countByOrgId(input.incidents);

  for (const org of input.organizations) {
    byOrgId.set(org.huntressOrgId, {
      ...org,
      agentsCount: agentCounts.get(org.huntressOrgId) ?? org.agentsCount,
      incidentsCount: incidentCounts.get(org.huntressOrgId) ?? org.incidentsCount,
    });
  }

  for (const agent of input.agents) {
    const orgId = huntressOrgIdForRecord(agent);
    if (!orgId || byOrgId.has(orgId)) continue;
    byOrgId.set(orgId, {
      huntressOrgId: orgId,
      accountId: agent.accountId,
      name: null,
      key: null,
      agentsCount: agentCounts.get(orgId) ?? 0,
      incidentsCount: incidentCounts.get(orgId) ?? 0,
      metadata: { source: 'agent' },
    });
  }

  for (const incident of input.incidents) {
    const orgId = huntressOrgIdForRecord(incident);
    if (!orgId || byOrgId.has(orgId)) continue;
    byOrgId.set(orgId, {
      huntressOrgId: orgId,
      accountId: incident.accountId,
      name: null,
      key: null,
      agentsCount: agentCounts.get(orgId) ?? 0,
      incidentsCount: incidentCounts.get(orgId) ?? 0,
      metadata: { source: 'incident' },
    });
  }

  return Array.from(byOrgId.values());
}

async function upsertDiscoveredOrganizations(params: {
  integrationId: string;
  partnerId: string;
  organizations: HuntressOrganizationRecord[];
}): Promise<void> {
  if (params.organizations.length === 0) return;

  const now = new Date();
  const values = params.organizations.map((org) => ({
    integrationId: params.integrationId,
    partnerId: params.partnerId,
    huntressOrgId: org.huntressOrgId,
    huntressOrgName: org.name?.slice(0, 255) ?? null,
    huntressOrgKey: org.key?.slice(0, 120) ?? null,
    huntressAccountId: org.accountId?.slice(0, 120) ?? null,
    agentsCount: org.agentsCount,
    incidentsCount: org.incidentsCount,
    metadata: org.metadata,
    lastSeenAt: now,
    updatedAt: now,
  }));

  for (const batch of chunk(values, 500)) {
    await db
      .insert(huntressOrgMappings)
      .values(batch)
      .onConflictDoUpdate({
        target: [huntressOrgMappings.integrationId, huntressOrgMappings.huntressOrgId],
        set: {
          huntressOrgName: sql`excluded.huntress_org_name`,
          partnerId: sql`excluded.partner_id`,
          huntressOrgKey: sql`excluded.huntress_org_key`,
          huntressAccountId: sql`excluded.huntress_account_id`,
          agentsCount: sql`excluded.agents_count`,
          incidentsCount: sql`excluded.incidents_count`,
          metadata: sql`excluded.metadata`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        }
      });
  }
}

async function loadMappedOrgIds(integrationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      huntressOrgId: huntressOrgMappings.huntressOrgId,
      orgId: huntressOrgMappings.orgId,
    })
    .from(huntressOrgMappings)
    .where(eq(huntressOrgMappings.integrationId, integrationId));

  const mappings = new Map<string, string>();
  for (const row of rows) {
    if (row.orgId) mappings.set(row.huntressOrgId, row.orgId);
  }
  return mappings;
}

function groupByMappedOrg<T extends { organizationId: string | null }>(
  rows: T[],
  mappings: Map<string, string>
): { byOrgId: Map<string, T[]>; skipped: number } {
  const byOrgId = new Map<string, T[]>();
  let skipped = 0;

  for (const row of rows) {
    const huntressOrgId = huntressOrgIdForRecord(row);
    const orgId = huntressOrgId ? mappings.get(huntressOrgId) : undefined;
    if (!orgId) {
      skipped += 1;
      continue;
    }
    const group = byOrgId.get(orgId) ?? [];
    group.push(row);
    byOrgId.set(orgId, group);
  }

  return { byOrgId, skipped };
}

async function publishHuntressEvent(
  type: 'huntress.incident_created' | 'huntress.incident_updated' | 'huntress.agent_offline',
  orgId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, 'huntress-sync');
  } catch (error) {
    console.error(`[HuntressSync] Failed to publish ${type}:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

async function publishHuntressEvents(events: Array<{
  type: 'huntress.incident_created' | 'huntress.incident_updated' | 'huntress.agent_offline';
  orgId: string;
  payload: Record<string, unknown>;
}>): Promise<void> {
  await runWithConcurrencyLimit(events, EVENT_PUBLISH_CONCURRENCY, async (event) => {
    await publishHuntressEvent(event.type, event.orgId, event.payload);
  });
}

async function upsertAgents(params: {
  orgId: string;
  integrationId: string;
  agents: HuntressAgentRecord[];
  devicesByHostname: Map<string, string>;
}): Promise<{ upserted: number }> {
  const deduped = new Map<string, HuntressAgentRecord>();
  for (const agent of params.agents) {
    if (!agent.huntressAgentId) continue;
    deduped.set(agent.huntressAgentId, agent);
  }

  const huntressAgentIds = Array.from(deduped.keys());
  if (huntressAgentIds.length === 0) {
    return { upserted: 0 };
  }

  const existingRows = await Promise.all(
    chunk(huntressAgentIds, 500).map(async (ids) => {
      return db
        .select({
          huntressAgentId: huntressAgents.huntressAgentId,
          status: huntressAgents.status,
        })
        .from(huntressAgents)
        .where(
          and(
            eq(huntressAgents.integrationId, params.integrationId),
            inArray(huntressAgents.huntressAgentId, ids)
          )
        );
    })
  );

  const existingByAgentId = new Map<string, { status: string | null }>();
  for (const rows of existingRows) {
    for (const row of rows) {
      existingByAgentId.set(row.huntressAgentId, row);
    }
  }

  const values = Array.from(deduped.values()).map((agent) => {
    const hostname = normalizeHostname(agent.hostname);
    const mappedDeviceId = hostname ? (params.devicesByHostname.get(hostname) ?? null) : null;
    return {
      orgId: params.orgId,
      integrationId: params.integrationId,
      huntressAgentId: agent.huntressAgentId,
      deviceId: mappedDeviceId,
      hostname: agent.hostname?.slice(0, 255) ?? null,
      platform: agent.platform?.slice(0, 32) ?? null,
      status: agent.status?.slice(0, 20) ?? null,
      lastSeenAt: agent.lastSeenAt,
      metadata: agent.metadata,
      updatedAt: new Date(),
    };
  });

  for (const [batchIndex, batch] of chunk(values, 500).entries()) {
    try {
      await db
        .insert(huntressAgents)
        .values(batch)
        .onConflictDoUpdate({
          target: [huntressAgents.integrationId, huntressAgents.huntressAgentId],
          set: {
            orgId: sql`excluded.org_id`,
            deviceId: sql`excluded.device_id`,
            hostname: sql`excluded.hostname`,
            platform: sql`excluded.platform`,
            status: sql`excluded.status`,
            lastSeenAt: sql`excluded.last_seen_at`,
            metadata: sql`excluded.metadata`,
            updatedAt: sql`excluded.updated_at`,
          }
        });
    } catch (err) {
      throw new Error(
        `Failed to upsert agent batch ${batchIndex + 1} (${batch.length} records, ` +
        `first huntressAgentId=${batch[0]?.huntressAgentId}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const offlineEvents: Array<{
    type: 'huntress.incident_created' | 'huntress.incident_updated' | 'huntress.agent_offline';
    orgId: string;
    payload: Record<string, unknown>;
  }> = [];
  // Only emit offline events for agents that transitioned to offline (were previously online and are now offline)
  for (const row of values) {
    const previous = existingByAgentId.get(row.huntressAgentId);
    if (!previous) continue;
    if (isOfflineAgentStatus(previous.status) || !isOfflineAgentStatus(row.status)) continue;

    offlineEvents.push({
      type: 'huntress.agent_offline',
      orgId: params.orgId,
      payload: {
        integrationId: params.integrationId,
        huntressAgentId: row.huntressAgentId,
        deviceId: row.deviceId,
        hostname: row.hostname,
        status: row.status,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      },
    });
  }
  await publishHuntressEvents(offlineEvents);

  return { upserted: values.length };
}

function incidentHasChanged(
  previous: {
    severity: string | null;
    category: string | null;
    title: string;
    description: string | null;
    recommendation: string | null;
    status: string;
    reportedAt: Date | null;
    resolvedAt: Date | null;
    deviceId: string | null;
  },
  next: {
    severity: string | null;
    category: string | null;
    title: string;
    description: string | null;
    recommendation: string | null;
    status: string;
    reportedAt: Date | null;
    resolvedAt: Date | null;
    deviceId: string | null;
  }
): boolean {
  return previous.severity !== next.severity
    || previous.category !== next.category
    || previous.title !== next.title
    || previous.description !== next.description
    || previous.recommendation !== next.recommendation
    || previous.status !== next.status
    || toComparableDate(previous.reportedAt) !== toComparableDate(next.reportedAt)
    || toComparableDate(previous.resolvedAt) !== toComparableDate(next.resolvedAt)
    || previous.deviceId !== next.deviceId;
}

async function upsertIncidents(params: {
  orgId: string;
  integrationId: string;
  incidents: HuntressIncidentRecord[];
  devicesByHostname: Map<string, string>;
}): Promise<{ created: number; updated: number }> {
  const deduped = new Map<string, HuntressIncidentRecord>();
  for (const incident of params.incidents) {
    if (!incident.huntressIncidentId) continue;
    deduped.set(incident.huntressIncidentId, incident);
  }

  const huntressIncidentIds = Array.from(deduped.keys());
  if (huntressIncidentIds.length === 0) {
    return { created: 0, updated: 0 };
  }

  const existingRows = await Promise.all(
    chunk(huntressIncidentIds, 500).map(async (ids) => {
      return db
        .select({
          huntressIncidentId: huntressIncidents.huntressIncidentId,
          severity: huntressIncidents.severity,
          category: huntressIncidents.category,
          title: huntressIncidents.title,
          description: huntressIncidents.description,
          recommendation: huntressIncidents.recommendation,
          status: huntressIncidents.status,
          reportedAt: huntressIncidents.reportedAt,
          resolvedAt: huntressIncidents.resolvedAt,
          deviceId: huntressIncidents.deviceId,
        })
        .from(huntressIncidents)
        .where(
          and(
            eq(huntressIncidents.integrationId, params.integrationId),
            inArray(huntressIncidents.huntressIncidentId, ids)
          )
        );
    })
  );

  const existingByIncidentId = new Map<string, {
    severity: string | null;
    category: string | null;
    title: string;
    description: string | null;
    recommendation: string | null;
    status: string;
    reportedAt: Date | null;
    resolvedAt: Date | null;
    deviceId: string | null;
  }>();
  for (const rows of existingRows) {
    for (const row of rows) {
      existingByIncidentId.set(row.huntressIncidentId, row);
    }
  }

  const agentIds = Array.from(new Set(
    Array.from(deduped.values())
      .map((incident) => incident.huntressAgentId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  ));

  const agentDeviceRows = agentIds.length > 0
    ? await db
      .select({
        huntressAgentId: huntressAgents.huntressAgentId,
        deviceId: huntressAgents.deviceId,
      })
      .from(huntressAgents)
      .where(
        and(
          eq(huntressAgents.integrationId, params.integrationId),
          inArray(huntressAgents.huntressAgentId, agentIds)
        )
      )
    : [];
  const deviceByAgentId = new Map<string, string | null>();
  for (const row of agentDeviceRows) {
    deviceByAgentId.set(row.huntressAgentId, row.deviceId);
  }

  const values = Array.from(deduped.values()).map((incident) => {
    const hostname = normalizeHostname(incident.hostname);
    const mappedByHostname = hostname ? (params.devicesByHostname.get(hostname) ?? null) : null;
    const mappedByAgent = incident.huntressAgentId ? (deviceByAgentId.get(incident.huntressAgentId) ?? null) : null;
    const mappedDeviceId = mappedByAgent ?? mappedByHostname;
    return {
      orgId: params.orgId,
      integrationId: params.integrationId,
      deviceId: mappedDeviceId,
      huntressIncidentId: incident.huntressIncidentId,
      severity: incident.severity?.slice(0, 20) ?? null,
      category: incident.category?.slice(0, 60) ?? null,
      title: incident.title,
      description: incident.description,
      recommendation: incident.recommendation,
      status: incident.status.slice(0, 30),
      reportedAt: incident.reportedAt,
      resolvedAt: incident.resolvedAt,
      details: incident.details,
      updatedAt: new Date(),
    };
  });

  for (const [batchIndex, batch] of chunk(values, 500).entries()) {
    try {
      await db
        .insert(huntressIncidents)
        .values(batch)
        .onConflictDoUpdate({
          target: [huntressIncidents.integrationId, huntressIncidents.huntressIncidentId],
          set: {
            orgId: sql`excluded.org_id`,
            deviceId: sql`excluded.device_id`,
            severity: sql`excluded.severity`,
            category: sql`excluded.category`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            recommendation: sql`excluded.recommendation`,
            status: sql`excluded.status`,
            reportedAt: sql`excluded.reported_at`,
            resolvedAt: sql`excluded.resolved_at`,
            details: sql`excluded.details`,
            updatedAt: sql`excluded.updated_at`,
          }
        });
    } catch (err) {
      throw new Error(
        `Failed to upsert incident batch ${batchIndex + 1} (${batch.length} records, ` +
        `first huntressIncidentId=${batch[0]?.huntressIncidentId}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  let created = 0;
  let updated = 0;
  const emittedEvents: Array<{
    type: 'huntress.incident_created' | 'huntress.incident_updated' | 'huntress.agent_offline';
    orgId: string;
    payload: Record<string, unknown>;
  }> = [];

  for (const row of values) {
    const previous = existingByIncidentId.get(row.huntressIncidentId);
    if (!previous) {
      created += 1;
      emittedEvents.push({
        type: 'huntress.incident_created',
        orgId: params.orgId,
        payload: {
          integrationId: params.integrationId,
          huntressIncidentId: row.huntressIncidentId,
          deviceId: row.deviceId,
          severity: row.severity,
          category: row.category,
          status: row.status,
          title: row.title,
        },
      });
      continue;
    }

    const hasChanged = incidentHasChanged(previous, row);
    if (!hasChanged) continue;
    updated += 1;
    emittedEvents.push({
      type: 'huntress.incident_updated',
      orgId: params.orgId,
      payload: {
        integrationId: params.integrationId,
        huntressIncidentId: row.huntressIncidentId,
        deviceId: row.deviceId,
        severity: row.severity,
        category: row.category,
        status: row.status,
        title: row.title,
        resolved: isResolvedIncidentStatus(row.status),
      },
    });
  }
  await publishHuntressEvents(emittedEvents);

  return { created, updated };
}

// Exported for unit testing the DB-context boundaries (#1697). The production
// entry points are the BullMQ worker (scheduled) and ingestHuntressWebhookPayload.
export async function syncIntegrationById(
  integrationId: string,
  source: 'manual' | 'scheduled' | 'webhook' = 'scheduled',
  webhookPayload?: { agents: HuntressAgentRecord[]; incidents: HuntressIncidentRecord[]; }
): Promise<HuntressSyncResult> {
  // Phase 1 — load the integration row in its own short DB context, kept
  // separate from the write phase so the external Huntress fetch below holds
  // NO open transaction (#1697). Pinning a pooled connection across the ~20s
  // HTTP window starved the US connection pool (Sentry BREEZE-9).
  const [integration] = await runWithSystemDbAccess(() =>
    db
      .select()
      .from(huntressIntegrations)
      .where(eq(huntressIntegrations.id, integrationId))
      .limit(1)
  );

  if (!integration) {
    console.warn(`[HuntressSync] Integration ${integrationId} not found, skipping sync`);
    throw new Error(`Huntress integration ${integrationId} not found`);
  }
  if (!integration.isActive) {
    console.warn(`[HuntressSync] Integration ${integrationId} is inactive, skipping sync`);
    return {
      integrationId,
      fetchedAgents: 0,
      fetchedIncidents: 0,
      upsertedAgents: 0,
      createdIncidents: 0,
      updatedIncidents: 0,
    };
  }

  try {
    let organizations: HuntressOrganizationRecord[];
    let agents: HuntressAgentRecord[];
    let incidents: HuntressIncidentRecord[];

    if (webhookPayload) {
      organizations = [];
      agents = webhookPayload.agents;
      incidents = webhookPayload.incidents;
    } else {
      let apiKey: string | null;
      try {
        apiKey = decryptSecret(integration.apiKeyEncrypted);
      } catch (err) {
        throw new Error(`Failed to decrypt API key for Huntress integration ${integrationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!apiKey) {
        throw new Error(`Huntress API key is empty for integration ${integrationId}`);
      }

      const client = new HuntressClient({
        apiKey,
        accountId: integration.accountId,
        baseUrl: integration.apiBaseUrl,
      });

      // Subtract 60s from last sync to create an overlap window, ensuring events near the boundary aren't missed
      const since = integration.lastSyncAt
        ? new Date(integration.lastSyncAt.getTime() - 60_000)
        : new Date(Date.now() - DEFAULT_LOOKBACK_MS);

      // Phase 2 — fetch from Huntress with NO DB context held.
      // runOutsideDbContext guarantees this even when an outer context exists
      // (e.g. the webhook caller wraps this function), so the external HTTP
      // never sits inside an open transaction (#1105/#1697).
      [organizations, agents, incidents] = await dbModule.runOutsideDbContext(() =>
        Promise.all([
          client.listOrganizations(),
          client.listAgents(since),
          client.listIncidents(since),
        ])
      );
    }

    // Phase 3 — persist everything in ONE DB context so the upserts and the
    // success-status update commit atomically together.
    return await runWithSystemDbAccess(async () => {
      const discoveredOrganizations = mergeDiscoveredOrganizations({ organizations, agents, incidents });
      await upsertDiscoveredOrganizations({
        integrationId: integration.id,
        partnerId: integration.partnerId,
        organizations: discoveredOrganizations,
      });

      const mappedOrgIds = await loadMappedOrgIds(integration.id);
      const groupedAgents = groupByMappedOrg(agents, mappedOrgIds);
      const groupedIncidents = groupByMappedOrg(incidents, mappedOrgIds);
      const allMappedOrgIds = Array.from(new Set([
        ...groupedAgents.byOrgId.keys(),
        ...groupedIncidents.byOrgId.keys(),
      ]));

      let upsertedAgents = 0;
      let createdIncidents = 0;
      let updatedIncidents = 0;

      for (const orgId of allMappedOrgIds) {
        const orgAgents = groupedAgents.byOrgId.get(orgId) ?? [];
        const orgIncidents = groupedIncidents.byOrgId.get(orgId) ?? [];
        const devicesByHostname = await mapDevicesByHostname(
          orgId,
          collectCandidateHostnames(orgAgents, orgIncidents)
        );

        const [agentResult, incidentResult] = await Promise.all([
          upsertAgents({
            orgId,
            integrationId: integration.id,
            agents: orgAgents,
            devicesByHostname,
          }),
          upsertIncidents({
            orgId,
            integrationId: integration.id,
            incidents: orgIncidents,
            devicesByHostname,
          }),
        ]);
        upsertedAgents += agentResult.upserted;
        createdIncidents += incidentResult.created;
        updatedIncidents += incidentResult.updated;
      }

      await db
        .update(huntressIntegrations)
        .set({
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(huntressIntegrations.id, integration.id));

      return {
        integrationId: integration.id,
        fetchedAgents: agents.length,
        fetchedIncidents: incidents.length,
        upsertedAgents,
        createdIncidents,
        updatedIncidents,
        discoveredOrganizations: discoveredOrganizations.length,
        skippedUnmappedAgents: groupedAgents.skipped,
        skippedUnmappedIncidents: groupedIncidents.skipped,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      // Record the failure on a FRESH transaction. Phase 3's write transaction
      // (or, on the webhook path, the caller's outer context) is rolling back as
      // we unwind, so recording the failure on that same connection would be
      // undone and the row would keep its stale status. Escape the current
      // context (runOutsideDbContext) and open a new transaction
      // (runWithSystemDbAccess) so the 'error' status commits and survives the
      // rollback.
      await dbModule.runOutsideDbContext(() =>
        runWithSystemDbAccess(() =>
          db
            .update(huntressIntegrations)
            .set({
              lastSyncStatus: 'error',
              lastSyncError: `${source}: ${message}`.slice(0, 2000),
              updatedAt: new Date(),
            })
            .where(eq(huntressIntegrations.id, integrationId))
        )
      );
    } catch (dbErr) {
      console.error(`[HuntressSync] Failed to record sync error for integration ${integrationId}:`, dbErr);
      captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)));
    }
    throw error;
  }
}

async function processSyncAll(): Promise<{ queued: number }> {
  const queue = getHuntressSyncQueue();
  // Read inside a short DB context — huntress_integrations is partner-scoped, so
  // a contextless read under breeze_app RLS silently returns 0 rows (#1375).
  // The enqueue below then runs with no transaction held (Redis-in-context is
  // itself the #1105 anti-pattern).
  const integrations = await runWithSystemDbAccess(() =>
    db
      .select({
        id: huntressIntegrations.id,
        lastSyncAt: huntressIntegrations.lastSyncAt,
      })
      .from(huntressIntegrations)
      .where(eq(huntressIntegrations.isActive, true))
  );

  const now = Date.now();
  const due = integrations.filter((integration) => {
    if (!integration.lastSyncAt) return true;
    const elapsedMinutes = (now - integration.lastSyncAt.getTime()) / 60_000;
    return elapsedMinutes >= DEFAULT_SYNC_INTERVAL_MINUTES;
  });

  await Promise.all(due.map((integration) => addUniqueJob(
    queue,
    'sync-integration',
    { type: 'sync-integration', integrationId: integration.id },
    `huntress-sync-integration-${integration.id}`,
    { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } }
  )));

  return { queued: due.length };
}

async function processSyncIntegration(data: SyncIntegrationJobData): Promise<HuntressSyncResult> {
  return syncIntegrationById(data.integrationId, 'scheduled');
}

export async function scheduleHuntressSync(integrationId?: string): Promise<string> {
  const queue = getHuntressSyncQueue();
  if (integrationId) {
    return addUniqueJob(
      queue,
      'sync-integration',
      { type: 'sync-integration', integrationId },
      `huntress-sync-integration-${integrationId}`,
      { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } }
    );
  }

  return addUniqueJob(
    queue,
    'sync-all',
    { type: 'sync-all' },
    'huntress-sync-all-manual',
    { removeOnComplete: true, removeOnFail: true }
  );
}

export async function ingestHuntressWebhookPayload(params: {
  integrationId: string;
  payload: unknown;
}): Promise<HuntressSyncResult> {
  return runWithSystemDbAccess(async () => {
    const parsed = parseHuntressWebhookPayload(params.payload);
    return syncIntegrationById(
      params.integrationId,
      'webhook',
      { agents: parsed.agents, incidents: parsed.incidents }
    );
  });
}

export async function findHuntressIntegrationByAccount(accountId: string): Promise<
  | { status: 'none' }
  | { status: 'ambiguous' }
  | {
    status: 'single';
    integration: {
      id: string;
      partnerId: string;
      accountId: string | null;
      webhookSecretEncrypted: string | null;
    };
  }
> {
  return runWithSystemDbAccess(async () => {
    const rows = await db
      .select({
        id: huntressIntegrations.id,
        partnerId: huntressIntegrations.partnerId,
        accountId: huntressIntegrations.accountId,
        webhookSecretEncrypted: huntressIntegrations.webhookSecretEncrypted,
      })
      .from(huntressIntegrations)
      .where(
        and(
          eq(huntressIntegrations.accountId, accountId),
          eq(huntressIntegrations.isActive, true)
        )
      )
      .limit(2);
    if (rows.length === 0) return { status: 'none' } as const;
    if (rows.length > 1) return { status: 'ambiguous' } as const;
    return {
      status: 'single' as const,
      integration: rows[0]!,
    };
  });
}

function createHuntressSyncWorker(): Worker<HuntressSyncJobData> {
  return new Worker<HuntressSyncJobData>(
    HUNTRESS_SYNC_QUEUE,
    async (job: Job<HuntressSyncJobData>) => {
      // No blanket withSystemDbAccessContext wrap here — each path manages its
      // own short DB contexts so the external Huntress fetch in syncIntegrationById
      // runs with no pooled connection held in an open transaction (#1105/#1697).
      switch (job.data.type) {
        case 'sync-all':
          return processSyncAll();
        case 'sync-integration':
          return processSyncIntegration(job.data);
        default:
          throw new Error(`Unknown Huntress sync job type: ${(job.data as { type: string }).type}`);
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

async function scheduleRepeatSyncAll(): Promise<void> {
  const queue = getHuntressSyncQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const repeatable of repeatables) {
    if (repeatable.name === 'sync-all') {
      await queue.removeRepeatableByKey(repeatable.key);
    }
  }

  await queue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { every: DEFAULT_SYNC_INTERVAL_MINUTES * 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 30 },
    }
  );
}

export async function initializeHuntressSyncJob(): Promise<void> {
  huntressSyncWorker = createHuntressSyncWorker();
  huntressSyncWorker.on('error', (error) => {
    console.error('[HuntressSync] Worker error:', error);
    captureException(error);
  });
  huntressSyncWorker.on('failed', (job, error) => {
    console.error(`[HuntressSync] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRepeatSyncAll();
  await scheduleHuntressSync();
  console.log('[HuntressSync] Huntress sync worker initialized');
}

export async function shutdownHuntressSyncJob(): Promise<void> {
  if (huntressSyncWorker) {
    await huntressSyncWorker.close();
    huntressSyncWorker = null;
  }
  if (huntressSyncQueue) {
    await huntressSyncQueue.close();
    huntressSyncQueue = null;
  }
  console.log('[HuntressSync] Huntress sync worker shut down');
}
