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
  networkBaselines,
  networkKnownGuests,
  networkChangeEvents,
  organizations,
  devices,
  deviceNetwork
} from '../db/schema';
import type { DiscoveryProfileAlertSettings } from '../db/schema';
import { eq, and, or, sql, inArray } from 'drizzle-orm';
import { normalizeMac, buildApprovalDecision } from '../services/assetApproval';
import { getRedisConnection } from '../services/redis';
import { sendCommandToAgent, isAgentConnected, type AgentCommand } from '../routes/agentWs';
import { isCronDue } from '../services/automationRuntime';

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

interface ScheduleProfilesJobData {
  type: 'schedule-profiles';
}

interface ProcessResultsJobData {
  type: 'process-results';
  jobId: string;
  profileId?: string;
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

type DiscoveryJobData = ScheduleProfilesJobData | DispatchScanJobData | ProcessResultsJobData;

/**
 * Create the discovery worker
 */
export function createDiscoveryWorker(): Worker<DiscoveryJobData> {
  return new Worker<DiscoveryJobData>(
    DISCOVERY_QUEUE,
    async (job: Job<DiscoveryJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'schedule-profiles':
            return await processScheduleProfiles();
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

type ProfileSchedule = {
  type?: 'manual' | 'cron' | 'interval';
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
};

function normalizeSchedule(raw: unknown): ProfileSchedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type !== 'manual' && type !== 'cron' && type !== 'interval') return null;

  const intervalMinutesRaw = typeof record.intervalMinutes === 'number'
    ? record.intervalMinutes
    : Number(record.intervalMinutes ?? NaN);
  const intervalMinutes = Number.isFinite(intervalMinutesRaw) && intervalMinutesRaw > 0
    ? Math.floor(intervalMinutesRaw)
    : undefined;

  return {
    type,
    cron: typeof record.cron === 'string' ? record.cron : undefined,
    intervalMinutes,
    timezone: typeof record.timezone === 'string' ? record.timezone : undefined
  };
}

function resolveScheduleTimeZone(value?: string): string {
  const candidate = value?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

async function hasActiveJob(profileId: string): Promise<boolean> {
  const [active] = await db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(
      and(
        eq(discoveryJobs.profileId, profileId),
        sql`${discoveryJobs.status} in ('scheduled', 'running')`
      )
    )
    .limit(1);
  return Boolean(active);
}

async function enqueueScheduledProfileRun(
  profileId: string,
  orgId: string,
  siteId: string
): Promise<{ queued: boolean; jobId: string | null }> {
  const [created] = await db.insert(discoveryJobs).values({
    profileId,
    orgId,
    siteId,
    status: 'scheduled',
    scheduledAt: new Date()
  }).returning();

  const createdJobId = created?.id ?? null;
  if (!created || !createdJobId) {
    return { queued: false, jobId: null };
  }

  try {
    await enqueueDiscoveryScan(createdJobId, profileId, orgId, siteId, null);
    return { queued: true, jobId: createdJobId };
  } catch (error) {
    console.error(`[DiscoveryWorker] Failed to enqueue scheduled scan for profile ${profileId}:`, error);
    await db.update(discoveryJobs).set({
      status: 'failed',
      completedAt: new Date(),
      errors: { message: 'Failed to enqueue scheduled profile scan' },
      updatedAt: new Date()
    }).where(eq(discoveryJobs.id, createdJobId));
    return { queued: false, jobId: createdJobId };
  }
}

async function processScheduleProfiles(): Promise<{ enqueued: number }> {
  const now = new Date();
  const minuteStart = new Date(now);
  minuteStart.setSeconds(0, 0);
  const minuteEnd = new Date(minuteStart.getTime() + 60 * 1000);

  const profiles = await db
    .select({
      id: discoveryProfiles.id,
      orgId: discoveryProfiles.orgId,
      siteId: discoveryProfiles.siteId,
      schedule: discoveryProfiles.schedule
    })
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.enabled, true));

  if (profiles.length === 0) return { enqueued: 0 };

  let enqueued = 0;

  for (const profile of profiles) {
    const schedule = normalizeSchedule(profile.schedule);
    if (!schedule || schedule.type === 'manual') continue;

    if (await hasActiveJob(profile.id)) {
      continue;
    }

    if (schedule.type === 'interval') {
      const intervalMinutes = schedule.intervalMinutes ?? 60;
      const thresholdMs = intervalMinutes * 60 * 1000;

      const [latest] = await db
        .select({
          scheduledAt: discoveryJobs.scheduledAt,
          createdAt: discoveryJobs.createdAt
        })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.profileId, profile.id))
        .orderBy(sql`${discoveryJobs.scheduledAt} desc nulls last, ${discoveryJobs.createdAt} desc`)
        .limit(1);

      const latestRunAt = latest?.scheduledAt ?? latest?.createdAt ?? null;
      const isDue = !latestRunAt || (now.getTime() - latestRunAt.getTime() >= thresholdMs);
      if (!isDue) continue;

      const result = await enqueueScheduledProfileRun(profile.id, profile.orgId, profile.siteId);
      if (result.queued) enqueued++;
      continue;
    }

    if (schedule.type === 'cron') {
      const cronExpression = schedule.cron?.trim();
      if (!cronExpression) continue;

      const timeZone = resolveScheduleTimeZone(schedule.timezone);
      if (!isCronDue(cronExpression, timeZone, now)) continue;

      const [existingMinuteJob] = await db
        .select({ id: discoveryJobs.id })
        .from(discoveryJobs)
        .where(
          and(
            eq(discoveryJobs.profileId, profile.id),
            sql`${discoveryJobs.scheduledAt} >= ${minuteStart.toISOString()}::timestamptz`,
            sql`${discoveryJobs.scheduledAt} < ${minuteEnd.toISOString()}::timestamptz`
          )
        )
        .limit(1);

      if (existingMinuteJob) continue;

      const result = await enqueueScheduledProfileRun(profile.id, profile.orgId, profile.siteId);
      if (result.queued) enqueued++;
    }
  }

  if (enqueued > 0) {
    console.log(`[DiscoveryWorker] Scheduled ${enqueued} discovery profile scan job(s)`);
  }

  return { enqueued };
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
  const requestedAgentId = data.agentId ?? null;
  let selectionSource: 'requested' | 'site-auto' = requestedAgentId ? 'requested' : 'site-auto';
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

  if (!agentId) {
    console.warn(
      `[DiscoveryWorker] No candidate agent found for job ${data.jobId} (profile=${data.profileId}, org=${data.orgId}, site=${data.siteId}, source=${selectionSource})`
    );
    await markJobFailed(data.jobId, 'No online agent available for this site');
    return { dispatched: false, agentId: null, durationMs: Date.now() - startTime };
  }

  if (!isAgentConnected(agentId)) {
    console.warn(
      `[DiscoveryWorker] Selected agent is not websocket-connected for job ${data.jobId} (agent=${agentId}, requestedAgent=${requestedAgentId ?? 'none'}, source=${selectionSource})`
    );
    await markJobFailed(data.jobId, 'No online agent available for this site');
    return { dispatched: false, agentId: null, durationMs: Date.now() - startTime };
  }

  if (!requestedAgentId) {
    selectionSource = 'site-auto';
  }
  console.log(
    `[DiscoveryWorker] Selected agent ${agentId} for job ${data.jobId} (profile=${data.profileId}, org=${data.orgId}, site=${data.siteId}, source=${selectionSource}${requestedAgentId ? `, requestedAgent=${requestedAgentId}` : ''})`
  );

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

  // ── Resolve profileId ─────────────────────────────────────────────────
  let profileId = data.profileId;
  if (!profileId) {
    const [jobRow] = await db
      .select({ profileId: discoveryJobs.profileId })
      .from(discoveryJobs)
      .where(eq(discoveryJobs.id, data.jobId))
      .limit(1);
    profileId = jobRow?.profileId;
  }

  // ── Load profile alertSettings ────────────────────────────────────────
  const defaultAlertSettings: DiscoveryProfileAlertSettings = {
    enabled: false, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90
  };
  let alertSettings: DiscoveryProfileAlertSettings = defaultAlertSettings;
  if (profileId) {
    const [profile] = await db
      .select({ alertSettings: discoveryProfiles.alertSettings, id: discoveryProfiles.id })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.id, profileId))
      .limit(1);
    alertSettings = (profile?.alertSettings as DiscoveryProfileAlertSettings | null) ?? defaultAlertSettings;
  }

  // ── Load known guest MACs ─────────────────────────────────────────────
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, data.orgId))
    .limit(1);

  const knownGuests = org?.partnerId ? await db
    .select({ macAddress: networkKnownGuests.macAddress })
    .from(networkKnownGuests)
    .where(eq(networkKnownGuests.partnerId, org.partnerId))
  : [];
  const knownGuestMacs = new Set(knownGuests.map(g => g.macAddress));

  // ── Load existing assets for approval comparison ──────────────────────
  const scannedIps = data.hosts.map(h => h.ip).filter(Boolean);
  const existingAssets = scannedIps.length > 0
    ? await db.select({
        id: discoveredAssets.id,
        ipAddress: discoveredAssets.ipAddress,
        macAddress: discoveredAssets.macAddress,
        hostname: discoveredAssets.hostname,
        approvalStatus: discoveredAssets.approvalStatus,
        isOnline: discoveredAssets.isOnline
      }).from(discoveredAssets).where(
        and(eq(discoveredAssets.orgId, data.orgId), inArray(discoveredAssets.ipAddress, scannedIps))
      )
    : [];
  const existingByIp = new Map(existingAssets.map(a => [a.ipAddress, a]));

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
              .set({ linkedDeviceId: match.deviceId, approvalStatus: 'approved' })
              .where(eq(discoveredAssets.id, upsertedAssetId));
          }
        }
      } catch (linkErr) {
        console.warn(`[DiscoveryWorker] Auto-link failed for ${host.ip}:`, linkErr);
      }
    }

    // ── Approval decision ─────────────────────────────────────────────────
    const existingForApproval = existingByIp.get(host.ip) ?? null;
    const guestMac = normalizeMac(host.mac);
    const isGuest = !!guestMac && knownGuestMacs.has(guestMac);

    const decision = buildApprovalDecision({
      existingAsset: existingForApproval
        ? { approvalStatus: existingForApproval.approvalStatus, macAddress: existingForApproval.macAddress }
        : null,
      incomingMac: host.mac,
      isKnownGuest: isGuest,
      alertSettings
    });

    // Update approvalStatus and isOnline
    if (upsertedAssetId) {
      await db.update(discoveredAssets)
        .set({ approvalStatus: decision.approvalStatus, isOnline: true })
        .where(eq(discoveredAssets.id, upsertedAssetId));
    }

    // Log change event if needed
    if (decision.shouldAlert && decision.eventType && profileId) {
      try {
        await db.insert(networkChangeEvents).values({
          orgId: data.orgId,
          siteId: data.siteId,
          baselineId: sql`(SELECT id FROM network_baselines WHERE org_id = ${data.orgId} AND site_id = ${data.siteId} LIMIT 1)`,
          profileId: profileId,
          eventType: decision.eventType,
          ipAddress: host.ip,
          macAddress: host.mac ?? null,
          hostname: host.hostname ?? null,
          assetType: mapAssetType(host.assetType),
          previousState: existingForApproval
            ? { macAddress: existingForApproval.macAddress, hostname: existingForApproval.hostname }
            : null,
          currentState: { macAddress: host.mac, hostname: host.hostname, assetType: host.assetType }
        });
      } catch (changeErr) {
        console.warn(
          `[DiscoveryWorker] Failed to log change event for ${host.ip}:`,
          changeErr instanceof Error ? changeErr.message : changeErr
        );
      }
    }
  }

  // ── Mark approved assets not seen in this scan as offline ─────────────
  if (scannedIps.length > 0) {
    const seenIps = new Set(data.hosts.map(h => h.ip));
    for (const asset of existingAssets) {
      if (!seenIps.has(asset.ipAddress) && asset.approvalStatus === 'approved' && asset.isOnline) {
        await db.update(discoveredAssets)
          .set({ isOnline: false })
          .where(eq(discoveredAssets.id, asset.id));

        // Log disappeared event if configured
        if (alertSettings.enabled && alertSettings.alertOnDisappeared && profileId) {
          try {
            await db.insert(networkChangeEvents).values({
              orgId: data.orgId,
              siteId: data.siteId,
              baselineId: sql`(SELECT id FROM network_baselines WHERE org_id = ${data.orgId} AND site_id = ${data.siteId} LIMIT 1)`,
              profileId,
              eventType: 'device_disappeared',
              ipAddress: asset.ipAddress,
              macAddress: asset.macAddress ?? null,
              hostname: asset.hostname ?? null,
              previousState: { approvalStatus: asset.approvalStatus, isOnline: true },
              currentState: { isOnline: false }
            });
          } catch (disappearedErr) {
            console.warn(
              `[DiscoveryWorker] Failed to log disappeared event for ${asset.ipAddress}:`,
              disappearedErr instanceof Error ? disappearedErr.message : disappearedErr
            );
          }
        }
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

  // If this discovery job was launched by a network baseline, enqueue comparison.
  const [baseline] = await db
    .select({
      id: networkBaselines.id,
      orgId: networkBaselines.orgId,
      siteId: networkBaselines.siteId
    })
    .from(networkBaselines)
    .where(eq(networkBaselines.lastScanJobId, data.jobId))
    .limit(1);

  if (baseline) {
    try {
      const { enqueueBaselineComparison } = await import('./networkBaselineWorker');
      await enqueueBaselineComparison(
        baseline.id,
        data.jobId,
        baseline.orgId,
        baseline.siteId,
        data.hosts
      );
    } catch (error) {
      console.error(
        `[DiscoveryWorker] Failed to enqueue baseline comparison for baseline=${baseline.id} job=${data.jobId}:`,
        error instanceof Error ? error.message : error
      );
      throw error; // Let BullMQ retry
    }
  }

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
  hostsDiscovered: number,
  profileId?: string
): Promise<string> {
  const queue = getDiscoveryQueue();
  const job = await queue.add(
    'process-results',
    {
      type: 'process-results',
      jobId,
      profileId,
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

async function scheduleRecurringProfilePlanner(): Promise<void> {
  const queue = getDiscoveryQueue();

  const newJob = await queue.add(
    'schedule-profiles',
    { type: 'schedule-profiles' as const },
    {
      repeat: {
        every: 60 * 1000
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  const repeatable = await queue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'schedule-profiles' && job.key !== newJob.repeatJobKey) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  console.log('[DiscoveryWorker] Scheduled repeatable profile scheduler (every 60s)');
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

    await scheduleRecurringProfilePlanner();

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
