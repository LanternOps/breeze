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
  notificationRoutingRules,
  devices,
  organizations,
  partners
} from '../db/schema';
import { eq, and, ne, inArray, asc, isNull, or, type SQL, type Column } from 'drizzle-orm';
import { getRedis, getBullMQConnection, isRedisAvailable } from './redis';
import { rateLimiter } from './rate-limit';
import { checkNotificationThrottle } from './notificationThrottle';
import { createAuditLogAsync } from './auditService';
import { interpolateTemplate } from './alertConditions';
import {
  sendEmailNotification,
  getEmailRecipients,
  sendWebhookNotification,
  sendInAppNotification,
  sendPagerDutyNotification,
  sendPushoverNotification,
  type WebhookConfig,
  type PagerDutyConfig,
  type PushoverConfig,
  type PushoverPriority,
  type AlertSeverity
} from './notificationSenders';
import { sendSmsNotification, type SmsChannelConfig } from './notificationSenders/smsSender';
import type { BreezeEvent } from './eventBus';
import { decryptNotificationChannelConfig } from './notificationChannelSecrets';

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
      connection: getBullMQConnection()
    });
  }
  return notificationQueue;
}

// Job data types
export interface SendNotificationJobData {
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
      switch (job.data.type) {
        case 'send':
          // processSendNotification manages its own short DB contexts and
          // performs the actual outbound send (email/webhook/Slack/Teams/
          // PagerDuty/Pushover/SMS) OUTSIDE any of them (#1105). Do NOT wrap
          // this call in runWithSystemDbAccess — that would re-introduce a
          // pooled connection held idle-in-transaction for the full send
          // duration, on every alert notification fleet-wide.
          return await processSendNotification(job.data);

        case 'process-alert': {
          // processAlertNotifications only does DB reads/writes plus fast
          // Redis enqueues (queue.addBulk / queue.add), so it keeps the
          // existing single-context shape. Bind the switch-narrowed job.data
          // to a const so the discriminated-union narrowing survives into the
          // runWithSystemDbAccess closure.
          const alertJobData = job.data;
          return await runWithSystemDbAccess(() => processAlertNotifications(alertJobData));
        }

        default:
          throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5
    }
  );
}

/**
 * Delivery rails are dual-owned (#2130): a channel / routing rule /
 * escalation policy is org-owned (org_id set) OR partner-wide (org_id NULL,
 * partner_id set). Every dispatcher lookup must match the alert org's own
 * rows OR partner-wide rows owned by that org's partner — a plain
 * eq(orgId, alert.orgId) silently never matches partner-wide rows (the #1724
 * trap; the worker runs under system context, so RLS is not the filter here).
 */
async function partnerIdForOrg(orgId: string): Promise<string | null> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.partnerId ?? null;
}

function railOwnershipCondition(
  orgCol: Column,
  partnerCol: Column,
  orgId: string,
  orgPartnerId: string | null
): SQL {
  if (!orgPartnerId) {
    return eq(orgCol, orgId);
  }
  return or(
    eq(orgCol, orgId),
    and(isNull(orgCol), eq(partnerCol, orgPartnerId))
  ) as SQL;
}

/**
 * Failed-job recovery (#4085): `queue.add`/`queue.addBulk` return the
 * EXISTING job for a duplicate id WITHOUT enqueuing a new one — including
 * when that existing job already reached the 'failed' state. A stable jobId
 * (baseline sends, escalation steps, process-alert) is only a double-send
 * guard while its failed-job hash exists in Redis; the moment a send fails,
 * that hash occupies the id for the rest of its `removeOnFail` window
 * (count- or age-bounded), and every later add for that identity — a
 * process-alert retry, a redelivered alert.triggered, a rescheduled
 * escalation — would otherwise silently return the dead job without
 * enqueuing, while the caller's `queued`/success count keeps reporting as if
 * it worked. Explicitly retry a duplicate-id job that is already 'failed' so
 * redelivery actually recovers instead of no-oping.
 *
 * Benign races only warn, never throw: the job can be removed/reaped between
 * `getState()` and `retry()` (e.g. a `removeOnFail` count/age purge), or
 * `getState()` itself can transiently fail — neither should fail the
 * caller's dispatch.
 */
async function retryIfFailedJob(job: Job<NotificationJobData>, context: string): Promise<void> {
  try {
    const state = await job.getState();
    if (state === 'failed') {
      await job.retry();
    }
  } catch (err) {
    console.warn(
      `[NotificationDispatcher] Failed to retry job ${job.id} (${context}) after duplicate-id failed-state check:`,
      err
    );
  }
}

/**
 * Process an alert and queue notifications to all configured channels.
 * Exported for the notificationRailsPartnerRls integration suite, which
 * proves the partner-wide rail fan-out (#2130) against real Postgres — every
 * unit test mocks the rail lookups away.
 */
export async function processAlertNotifications(data: ProcessAlertJobData): Promise<{
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

  // Durable status guard (#4085): `cancelAlertEscalations` only removes jobs
  // that are DELAYED at the moment it runs — an optimization, not the
  // correctness mechanism. Under queue delivery, `alert.resolved` can
  // process before a retried `alert.triggered` delivery, which would
  // otherwise re-fan-out the whole baseline notification set for an alert
  // that is already closed. Acknowledged still gets the baseline — only
  // escalations are cancelled on ack (today's semantics, preserved).
  if (alert.status === 'resolved') {
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

  // Dual-axis rail resolution (#2130): resolve the alert org's partner once,
  // so routing/channel/escalation lookups can match partner-wide rows too.
  const orgPartnerId = await partnerIdForOrg(alert.orgId);

  // Phase 5: Notification routing rules. Site-restricted rules fail closed if
  // the firing device or its site cannot be resolved.
  // Check routing rules before falling back to all channels
  if (channelIds.length === 0) {
    const routedChannelIds = await resolveRoutingRules(
      alert.orgId,
      alert.severity,
      orgPartnerId,
      device?.siteId ?? null
    );
    if (routedChannelIds.length > 0) {
      channelIds = routedChannelIds;
    }
  }

  // For config policy alerts (no ruleId) or rules without channel overrides and no routing rules,
  // fall back to all enabled channels for the org — including the partner's
  // partner-wide channels, which are active for every member org by design.
  if (channelIds.length === 0) {
    const orgChannels = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, alert.orgId, orgPartnerId),
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
        railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, alert.orgId, orgPartnerId),
        eq(notificationChannels.enabled, true),
        inArray(notificationChannels.id, requestedChannelIds)
      )
    );
  channelIds = validChannels.map((channel) => channel.id);

  if (channelIds.length === 0) {
    console.log(`[NotificationDispatcher] No valid channels in alert org or its partner for alert ${data.alertId}`);
    return { queued: 0, inAppSent, durationMs: Date.now() - startTime };
  }

  // Queue notification jobs for each channel with retry + exponential backoff (Phase 4a)
  const queue = getNotificationQueue();
  const jobs = channelIds.map(channelId => ({
    name: 'send',
    data: {
      type: 'send' as const,
      alertId: data.alertId,
      channelId
    },
    opts: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 30_000 }, // 30s, 60s (2 retries)
      removeOnComplete: true,
      removeOnFail: { count: 100 },
      // Stable per-(alert, channel) id for the baseline (step 0) send (#4085):
      // without this, a retried `process-alert` job (attempts:3 on the
      // process-alert job itself) re-runs this whole addBulk and duplicates
      // the entire baseline fan-out — every channel gets a second email/SMS/
      // Slack/webhook/PagerDuty/Pushover send. BullMQ returns the existing
      // job for a duplicate id instead of enqueuing a second one, so the
      // retry collapses onto the same job. Escalation sends already have a
      // stable jobId (`escalation-<alertId>-step<n>-<channelId>`) — this
      // gives baseline sends the same property.
      //
      // This jobId collapse is only a FAST PATH, and only while the job hash
      // still exists — see `retryIfFailedJob` below for what happens once it
      // reaches 'failed'. Task 8's durable (alertId, channelId, escalationStep)
      // row identity in `alert_notifications` (unique index; see
      // `buildAlertNotificationClaimCas`) is the actual double-send backstop.
      jobId: `alert-send-${data.alertId}-${channelId}-0`
    }
  }));

  const addedJobs = await queue.addBulk(jobs);
  await Promise.all(
    addedJobs.map((job) => retryIfFailedJob(job, `alert ${data.alertId} baseline send`))
  );

  // Check for escalation policy (only applicable to rule-based alerts)
  const escalationPolicyId = ruleOverrides?.escalationPolicyId as string | undefined;
  if (escalationPolicyId) {
    await scheduleEscalation(data.alertId, escalationPolicyId, alert.orgId, orgPartnerId);
  }

  return {
    queued: jobs.length,
    inAppSent,
    durationMs: Date.now() - startTime
  };
}

/**
 * Result shape returned by the short "prepare" DB context below: either an
 * early-exit result (nothing left to send) or everything needed to perform
 * the outbound send once the context has closed.
 */
type PrepareSendResult =
  | {
      send: false;
      result: { success: boolean; channelType: string; error?: string };
    }
  | {
      send: true;
      alert: typeof alerts.$inferSelect;
      channel: typeof notificationChannels.$inferSelect;
      notificationRecord: typeof alertNotifications.$inferSelect;
      device: typeof devices.$inferSelect | undefined;
      org: typeof organizations.$inferSelect | undefined;
    };

/**
 * The claim / success CAS for a send-identity row (wave 3.5c, #4085): this
 * row, unless it has already reached 'sent'. Used both to reclaim an
 * orphaned 'pending' row for a retry (a prior attempt crashed between the
 * insert and the final update) and to CAS the eventual send outcome to
 * 'sent' — either way, a row that already recorded a successful send must
 * never be clobbered back to 'pending' by a stale/racing attempt.
 *
 * Exported so tests can assert the COMPILED SQL rather than substring-match
 * column names against a mocked drizzle-orm (vacuous-Drizzle-assertion
 * rule) — swapping `ne` for `eq` here silently turns the dedupe backstop
 * into a no-op (every row becomes reclaimable, including already-sent ones).
 */
export function buildAlertNotificationClaimCas(id: string): SQL {
  return and(eq(alertNotifications.id, id), ne(alertNotifications.status, 'sent'))!;
}

/**
 * Send a notification through a specific channel.
 *
 * Split into three phases to avoid holding a pooled DB connection across the
 * outbound send (#1105):
 *   1. `runWithSystemDbAccess` — resolve alert/channel, create the pending
 *      notification record, and run the rate-limit/throttle guards. Any
 *      early exit (channel missing, rate limited, throttled, ...) is decided
 *      and persisted INSIDE this short context, before the send is attempted
 *      ("mark-attempted before send").
 *   2. Outside any DB context — perform the actual outbound send (email/
 *      webhook/Slack/Teams/PagerDuty/Pushover/SMS).
 *   3. `runWithSystemDbAccess` — persist the final sent/failed result AFTER
 *      the send completes ("record-result after send").
 *
 * Trade-off: previously steps 1-3 were one transaction, so a crash between
 * the pending insert and the final update would roll back the whole thing —
 * a BullMQ retry would insert a fresh pending row and try again cleanly. Now
 * step 1 commits before the send runs, so the same crash instead leaves an
 * orphaned 'pending' row. Wave 3.5c (#4085) closed the double-send/orphan gap
 * this used to leave open: sends are keyed by a durable
 * (alertId, channelId, escalationStep) identity (unique index; see
 * `buildAlertNotificationClaimCas`), so a retry after a mid-send crash
 * RECLAIMS that same row instead of inserting a fresh one, and a retry after
 * a row already reached 'sent' is a dedupe skip with no egress call at all.
 */
export async function processSendNotification(data: SendNotificationJobData): Promise<{
  success: boolean;
  channelType: string;
  error?: string;
  durationMs: number;
}> {
  const startTime = Date.now();

  const prepared: PrepareSendResult = await runWithSystemDbAccess(async () => {
    // Get alert details
    const [alert] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, data.alertId))
      .limit(1);

    if (!alert) {
      return {
        send: false,
        result: { success: false, channelType: 'unknown', error: 'Alert not found' }
      } satisfies PrepareSendResult;
    }

    // Durable status guard for escalation sends (#4085): `cancelAlertEscalations`
    // only removes jobs that are DELAYED at the moment it runs — an
    // optimization, not the correctness mechanism. An escalation step is a
    // delayed job scheduled minutes/hours ahead; by the time it fires, the
    // alert may have been acknowledged (that is what cancel-on-ack is meant
    // to express) or resolved. Re-load the alert fresh right here (the
    // select above IS that reload — no second query needed) and skip egress
    // for anything but 'active'. This runs BEFORE the send-identity
    // insert/claim below, so a skipped escalation never touches or creates
    // an alert_notifications row. `success: true` resolves the BullMQ job
    // cleanly — this is an intentional skip, not a failure to retry.
    const escalationStep = data.escalationStep ?? 0;
    if (escalationStep >= 1 && alert.status !== 'active') {
      console.log(
        `[NotificationDispatcher] Skipping escalation step ${escalationStep} for alert ${data.alertId} `
        + `— status is '${alert.status}', not 'active'`
      );
      return {
        send: false,
        result: { success: true, channelType: 'unknown' }
      } satisfies PrepareSendResult;
    }

    // Get channel — the alert org's own, or a partner-wide channel owned by
    // that org's partner (#2130).
    const sendOrgPartnerId = await partnerIdForOrg(alert.orgId);
    const [channel] = await db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, data.channelId),
          railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, alert.orgId, sendOrgPartnerId),
          eq(notificationChannels.enabled, true)
        )
      )
      .limit(1);

    if (!channel) {
      // A resolved {success:false} completes the BullMQ job (no 'failed' event)
      // and no alert_notifications row exists yet on this path — without a log
      // this send (possibly a DELAYED escalation step whose channel/partner
      // state drifted since scheduling) vanishes without a trace (#2130 review).
      console.warn(
        `[NotificationDispatcher] Channel ${data.channelId} not found (or disabled) for alert ${data.alertId}`
        + `${data.escalationStep ? ` escalation step ${data.escalationStep}` : ''} — send dropped`
      );
      return {
        send: false,
        result: { success: false, channelType: 'unknown', error: 'Channel not found for alert organization or its partner' }
      } satisfies PrepareSendResult;
    }

    // Send identity: (alertId, channelId, escalationStep). `?? 0` is
    // load-bearing — an explicit `escalationStep: null` must still collapse
    // onto step 0; a schema column default alone would not stop it, because
    // Drizzle sends the literal `null` rather than omitting the key (#4085).
    // (`escalationStep` itself is computed above, ahead of the status guard.)
    const [insertedRecord] = await db
      .insert(alertNotifications)
      .values({
        alertId: data.alertId,
        channelId: data.channelId,
        escalationStep,
        status: 'pending'
      })
      .onConflictDoNothing({
        target: [alertNotifications.alertId, alertNotifications.channelId, alertNotifications.escalationStep]
      })
      .returning();

    let notificationRecord = insertedRecord;

    if (!notificationRecord) {
      // Conflict: a row for this exact (alert, channel, step) identity
      // already exists — either a durable dedupe win (already sent) or an
      // orphaned 'pending'/'failed' row from a prior crashed/failed attempt.
      const [existing] = await db
        .select()
        .from(alertNotifications)
        .where(
          and(
            eq(alertNotifications.alertId, data.alertId),
            eq(alertNotifications.channelId, data.channelId),
            eq(alertNotifications.escalationStep, escalationStep)
          )
        )
        .limit(1);

      if (existing?.status === 'sent') {
        // Durable per-channel backstop: this exact send already succeeded.
        // Resolve success with NO egress call — the job completes cleanly.
        return {
          send: false,
          result: { success: true, channelType: channel.type }
        } satisfies PrepareSendResult;
      }

      if (existing) {
        // CLAIM: reuse the existing row for this attempt. Guarded by the
        // same CAS used for the eventual success write, so a concurrent
        // attempt that already reached 'sent' between the select above and
        // this update can never be clobbered back to 'pending'.
        const [claimed] = await db
          .update(alertNotifications)
          .set({ status: 'pending', errorMessage: null })
          .where(buildAlertNotificationClaimCas(existing.id))
          .returning();
        notificationRecord = claimed;

        if (!claimed) {
          // Lost the race: the row reached 'sent' between the select and the
          // claim update. Same outcome as the sent-skip above.
          return {
            send: false,
            result: { success: true, channelType: channel.type }
          } satisfies PrepareSendResult;
        }
      }
    }

    if (!notificationRecord) {
      return {
        send: false,
        result: { success: false, channelType: channel.type, error: 'Failed to create notification record' }
      } satisfies PrepareSendResult;
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

    // Phase 4b: Notification rate limiting
    const redis = isRedisAvailable() ? getRedis() : null;
    if (!redis) {
      console.warn(`[NotificationDispatcher] Redis unavailable — notification rate limiting DISABLED for org ${alert.orgId}`);
    }
    if (redis) {
      const rateKey = `notify:${alert.orgId}:${channel.type}`;
      const rateLimitResult = await rateLimiter(redis, rateKey, 60, 300); // 60 per 5 min
      if (!rateLimitResult.allowed) {
        console.warn(`[NotificationDispatcher] Rate limited for ${channel.type} channel in org ${alert.orgId}. Remaining: ${rateLimitResult.remaining}`);
        // Update pending record to reflect rate limiting — guarded by the
        // same claim CAS as every other terminal write on this row (#4085):
        // two concurrent attempts can share one row id after the
        // conflict-claim path above, so an unconditional `WHERE id = ?` here
        // could stomp a 'sent' row written by the OTHER attempt back to
        // 'failed', and a subsequent retry would then see a non-'sent' row
        // and re-send.
        if (notificationRecord?.id) {
          const [written] = await db.update(alertNotifications)
            .set({ status: 'failed', sentAt: null, errorMessage: 'Rate limited' })
            .where(buildAlertNotificationClaimCas(notificationRecord.id))
            .returning();
          if (!written) {
            // Zero rows: the only status the CAS excludes is 'sent', so this
            // can only mean another attempt already delivered this exact
            // send identity between our read and this write. That attempt's
            // outcome stands — resolve success/skip rather than reporting a
            // rate-limit failure that no longer reflects reality.
            return {
              send: false,
              result: { success: true, channelType: channel.type }
            } satisfies PrepareSendResult;
          }
        }
        return {
          send: false,
          result: { success: false, channelType: channel.type, error: `Rate limited (resets at ${rateLimitResult.resetAt.toISOString()})` }
        } satisfies PrepareSendResult;
      }
    }

    // Feature #4: per-channel sliding-window throttle (defense-in-depth vs alert storms).
    // Keyed by (channelId, device:<deviceId>) so one flooding device cannot starve other devices.
    if (channel.throttleMaxPerWindow && channel.throttleMaxPerWindow > 0) {
      const windowSeconds = channel.throttleWindowSeconds ?? 3600;
      const throttle = await checkNotificationThrottle(
        channel.id,
        `device:${alert.deviceId}`,
        channel.throttleMaxPerWindow,
        windowSeconds
      );
      if (!throttle.allowed) {
        const windowExpiresIso = new Date(throttle.windowExpiresAt).toISOString();
        const throttleMessage = `Throttled: ${throttle.currentCount} delivered in last ${windowSeconds}s (cap=${channel.throttleMaxPerWindow})`;
        console.warn(
          `[NotificationThrottle] Suppressed: channel=${channel.id} device=${alert.deviceId} ` +
          `count=${throttle.currentCount}/${channel.throttleMaxPerWindow} resetsAt=${windowExpiresIso}`
        );
        // Use 'failed' status + descriptive errorMessage so UI / queries that
        // filter by status see throttled rows alongside other delivery failures.
        // The alert_notifications.status column carries pending/sent/failed only;
        // 'suppressed' belongs to the separate alertStatusEnum and would render
        // as a phantom value here. (See #796 review.)
        //
        // Guarded by the same claim CAS as every other terminal write on this
        // row (#4085) — see the rate-limit write above for why an
        // unconditional `WHERE id = ?` is unsafe here.
        const [written] = await db.update(alertNotifications)
          .set({
            status: 'failed',
            sentAt: null,
            errorMessage: throttleMessage
          })
          .where(buildAlertNotificationClaimCas(notificationRecord.id))
          .returning();

        if (!written) {
          // Zero rows: another attempt already delivered this exact send
          // identity. Nothing was actually suppressed by this throttle
          // check anymore — skip the audit log and resolve success/skip.
          return {
            send: false,
            result: { success: true, channelType: channel.type }
          } satisfies PrepareSendResult;
        }

        // Operator-visible audit event so a misconfigured cap silently eating
        // alerts is investigable instead of buried in stdout. (See #796 review.)
        createAuditLogAsync({
          orgId: alert.orgId,
          actorType: 'system',
          actorId: '00000000-0000-0000-0000-000000000000',
          action: 'alert.notification.throttled',
          resourceType: 'alert_notification',
          resourceId: notificationRecord.id,
          result: 'denied',
          errorMessage: throttleMessage,
          details: {
            channelId: channel.id,
            channelType: channel.type,
            deviceId: alert.deviceId,
            currentCount: throttle.currentCount,
            maxPerWindow: channel.throttleMaxPerWindow,
            windowSeconds,
            windowExpiresAt: windowExpiresIso,
          },
        });
        return {
          send: false,
          result: { success: false, channelType: channel.type, error: `Throttled (resets at ${windowExpiresIso})` }
        } satisfies PrepareSendResult;
      }
    }

    return { send: true, alert, channel, notificationRecord, device, org } satisfies PrepareSendResult;
  });

  if (!prepared.send) {
    return { ...prepared.result, durationMs: Date.now() - startTime };
  }

  const { alert, channel, notificationRecord, device, org } = prepared;

  // Phase 4c: Per-channel notification templates (pure computation — no DB/Redis needed)
  const channelTemplates = channel.templates as Record<string, string> | null;
  let messageBody = alert.message || alert.title;
  if (channelTemplates?.alert_triggered) {
    messageBody = interpolateTemplate(channelTemplates.alert_triggered, {
      alertName: alert.title,
      severity: alert.severity,
      message: alert.message || '',
      deviceId: alert.deviceId,
      deviceName: device?.displayName || device?.hostname || '',
      orgName: org?.name || '',
      triggeredAt: alert.triggeredAt.toISOString(),
    });
  }

  // Use the per-channel template message body if available
  const alertForSend = messageBody !== (alert.message || alert.title)
    ? { ...alert, message: messageBody }
    : alert;

  // Send notification based on channel type — OUTSIDE any DB context (#1105).
  let success = false;
  let error: string | undefined;

  try {
    const channelConfig = decryptNotificationChannelConfig(channel.type, channel.config);
    switch (channel.type) {
      case 'email':
        const emailResult = await sendEmailChannelNotification(
          channelConfig as Record<string, unknown>,
          alertForSend,
          device,
          org
        );
        success = emailResult.success;
        error = emailResult.error;
        break;

      case 'webhook':
        const webhookResult = await sendWebhookChannelNotification(
          channelConfig as WebhookConfig,
          alertForSend,
          device,
          org
        );
        success = webhookResult.success;
        error = webhookResult.error;
        break;

      case 'sms':
        const smsResult = await sendSmsChannelNotification(
          channelConfig as SmsChannelConfig,
          alertForSend,
          device,
          org
        );
        success = smsResult.success;
        error = smsResult.error;
        break;

      case 'slack':
        const slackResult = await sendChatWebhookChannelNotification(
          'slack',
          channelConfig as Record<string, unknown>,
          alertForSend,
          device,
          org
        );
        success = slackResult.success;
        error = slackResult.error;
        break;

      case 'teams':
        const teamsResult = await sendChatWebhookChannelNotification(
          'teams',
          channelConfig as Record<string, unknown>,
          alertForSend,
          device,
          org
        );
        success = teamsResult.success;
        error = teamsResult.error;
        break;

      case 'pagerduty':
        const pagerDutyResult = await sendPagerDutyChannelNotification(
          channelConfig as PagerDutyConfig,
          alertForSend,
          device,
          org
        );
        success = pagerDutyResult.success;
        error = pagerDutyResult.error;
        break;

      case 'pushover':
        const pushoverResult = await sendPushoverChannelNotification(
          channelConfig as PushoverConfig,
          alertForSend,
          device,
          org
        );
        success = pushoverResult.success;
        error = pushoverResult.error;
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

  // Persist the final result — short DB context, AFTER the send completes
  // ("record-result after send"), so the transaction never spans the send.
  if (success) {
    // CAS to 'sent' rather than an unconditional update: a racing/stale
    // attempt on the same send identity (see buildAlertNotificationClaimCas)
    // must never re-open a row that another attempt already finished.
    await runWithSystemDbAccess(() =>
      db
        .update(alertNotifications)
        .set({ status: 'sent', sentAt: new Date(), errorMessage: null })
        .where(buildAlertNotificationClaimCas(notificationRecord.id))
    );

    console.log(`[NotificationDispatcher] Sent ${channel.type} notification for alert ${data.alertId}`);

    return {
      success: true,
      channelType: channel.type,
      error: undefined,
      durationMs: Date.now() - startTime
    };
  }

  // Guarded by the same claim CAS as the success write above: two
  // concurrent attempts can share one row id after the conflict-claim path,
  // so an unconditional `WHERE id = ?` here could stomp a 'sent' row written
  // by the OTHER (winning) attempt back to 'failed' — and a subsequent
  // retry would then see a non-'sent' row, re-claim it, and RE-SEND (#4085).
  const [failedRow] = await runWithSystemDbAccess(() =>
    db
      .update(alertNotifications)
      .set({ status: 'failed', sentAt: null, errorMessage: error || null })
      .where(buildAlertNotificationClaimCas(notificationRecord.id))
      .returning()
  );

  console.error(`[NotificationDispatcher] Failed to send ${channel.type} notification: ${error}`);

  if (!failedRow) {
    // Zero rows: the CAS excludes only 'sent', so this can only mean another
    // attempt already delivered this exact send identity between our claim
    // and this write. That attempt's outcome stands — a spurious 'failed'
    // job here would only trigger a pointless BullMQ retry, so resolve
    // success instead of throwing.
    return {
      success: true,
      channelType: channel.type,
      error: undefined,
      durationMs: Date.now() - startTime
    };
  }

  // Throw so BullMQ's attempts+backoff actually retries a transport failure.
  // This path used to return a resolved {success:false}, which BullMQ treats
  // as a completed job and never retries (#4085 — codex-flagged defect: with
  // attempts:3, transport failures were never actually retried). The row is
  // reclaimed on the next attempt via the send-identity claim path above.
  throw new Error(error || `Unknown error sending ${channel.type} notification`);
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
  // Get rule for additional context (ruleId may be null for config policy alerts).
  // This now runs during the outbound-send phase (#1105), with no ambient DB
  // context, so it must open its own short one rather than assume `db` is
  // already inside a transaction.
  const ruleId = alert.ruleId;
  const rule = ruleId
    ? await runWithSystemDbAccess(async () =>
        (await db
          .select()
          .from(alertRules)
          .where(eq(alertRules.id, ruleId))
          .limit(1))[0]
      )
    : undefined;

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
 * Send notification via Pushover channel.
 *
 * Per-org channels may leave any field blank; in that case we fall back to
 * the partner-level `pushoverAppToken` / `pushoverDefaultUser` /
 * `pushoverDefaultSound` / `pushoverDefaultPriority` from
 * `partners.settings.notifications`. This mirrors the Slack-webhook-URL
 * inheritance pattern.
 */
async function sendPushoverChannelNotification(
  config: PushoverConfig,
  alert: typeof alerts.$inferSelect,
  device: typeof devices.$inferSelect | undefined,
  org: typeof organizations.$inferSelect | undefined
): Promise<{ success: boolean; error?: string }> {
  const merged: PushoverConfig = { ...config };

  const tokenBlank = !merged.token || merged.token.trim().length === 0;
  const userBlank = !merged.user || merged.user.trim().length === 0;
  const needsInherit = tokenBlank || userBlank || merged.sound === undefined || merged.priority === undefined;

  if (needsInherit && org?.partnerId) {
    const inherited = await runWithSystemDbAccess(async () => {
      const [partner] = await db
        .select({ settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, org.partnerId))
        .limit(1);
      const notifications = (partner?.settings as { notifications?: Record<string, unknown> } | null)?.notifications;
      return {
        pushoverAppToken: typeof notifications?.pushoverAppToken === 'string' ? notifications.pushoverAppToken : undefined,
        pushoverDefaultUser: typeof notifications?.pushoverDefaultUser === 'string' ? notifications.pushoverDefaultUser : undefined,
        pushoverDefaultSound: typeof notifications?.pushoverDefaultSound === 'string' ? notifications.pushoverDefaultSound : undefined,
        pushoverDefaultPriority: typeof notifications?.pushoverDefaultPriority === 'number' ? notifications.pushoverDefaultPriority as PushoverPriority : undefined,
      };
    });

    if (tokenBlank && inherited.pushoverAppToken) {
      merged.token = inherited.pushoverAppToken;
    }
    if (userBlank && inherited.pushoverDefaultUser) {
      merged.user = inherited.pushoverDefaultUser;
    }
    if (merged.sound === undefined && inherited.pushoverDefaultSound) {
      merged.sound = inherited.pushoverDefaultSound;
    }
    if (merged.priority === undefined && inherited.pushoverDefaultPriority !== undefined) {
      merged.priority = inherited.pushoverDefaultPriority;
    }
  }

  const dashboardUrl = process.env.DASHBOARD_URL
    ? `${process.env.DASHBOARD_URL}/alerts/${alert.id}`
    : undefined;

  const result = await sendPushoverNotification(merged, {
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
 * Phase 5: Resolve notification routing rules for an alert.
 * Returns channel IDs from the first matching routing rule (by priority).
 * Returns empty array if no routing rules match (falls through to default behavior).
 */
export async function resolveRoutingRules(
  orgId: string,
  severity: string,
  orgPartnerId: string | null,
  deviceSiteId: string | null
): Promise<string[]> {
  // Dual-axis (#2130): the org's own rules AND its partner's partner-wide
  // rules compete in one priority ordering; the first match wins regardless
  // of axis, so an org can pre-empt a partner-wide rule with a
  // higher-priority org rule.
  const rules = await db
    .select()
    .from(notificationRoutingRules)
    .where(
      and(
        railOwnershipCondition(notificationRoutingRules.orgId, notificationRoutingRules.partnerId, orgId, orgPartnerId),
        eq(notificationRoutingRules.enabled, true)
      )
    )
    .orderBy(asc(notificationRoutingRules.priority));

  for (const rule of rules) {
    const conditions = rule.conditions as {
      severities?: string[];
      conditionTypes?: string[];
      deviceTags?: string[];
      siteIds?: string[];
    };

    // Check severity match
    if (conditions.severities && conditions.severities.length > 0) {
      if (!conditions.severities.includes(severity)) {
        continue;
      }
    }

    if (conditions.siteIds && conditions.siteIds.length > 0) {
      if (!deviceSiteId || !conditions.siteIds.includes(deviceSiteId)) {
        continue;
      }
    }

    // First matching rule wins
    const channelIds = rule.channelIds;
    if (channelIds && channelIds.length > 0) {
      console.log(`[NotificationDispatcher] Routing rule "${rule.name}" matched for severity=${severity}`);
      return channelIds;
    }
  }

  return [];
}

/**
 * Schedule escalation steps based on policy
 */
async function scheduleEscalation(alertId: string, policyId: string, orgId: string, orgPartnerId: string | null): Promise<void> {
  const [policy] = await db
    .select()
    .from(escalationPolicies)
    .where(
      and(
        eq(escalationPolicies.id, policyId),
        railOwnershipCondition(escalationPolicies.orgId, escalationPolicies.partnerId, orgId, orgPartnerId)
      )
    )
    .limit(1);

  if (!policy) {
    // The rule still references this policy but the dual-axis lookup missed —
    // deleted policy, or the org's partner changed since the rule was bound.
    // Silently dropping would erase the whole escalation chain (#2130 review).
    console.warn(
      `[NotificationDispatcher] Escalation policy ${policyId} not found for alert ${alertId} `
      + `(org ${orgId}, partner ${orgPartnerId ?? 'none'}) — escalation skipped`
    );
    return;
  }

  const steps = policy.steps as Array<{
    delayMinutes: number;
    channelIds: string[];
  }>;

  if (!Array.isArray(steps) || steps.length === 0) {
    console.warn(
      `[NotificationDispatcher] Escalation policy ${policyId} has no steps for alert ${alertId} — escalation skipped`
    );
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
          railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, orgId, orgPartnerId),
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
      const job = await queue.add(
        'send',
        {
          type: 'send',
          alertId,
          channelId,
          escalationStep: i + 1
        },
        {
          delay: delayMs,
          jobId: `escalation-${alertId}-step${i + 1}-${channelId}`,
          // Carried from the Task 8 review (#4085): now that a transport
          // failure in processSendNotification THROWS (so BullMQ's
          // attempts+backoff can actually retry it), a failing escalation
          // send with no `attempts`/`removeOnFail` of its own becomes a
          // permanently-retained failed job hash with ZERO retries — the
          // stable jobId then stays occupied forever and nothing ever
          // re-fires that escalation step.
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: { age: 3600 }
        }
      );
      // Same exposure as the baseline sends above: a duplicate add against a
      // failed escalation-step hash would otherwise silently no-op for the
      // whole 1-hour removeOnFail window.
      await retryIfFailedJob(job, `alert ${alertId} escalation step ${i + 1}`);
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
export async function dispatchAlertNotifications(
  alertId: string,
  dedupeToken: string = alertId
): Promise<void> {
  const queue = getNotificationQueue();

  const job = await queue.add(
    'process-alert',
    {
      type: 'process-alert',
      alertId
    },
    {
      // A redelivered alert.triggered must not fan out a second notification
      // set — email, SMS, Slack, Teams, PagerDuty and Pushover all hang off
      // this one job. BullMQ does NOT reject a duplicate jobId: it returns the
      // existing job and resolves normally (addStandardJob -> handleDuplicatedJob),
      // which is the behaviour relied on here. The token must therefore be
      // STABLE for one (alert, event) pair: never randomised, never timestamped.
      // The subscriber below supplies `event.id`.
      //
      // Retention-bounded on the SUCCESS path only: `removeOnComplete: true`
      // deletes the job key and frees the id. A FAILED job is the dangerous
      // case — its hash is retained, so the id stays occupied and any later
      // add for that (alert, event) is silently swallowed, meaning the
      // redelivery that exists to recover the failure never notifies anyone.
      // Hence `attempts` (so a transient blip doesn't burn the id at all) and
      // an AGE-bounded removeOnFail (so a permanent failure self-clears rather
      // than suppressing that alert forever).
      //
      // None of this is durable dedupe: `alert_notifications` carries no unique
      // constraint, so there is no per-channel backstop for the six external
      // channels. That belongs in wave 3.5c (#4085) alongside at-least-once
      // delivery; the in-app row's dedupe key covers in-app only.
      jobId: `process-alert-${alertId}-${dedupeToken}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 }
    }
  );

  // Failed-job recovery (#4085): see `retryIfFailedJob` above. A redelivered
  // alert.triggered landing on a previously-FAILED process-alert hash (still
  // retained for up to an hour by the age-bounded removeOnFail above) was a
  // silent permanent drop before this — the redelivery that exists
  // specifically to recover the failure never notified anyone.
  await retryIfFailedJob(job, `alert ${alertId} process-alert`);
}

/**
 * Handle one alert lifecycle event (`alert.triggered` / `alert.acknowledged` /
 * `alert.resolved`).
 *
 * Registered under subscriber id `notification-dispatcher` (services/eventSubscribers.ts).
 * MUST throw on failure — queue-mode dispatch (#4085) retries on a thrown
 * rejection; local delivery's wrapper (eventBus.ts's invokeLocalHandlers)
 * provides the swallow-and-log semantics the old subscribers' try/catch used
 * to provide themselves.
 */
export async function handleAlertLifecycleEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { alertId?: string };
  if (!payload.alertId) {
    // Kept as a guard, not a silent no-op (#4085): these events should always
    // carry an alertId, so a missing one is worth a trace even though there is
    // nothing actionable to do about it here.
    console.warn(
      `[NotificationDispatcher] ${event.type} event missing alertId; skipping`,
      JSON.stringify({ eventId: event.id, orgId: event.orgId })
    );
    return;
  }

  switch (event.type) {
    case 'alert.triggered':
      // Pass the event id so a redelivered alert.triggered collapses onto the
      // same job rather than notifying every on-call tech twice.
      await dispatchAlertNotifications(payload.alertId, event.id);
      return;
    case 'alert.acknowledged':
    case 'alert.resolved':
      await cancelAlertEscalations(payload.alertId);
      return;
    default:
      return;
  }
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
