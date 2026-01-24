import { db } from '../db';
import { deployments, deploymentDevices, devices, deviceGroups, deviceGroupMemberships, maintenanceWindows, maintenanceOccurrences } from '../db/schema';
import { eq, and, inArray, sql, desc, asc } from 'drizzle-orm';
import { evaluateFilter, extractFieldsFromFilter, FilterConditionGroup } from './filterEngine';

// Types defined locally to avoid rootDir issues
export interface Deployment {
  id: string;
  orgId: string;
  name: string;
  type: string;
  payload: unknown;
  targetType: string;
  targetConfig: DeploymentTargetConfig;
  schedule?: unknown;
  rolloutConfig: RolloutConfig;
  status: string;
  createdBy?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface DeploymentDevice {
  id: string;
  deploymentId: string;
  deviceId: string;
  batchNumber?: number | null;
  status: string;
  retryCount: number;
  maxRetries: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  result?: unknown;
}

export interface DeploymentProgress {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  currentBatch?: number | null;
  totalBatches?: number | null;
  percentComplete?: number;
}

export interface RolloutConfig {
  type: 'immediate' | 'staggered';
  staggered?: {
    batchSize: number | string; // 10 or "10%"
    batchDelayMinutes: number;
    pauseOnFailureCount?: number;
    pauseOnFailurePercent?: number;
  };
  respectMaintenanceWindows: boolean;
  retryConfig: {
    maxRetries: number;
    backoffMinutes: number[]; // e.g., [5, 15, 60]
  };
}

export interface DeploymentTargetConfig {
  type: 'all' | 'devices' | 'groups' | 'filter';
  deviceIds?: string[];
  groupIds?: string[];
  filter?: FilterConditionGroup;
}

// ============================================
// Target Resolution
// ============================================

export interface ResolveTargetOptions {
  orgId: string;
  targetConfig: DeploymentTargetConfig;
}

/**
 * Resolve deployment targets to a list of device IDs
 */
export async function resolveDeploymentTargets(
  options: ResolveTargetOptions
): Promise<string[]> {
  const { orgId, targetConfig } = options;
  let deviceIds: string[] = [];

  switch (targetConfig.type) {
    case 'devices':
      // Direct device IDs
      if (targetConfig.deviceIds?.length) {
        // Verify devices exist and belong to org
        const validDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.orgId, orgId),
              inArray(devices.id, targetConfig.deviceIds)
            )
          );
        deviceIds = validDevices.map(d => d.id);
      }
      break;

    case 'groups':
      // Get all devices from specified groups
      if (targetConfig.groupIds?.length) {
        const groupDevices = await db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
          .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
          .where(
            and(
              inArray(deviceGroupMemberships.groupId, targetConfig.groupIds),
              eq(devices.orgId, orgId)
            )
          );
        deviceIds = [...new Set(groupDevices.map(d => d.deviceId))];
      }
      break;

    case 'filter':
      // Evaluate filter to get matching devices
      if (targetConfig.filter) {
        const result = await evaluateFilter(targetConfig.filter, { orgId });
        deviceIds = result.deviceIds;
      }
      break;

    case 'all':
      // All devices in the org
      const allDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, orgId));
      deviceIds = allDevices.map(d => d.id);
      break;
  }

  return deviceIds;
}

// ============================================
// Maintenance Window Handling
// ============================================

/**
 * Check if a device is currently in a maintenance window
 */
export async function isDeviceInMaintenanceWindow(
  deviceId: string,
  timezone: string = 'UTC'
): Promise<boolean> {
  const now = new Date();

  // Get device's org, site, and groups
  const [device] = await db
    .select({
      orgId: devices.orgId,
      siteId: devices.siteId
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return false;
  }

  // Get device's groups
  const deviceGroupIds = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  const groupIds = deviceGroupIds.map(g => g.groupId);

  // Check for active maintenance windows
  const activeWindows = await db
    .select({ id: maintenanceWindows.id })
    .from(maintenanceWindows)
    .where(
      sql`${maintenanceWindows.orgId} = ${device.orgId}
        AND ${maintenanceWindows.status} = 'scheduled'
        AND ${maintenanceWindows.startTime} <= ${now}
        AND ${maintenanceWindows.endTime} >= ${now}
        AND (
          ${maintenanceWindows.deviceIds} && ARRAY[${deviceId}]::uuid[]
          OR ${maintenanceWindows.siteIds} && ARRAY[${device.siteId}]::uuid[]
          OR ${maintenanceWindows.groupIds} && ${groupIds.length > 0 ? sql`ARRAY[${sql.join(groupIds.map(id => sql`${id}`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`}
        )`
    );

  return activeWindows.length > 0;
}

/**
 * Get the next maintenance window for a device
 */
export async function getNextMaintenanceWindow(
  deviceId: string
): Promise<{ start: Date; end: Date } | null> {
  const now = new Date();

  const [device] = await db
    .select({
      orgId: devices.orgId,
      siteId: devices.siteId
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const [nextWindow] = await db
    .select({
      startTime: maintenanceWindows.startTime,
      endTime: maintenanceWindows.endTime
    })
    .from(maintenanceWindows)
    .where(
      sql`${maintenanceWindows.orgId} = ${device.orgId}
        AND ${maintenanceWindows.status} = 'scheduled'
        AND ${maintenanceWindows.startTime} > ${now}
        AND (
          ${maintenanceWindows.deviceIds} && ARRAY[${deviceId}]::uuid[]
          OR ${maintenanceWindows.siteIds} && ARRAY[${device.siteId}]::uuid[]
        )`
    )
    .orderBy(asc(maintenanceWindows.startTime))
    .limit(1);

  if (!nextWindow) {
    return null;
  }

  return {
    start: nextWindow.startTime,
    end: nextWindow.endTime
  };
}

// ============================================
// Batch Management
// ============================================

/**
 * Calculate batch assignments for devices
 */
export function calculateBatches(
  deviceIds: string[],
  rolloutConfig: RolloutConfig
): Map<string, number> {
  const batchAssignments = new Map<string, number>();

  if (rolloutConfig.type === 'immediate') {
    // All devices in batch 1
    deviceIds.forEach(id => batchAssignments.set(id, 1));
    return batchAssignments;
  }

  // Staggered rollout
  const staggered = rolloutConfig.staggered;
  if (!staggered) {
    deviceIds.forEach(id => batchAssignments.set(id, 1));
    return batchAssignments;
  }

  // Calculate batch size
  let batchSize: number;
  if (typeof staggered.batchSize === 'string') {
    // Percentage
    const percent = parseInt(staggered.batchSize.replace('%', ''), 10);
    batchSize = Math.max(1, Math.ceil(deviceIds.length * (percent / 100)));
  } else {
    batchSize = staggered.batchSize;
  }

  // Assign devices to batches
  let batchNumber = 1;
  deviceIds.forEach((id, index) => {
    if (index > 0 && index % batchSize === 0) {
      batchNumber++;
    }
    batchAssignments.set(id, batchNumber);
  });

  return batchAssignments;
}

/**
 * Filter devices that can be deployed to right now (respecting maintenance windows)
 */
export async function filterEligibleDevices(
  deviceIds: string[],
  respectMaintenanceWindows: boolean
): Promise<string[]> {
  if (!respectMaintenanceWindows) {
    return deviceIds;
  }

  const eligibleDevices: string[] = [];

  for (const deviceId of deviceIds) {
    const inMaintenance = await isDeviceInMaintenanceWindow(deviceId);
    if (inMaintenance) {
      eligibleDevices.push(deviceId);
    }
  }

  return eligibleDevices;
}

// ============================================
// Deployment Execution
// ============================================

/**
 * Initialize a deployment by resolving targets and creating device records
 */
export async function initializeDeployment(
  deploymentId: string
): Promise<{ success: boolean; deviceCount: number; error?: string }> {
  // Get deployment
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  if (!deployment) {
    return { success: false, deviceCount: 0, error: 'Deployment not found' };
  }

  if (deployment.status !== 'draft') {
    return { success: false, deviceCount: 0, error: 'Deployment is not in draft status' };
  }

  // Resolve targets
  const deviceIds = await resolveDeploymentTargets({
    orgId: deployment.orgId,
    targetConfig: deployment.targetConfig as DeploymentTargetConfig
  });

  if (deviceIds.length === 0) {
    return { success: false, deviceCount: 0, error: 'No devices match the target criteria' };
  }

  // Calculate batches
  const rolloutConfig = deployment.rolloutConfig as RolloutConfig;
  const batches = calculateBatches(deviceIds, rolloutConfig);

  // Create deployment device records
  const deviceRecords = deviceIds.map(deviceId => ({
    deploymentId,
    deviceId,
    batchNumber: batches.get(deviceId) || 1,
    maxRetries: rolloutConfig.retryConfig?.maxRetries || 3
  }));

  await db.insert(deploymentDevices).values(deviceRecords);

  // Update deployment status to scheduled
  await db
    .update(deployments)
    .set({ status: 'pending' })
    .where(eq(deployments.id, deploymentId));

  return { success: true, deviceCount: deviceIds.length };
}

/**
 * Get deployment progress
 */
export async function getDeploymentProgress(
  deploymentId: string
): Promise<DeploymentProgress> {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  if (!deployment) {
    throw new Error('Deployment not found');
  }

  // Get counts by status
  const statusCounts = await db
    .select({
      status: deploymentDevices.status,
      count: sql<number>`count(*)`
    })
    .from(deploymentDevices)
    .where(eq(deploymentDevices.deploymentId, deploymentId))
    .groupBy(deploymentDevices.status);

  const counts: Record<string, number> = {};
  statusCounts.forEach(s => {
    counts[s.status] = Number(s.count);
  });

  // Get total and batch info
  const [totals] = await db
    .select({
      total: sql<number>`count(*)`,
      maxBatch: sql<number>`max(batch_number)`
    })
    .from(deploymentDevices)
    .where(eq(deploymentDevices.deploymentId, deploymentId));

  // Get current batch (first batch with pending devices)
  const [currentBatchResult] = await db
    .select({
      batchNumber: deploymentDevices.batchNumber
    })
    .from(deploymentDevices)
    .where(
      and(
        eq(deploymentDevices.deploymentId, deploymentId),
        eq(deploymentDevices.status, 'pending')
      )
    )
    .orderBy(asc(deploymentDevices.batchNumber))
    .limit(1);

  const total = Number(totals?.total || 0);
  const completed = counts['completed'] || 0;
  const failed = counts['failed'] || 0;

  return {
    total,
    pending: counts['pending'] || 0,
    running: counts['running'] || 0,
    completed,
    failed,
    skipped: counts['skipped'] || 0,
    currentBatch: currentBatchResult?.batchNumber || null,
    totalBatches: Number(totals?.maxBatch) || null,
    percentComplete: total > 0 ? Math.round(((completed + failed) / total) * 100) : 0
  };
}

/**
 * Check if deployment should be paused based on failure conditions
 */
export async function shouldPauseDeployment(
  deploymentId: string,
  rolloutConfig: RolloutConfig
): Promise<{ pause: boolean; reason?: string }> {
  if (rolloutConfig.type !== 'staggered' || !rolloutConfig.staggered) {
    return { pause: false };
  }

  const progress = await getDeploymentProgress(deploymentId);
  const { pauseOnFailureCount, pauseOnFailurePercent } = rolloutConfig.staggered;

  if (pauseOnFailureCount && progress.failed >= pauseOnFailureCount) {
    return { pause: true, reason: `Failure count (${progress.failed}) exceeded threshold (${pauseOnFailureCount})` };
  }

  if (pauseOnFailurePercent && progress.total > 0) {
    const failurePercent = (progress.failed / progress.total) * 100;
    if (failurePercent >= pauseOnFailurePercent) {
      return { pause: true, reason: `Failure rate (${failurePercent.toFixed(1)}%) exceeded threshold (${pauseOnFailurePercent}%)` };
    }
  }

  return { pause: false };
}

/**
 * Update deployment device status
 */
export async function updateDeploymentDeviceStatus(
  deploymentId: string,
  deviceId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
  result?: { success: boolean; exitCode?: number; output?: string; error?: string; durationMs?: number }
): Promise<void> {
  const updates: Record<string, unknown> = {
    status,
    ...(status === 'running' && { startedAt: new Date() }),
    ...(['completed', 'failed', 'skipped'].includes(status) && { completedAt: new Date() }),
    ...(result && { result })
  };

  await db
    .update(deploymentDevices)
    .set(updates)
    .where(
      and(
        eq(deploymentDevices.deploymentId, deploymentId),
        eq(deploymentDevices.deviceId, deviceId)
      )
    );
}

/**
 * Increment retry count for a failed device
 */
export async function incrementRetryCount(
  deploymentId: string,
  deviceId: string
): Promise<{ canRetry: boolean; retryCount: number }> {
  const [device] = await db
    .select({
      retryCount: deploymentDevices.retryCount,
      maxRetries: deploymentDevices.maxRetries
    })
    .from(deploymentDevices)
    .where(
      and(
        eq(deploymentDevices.deploymentId, deploymentId),
        eq(deploymentDevices.deviceId, deviceId)
      )
    )
    .limit(1);

  if (!device) {
    return { canRetry: false, retryCount: 0 };
  }

  const newRetryCount = device.retryCount + 1;
  const canRetry = newRetryCount <= device.maxRetries;

  if (canRetry) {
    await db
      .update(deploymentDevices)
      .set({
        retryCount: newRetryCount,
        status: 'pending'
      })
      .where(
        and(
          eq(deploymentDevices.deploymentId, deploymentId),
          eq(deploymentDevices.deviceId, deviceId)
        )
      );
  }

  return { canRetry, retryCount: newRetryCount };
}

/**
 * Pause a running deployment
 */
export async function pauseDeployment(deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ status: 'paused' })
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.status, 'running')
      )
    );
}

/**
 * Resume a paused deployment
 */
export async function resumeDeployment(deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ status: 'running' })
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.status, 'paused')
      )
    );
}

/**
 * Cancel a deployment
 */
export async function cancelDeployment(deploymentId: string): Promise<void> {
  // Update deployment status
  await db
    .update(deployments)
    .set({
      status: 'cancelled',
      completedAt: new Date()
    })
    .where(eq(deployments.id, deploymentId));

  // Mark all pending devices as skipped
  await db
    .update(deploymentDevices)
    .set({
      status: 'skipped',
      completedAt: new Date()
    })
    .where(
      and(
        eq(deploymentDevices.deploymentId, deploymentId),
        eq(deploymentDevices.status, 'pending')
      )
    );
}

/**
 * Get backoff delay for retry
 */
export function getRetryBackoffMs(
  retryCount: number,
  rolloutConfig: RolloutConfig
): number {
  const backoffMinutes = rolloutConfig.retryConfig?.backoffMinutes || [5, 15, 60];
  const index = Math.min(retryCount - 1, backoffMinutes.length - 1);
  return (backoffMinutes[index] || 60) * 60 * 1000;
}
