import { createHash } from 'node:crypto';
import { Job, type JobsOptions, Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  dnsEventAggregations,
  devices,
  deviceNetwork,
  dnsActionEnum,
  dnsFilterIntegrations,
  dnsPolicies,
  dnsSecurityEvents,
  dnsThreatCategoryEnum,
  type DnsAction,
  type DnsIntegrationConfig,
  type DnsPolicyDomain,
  type DnsThreatCategory
} from '../db/schema';
import { createDnsProvider, type DnsEvent } from '../services/dnsProviders';
import { getRedisConnection } from '../services/redis';
import { decryptSecret } from '../services/secretCrypto';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const DNS_SYNC_QUEUE = 'dns-sync';
const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 1440;

const VALID_ACTIONS = new Set(dnsActionEnum.enumValues);
const VALID_CATEGORIES = new Set(dnsThreatCategoryEnum.enumValues);
const DATE_KEY_RE = /^(\d{4}-\d{2}-\d{2})/;

interface SyncIntegrationJobData {
  type: 'sync-integration';
  integrationId: string;
}

interface SyncAllJobData {
  type: 'sync-all';
}

interface PolicySyncOperation {
  add: string[];
  remove: string[];
}

interface SyncPolicyJobData {
  type: 'sync-policy';
  policyId: string;
  operations?: PolicySyncOperation;
}

type DnsSyncJobData = SyncIntegrationJobData | SyncAllJobData | SyncPolicyJobData;

let dnsSyncQueue: Queue<DnsSyncJobData> | null = null;
let dnsSyncWorker: Worker<DnsSyncJobData> | null = null;

interface EventAggregationDelta {
  orgId: string;
  date: string;
  integrationId: string | null;
  deviceId: string | null;
  domain: string | null;
  category: DnsThreatCategory | null;
  totalQueries: number;
  blockedQueries: number;
  allowedQueries: number;
}

export function getDnsSyncQueue(): Queue<DnsSyncJobData> {
  if (!dnsSyncQueue) {
    dnsSyncQueue = new Queue<DnsSyncJobData>(DNS_SYNC_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return dnsSyncQueue;
}

function parseIntegrationConfig(value: unknown): DnsIntegrationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as DnsIntegrationConfig;
}

function normalizeDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.length > 500) return null;
  return normalized;
}

function normalizeAction(action: unknown): DnsAction {
  if (typeof action === 'string' && VALID_ACTIONS.has(action as DnsAction)) {
    return action as DnsAction;
  }
  const normalized = typeof action === 'string' ? action.toLowerCase() : '';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('redirect')) return 'redirected';
  return 'allowed';
}

function normalizeThreatCategory(value: unknown): DnsThreatCategory | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (VALID_CATEGORIES.has(normalized as DnsThreatCategory)) {
    return normalized as DnsThreatCategory;
  }

  if (normalized.includes('phish')) return 'phishing';
  if (normalized.includes('malware')) return 'malware';
  if (normalized.includes('bot')) return 'botnet';
  if (normalized.includes('ransom')) return 'ransomware';
  if (normalized.includes('crypto')) return 'cryptomining';
  if (normalized.includes('spam')) return 'spam';
  if (normalized.includes('ad')) return 'adware';
  if (normalized.includes('adult')) return 'adult_content';
  if (normalized.includes('gambl')) return 'gambling';
  if (normalized.includes('social')) return 'social_media';
  if (normalized.includes('stream')) return 'streaming';

  return 'unknown';
}

function normalizeQueryType(value: unknown): string {
  if (typeof value !== 'string') return 'A';
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized.slice(0, 10) : 'A';
}

function normalizeSourceIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 45 ? normalized : null;
}

function normalizeSourceHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 255) : null;
}

function normalizeThreatType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

function createFallbackProviderEventId(integrationId: string, event: DnsEvent): string {
  const seed = [
    integrationId,
    event.timestamp.toISOString(),
    event.domain,
    event.queryType,
    event.action,
    event.sourceIp ?? '',
    event.sourceHostname ?? ''
  ].join('|');
  return createHash('sha256').update(seed).digest('hex').slice(0, 48);
}

function normalizePolicyDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const domain = normalizeDomain((item as DnsPolicyDomain).domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    output.push(domain);
  }

  return output;
}

function normalizeDomainList(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const domain of domains) {
    const normalized = normalizeDomain(domain);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function toDateKey(value: Date): string {
  const iso = value.toISOString();
  const match = DATE_KEY_RE.exec(iso);
  return match?.[1] ?? iso.slice(0, 10);
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function syncIntervalMinutesFromConfig(config: DnsIntegrationConfig): number {
  const configured = Number(config.syncInterval);
  if (!Number.isFinite(configured)) return DEFAULT_SYNC_INTERVAL_MINUTES;
  return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(configured)));
}

async function addUniqueJob(
  queue: Queue<DnsSyncJobData>,
  name: string,
  data: DnsSyncJobData,
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
    await existing.remove().catch(() => undefined);
  }

  const job = await queue.add(name, data, {
    jobId,
    ...opts
  });
  return String(job.id);
}

async function persistAggregationDeltas(deltas: EventAggregationDelta[]): Promise<void> {
  if (deltas.length === 0) return;
  for (const batch of chunk(deltas, 500)) {
    await db.insert(dnsEventAggregations).values(batch);
  }
}

async function mapDevicesByIp(orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      deviceId: deviceNetwork.deviceId,
      ipAddress: deviceNetwork.ipAddress
    })
    .from(deviceNetwork)
    .innerJoin(devices, eq(deviceNetwork.deviceId, devices.id))
    .where(
      and(
        eq(devices.orgId, orgId),
        isNotNull(deviceNetwork.ipAddress)
      )
    );

  const byIp = new Map<string, string>();
  for (const row of rows) {
    if (!row.ipAddress) continue;
    byIp.set(row.ipAddress, row.deviceId);
  }
  return byIp;
}

export async function scheduleDnsEventSync(integrationId?: string): Promise<string> {
  const queue = getDnsSyncQueue();
  if (integrationId) {
    return addUniqueJob(
      queue,
      'sync-integration',
      { type: 'sync-integration', integrationId },
      `sync-integration:${integrationId}`,
      { removeOnComplete: true, removeOnFail: true }
    );
  }

  return addUniqueJob(
    queue,
    'sync-all',
    { type: 'sync-all' },
    'sync-all:manual',
    { removeOnComplete: true, removeOnFail: true }
  );
}

export async function schedulePolicySync(
  policyId: string,
  operations?: Partial<PolicySyncOperation>
): Promise<string> {
  const queue = getDnsSyncQueue();
  return addUniqueJob(
    queue,
    'sync-policy',
    {
      type: 'sync-policy',
      policyId,
      operations: operations
        ? {
          add: normalizeDomainList(operations.add),
          remove: normalizeDomainList(operations.remove)
        }
        : undefined
    },
    `sync-policy:${policyId}`,
    { removeOnComplete: true, removeOnFail: true }
  );
}

async function processSyncAll(): Promise<{ queued: number }> {
  const queue = getDnsSyncQueue();
  const now = Date.now();

  const integrations = await db
    .select({
      id: dnsFilterIntegrations.id,
      lastSync: dnsFilterIntegrations.lastSync,
      config: dnsFilterIntegrations.config
    })
    .from(dnsFilterIntegrations)
    .where(eq(dnsFilterIntegrations.isActive, true));

  const dueIntegrations = integrations.filter((integration) => {
    const config = parseIntegrationConfig(integration.config);
    const intervalMinutes = syncIntervalMinutesFromConfig(config);
    if (!integration.lastSync) return true;
    const elapsedMs = now - integration.lastSync.getTime();
    return elapsedMs >= intervalMinutes * 60 * 1000;
  });

  if (dueIntegrations.length === 0) {
    return { queued: 0 };
  }

  await Promise.all(
    dueIntegrations.map((integration) => addUniqueJob(
      queue,
      'sync-integration',
      { type: 'sync-integration', integrationId: integration.id },
      `sync-integration:${integration.id}`,
      { removeOnComplete: true, removeOnFail: true }
    ))
  );

  return { queued: dueIntegrations.length };
}

async function processSyncIntegration(data: SyncIntegrationJobData): Promise<{
  integrationId: string;
  fetched: number;
  inserted: number;
}> {
  const [integration] = await db
    .select()
    .from(dnsFilterIntegrations)
    .where(eq(dnsFilterIntegrations.id, data.integrationId))
    .limit(1);

  if (!integration || !integration.isActive) {
    return { integrationId: data.integrationId, fetched: 0, inserted: 0 };
  }

  const config = parseIntegrationConfig(integration.config);

  try {
    const provider = createDnsProvider({
      provider: integration.provider,
      apiKey: decryptSecret(integration.apiKey),
      apiSecret: decryptSecret(integration.apiSecret),
      config
    });

    const since = integration.lastSync
      ? new Date(integration.lastSync.getTime() - 60 * 1000)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const until = new Date();

    const events = await provider.syncEvents(since, until);
    const categoriesFilter = new Set(
      (config.categories ?? [])
        .map((item) => normalizeThreatCategory(item))
        .filter((item): item is DnsThreatCategory => item !== null)
    );
    const devicesByIp = await mapDevicesByIp(integration.orgId);

    const values = events.flatMap((event) => {
      const domain = normalizeDomain(event.domain);
      if (!domain) return [];

      const action = normalizeAction(event.action);
      const category = normalizeThreatCategory(event.category);

      if (categoriesFilter.size > 0) {
        if (!category || !categoriesFilter.has(category)) {
          return [];
        }
      }

      const sourceIp = normalizeSourceIp(event.sourceIp);
      const deviceId = sourceIp ? (devicesByIp.get(sourceIp) ?? null) : null;

      return [{
        orgId: integration.orgId,
        integrationId: integration.id,
        deviceId,
        timestamp: event.timestamp,
        domain,
        queryType: normalizeQueryType(event.queryType),
        action,
        category,
        threatType: normalizeThreatType(event.threatType),
        sourceIp,
        sourceHostname: normalizeSourceHost(event.sourceHostname),
        providerEventId: normalizeSourceHost(event.providerEventId) ?? createFallbackProviderEventId(integration.id, event),
        metadata: event.metadata ?? null
      }];
    });

    let insertedCount = 0;
    const aggregationMap = new Map<string, EventAggregationDelta>();

    for (const batch of chunk(values, 500)) {
      const inserted = await db
        .insert(dnsSecurityEvents)
        .values(batch)
        .onConflictDoNothing({
          target: [dnsSecurityEvents.integrationId, dnsSecurityEvents.providerEventId]
        })
        .returning({
          orgId: dnsSecurityEvents.orgId,
          integrationId: dnsSecurityEvents.integrationId,
          deviceId: dnsSecurityEvents.deviceId,
          timestamp: dnsSecurityEvents.timestamp,
          domain: dnsSecurityEvents.domain,
          category: dnsSecurityEvents.category,
          action: dnsSecurityEvents.action
        });

      insertedCount += inserted.length;

      for (const row of inserted) {
        const day = toDateKey(row.timestamp);
        const category = row.category as DnsThreatCategory | null;
        const key = [
          row.orgId,
          day,
          row.integrationId ?? '',
          row.deviceId ?? '',
          row.domain ?? '',
          category ?? ''
        ].join('|');

        const current = aggregationMap.get(key) ?? {
          orgId: row.orgId,
          date: day,
          integrationId: row.integrationId,
          deviceId: row.deviceId,
          domain: row.domain,
          category,
          totalQueries: 0,
          blockedQueries: 0,
          allowedQueries: 0
        };

        current.totalQueries += 1;
        if (row.action === 'blocked') current.blockedQueries += 1;
        if (row.action === 'allowed') current.allowedQueries += 1;
        aggregationMap.set(key, current);
      }
    }

    await persistAggregationDeltas(Array.from(aggregationMap.values()));

    const retentionDays = Number(config.retentionDays);
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      const cutoff = new Date(Date.now() - Math.round(retentionDays) * 24 * 60 * 60 * 1000);
      await db
        .delete(dnsSecurityEvents)
        .where(
          and(
            eq(dnsSecurityEvents.integrationId, integration.id),
            lte(dnsSecurityEvents.timestamp, cutoff)
          )
        );
    }

    await db
      .update(dnsFilterIntegrations)
      .set({
        lastSync: until,
        lastSyncStatus: 'success',
        lastSyncError: null,
        totalEventsProcessed: sql`${dnsFilterIntegrations.totalEventsProcessed} + ${insertedCount}`,
        updatedAt: new Date()
      })
      .where(eq(dnsFilterIntegrations.id, integration.id));

    return {
      integrationId: integration.id,
      fetched: events.length,
      inserted: insertedCount
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(dnsFilterIntegrations)
      .set({
        lastSyncStatus: 'error',
        lastSyncError: message.slice(0, 2000),
        updatedAt: new Date()
      })
      .where(eq(dnsFilterIntegrations.id, integration.id));
    throw error;
  }
}

async function processPolicySync(data: SyncPolicyJobData): Promise<{
  policyId: string;
  added: number;
  removed: number;
}> {
  const [row] = await db
    .select({
      policy: dnsPolicies,
      integration: dnsFilterIntegrations
    })
    .from(dnsPolicies)
    .innerJoin(dnsFilterIntegrations, eq(dnsPolicies.integrationId, dnsFilterIntegrations.id))
    .where(eq(dnsPolicies.id, data.policyId))
    .limit(1);

  if (!row) {
    return { policyId: data.policyId, added: 0, removed: 0 };
  }

  const config = parseIntegrationConfig(row.integration.config);

  try {
    const provider = createDnsProvider({
      provider: row.integration.provider,
      apiKey: decryptSecret(row.integration.apiKey),
      apiSecret: decryptSecret(row.integration.apiSecret),
      config
    });

    const addDomains = data.operations
      ? normalizeDomainList(data.operations.add)
      : normalizePolicyDomains(row.policy.domains);
    const removeDomains = data.operations
      ? normalizeDomainList(data.operations.remove)
      : [];

    const runBatched = async (
      domains: string[],
      operation: (domain: string) => Promise<void>,
      concurrency = 10
    ): Promise<void> => {
      if (domains.length === 0) return;
      for (let i = 0; i < domains.length; i += concurrency) {
        const block = domains.slice(i, i + concurrency);
        await Promise.all(block.map(operation));
      }
    };

    if (row.policy.type === 'blocklist') {
      await runBatched(addDomains, (domain) => provider.addBlocklistDomain(domain), 10);
      await runBatched(removeDomains, (domain) => provider.removeBlocklistDomain(domain), 10);
    } else {
      await runBatched(addDomains, (domain) => provider.addAllowlistDomain(domain), 10);
      await runBatched(removeDomains, (domain) => provider.removeAllowlistDomain(domain), 10);
    }

    await db
      .update(dnsPolicies)
      .set({
        syncStatus: 'synced',
        lastSynced: new Date(),
        syncError: null,
        updatedAt: new Date()
      })
      .where(eq(dnsPolicies.id, row.policy.id));

    return {
      policyId: row.policy.id,
      added: addDomains.length,
      removed: removeDomains.length
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(dnsPolicies)
      .set({
        syncStatus: 'error',
        syncError: message.slice(0, 2000),
        updatedAt: new Date()
      })
      .where(eq(dnsPolicies.id, row.policy.id));
    throw error;
  }
}

function createDnsSyncWorker(): Worker<DnsSyncJobData> {
  return new Worker<DnsSyncJobData>(
    DNS_SYNC_QUEUE,
    async (job: Job<DnsSyncJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'sync-all':
            return processSyncAll();
          case 'sync-integration':
            return processSyncIntegration(job.data);
          case 'sync-policy':
            return processPolicySync(job.data);
          default:
            throw new Error(`Unknown DNS sync job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 4
    }
  );
}

async function scheduleRepeatSyncAllJob(): Promise<void> {
  const queue = getDnsSyncQueue();
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
      repeat: { every: DEFAULT_SYNC_INTERVAL_MINUTES * 60 * 1000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );
}

export async function initializeDnsSyncJob(): Promise<void> {
  dnsSyncWorker = createDnsSyncWorker();

  dnsSyncWorker.on('error', (error) => {
    console.error('[DnsSyncJob] Worker error:', error);
  });

  dnsSyncWorker.on('failed', (job, error) => {
    console.error(`[DnsSyncJob] Job ${job?.id} failed:`, error);
  });

  await scheduleRepeatSyncAllJob();
  await scheduleDnsEventSync();

  console.log('[DnsSyncJob] DNS sync worker initialized');
}

export async function shutdownDnsSyncJob(): Promise<void> {
  if (dnsSyncWorker) {
    await dnsSyncWorker.close();
    dnsSyncWorker = null;
  }

  if (dnsSyncQueue) {
    await dnsSyncQueue.close();
    dnsSyncQueue = null;
  }

  console.log('[DnsSyncJob] DNS sync worker shut down');
}
