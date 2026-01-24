import { Queue, Worker, Job } from 'bullmq';
import { db } from '../db';
import { deployments, deploymentDevices, devices, deviceCommands, scripts, users, organizationUsers } from '../db/schema';
import { eq, and, asc, inArray } from 'drizzle-orm';
import {
  getDeploymentProgress,
  shouldPauseDeployment,
  updateDeploymentDeviceStatus,
  incrementRetryCount,
  getRetryBackoffMs,
  pauseDeployment,
  isDeviceInMaintenanceWindow,
  filterEligibleDevices,
  RolloutConfig
} from '../services/deploymentEngine';

// DeploymentPayload type defined locally
interface DeploymentPayload {
  type: 'script' | 'patch' | 'software' | 'policy';
  scriptId?: string;
  parameters?: Record<string, string>;
  patchIds?: string[];
  packageId?: string;
  action?: 'install' | 'uninstall' | 'update';
  policyId?: string;
}
import { getRedisConnection } from '../services/redis';
import { getUsersForAlert, sendPushToUser } from '../services/notifications';
import { getEmailService } from '../services/email';

// Queue names
const DEPLOYMENT_QUEUE = 'deployments';
const DEPLOYMENT_DEVICE_QUEUE = 'deployment-devices';



// ============================================
// Deployment Notification Helpers
// ============================================

interface DeploymentPauseNotificationParams {
  deploymentId: string;
  deploymentName: string;
  orgId: string;
  reason?: string;
  dashboardUrl?: string;
}

/**
 * Send notifications about a paused deployment to all relevant users
 * Sends both push notifications and emails
 */
async function sendDeploymentPausedNotifications(params: DeploymentPauseNotificationParams): Promise<void> {
  const { deploymentId, deploymentName, orgId, reason, dashboardUrl } = params;

  // Get users for this organization
  const targetUsers = await getUsersForAlert(orgId);

  // Get user emails for email notifications
  const userEmails = await db
    .select({
      email: users.email,
      name: users.name
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(and(eq(organizationUsers.orgId, orgId), eq(users.status, 'active')));

  // Prepare push notification payload
  const pushPayload = {
    title: 'Deployment paused',
    body: reason
      ? `Deployment ${deploymentName} was paused. ${reason}`
      : `Deployment ${deploymentName} was paused.`,
    data: {
      deploymentId,
      reason: reason ?? 'unspecified'
    },
    alertId: null,
    eventType: 'deployment.paused'
  };

  // Send push notifications
  const pushPromises = targetUsers.map(userId => sendPushToUser(userId, pushPayload));

  // Send email notifications
  const emailPromises: Promise<void>[] = [];
  const emailService = getEmailService();
  if (emailService) {
    for (const user of userEmails) {
      const emailPromise = emailService.sendEmail({
        to: user.email,
        subject: `Deployment Paused: ${deploymentName}`,
        html: buildDeploymentPausedEmailHtml({
          name: user.name,
          deploymentName,
          reason,
          dashboardUrl
        }),
        text: buildDeploymentPausedEmailText({
          name: user.name,
          deploymentName,
          reason,
          dashboardUrl
        })
      }).catch(err => {
        console.error(`Failed to send deployment paused email to ${user.email}:`, err);
      });
      emailPromises.push(emailPromise);
    }
  }

  // Wait for all notifications to be sent
  await Promise.all([...pushPromises, ...emailPromises]);
}

function buildDeploymentPausedEmailHtml(params: {
  name: string;
  deploymentName: string;
  reason?: string;
  dashboardUrl?: string;
}): string {
  const { name, deploymentName, reason, dashboardUrl } = params;
  const reasonHtml = reason
    ? `<p style="margin: 0 0 16px; font-size: 14px; color: #4a5568;"><strong>Reason:</strong> ${escapeHtmlForEmail(reason)}</p>`
    : '';
  const buttonHtml = dashboardUrl
    ? `<a href="${escapeHtmlForEmail(dashboardUrl)}" style="display: inline-block; padding: 12px 20px; border-radius: 8px; background: #0f172a; color: #ffffff; font-size: 14px; text-decoration: none;">View Deployment</a>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Deployment Paused</title>
  </head>
  <body style="margin: 0; padding: 0; background: #eef2f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #eef2f7; padding: 24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: #ffffff; border-radius: 12px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);">
            <tr>
              <td style="padding: 28px 32px 8px;">
                <h1 style="margin: 0; font-size: 22px; color: #111827; font-weight: 600;">
                  Deployment Paused
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 32px 24px;">
                <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
                  Hi ${escapeHtmlForEmail(name)},
                </p>
                <p style="margin: 0 0 16px; font-size: 16px; color: #1d2735;">
                  The deployment <strong>${escapeHtmlForEmail(deploymentName)}</strong> has been automatically paused due to excessive failures.
                </p>
                ${reasonHtml}
                <p style="margin: 0 0 16px; font-size: 14px; color: #4a5568;">
                  Please review the deployment status and take appropriate action. You can resume the deployment once the underlying issues have been addressed.
                </p>
                ${buttonHtml}
              </td>
            </tr>
            <tr>
              <td style="padding: 0 32px 24px;">
                <p style="margin: 0; font-size: 12px; color: #6b7280;">
                  This is an automated notification from Breeze RMM.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin: 16px 0 0; font-size: 12px; color: #94a3b8;">
            Breeze RMM
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildDeploymentPausedEmailText(params: {
  name: string;
  deploymentName: string;
  reason?: string;
  dashboardUrl?: string;
}): string {
  const { name, deploymentName, reason, dashboardUrl } = params;
  const lines = [
    `Hi ${name},`,
    '',
    `The deployment "${deploymentName}" has been automatically paused due to excessive failures.`,
    ''
  ];

  if (reason) {
    lines.push(`Reason: ${reason}`, '');
  }

  lines.push(
    'Please review the deployment status and take appropriate action.',
    'You can resume the deployment once the underlying issues have been addressed.',
    ''
  );

  if (dashboardUrl) {
    lines.push(`View deployment: ${dashboardUrl}`, '');
  }

  lines.push('This is an automated notification from Breeze RMM.');

  return lines.join('\n');
}

function escapeHtmlForEmail(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// Queue Definitions
// ============================================

let deploymentQueue: Queue | null = null;
let deploymentDeviceQueue: Queue | null = null;

export function getDeploymentQueue(): Queue {
  if (!deploymentQueue) {
    deploymentQueue = new Queue(DEPLOYMENT_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return deploymentQueue;
}

export function getDeploymentDeviceQueue(): Queue {
  if (!deploymentDeviceQueue) {
    deploymentDeviceQueue = new Queue(DEPLOYMENT_DEVICE_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return deploymentDeviceQueue;
}

// ============================================
// Job Data Types
// ============================================

interface ProcessDeploymentJob {
  deploymentId: string;
}

interface ProcessDeploymentDeviceJob {
  deploymentId: string;
  deviceId: string;
  batchNumber: number;
}

interface ScheduleNextBatchJob {
  deploymentId: string;
  currentBatch: number;
}

// ============================================
// Deployment Worker
// ============================================

export function createDeploymentWorker(): Worker {
  return new Worker<ProcessDeploymentJob>(
    DEPLOYMENT_QUEUE,
    async (job: Job<ProcessDeploymentJob>) => {
      const { deploymentId } = job.data;

      // Get deployment
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);

      if (!deployment) {
        throw new Error(`Deployment ${deploymentId} not found`);
      }

      if (deployment.status !== 'pending' && deployment.status !== 'running') {
        // Deployment is not in a state that can be processed
        return { skipped: true, reason: `Deployment status is ${deployment.status}` };
      }

      // Update deployment to running
      await db
        .update(deployments)
        .set({
          status: 'running',
          startedAt: deployment.startedAt || new Date()
        })
        .where(eq(deployments.id, deploymentId));

      const rolloutConfig = deployment.rolloutConfig as RolloutConfig;

      // Get devices for the first pending batch
      const batchDevices = await db
        .select({
          deviceId: deploymentDevices.deviceId,
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
        .limit(100);

      if (batchDevices.length === 0) {
        // No more devices to process, check if complete
        const progress = await getDeploymentProgress(deploymentId);
        if (progress.pending === 0 && progress.running === 0) {
          // Deployment complete
          await db
            .update(deployments)
            .set({
              status: 'completed',
              completedAt: new Date()
            })
            .where(eq(deployments.id, deploymentId));
          return { completed: true };
        }
        return { waiting: true };
      }

      // Get the current batch number
      const currentBatch = batchDevices[0]?.batchNumber || 1;

      // Filter to only devices in the current batch
      const currentBatchDevices = batchDevices.filter(d => d.batchNumber === currentBatch);

      // If respecting maintenance windows, filter eligible devices
      let eligibleDeviceIds = currentBatchDevices.map(d => d.deviceId);
      if (rolloutConfig.respectMaintenanceWindows) {
        eligibleDeviceIds = await filterEligibleDevices(eligibleDeviceIds, true);
      }

      // Queue jobs for each device
      const deviceQueue = getDeploymentDeviceQueue();
      const jobs = eligibleDeviceIds.map(deviceId => ({
        name: 'process-device',
        data: {
          deploymentId,
          deviceId,
          batchNumber: currentBatch
        } as ProcessDeploymentDeviceJob
      }));

      await deviceQueue.addBulk(jobs);

      // Schedule check for next batch if staggered
      if (rolloutConfig.type === 'staggered' && rolloutConfig.staggered) {
        const delayMs = rolloutConfig.staggered.batchDelayMinutes * 60 * 1000;
        await getDeploymentQueue().add(
          'check-next-batch',
          { deploymentId, currentBatch } as ScheduleNextBatchJob,
          { delay: delayMs }
        );
      }

      return {
        processed: eligibleDeviceIds.length,
        skipped: currentBatchDevices.length - eligibleDeviceIds.length,
        batch: currentBatch
      };
    },
    {
      connection: getRedisConnection(),
      concurrency: 5
    }
  );
}

// ============================================
// Device Worker
// ============================================

export function createDeploymentDeviceWorker(): Worker {
  return new Worker<ProcessDeploymentDeviceJob>(
    DEPLOYMENT_DEVICE_QUEUE,
    async (job: Job<ProcessDeploymentDeviceJob>) => {
      const { deploymentId, deviceId, batchNumber } = job.data;

      // Get deployment
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);

      if (!deployment) {
        throw new Error(`Deployment ${deploymentId} not found`);
      }

      if (deployment.status === 'paused' || deployment.status === 'cancelled') {
        // Skip if deployment is paused or cancelled
        await updateDeploymentDeviceStatus(deploymentId, deviceId, 'skipped', {
          success: false,
          error: `Deployment ${deployment.status}`
        });
        return { skipped: true, reason: deployment.status };
      }

      // Check maintenance window
      const rolloutConfig = deployment.rolloutConfig as RolloutConfig;
      if (rolloutConfig.respectMaintenanceWindows) {
        const inMaintenance = await isDeviceInMaintenanceWindow(deviceId);
        if (!inMaintenance) {
          // Re-queue for later
          await getDeploymentDeviceQueue().add(
            'process-device',
            job.data,
            { delay: 5 * 60 * 1000 } // Check again in 5 minutes
          );
          return { delayed: true, reason: 'waiting for maintenance window' };
        }
      }

      // Mark as running
      await updateDeploymentDeviceStatus(deploymentId, deviceId, 'running');

      try {
        // Execute the deployment payload
        const result = await executeDeploymentPayload(
          deployment.payload as DeploymentPayload,
          deviceId
        );

        // Update status based on result
        if (result.success) {
          await updateDeploymentDeviceStatus(deploymentId, deviceId, 'completed', result);
        } else {
          // Check if we should retry
          const { canRetry, retryCount } = await incrementRetryCount(deploymentId, deviceId);
          if (canRetry) {
            const backoffMs = getRetryBackoffMs(retryCount, rolloutConfig);
            await getDeploymentDeviceQueue().add(
              'process-device',
              job.data,
              { delay: backoffMs }
            );
            return { retrying: true, retryCount, backoffMs };
          } else {
            await updateDeploymentDeviceStatus(deploymentId, deviceId, 'failed', result);
          }
        }

        // Check if deployment should be paused due to failures
        const { pause, reason } = await shouldPauseDeployment(deploymentId, rolloutConfig);
        if (pause) {
          await pauseDeployment(deploymentId);
          
          // Send notifications to relevant users (push and email)
          await sendDeploymentPausedNotifications({
            deploymentId,
            deploymentName: deployment.name,
            orgId: deployment.orgId,
            reason: reason ?? undefined,
            dashboardUrl: process.env.DASHBOARD_URL 
              ? `${process.env.DASHBOARD_URL}/deployments/${deploymentId}`
              : undefined
          });
          
          return { completed: true, deploymentPaused: true, pauseReason: reason };
        }

        return { completed: true, success: result.success };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Check if we should retry
        const { canRetry, retryCount } = await incrementRetryCount(deploymentId, deviceId);
        if (canRetry) {
          const backoffMs = getRetryBackoffMs(retryCount, rolloutConfig);
          await getDeploymentDeviceQueue().add(
            'process-device',
            job.data,
            { delay: backoffMs }
          );
          return { retrying: true, retryCount, error: errorMessage };
        }

        await updateDeploymentDeviceStatus(deploymentId, deviceId, 'failed', {
          success: false,
          error: errorMessage
        });

        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 10
    }
  );
}

// ============================================
// Payload Execution
// ============================================

interface ExecutionResult {
  success: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  durationMs?: number;
}

async function executeDeploymentPayload(
  payload: DeploymentPayload,
  deviceId: string
): Promise<ExecutionResult> {
  const startTime = Date.now();

  try {
    switch (payload.type) {
      case 'script':
        return await executeScriptPayload(payload as { type: 'script'; scriptId: string; parameters?: Record<string, unknown> }, deviceId, startTime);
      case 'patch':
        return await executePatchPayload(payload as { type: 'patch'; patchIds: string[] }, deviceId, startTime);
      case 'software':
        return await executeSoftwarePayload(payload as { type: 'software'; packageId: string; action: 'install' | 'uninstall' | 'update' }, deviceId, startTime);
      case 'policy':
        return await executePolicyPayload(payload as { type: 'policy'; policyId: string }, deviceId, startTime);
      default:
        return {
          success: false,
          error: `Unknown payload type: ${(payload as { type: string }).type}`,
          durationMs: Date.now() - startTime
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Execution failed',
      durationMs: Date.now() - startTime
    };
  }
}

async function executeScriptPayload(
  payload: { type: 'script'; scriptId: string; parameters?: Record<string, unknown> },
  deviceId: string,
  startTime: number
): Promise<ExecutionResult> {
  // Get the script
  const [script] = await db
    .select()
    .from(scripts)
    .where(eq(scripts.id, payload.scriptId))
    .limit(1);

  if (!script) {
    return {
      success: false,
      error: 'Script not found',
      durationMs: Date.now() - startTime
    };
  }

  // Create command for the device
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'run_script',
      payload: {
        scriptId: payload.scriptId,
        content: script.content,
        language: script.language,
        parameters: payload.parameters || {},
        timeoutSeconds: script.timeoutSeconds,
        runAs: script.runAs
      },
      status: 'pending'
    })
    .returning();

  if (!command) {
    return {
      success: false,
      error: 'Failed to create command',
      durationMs: Date.now() - startTime
    };
  }

  // Wait for command to complete (with timeout)
  const timeoutMs = (script.timeoutSeconds + 60) * 1000; // Add 60s buffer
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < timeoutMs) {
    const [updatedCommand] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, command.id))
      .limit(1);

    if (!updatedCommand) {
      return {
        success: false,
        error: 'Command not found',
        durationMs: Date.now() - startTime
      };
    }

    if (updatedCommand.status === 'completed') {
      const result = updatedCommand.result as { exitCode?: number; stdout?: string; stderr?: string } | null;
      return {
        success: result?.exitCode === 0,
        exitCode: result?.exitCode,
        output: result?.stdout,
        error: result?.stderr,
        durationMs: Date.now() - startTime
      };
    }

    if (updatedCommand.status === 'failed') {
      const result = updatedCommand.result as { error?: string } | null;
      return {
        success: false,
        error: result?.error || 'Command failed',
        durationMs: Date.now() - startTime
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  // Timeout
  return {
    success: false,
    error: 'Command timed out',
    durationMs: Date.now() - startTime
  };
}

async function executePatchPayload(
  payload: { type: 'patch'; patchIds: string[] },
  deviceId: string,
  startTime: number
): Promise<ExecutionResult> {
  // Create command for the device to install patches
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'install_patches',
      payload: {
        patchIds: payload.patchIds
      },
      status: 'pending'
    })
    .returning();

  if (!command) {
    return {
      success: false,
      error: 'Failed to create command',
      durationMs: Date.now() - startTime
    };
  }

  // Wait for command to complete (patches can take a while)
  const timeoutMs = 30 * 60 * 1000; // 30 minutes
  const pollInterval = 5000;
  let elapsed = 0;

  while (elapsed < timeoutMs) {
    const [updatedCommand] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, command.id))
      .limit(1);

    if (!updatedCommand) {
      return {
        success: false,
        error: 'Command not found',
        durationMs: Date.now() - startTime
      };
    }

    if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
      const result = updatedCommand.result as { success?: boolean; installedCount?: number; error?: string } | null;
      return {
        success: result?.success || false,
        output: result?.installedCount ? `Installed ${result.installedCount} patches` : undefined,
        error: result?.error,
        durationMs: Date.now() - startTime
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return {
    success: false,
    error: 'Patch installation timed out',
    durationMs: Date.now() - startTime
  };
}

async function executeSoftwarePayload(
  payload: { type: 'software'; packageId: string; action: 'install' | 'uninstall' | 'update' },
  deviceId: string,
  startTime: number
): Promise<ExecutionResult> {
  // Create command for the device
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId,
      type: `software_${payload.action}`,
      payload: {
        packageId: payload.packageId
      },
      status: 'pending'
    })
    .returning();

  if (!command) {
    return {
      success: false,
      error: 'Failed to create command',
      durationMs: Date.now() - startTime
    };
  }

  // Wait for command to complete
  const timeoutMs = 15 * 60 * 1000; // 15 minutes
  const pollInterval = 3000;
  let elapsed = 0;

  while (elapsed < timeoutMs) {
    const [updatedCommand] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, command.id))
      .limit(1);

    if (!updatedCommand) {
      return {
        success: false,
        error: 'Command not found',
        durationMs: Date.now() - startTime
      };
    }

    if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
      const result = updatedCommand.result as { success?: boolean; error?: string } | null;
      return {
        success: result?.success || false,
        error: result?.error,
        durationMs: Date.now() - startTime
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return {
    success: false,
    error: 'Software operation timed out',
    durationMs: Date.now() - startTime
  };
}

async function executePolicyPayload(
  payload: { type: 'policy'; policyId: string },
  deviceId: string,
  startTime: number
): Promise<ExecutionResult> {
  // Create command for the device to apply policy
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'apply_policy',
      payload: {
        policyId: payload.policyId
      },
      status: 'pending'
    })
    .returning();

  if (!command) {
    return {
      success: false,
      error: 'Failed to create command',
      durationMs: Date.now() - startTime
    };
  }

  // Wait for command to complete
  const timeoutMs = 10 * 60 * 1000; // 10 minutes
  const pollInterval = 2000;
  let elapsed = 0;

  while (elapsed < timeoutMs) {
    const [updatedCommand] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, command.id))
      .limit(1);

    if (!updatedCommand) {
      return {
        success: false,
        error: 'Command not found',
        durationMs: Date.now() - startTime
      };
    }

    if (updatedCommand.status === 'completed' || updatedCommand.status === 'failed') {
      const result = updatedCommand.result as { success?: boolean; error?: string; compliant?: boolean } | null;
      return {
        success: result?.success || false,
        output: result?.compliant ? 'Device is compliant' : 'Device is non-compliant',
        error: result?.error,
        durationMs: Date.now() - startTime
      };
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return {
    success: false,
    error: 'Policy application timed out',
    durationMs: Date.now() - startTime
  };
}

// ============================================
// Queue Management
// ============================================

/**
 * Start a deployment by adding it to the queue
 */
export async function startDeployment(deploymentId: string): Promise<void> {
  const queue = getDeploymentQueue();
  await queue.add('process-deployment', { deploymentId });
}

/**
 * Initialize workers (call during app startup)
 */
export function initializeDeploymentWorkers(): void {
  createDeploymentWorker();
  createDeploymentDeviceWorker();
  console.log('Deployment workers initialized');
}
