import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import * as dbModule from '../db';
import { discoveredAssets, networkConfigTypeEnum } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import {
  backupNetworkConfig,
  collectNetworkDeviceConfig,
  refreshFirmwarePostureForOrg
} from '../services/networkConfigManagement';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const NETWORK_CONFIG_QUEUE = 'network-config-management';
const MANAGED_TYPES = ['router', 'switch', 'firewall', 'access_point'] as const;

interface ScheduleBackupsJobData {
  type: 'schedule-config-backups';
}

interface BackupDeviceJobData {
  type: 'backup-device-config';
  orgId: string;
  assetId: string;
}

interface RefreshFirmwareJobData {
  type: 'refresh-firmware-intelligence';
  orgId?: string;
}

type NetworkConfigJobData = ScheduleBackupsJobData | BackupDeviceJobData | RefreshFirmwareJobData;

let networkConfigQueue: Queue | null = null;
let networkConfigWorker: Worker<NetworkConfigJobData> | null = null;

export function getNetworkConfigQueue(): Queue {
  if (!networkConfigQueue) {
    networkConfigQueue = new Queue(NETWORK_CONFIG_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return networkConfigQueue;
}

function createWorker(): Worker<NetworkConfigJobData> {
  return new Worker<NetworkConfigJobData>(
    NETWORK_CONFIG_QUEUE,
    async (job: Job<NetworkConfigJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'schedule-config-backups':
            return processScheduleBackups();
          case 'backup-device-config':
            return processBackupDeviceConfig(job.data);
          case 'refresh-firmware-intelligence':
            return processFirmwareRefresh(job.data.orgId);
          default:
            throw new Error(`Unknown network config job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5
    }
  );
}

async function processScheduleBackups(): Promise<{ enqueued: number }> {
  const assets = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId
    })
    .from(discoveredAssets)
    .where(
      and(
        inArray(discoveredAssets.assetType, MANAGED_TYPES),
        eq(discoveredAssets.approvalStatus, 'approved')
      )
    );

  if (assets.length === 0) {
    return { enqueued: 0 };
  }

  const queue = getNetworkConfigQueue();
  let enqueued = 0;

  for (const asset of assets) {
    await queue.add(
      'backup-device-config',
      {
        type: 'backup-device-config',
        orgId: asset.orgId,
        assetId: asset.id
      },
      {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 }
      }
    );
    enqueued++;
  }

  if (enqueued > 0) {
    console.log(`[NetworkConfigJobs] Scheduled ${enqueued} network configuration backup job(s)`);
  }

  return { enqueued };
}

async function processBackupDeviceConfig(data: BackupDeviceJobData): Promise<{
  backupsCreated: number;
  changed: number;
}> {
  const [asset] = await db
    .select()
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.id, data.assetId),
        eq(discoveredAssets.orgId, data.orgId)
      )
    )
    .limit(1);

  if (!asset) {
    console.warn(`[NetworkConfigJobs] Asset ${data.assetId} not found in org ${data.orgId}`);
    return { backupsCreated: 0, changed: 0 };
  }

  let backupsCreated = 0;
  let changed = 0;

  for (const configType of networkConfigTypeEnum.enumValues) {
    const collected = await collectNetworkDeviceConfig(asset, configType);
    if (!collected?.configText) {
      continue;
    }

    const result = await backupNetworkConfig({
      orgId: data.orgId,
      assetId: data.assetId,
      configType,
      configText: collected.configText,
      unchangedSnapshotMinIntervalMinutes: 60,
      metadata: {
        collector: collected.collector,
        ...(collected.metadata ?? {}),
        source: 'scheduled'
      }
    });

    if (!result.skipped) {
      backupsCreated++;
    }
    if (!result.skipped && result.changed) {
      changed++;
    }
  }

  return { backupsCreated, changed };
}

async function processFirmwareRefresh(orgId?: string): Promise<{ orgsChecked: number; assetsChecked: number; vulnerableAssets: number }> {
  const orgRows = orgId
    ? [{ orgId }]
    : await db
      .selectDistinct({ orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(inArray(discoveredAssets.assetType, MANAGED_TYPES));

  let assetsChecked = 0;
  let vulnerableAssets = 0;

  for (const row of orgRows) {
    const summary = await refreshFirmwarePostureForOrg(row.orgId);
    assetsChecked += summary.checked;
    vulnerableAssets += summary.vulnerable;
  }

  if (orgRows.length > 0) {
    console.log(
      `[NetworkConfigJobs] Firmware posture refresh complete (orgs=${orgRows.length}, assets=${assetsChecked}, vulnerable=${vulnerableAssets})`
    );
  }

  return {
    orgsChecked: orgRows.length,
    assetsChecked,
    vulnerableAssets
  };
}

async function scheduleRecurringJobs(): Promise<void> {
  const queue = getNetworkConfigQueue();
  const existingJobs = await queue.getRepeatableJobs();

  for (const job of existingJobs) {
    if (job.name === 'schedule-config-backups' || job.name === 'refresh-firmware-intelligence') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'schedule-config-backups',
    { type: 'schedule-config-backups' as const },
    {
      repeat: {
        every: 24 * 60 * 60 * 1000
      },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 40 }
    }
  );

  await queue.add(
    'refresh-firmware-intelligence',
    { type: 'refresh-firmware-intelligence' as const },
    {
      repeat: {
        every: 24 * 60 * 60 * 1000
      },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 40 }
    }
  );

  console.log('[NetworkConfigJobs] Scheduled recurring backup and firmware refresh jobs');
}

export async function enqueueNetworkConfigBackup(orgId: string, assetId: string): Promise<string> {
  const queue = getNetworkConfigQueue();
  const job = await queue.add(
    'backup-device-config',
    {
      type: 'backup-device-config',
      orgId,
      assetId
    },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );

  if (!job.id) {
    throw new Error('Failed to enqueue network config backup job');
  }
  return String(job.id);
}

export async function initializeNetworkConfigJobs(): Promise<void> {
  if (!networkConfigWorker) {
    networkConfigWorker = createWorker();
    networkConfigWorker.on('failed', (job, error) => {
      console.error(`[NetworkConfigJobs] Job ${job?.id ?? 'unknown'} failed:`, error);
    });
    networkConfigWorker.on('completed', (job) => {
      if (job?.name === 'schedule-config-backups') {
        console.log('[NetworkConfigJobs] Backup scheduler cycle completed');
      }
    });
  }

  await scheduleRecurringJobs();

  // Bootstrap a firmware refresh run during startup for quicker posture visibility.
  const queue = getNetworkConfigQueue();
  await queue.add(
    'refresh-firmware-intelligence',
    { type: 'refresh-firmware-intelligence' },
    {
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 40 }
    }
  );
}

export async function shutdownNetworkConfigJobs(): Promise<void> {
  await Promise.all([
    networkConfigWorker?.close().catch((error) => {
      console.error('[NetworkConfigJobs] Failed closing worker:', error);
    }),
    networkConfigQueue?.close().catch((error) => {
      console.error('[NetworkConfigJobs] Failed closing queue:', error);
    })
  ]);

  networkConfigWorker = null;
  networkConfigQueue = null;
}
