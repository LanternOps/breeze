/**
 * Discovery Worker
 *
 * BullMQ worker that dispatches network discovery scan commands to agents
 * and processes results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  discoveryProfiles,
  discoveryJobs,
  discoveredAssets,
  networkTopology,
  devices,
  deviceNetwork
} from '../db/schema';
import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { sendCommandToAgent, isAgentConnected, type AgentCommand } from '../routes/agentWs';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Queue name
const DISCOVERY_QUEUE = 'discovery';

// Singleton queue instance
let discoveryQueue: Queue | null = null;

/**
 * Get or create the discovery queue
 */
export function getDiscoveryQueue(): Queue {
  if (!discoveryQueue) {
    discoveryQueue = new Queue(DISCOVERY_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return discoveryQueue;
}

// Job data types

interface DispatchScanJobData {
  type: 'dispatch-scan';
  jobId: string;
  profileId: string;
  orgId: string;
  siteId: string;
  agentId?: string | null;
}

interface ProcessResultsJobData {
  type: 'process-results';
  jobId: string;
  orgId: string;
  siteId: string;
  hosts: DiscoveredHostResult[];
  hostsScanned: number;
  hostsDiscovered: number;
}

export interface DiscoveredHostResult {
  ip: string;
  mac?: string;
  hostname?: string;
  netbiosName?: string;
  assetType: string;
  manufacturer?: string;
  model?: string;
  openPorts?: Array<{ port: number; service: string }>;
  osFingerprint?: string;
  snmpData?: {
    sysDescr?: string;
    sysObjectId?: string;
    sysName?: string;
  };
  responseTimeMs?: number;
  methods: string[];
}

type DiscoveryJobData = DispatchScanJobData | ProcessResultsJobData;

/**
 * Create the discovery worker
 */
export function createDiscoveryWorker(): Worker<DiscoveryJobData> {
  return new Worker<DiscoveryJobData>(
    DISCOVERY_QUEUE,
    async (job: Job<DiscoveryJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'dispatch-scan':
            return await processDispatchScan(job.data);
          case 'process-results':
            return await processResults(job.data);
          default:
            throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5
    }
  );
}

/**
 * Dispatch a discovery scan command to an agent
 */
async function processDispatchScan(data: DispatchScanJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Load the profile
  const [profile] = await db
    .select()
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.id, data.profileId))
    .limit(1);

  if (!profile) {
    await markJobFailed(data.jobId, 'Profile not found');
    return { dispatched: false, agentId: null, durationMs: Date.now() - startTime };
  }

  // Find an online agent to run the scan
  let agentId = data.agentId;
  if (!agentId) {
    // Pick an online agent from the same site
    const [onlineAgent] = await db
      .select({ agentId: devices.agentId })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, data.orgId),
          eq(devices.siteId, data.siteId),
          eq(devices.status, 'online')
        )
      )
      .limit(1);

    agentId = onlineAgent?.agentId ?? null;
  }

  if (!agentId || !isAgentConnected(agentId)) {
    await markJobFailed(data.jobId, 'No online agent available for this site');
    return { dispatched: false, agentId: null, durationMs: Date.now() - startTime };
  }

  // Build the command payload from the profile
  const command: AgentCommand = {
    id: data.jobId, // Use job ID as command ID so results correlate
    type: 'network_discovery',
    payload: {
      jobId: data.jobId,
      subnets: profile.subnets ?? [],
      excludeIps: profile.excludeIps ?? [],
      methods: profile.methods ?? [],
      portRanges: profile.portRanges ?? [],
      snmpCommunities: profile.snmpCommunities ?? [],
      deepScan: profile.deepScan ?? false,
      identifyOS: profile.identifyOS ?? false,
      resolveHostnames: profile.resolveHostnames ?? false,
      timeout: profile.timeout ?? 2,
      concurrency: profile.concurrency ?? 128
    }
  };

  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    await markJobFailed(data.jobId, 'Failed to send command to agent');
    return { dispatched: false, agentId, durationMs: Date.now() - startTime };
  }

  // Update job status to running
  await db
    .update(discoveryJobs)
    .set({
      status: 'running',
      agentId,
      startedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(discoveryJobs.id, data.jobId));

  console.log(`[DiscoveryWorker] Scan dispatched to agent ${agentId} for job ${data.jobId}`);
  return { dispatched: true, agentId, durationMs: Date.now() - startTime };
}

/**
 * Process discovery results — upsert discovered assets
 */
async function processResults(data: ProcessResultsJobData): Promise<{
  newAssets: number;
  updatedAssets: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Check if job was cancelled before processing results
  const [currentJob] = await db
    .select({ status: discoveryJobs.status })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.id, data.jobId))
    .limit(1);

  if (currentJob?.status === 'cancelled') {
    console.log(`[DiscoveryWorker] Job ${data.jobId} was cancelled — skipping result processing`);
    return { newAssets: 0, updatedAssets: 0, durationMs: Date.now() - startTime };
  }

  let newCount = 0;
  let updatedCount = 0;

  for (const host of data.hosts) {
    if (!host.ip) continue;

    // Check if asset already exists (by org + IP)
    const [existing] = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, data.orgId),
          sql`${discoveredAssets.ipAddress} = ${host.ip}`
        )
      )
      .limit(1);

    const assetData = {
      ipAddress: host.ip,
      macAddress: host.mac ?? null,
      hostname: host.hostname ?? null,
      netbiosName: host.netbiosName ?? null,
      assetType: mapAssetType(host.assetType),
      manufacturer: host.manufacturer ?? null,
      model: host.model ?? null,
      openPorts: host.openPorts ?? null,
      osFingerprint: host.osFingerprint ? { os: host.osFingerprint } : null,
      snmpData: host.snmpData ?? null,
      responseTimeMs: host.responseTimeMs ?? null,
      discoveryMethods: host.methods?.map(mapMethod) ?? [],
      lastSeenAt: new Date(),
      lastJobId: data.jobId,
      updatedAt: new Date()
    };

    let upsertedAssetId: string | null = null;
    let alreadyLinked = false;

    if (existing) {
      await db
        .update(discoveredAssets)
        .set(assetData)
        .where(eq(discoveredAssets.id, existing.id));
      upsertedAssetId = existing.id;
      updatedCount++;

      // Check if already linked (preserve manual decisions)
      const [currentAsset] = await db
        .select({ linkedDeviceId: discoveredAssets.linkedDeviceId })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, existing.id))
        .limit(1);
      alreadyLinked = !!currentAsset?.linkedDeviceId;
    } else {
      const [inserted] = await db.insert(discoveredAssets).values({
        orgId: data.orgId,
        siteId: data.siteId,
        status: 'new',
        ...assetData
      }).returning({ id: discoveredAssets.id });
      upsertedAssetId = inserted?.id ?? null;
      newCount++;
    }

    // Auto-link: match discovered asset to enrolled device by MAC or IP
    if (upsertedAssetId && !alreadyLinked && (assetData.macAddress || assetData.ipAddress)) {
      try {
        const conditions = [];
        if (assetData.macAddress) conditions.push(eq(deviceNetwork.macAddress, assetData.macAddress));
        if (assetData.ipAddress) conditions.push(eq(deviceNetwork.ipAddress, assetData.ipAddress));

        if (conditions.length > 0) {
          const [match] = await db
            .select({ deviceId: deviceNetwork.deviceId })
            .from(deviceNetwork)
            .innerJoin(devices, eq(devices.id, deviceNetwork.deviceId))
            .where(and(eq(devices.orgId, data.orgId), or(...conditions)))
            .limit(1);

          if (match) {
            await db
              .update(discoveredAssets)
              .set({ linkedDeviceId: match.deviceId, status: 'managed' as any })
              .where(eq(discoveredAssets.id, upsertedAssetId));
          }
        }
      } catch (linkErr) {
        console.warn(`[DiscoveryWorker] Auto-link failed for ${host.ip}:`, linkErr);
      }
    }
  }

  // Enrich topology: link discovered routers/switches/gateways to other hosts
  try {
    await enrichTopology(data.orgId, data.siteId, data.hosts);
  } catch (err) {
    console.error(`[DiscoveryWorker] Topology enrichment failed for job ${data.jobId}:`, err);
  }

  // Update the job record
  await db
    .update(discoveryJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      hostsScanned: data.hostsScanned,
      hostsDiscovered: data.hostsDiscovered,
      newAssets: newCount,
      updatedAt: new Date()
    })
    .where(eq(discoveryJobs.id, data.jobId));

  console.log(`[DiscoveryWorker] Job ${data.jobId} completed: ${newCount} new, ${updatedCount} updated`);
  return { newAssets: newCount, updatedAssets: updatedCount, durationMs: Date.now() - startTime };
}

/**
 * Map agent asset type string to DB enum value
 */
function mapAssetType(agentType: string): any {
  const typeMap: Record<string, string> = {
    workstation: 'workstation',
    server: 'server',
    printer: 'printer',
    router: 'router',
    switch: 'switch',
    firewall: 'firewall',
    access_point: 'access_point',
    phone: 'phone',
    iot: 'iot',
    camera: 'camera',
    nas: 'nas',
    // Fallbacks for older agent versions that send invalid type strings
    windows: 'workstation',
    linux: 'workstation',
    web: 'unknown',
  };
  return typeMap[agentType] ?? 'unknown';
}

/**
 * Map agent method name to DB enum value
 */
function mapMethod(method: string): any {
  const methodMap: Record<string, string> = {
    arp: 'arp',
    ping: 'ping',
    ports: 'port_scan',
    port_scan: 'port_scan',
    snmp: 'snmp',
    wmi: 'wmi',
    ssh: 'ssh',
    mdns: 'mdns',
    netbios: 'netbios',
  };
  return methodMap[method] ?? method;
}

/**
 * Enrich network topology by creating links between gateway devices
 * (routers, switches, firewalls) and the hosts they connect.
 *
 * Uses a single batch query to resolve all IP-to-asset-ID mappings
 * instead of querying per host, reducing DB round trips from O(G*E)
 * to O(1) for the lookup phase.
 */
async function enrichTopology(
  orgId: string,
  siteId: string,
  hosts: DiscoveredHostResult[]
): Promise<void> {
  const gatewayTypes = new Set(['router', 'switch', 'firewall', 'access_point']);
  const gateways = hosts.filter((h) => gatewayTypes.has(h.assetType));
  const endpoints = hosts.filter((h) => !gatewayTypes.has(h.assetType) && h.ip);

  if (gateways.length === 0 || endpoints.length === 0) return;

  // Batch-load all relevant asset IDs in one query
  const allIPs = hosts.filter((h) => h.ip).map((h) => h.ip);
  const assetRows = await db
    .select({ id: discoveredAssets.id, ipAddress: discoveredAssets.ipAddress })
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, orgId),
        inArray(discoveredAssets.ipAddress, allIPs)
      )
    );

  const ipToAssetId = new Map<string, string>();
  for (const row of assetRows) {
    ipToAssetId.set(row.ipAddress, row.id);
  }

  // Collect all gateway-endpoint pairs that have resolved asset IDs
  const gwAssetIds = new Set<string>();
  const pairs: Array<{ sourceId: string; targetId: string; connectionType: string }> = [];

  for (const gw of gateways) {
    const gwId = ipToAssetId.get(gw.ip);
    if (!gwId) continue;
    gwAssetIds.add(gwId);

    const connectionType = gw.assetType === 'switch' ? 'ethernet' : 'routed';
    for (const ep of endpoints) {
      const epId = ipToAssetId.get(ep.ip);
      if (!epId) continue;
      pairs.push({ sourceId: gwId, targetId: epId, connectionType });
    }
  }

  if (pairs.length === 0) return;

  // Batch-load existing topology links for these gateways
  const existingLinks = await db
    .select({ id: networkTopology.id, sourceId: networkTopology.sourceId, targetId: networkTopology.targetId })
    .from(networkTopology)
    .where(
      and(
        eq(networkTopology.orgId, orgId),
        inArray(networkTopology.sourceId, Array.from(gwAssetIds))
      )
    );

  const existingSet = new Map<string, string>();
  for (const link of existingLinks) {
    existingSet.set(`${link.sourceId}:${link.targetId}`, link.id);
  }

  const now = new Date();
  const toInsert: Array<typeof pairs[number] & { orgId: string; siteId: string; sourceType: string; targetType: string; lastVerifiedAt: Date }> = [];
  const toUpdateIds: string[] = [];

  for (const pair of pairs) {
    const key = `${pair.sourceId}:${pair.targetId}`;
    const existingId = existingSet.get(key);
    if (existingId) {
      toUpdateIds.push(existingId);
    } else {
      toInsert.push({
        orgId,
        siteId,
        sourceType: 'discovered_asset',
        sourceId: pair.sourceId,
        targetType: 'discovered_asset',
        targetId: pair.targetId,
        connectionType: pair.connectionType,
        lastVerifiedAt: now
      });
    }
  }

  if (toUpdateIds.length > 0) {
    await db
      .update(networkTopology)
      .set({ lastVerifiedAt: now, updatedAt: now })
      .where(inArray(networkTopology.id, toUpdateIds));
  }

  if (toInsert.length > 0) {
    await db.insert(networkTopology).values(toInsert);
  }
}

async function markJobFailed(jobId: string, error: string): Promise<void> {
  await db
    .update(discoveryJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errors: { message: error },
      updatedAt: new Date()
    })
    .where(eq(discoveryJobs.id, jobId));
}

/**
 * Enqueue a discovery scan
 */
export async function enqueueDiscoveryScan(
  jobId: string,
  profileId: string,
  orgId: string,
  siteId: string,
  agentId?: string | null
): Promise<string> {
  const queue = getDiscoveryQueue();
  const job = await queue.add(
    'dispatch-scan',
    {
      type: 'dispatch-scan',
      jobId,
      profileId,
      orgId,
      siteId,
      agentId
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );
  return job.id!;
}

/**
 * Enqueue processing of discovery results
 */
export async function enqueueDiscoveryResults(
  jobId: string,
  orgId: string,
  siteId: string,
  hosts: DiscoveredHostResult[],
  hostsScanned: number,
  hostsDiscovered: number
): Promise<string> {
  const queue = getDiscoveryQueue();
  const job = await queue.add(
    'process-results',
    {
      type: 'process-results',
      jobId,
      orgId,
      siteId,
      hosts,
      hostsScanned,
      hostsDiscovered
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );
  return job.id!;
}

// Worker instance (kept for cleanup)
let discoveryWorkerInstance: Worker<DiscoveryJobData> | null = null;

/**
 * Initialize discovery worker
 * Call this during app startup
 */
export async function initializeDiscoveryWorker(): Promise<void> {
  try {
    discoveryWorkerInstance = createDiscoveryWorker();

    discoveryWorkerInstance.on('error', (error) => {
      console.error('[DiscoveryWorker] Worker error:', error);
    });

    discoveryWorkerInstance.on('failed', (job, error) => {
      console.error(`[DiscoveryWorker] Job ${job?.id} failed:`, error);
    });

    discoveryWorkerInstance.on('completed', (job, result) => {
      if (job.data.type === 'process-results' && result && typeof result === 'object' && 'newAssets' in result) {
        const r = result as { newAssets: number; updatedAssets: number };
        if (r.newAssets > 0 || r.updatedAssets > 0) {
          console.log(`[DiscoveryWorker] Results processed: ${r.newAssets} new, ${r.updatedAssets} updated`);
        }
      }
    });

    console.log('[DiscoveryWorker] Discovery worker initialized');
  } catch (error) {
    console.error('[DiscoveryWorker] Failed to initialize:', error);
    throw error;
  }
}

/**
 * Shutdown discovery worker gracefully
 */
export async function shutdownDiscoveryWorker(): Promise<void> {
  if (discoveryWorkerInstance) {
    await discoveryWorkerInstance.close();
    discoveryWorkerInstance = null;
  }

  if (discoveryQueue) {
    await discoveryQueue.close();
    discoveryQueue = null;
  }

  console.log('[DiscoveryWorker] Discovery worker shut down');
}
