/**
 * Notification Dispatcher
 *
 * Orchestrates sending notifications through various channels when alerts trigger.
 * Handles channel routing, escalation policies, and delivery tracking.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  alerts,
  alertRules,
  notificationChannels,
  alertNotifications,
  escalationPolicies,
  devices,
  organizations
} from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getRedisConnection } from './redis';
import {
  sendEmailNotification,
  getEmailRecipients,
  sendWebhookNotification,
  sendInAppNotification,
  sendPagerDutyNotification,
  type WebhookConfig,
  type PagerDutyConfig,
  type AlertSeverity
} from './notificationSenders';
import { sendSmsNotification, type SmsChannelConfig } from './notificationSenders/smsSender';
import { getEventBus } from './eventBus';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// Queue name
const NOTIFICATION_QUEUE = 'alert-notifications';

// Singleton queue instance
let notificationQueue: Queue | null = null;

/**
 * Get or create the notification queue
 */
export function getNotificationQueue(): Queue {
  if (!notificationQueue) {
    notificationQueue = new Queue(NOTIFICATION_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return notificationQueue;
}

// Job data types
interface SendNotificationJobData {
  type: 'send';
  alertId: string;
  channelId: string;
  escalationStep?: number;
}

interface ProcessAlertJobData {
  type: 'process-alert';
  alertId: string;
}

type NotificationJobData = SendNotificationJobData | ProcessAlertJobData;

/**
 * Create the notification worker
 */
export function createNotificationWorker(): Worker<NotificationJobData> {
  return new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE,
    async (job: Job<NotificationJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'send':
            return await processSendNotification(job.data);

          case 'process-alert':
            return await processAlertNotifications(job.data);

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
 * Process an alert and queue notifications to all configured channels
 */
async function processAlertNotifications(data: ProcessAlertJobData): Promise<{
  queued: number;
  inAppSent: boolean;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Get alert details
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, data.alertId))
    .limit(1);

  if (!alert) {
    return { queued: 0, inAppSent: false, durationMs: Date.now() - startTime };
  }

  // Get device info for in-app notification
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, alert.deviceId))
    .limit(1);

  // Always send in-app notifications first (baseline notification)
  let inAppSent = false;
  try {
    const inAppResult = await sendInAppNotification({
      alertId: alert.id,
      alertName: alert.title,
      severity: alert.severity as AlertSeverity,
      message: alert.message || alert.title,
      orgId: alert.orgId,
      deviceId: alert.deviceId,
      deviceName: device?.displayName || device?.hostname,
      link: `/alerts/${alert.id}`
    });
    inAppSent = inAppResult.success;
    if (inAppResult.success) {
      console.log(`[NotificationDispatcher] Sent ${inAppResult.notificationCount} in-app notifications for alert ${data.alertId}`);
    }
  } catch (error) {
    console.error('[NotificationDispatcher] Failed to send in-app notifications:', error);
  }

  // Get notification channels — from rule overrides or org defaults
  let channelIds: string[] = [];
  let ruleOverrides: Record<string, unknown> | null = null;

  if (alert.ruleId) {
    const [rule] = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1);

    if (rule) {
      ruleOverrides = rule.overrideSettings as Record<string, unknown> | null;
      channelIds = (ruleOverrides?.notificationChannelIds as string[]) || [];
    }
  }

  // For config policy alerts (no ruleId) or rules without channel overrides,
  // fall back to all enabled channels for the org
  if (channelIds.length === 0) {
    const orgChannels = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.orgId, alert.orgId),
          eq(notificationChannels.enabled, true)
        )
      );
    channelIds = orgChannels.map(c => c.id);
  }

  if (channelIds.length === 0) {
    console.log(`[NotificationDispatcher] No additional channels configured for alert ${data.alertId}`);
    return { queued: 0, inAppSent, durationMs: Date.now() - startTime };
  }

  const requestedChannelIds = [...new Set(channelIds.filter(Boolean))];
  if (requestedChannelIds.length === 0) {
    console.log(`[NotificationDispatcher] No valid channel IDs configured for alert ${data.alertId}`);
    return { queued: 0, inAppSent, durationMs: Date.now() - startTime };
  }

  const validChannels = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.orgId, alert.orgId),
        eq(notificationChannels.enabled, true),
        inArray(notificationChannels.id, requestedChannelIds)
      )
    );
  channelIds = validChannels.map((channel) => channel.id);

  if (channelIds.length === 0) {
    console.log(`[NotificationDispatcher] No valid channels in alert org for alert ${data.alertId}`);
    return { queued: 0, inAppSent, durationMs: Date.now() - startTime };
  }

  // Queue notification jobs for each channel
  const queue = getNotificationQueue();
  const jobs = channelIds.map(channelId => ({
    name: 'send',
    data: {
      type: 'send' as const,
      alertId: data.alertId,
      channelId
    }
  }));

  await queue.addBulk(jobs);

  // Check for escalation policy (only applicable to rule-based alerts)
  const escalationPolicyId = ruleOverrides?.escalationPolicyId as string | undefined;
  if (escalationPolicyId) {
    await scheduleEscalation(data.alertId, escalationPolicyId, alert.orgId);
  }

  return {
    queued: jobs.length,
    inAppSent,
    durationMs: Date.now() - startTime
  };
}

/**
 * Send a notification through a specific channel
 */
async function processSendNotification(data: SendNotificationJobData): Promise<{
  success: boolean;
  channelType: string;
  error?: string;
  durationMs: number;
}> {
  const startTime = Date.now();

  // Get alert details
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, data.alertId))
    .limit(1);

  if (!alert) {
    return {
      success: false,
      channelType: 'unknown',
      error: 'Alert not found',
      durationMs: Date.now() - startTime
    };
  }

  // Get channel
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, data.channelId),
        eq(notificationChannels.orgId, alert.orgId),
        eq(notificationChannels.enabled, true)
      )
    )
    .limit(1);

  if (!channel) {
    return {
      success: false,
      channelType: 'unknown',
      error: 'Channel not found for alert organization',
      durationMs: Date.now() - startTime
    };
  }

  // Create notification record (pending)
  const [notificationRecord] = await db
    .insert(alertNotifications)
    .values({
      alertId: data.alertId,
      channelId: data.channelId,
      status: 'pending'
    })
    .returning();

  if (!notificationRecord) {
    return {
      success: false,
      channelType: channel.type,
      error: 'Failed to create notification record',
      durationMs: Date.now() - startTime
    };
  }

  // Get device info for context
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, alert.deviceId))
    .limit(1);

  // Get org info
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, alert.orgId))
    .limit(1);

  // Send notification based on channel type
  let success = false;
  let error: string | undefined;

  try {
    switch (channel.type) {
      case 'email':
        const emailResult = await sendEmailChannelNotification(
          channel.config as Record<string, unknown>,
          alert,
          device,
          org
        );
        success = emailResult.success;
        error = emailResult.error;
        break;

      case 'webhook':
        const webhookResult = await sendWebhookChannelNotification(
          channel.config as WebhookConfig,
          alert,
          device,
          org
        );
        success = webhookResult.success;
        error = webhookResult.error;
        break;

      case 'sms':
        const smsResult = await sendSmsChannelNotification(
          channel.config as SmsChannelConfig,
          alert,
          device,
          org
        );
        success = smsResult.success;
        error = smsResult.error;
        break;

      case 'slack':
        const slackResult = await sendChatWebhookChannelNotification(
          'slack',
          channel.config as Record<string, unknown>,
          alert,
          device,
          org
        );
        success = slackResult.success;
        error = slackResult.error;
        break;

      case 'teams':
        const teamsResult = await sendChatWebhookChannelNotification(
          'teams',
          channel.config as Record<string, unknown>,
          alert,
          device,
          org
        );
        success = teamsResult.success;
        error = teamsResult.error;
        break;

      case 'pagerduty':
        const pagerDutyResult = await sendPagerDutyChannelNotification(
          channel.config as PagerDutyConfig,
          alert,
          device,
          org
        );
        success = pagerDutyResult.success;
        error = pagerDutyResult.error;
        break;

      // In-app notifications are handled automatically in processAlertNotifications
      // This case is here for completeness if in_app is added as a channel type
      case 'in_app' as typeof channel.type:
        // Already sent in processAlertNotifications, mark as success
        success = true;
        break;

      default:
        error = `Unknown channel type: ${channel.type}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  // Update notification record
  await db
    .update(alertNotifications)
    .set({
      status: success ? 'sent' : 'failed',
      sentAt: success ? new Date() : null,
      errorMessage: error || null
    })
    .where(eq(alertNotifications.id, notificationRecord.id));

  if (success) {
    console.log(`[NotificationDispatcher] Sent ${channel.type} notification for alert ${data.alertId}`);
  } else {
    console.error(`[NotificationDispatcher] Failed to send ${channel.type} notification: ${error}`);
  }

  return {
    success,
    channelType: channel.type,
    error,
    durationMs: Date.now() - startTime
  };
}

/**
 * Send notification via email channel
 */
async function sendEmailChannelNotification(
  config: Record<string, unknown>,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  const recipients = getEmailRecipients(config);

  if (recipients.length === 0) {
    return { success: false, error: 'No email recipients configured' };
  }

  const dashboardUrl = process.env.DASHBOARD_URL
    ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}`
    : undefined;

  return sendEmailNotification({
    to: recipients,
    alertName: alert.title,
    severity: alert.severity as AlertSeverity,
    summary: alert.message || alert.title,
    deviceName: device?.displayName || device?.hostname,
    occurredAt: alert.triggeredAt,
    dashboardUrl,
    orgName: org?.name
  });
}

/**
 * Send notification via webhook channel
 */
async function sendWebhookChannelNotification(
  config: WebhookConfig,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  // Get rule for additional context (ruleId may be null for config policy alerts)
  const rule = alert.ruleId ? (await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, alert.ruleId))
    .limit(1))[0] : undefined;

  return sendWebhookNotification(config, {
    alertId: alert.id,
    alertName: alert.title,
    severity: alert.severity,
    summary: alert.message || alert.title,
    deviceId: alert.deviceId,
    deviceName: device?.displayName ?? device?.hostname ?? undefined,
    orgId: alert.orgId,
    orgName: org?.name,
    triggeredAt: alert.triggeredAt.toISOString(),
    ruleId: alert.ruleId ?? undefined,
    ruleName: rule?.name,
    context: alert.context as Record<string, unknown>
  });
}

/**
 * Send notification via Slack/Teams webhook channel
 */
async function sendChatWebhookChannelNotification(
  channelType: 'slack' | 'teams',
  config: Record<string, unknown>,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : '';
  if (!webhookUrl) {
    return { success: false, error: `${channelType} channel missing webhookUrl` };
  }

  const dashboardUrl = process.env.DASHBOARD_URL
    ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}`
    : undefined;

  const payloadTemplate = '{"text":"[{{severity}}] {{alertName}}: {{summary}}{{dashboardUrl}}"}';

  return sendWebhookNotification(
    {
      url: webhookUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payloadTemplate
    },
    {
      alertId: alert.id,
      alertName: alert.title,
      severity: alert.severity,
      summary: alert.message || alert.title,
      deviceId: alert.deviceId,
      deviceName: device?.displayName ?? device?.hostname ?? undefined,
      orgId: alert.orgId,
      orgName: org?.name,
      triggeredAt: alert.triggeredAt.toISOString(),
      ruleId: alert.ruleId ?? undefined,
      context: {
        dashboardUrl: dashboardUrl ? ` ${dashboardUrl}` : ''
      }
    }
  );
}

/**
 * Send notification via SMS channel
 */
export async function sendSmsChannelNotification(
  config: SmsChannelConfig,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  const dashboardUrl = process.env.DASHBOARD_URL
    ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}`
    : undefined;

  const smsResult = await sendSmsNotification(config, {
    alertName: alert.title,
    severity: alert.severity as AlertSeverity,
    summary: alert.message || alert.title,
    deviceName: device?.displayName || device?.hostname,
    occurredAt: alert.triggeredAt,
    dashboardUrl,
    orgName: org?.name
  });

  return {
    success: smsResult.success,
    error: smsResult.error
  };
}

/**
 * Send notification via PagerDuty channel
 */
async function sendPagerDutyChannelNotification(
  config: PagerDutyConfig,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  const dashboardUrl = process.env.DASHBOARD_URL
    ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}`
    : undefined;

  const result = await sendPagerDutyNotification(config, {
    alertId: alert.id,
    alertName: alert.title,
    severity: alert.severity as AlertSeverity,
    summary: alert.message || alert.title,
    deviceId: alert.deviceId,
    deviceName: device?.displayName ?? device?.hostname ?? undefined,
    orgId: alert.orgId,
    orgName: org?.name,
    triggeredAt: alert.triggeredAt.toISOString(),
    ruleId: alert.ruleId ?? undefined,
    dashboardUrl
  });

  return {
    success: result.success,
    error: result.error
  };
}

/**
 * Schedule escalation steps based on policy
 */
async function scheduleEscalation(alertId: string, policyId: string, orgId: string): Promise<void> {
  const [policy] = await db
    .select()
    .from(escalationPolicies)
    .where(
      and(
        eq(escalationPolicies.id, policyId),
        eq(escalationPolicies.orgId, orgId)
      )
    )
    .limit(1);

  if (!policy) {
    return;
  }

  const steps = policy.steps as Array<{
    delayMinutes: number;
    channelIds: string[];
  }>;

  if (!Array.isArray(steps) || steps.length === 0) {
    return;
  }

  const queue = getNotificationQueue();
  const requestedChannelIds = [...new Set(
    steps.flatMap((step) => Array.isArray(step.channelIds) ? step.channelIds : []).filter(Boolean)
  )];
  const validChannels = requestedChannelIds.length > 0
    ? await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.orgId, orgId),
          eq(notificationChannels.enabled, true),
          inArray(notificationChannels.id, requestedChannelIds)
        )
      )
    : [];
  const validChannelIdSet = new Set(validChannels.map((channel) => channel.id));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    const delayMs = step.delayMinutes * 60 * 1000;

    const stepChannelIds = (step.channelIds || []).filter((channelId) => validChannelIdSet.has(channelId));

    for (const channelId of stepChannelIds) {
      await queue.add(
        'send',
        {
          type: 'send',
          alertId,
          channelId,
          escalationStep: i + 1
        },
        {
          delay: delayMs,
          jobId: `escalation-${alertId}-step${i + 1}-${channelId}`
        }
      );
    }
  }

  console.log(`[NotificationDispatcher] Scheduled ${steps.length} escalation steps for alert ${alertId}`);
}

/**
 * Cancel pending escalations for an alert (when acknowledged/resolved)
 */
export async function cancelAlertEscalations(alertId: string): Promise<number> {
  const queue = getNotificationQueue();
  const delayed = await queue.getDelayed();

  let cancelled = 0;
  for (const job of delayed) {
    if (job.data.type === 'send' &&
        job.data.alertId === alertId &&
        job.data.escalationStep) {
      await job.remove();
      cancelled++;
    }
  }

  if (cancelled > 0) {
    console.log(`[NotificationDispatcher] Cancelled ${cancelled} escalations for alert ${alertId}`);
  }

  return cancelled;
}

/**
 * Dispatch notifications for a new alert
 * Call this when an alert is created
 */
export async function dispatchAlertNotifications(alertId: string): Promise<void> {
  const queue = getNotificationQueue();

  await queue.add(
    'process-alert',
    {
      type: 'process-alert',
      alertId
    },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );
}

/**
 * Subscribe to alert events and dispatch notifications automatically
 */
export function subscribeToAlertEvents(): void {
  const eventBus = getEventBus();

  eventBus.subscribe('alert.triggered', async (event) => {
    try {
      const payload = event.payload as { alertId?: string };
      if (payload.alertId) {
        await dispatchAlertNotifications(payload.alertId);
      }
    } catch (error) {
      console.error('Failed to dispatch alert notifications:', error);
    }
  });

  eventBus.subscribe('alert.acknowledged', async (event) => {
    try {
      const payload = event.payload as { alertId?: string };
      if (payload.alertId) {
        await cancelAlertEscalations(payload.alertId);
      }
    } catch (error) {
      console.error('Failed to cancel escalations on acknowledge:', error);
    }
  });

  eventBus.subscribe('alert.resolved', async (event) => {
    try {
      const payload = event.payload as { alertId?: string };
      if (payload.alertId) {
        await cancelAlertEscalations(payload.alertId);
      }
    } catch (error) {
      console.error('Failed to cancel escalations on resolve:', error);
    }
  });

  console.log('[NotificationDispatcher] Subscribed to alert events');
}

// Worker instance
let notificationWorker: Worker<NotificationJobData> | null = null;

/**
 * Initialize notification dispatcher
 * Call this during app startup
 */
export async function initializeNotificationDispatcher(): Promise<void> {
  try {
    // Create worker
    notificationWorker = createNotificationWorker();

    // Set up error handlers
    notificationWorker.on('error', (error) => {
      console.error('[NotificationDispatcher] Worker error:', error);
    });

    notificationWorker.on('failed', (job, error) => {
      console.error(`[NotificationDispatcher] Job ${job?.id} failed:`, error);
    });

    // Subscribe to alert events
    subscribeToAlertEvents();

    console.log('[NotificationDispatcher] Notification dispatcher initialized');
  } catch (error) {
    console.error('[NotificationDispatcher] Failed to initialize:', error);
    throw error;
  }
}

/**
 * Shutdown notification dispatcher gracefully
 */
export async function shutdownNotificationDispatcher(): Promise<void> {
  if (notificationWorker) {
    await notificationWorker.close();
    notificationWorker = null;
  }

  if (notificationQueue) {
    await notificationQueue.close();
    notificationQueue = null;
  }

  console.log('[NotificationDispatcher] Notification dispatcher shut down');
}

/**
 * Get queue status for monitoring
 */
export async function getNotificationQueueStatus(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getNotificationQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);

  return { waiting, active, completed, failed, delayed };
}
