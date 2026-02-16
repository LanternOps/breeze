import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { notificationChannels } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  getEmailRecipients,
  sendEmailNotification,
  sendPagerDutyNotification,
  sendSmsNotification,
  sendWebhookNotification,
  testWebhook,
  type AlertSeverity,
  type PagerDutyConfig,
  type SmsChannelConfig,
  type WebhookConfig
} from '../../services/notificationSenders';
import { listChannelsSchema, createChannelSchema, updateChannelSchema } from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getNotificationChannelWithOrgCheck,
  validateNotificationChannelConfig,
} from './helpers';

export const channelsRoutes = new Hono();

// GET /alerts/channels - List notification channels
channelsRoutes.get(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listChannelsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(notificationChannels.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(notificationChannels.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(notificationChannels.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(notificationChannels.orgId, query.orgId));
    }

    // Additional filters
    if (query.type) {
      conditions.push(eq(notificationChannels.type, query.type));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(notificationChannels.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(notificationChannels)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get channels
    const channelsList = await db
      .select()
      .from(notificationChannels)
      .where(whereCondition)
      .orderBy(desc(notificationChannels.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: channelsList,
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/channels - Create notification channel
channelsRoutes.post(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const orgId = data.orgId ?? auth.orgId;
    if (!orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const configErrors = validateNotificationChannelConfig(data.type, data.config);
    if (configErrors.length > 0) {
      return c.json({
        error: `Invalid ${data.type} channel configuration`,
        details: configErrors
      }, 400);
    }

    const [channel] = await db
      .insert(notificationChannels)
      .values({
        orgId,
        name: data.name,
        type: data.type,
        config: data.config,
        enabled: data.enabled
      })
      .returning();
    if (!channel) {
      return c.json({ error: 'Failed to create notification channel' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'notification_channel.create',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
      details: {
        type: channel.type,
        enabled: channel.enabled,
      },
    });

    return c.json(channel, 201);
  }
);

// PUT /alerts/channels/:id - Update notification channel
channelsRoutes.put(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    if (data.config !== undefined) {
      const configErrors = validateNotificationChannelConfig(channel.type, data.config);
      if (configErrors.length > 0) {
        return c.json({
          error: `Invalid ${channel.type} channel configuration`,
          details: configErrors
        }, 400);
      }
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) updates.config = data.config;
    if (data.enabled !== undefined) updates.enabled = data.enabled;

    const [updated] = await db
      .update(notificationChannels)
      .set(updates)
      .where(eq(notificationChannels.id, channelId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update notification channel' }, 500);
    }

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.update',
      resourceType: 'notification_channel',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(data),
      },
    });

    return c.json(updated);
  }
);

// DELETE /alerts/channels/:id - Delete notification channel
channelsRoutes.delete(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId));

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.delete',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
    });

    return c.json({ success: true });
  }
);

// POST /alerts/channels/:id/test - Test notification channel
channelsRoutes.post(
  '/channels/:id/test',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Send a real test notification through the selected channel type.
    const testMessage = {
      title: 'Test Alert from Breeze RMM',
      message: `This is a test notification sent to channel "${channel.name}" at ${new Date().toISOString()}`,
      severity: 'info',
      source: 'manual_test'
    };

    const dashboardUrl = process.env.DASHBOARD_URL
      ? `${process.env.DASHBOARD_URL}/alerts/channels`
      : undefined;

    let testResult: { success: boolean; message: string; details?: unknown };

    try {
      switch (channel.type) {
        case 'email': {
          const recipients = getEmailRecipients(channel.config as Record<string, unknown>);
          if (recipients.length === 0) {
            testResult = {
              success: false,
              message: 'No email recipients configured for this channel'
            };
            break;
          }

          const emailResult = await sendEmailNotification({
            to: recipients,
            alertName: testMessage.title,
            severity: testMessage.severity as AlertSeverity,
            summary: testMessage.message,
            dashboardUrl,
            orgName: 'Breeze'
          });

          testResult = {
            success: emailResult.success,
            message: emailResult.success ? 'Test email sent successfully' : (emailResult.error || 'Failed to send test email'),
            details: { recipients }
          };
          break;
        }

        case 'webhook': {
          const webhookResult = await testWebhook(channel.config as WebhookConfig);
          testResult = {
            success: webhookResult.success,
            message: webhookResult.success
              ? 'Test webhook sent successfully'
              : (webhookResult.error || 'Failed to send test webhook'),
            details: {
              url: (channel.config as { url?: string })?.url,
              statusCode: webhookResult.statusCode
            }
          };
          break;
        }

        case 'slack':
        case 'teams': {
          const config = channel.config as Record<string, unknown>;
          const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : '';
          if (!webhookUrl) {
            testResult = {
              success: false,
              message: `${channel.type} webhookUrl is not configured`
            };
            break;
          }

          const chatResult = await sendWebhookNotification(
            {
              url: webhookUrl,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              payloadTemplate: '{"text":"[{{severity}}] {{alertName}}: {{summary}}{{dashboardUrl}}"}'
            },
            {
              alertId: `test-${channel.id}`,
              alertName: testMessage.title,
              severity: testMessage.severity,
              summary: testMessage.message,
              orgId: channel.orgId,
              orgName: 'Breeze',
              triggeredAt: new Date().toISOString(),
              context: { dashboardUrl: dashboardUrl ? ` ${dashboardUrl}` : '' }
            }
          );

          testResult = {
            success: chatResult.success,
            message: chatResult.success
              ? `Test ${channel.type} message sent successfully`
              : (chatResult.error || `Failed to send test ${channel.type} message`),
            details: {
              webhookUrl,
              statusCode: chatResult.statusCode
            }
          };
          break;
        }

        case 'pagerduty': {
          const pagerDutyResult = await sendPagerDutyNotification(
            channel.config as PagerDutyConfig,
            {
              alertId: `test-${channel.id}`,
              alertName: testMessage.title,
              severity: testMessage.severity as AlertSeverity,
              summary: testMessage.message,
              orgId: channel.orgId,
              orgName: 'Breeze',
              triggeredAt: new Date().toISOString(),
              dashboardUrl
            }
          );

          testResult = {
            success: pagerDutyResult.success,
            message: pagerDutyResult.success
              ? 'Test PagerDuty event sent successfully'
              : (pagerDutyResult.error || 'Failed to send test PagerDuty event'),
            details: {
              statusCode: pagerDutyResult.statusCode,
              dedupKey: pagerDutyResult.dedupKey
            }
          };
          break;
        }

        case 'sms':
          {
            const smsResult = await sendSmsNotification(
              channel.config as SmsChannelConfig,
              {
                alertName: testMessage.title,
                severity: 'info',
                summary: testMessage.message,
                dashboardUrl
              }
            );

            testResult = {
              success: smsResult.success,
              message: smsResult.success ? 'Test SMS sent successfully' : (smsResult.error || 'Failed to send test SMS'),
              details: {
                phoneNumbers: (channel.config as { phoneNumbers?: string[] })?.phoneNumbers,
                sentCount: smsResult.sentCount,
                failedCount: smsResult.failedCount
              }
            };
          }
          break;

        default:
          testResult = {
            success: false,
            message: `Unknown channel type: ${channel.type}`
          };
      }
    } catch (error) {
      testResult = {
        success: false,
        message: `Failed to test channel: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }

    const response = {
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      testMessage,
      testResult,
      testedAt: new Date().toISOString(),
      testedBy: auth.user.id
    };

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.test',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
      details: {
        success: testResult.success,
      },
      result: testResult.success ? 'success' : 'failure',
    });

    return c.json(response);
  }
);
