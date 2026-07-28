import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc, inArray, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { notificationChannels, organizations, partners } from '../../db/schema';
import { dbAccessContextFromAuth, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import {
  decryptNotificationChannelConfig,
  encryptNotificationChannelConfig,
  redactNotificationChannelConfig,
} from '../../services/notificationChannelSecrets';
import {
  getEmailRecipients,
  sendEmailNotification,
  sendPagerDutyNotification,
  sendPushoverNotification,
  sendSmsNotification,
  sendWebhookNotification,
  testWebhook,
  type AlertSeverity,
  type PagerDutyConfig,
  type PushoverConfig,
  type PushoverPriority,
  type SmsChannelConfig,
  type WebhookConfig
} from '../../services/notificationSenders';
import { listChannelsSchema, createChannelSchema, updateChannelSchema } from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getNotificationChannelWithOrgCheck,
  validateNotificationChannelConfig,
  validatePushoverChannelInheritance,
} from './helpers';
import { PERMISSIONS } from '../../services/permissions';

export const channelsRoutes = new Hono();
const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

/**
 * POST /channels/:id/test is registered in SELF_MANAGED_DB_CONTEXT_ROUTES
 * (#1105 / BREEZE-A) — it fires a real outbound notification send that can
 * take up to ~10s, so the auth middleware does NOT wrap this route in the
 * usual request transaction. Reads/writes instead run in short, explicit
 * contexts built from the same fields the middleware would have used
 * (`dbAccessContextFromAuth` mirrors the `buildDbAccessContext` call in
 * auth.ts's dispatch), so RLS visibility is identical to the auto-wrapped
 * path. Mirrors `withProviderDbContext` in routes/sso.ts.
 */
function withChannelsDbContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));
}

function toChannelResponse(channel: typeof notificationChannels.$inferSelect) {
  // lastTestedAt and lastTestStatus are carried through via the ...channel spread;
  // updatedAt is intentionally NOT bumped when persisting a test result — running
  // a test is not a user content change, only lastTestedAt is the relevant timestamp.
  return {
    ...channel,
    config: redactNotificationChannelConfig(channel.type, channel.config),
  };
}

function getRedactedConfigValue(config: unknown, key: string): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  return (config as Record<string, unknown>)[key];
}

// GET /alerts/channels - List notification channels
channelsRoutes.get(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
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
        // "All orgs" view: org-owned channels across accessible orgs PLUS
        // this partner's own partner-wide channels (org_id NULL, #2130).
        const orgIds = auth.accessibleOrgIds ?? [];
        const orgCondition = orgIds.length > 0
          ? inArray(notificationChannels.orgId, orgIds)
          : undefined;
        const partnerCondition = auth.partnerId
          ? and(isNull(notificationChannels.orgId), eq(notificationChannels.partnerId, auth.partnerId))
          : undefined;
        const ownership = orgCondition && partnerCondition
          ? or(orgCondition, partnerCondition)
          : (orgCondition ?? partnerCondition);
        if (!ownership) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(ownership as ReturnType<typeof eq>);
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
      data: channelsList.map(toChannelResponse),
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/channels - Create notification channel
channelsRoutes.post(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', createChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Resolve the ownership axis (#2130): partner-wide creation requires the
    // partner-wide capability; the default path stays org-owned.
    let owner: { orgId: string | null; partnerId: string | null };
    if (data.ownerScope === 'partner') {
      if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgId = data.orgId ?? auth.orgId;
      if (!orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      owner = { orgId, partnerId: null };
    }

    const configErrors = validateNotificationChannelConfig(data.type, data.config);
    if (configErrors.length > 0) {
      return c.json({
        error: `Invalid ${data.type} channel configuration`,
        details: configErrors
      }, 400);
    }

    if (data.type === 'pushover') {
      const inheritanceError = await validatePushoverChannelInheritance(owner, data.config);
      if (inheritanceError) {
        return c.json({
          error: `Invalid ${data.type} channel configuration`,
          details: [inheritanceError]
        }, 400);
      }
    }

    const [channel] = await db
      .insert(notificationChannels)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: data.name,
        type: data.type,
        config: encryptNotificationChannelConfig(data.type, data.config),
        enabled: data.enabled,
        throttleMaxPerWindow: data.throttleMaxPerWindow ?? null,
        throttleWindowSeconds: data.throttleWindowSeconds ?? 3600
      })
      .returning();
    if (!channel) {
      return c.json({ error: 'Failed to create notification channel' }, 500);
    }

    writeRouteAudit(c, {
      orgId: owner.orgId,
      action: 'notification_channel.create',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
      details: {
        type: channel.type,
        enabled: channel.enabled,
      },
    });

    return c.json(toChannelResponse(channel), 201);
  }
);

// PUT /alerts/channels/:id - Update notification channel
channelsRoutes.put(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updateChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Partner-wide channels are administrable only with the partner-wide
    // capability (#2130).
    if (channel.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    if (data.config !== undefined) {
      const configForValidation = decryptNotificationChannelConfig(
        channel.type,
        encryptNotificationChannelConfig(channel.type, data.config, channel.config)
      );
      const configErrors = validateNotificationChannelConfig(channel.type, configForValidation);
      if (configErrors.length > 0) {
        return c.json({
          error: `Invalid ${channel.type} channel configuration`,
          details: configErrors
        }, 400);
      }

      if (channel.type === 'pushover') {
        const inheritanceError = await validatePushoverChannelInheritance(channel, configForValidation);
        if (inheritanceError) {
          return c.json({
            error: `Invalid ${channel.type} channel configuration`,
            details: [inheritanceError]
          }, 400);
        }
      }
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) {
      updates.config = encryptNotificationChannelConfig(channel.type, data.config, channel.config);
    }
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.throttleMaxPerWindow !== undefined) {
      updates.throttleMaxPerWindow = data.throttleMaxPerWindow;
    }
    if (data.throttleWindowSeconds !== undefined) {
      updates.throttleWindowSeconds = data.throttleWindowSeconds;
    }

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

    return c.json(toChannelResponse(updated));
  }
);

// DELETE /alerts/channels/:id - Delete notification channel
channelsRoutes.delete(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id')!;

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Partner-wide channels are administrable only with the partner-wide
    // capability (#2130).
    if (channel.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
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
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id')!;

    // Short, explicit DB context — this route is in SELF_MANAGED_DB_CONTEXT_ROUTES
    // (the outbound send below is not tenant-bounded and can take ~10s), so
    // there is no ambient request transaction to read under (#1105).
    const channel = await withChannelsDbContext(auth, () => getNotificationChannelWithOrgCheck(channelId, auth));
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Test-send is a mutator in effect: it fires a REAL external notification
    // (Slack/PagerDuty/SMS/...) on the shared destination and overwrites the
    // channel's lastTestedAt/lastTestStatus for every org under the partner —
    // gate partner-wide channels like the sibling PUT/DELETE (#2130 review).
    if (channel.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const channelConfig = decryptNotificationChannelConfig(channel.type, channel.config);
    const redactedChannelConfig = redactNotificationChannelConfig(channel.type, channel.config);

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
          const webhookResult = await testWebhook(channelConfig as WebhookConfig);
          testResult = {
            success: webhookResult.success,
            message: webhookResult.success
              ? 'Test webhook sent successfully'
              : (webhookResult.error || 'Failed to send test webhook'),
            details: {
              url: getRedactedConfigValue(redactedChannelConfig, 'url'),
              statusCode: webhookResult.statusCode
            }
          };
          break;
        }

        case 'slack':
        case 'teams': {
          const config = channelConfig as Record<string, unknown>;
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
              // Partner-wide channels (#2130) have no owning org; the test
              // payload's orgId is informational only.
              orgId: channel.orgId ?? channel.partnerId ?? 'partner-wide',
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
              webhookUrl: getRedactedConfigValue(redactedChannelConfig, 'webhookUrl'),
              statusCode: chatResult.statusCode
            }
          };
          break;
        }

        case 'pagerduty': {
          const pagerDutyResult = await sendPagerDutyNotification(
            channelConfig as PagerDutyConfig,
            {
              alertId: `test-${channel.id}`,
              alertName: testMessage.title,
              severity: testMessage.severity as AlertSeverity,
              summary: testMessage.message,
              // Partner-wide channels (#2130) have no owning org; the test
              // payload's orgId is informational only.
              orgId: channel.orgId ?? channel.partnerId ?? 'partner-wide',
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

        case 'pushover': {
          const cfg = { ...(channelConfig as PushoverConfig) };
          const tokenBlank = !cfg.token || cfg.token.trim().length === 0;
          const userBlank = !cfg.user || cfg.user.trim().length === 0;

          if (tokenBlank || userBlank) {
            // Mirror dispatcher inheritance: pull defaults from the channel's
            // partner.settings.notifications when blank. Org-tier callers do
            // not have partner-read RLS, so we must escape the request DB
            // context and run the lookup under system scope. Otherwise the
            // partner row is silently filtered and inheritance fails open
            // with a misleading "token required" error.
            const inherited = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
              // Partner-wide channels (#2130) carry the partner directly;
              // org-owned channels derive it from their org.
              let partnerId = channel.partnerId ?? null;
              if (!partnerId && channel.orgId) {
                const [orgRow] = await db
                  .select({ partnerId: organizations.partnerId })
                  .from(organizations)
                  .where(eq(organizations.id, channel.orgId))
                  .limit(1);
                partnerId = orgRow?.partnerId ?? null;
              }
              if (!partnerId) {
                return null;
              }
              const [partner] = await db
                .select({ settings: partners.settings })
                .from(partners)
                .where(eq(partners.id, partnerId))
                .limit(1);
              return (partner?.settings as { notifications?: Record<string, unknown> } | null)?.notifications ?? null;
            }));

            if (inherited) {
              if (tokenBlank && typeof inherited.pushoverAppToken === 'string') {
                cfg.token = inherited.pushoverAppToken;
              }
              if (userBlank && typeof inherited.pushoverDefaultUser === 'string') {
                cfg.user = inherited.pushoverDefaultUser;
              }
              if (cfg.sound === undefined && typeof inherited.pushoverDefaultSound === 'string') {
                cfg.sound = inherited.pushoverDefaultSound;
              }
              if (cfg.priority === undefined && typeof inherited.pushoverDefaultPriority === 'number') {
                cfg.priority = inherited.pushoverDefaultPriority as PushoverPriority;
              }
            }
          }

          const pushoverResult = await sendPushoverNotification(cfg, {
            alertId: `test-${channel.id}`,
            alertName: testMessage.title,
            severity: testMessage.severity as AlertSeverity,
            summary: testMessage.message,
            // Partner-wide channels (#2130) have no owning org; informational.
            orgId: channel.orgId ?? channel.partnerId ?? 'partner-wide',
            orgName: 'Breeze',
            triggeredAt: new Date().toISOString(),
            dashboardUrl
          });

          testResult = {
            success: pushoverResult.success,
            message: pushoverResult.success
              ? 'Test Pushover notification sent successfully'
              : (pushoverResult.error || 'Failed to send test Pushover notification'),
            details: {
              statusCode: pushoverResult.statusCode,
              request: pushoverResult.request,
              receipt: pushoverResult.receipt
            }
          };
          break;
        }

        case 'sms':
          {
            const smsResult = await sendSmsNotification(
              channelConfig as SmsChannelConfig,
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
                phoneNumbers: (channelConfig as { phoneNumbers?: string[] })?.phoneNumbers,
                sentCount: smsResult.sentCount,
                failedCount: smsResult.failedCount
              }
            };
          }
          break;

        default: {
          // Compile-time exhaustiveness: if a new enum value is added without
          // a case above, TS errors here. Runtime 501 covers the deploy-drift
          // case where the DB enum has a value the code does not handle yet.
          const _exhaustiveCheck: never = channel.type;
          void _exhaustiveCheck;
          const unsupportedType = (channel as { type: string }).type;
          console.error(
            '[Channels] Test endpoint missing handler for channel type',
            { channelId: channel.id, type: unsupportedType }
          );
          writeRouteAudit(c, {
            orgId: channel.orgId,
            action: 'notification_channel.test',
            resourceType: 'notification_channel',
            resourceId: channel.id,
            resourceName: channel.name,
            details: {
              success: false,
              reason: 'unsupported_channel_type',
              type: unsupportedType,
            },
            result: 'failure',
          });
          // NOTE: unsupported channel type returns early; last_test_status is intentionally not persisted here (deploy-drift path, already covered by the audit log).
          return c.json(
            {
              success: false,
              error: `Test endpoint does not support channel type: ${unsupportedType}`
            },
            501
          );
        }
      }
    } catch (error) {
      testResult = {
        success: false,
        message: `Failed to test channel: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }

    // Best-effort audit field — a DB hiccup here must not mask a successful
    // (or completed) test send. The HTTP response reflects testResult, not this write.
    // updatedAt is intentionally NOT bumped here; running a test is not a user content change.
    // Own short context (#1105) — the outbound send above ran with no ambient
    // request transaction; this write reopens one just for the persist.
    try {
      await withChannelsDbContext(auth, () =>
        db.update(notificationChannels)
          .set({
            lastTestedAt: new Date(),
            lastTestStatus: testResult.success ? 'success' : 'failed',
          })
          .where(eq(notificationChannels.id, channel.id))
      );
    } catch (persistError) {
      console.error('[Channels] Failed to persist test outcome', { channelId: channel.id, persistError });
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
