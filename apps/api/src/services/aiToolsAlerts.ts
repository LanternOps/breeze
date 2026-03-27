/**
 * AI Alert Tools
 *
 * Tools for managing alerts and notification channels.
 * - manage_alerts (Tier 1 base): Query, view, acknowledge, resolve, or suppress alerts
 * - manage_notification_channels (Tier 1 base): List, test, create, update, or delete notification channels
 */

import { db } from '../db';
import { alerts, devices, notificationChannels } from '../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent } from './eventBus';

type AiToolTier = 1 | 2 | 3 | 4;

async function findAlertWithAccess(alertId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(alerts.id, alertId)];
  const orgCond = auth.orgCondition(alerts.orgId);
  if (orgCond) conditions.push(orgCond);
  const [alert] = await db.select().from(alerts).where(and(...conditions)).limit(1);
  return alert || null;
}

export function registerAlertTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // manage_alerts - Tier 1 (list/get), Tier 2 (acknowledge/resolve/suppress)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier, // Base tier; acknowledge/resolve/suppress checked at runtime in guardrails
    definition: {
      name: 'manage_alerts',
      description: 'Query, view, acknowledge, resolve, or suppress alerts. Use action "list" to search alerts, "get" for details, "acknowledge" to mark as seen, "resolve" to close, or "suppress" to temporarily silence an alert.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'acknowledge', 'resolve', 'suppress'], description: 'The action to perform' },
          alertId: { type: 'string', description: 'Alert UUID (required for get/acknowledge/resolve/suppress)' },
          status: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed'], description: 'Filter by status (for list)' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Filter by severity (for list)' },
          deviceId: { type: 'string', description: 'Filter by device UUID (for list)' },
          limit: { type: 'number', description: 'Max results (for list, default 25)' },
          resolutionNote: { type: 'string', description: 'Note when resolving or suppressing an alert' },
          suppressDuration: { type: 'number', description: 'Hours to suppress the alert (default: 24, max: 720)' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as string;

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCondition = auth.orgCondition(alerts.orgId);
        if (orgCondition) conditions.push(orgCondition);
        if (input.status) conditions.push(eq(alerts.status, input.status as typeof alerts.status.enumValues[number]));
        if (input.severity) conditions.push(eq(alerts.severity, input.severity as typeof alerts.severity.enumValues[number]));
        if (input.deviceId) conditions.push(eq(alerts.deviceId, input.deviceId as string));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

        const results = await db
          .select({
            id: alerts.id,
            status: alerts.status,
            severity: alerts.severity,
            title: alerts.title,
            message: alerts.message,
            deviceId: alerts.deviceId,
            triggeredAt: alerts.triggeredAt,
            acknowledgedAt: alerts.acknowledgedAt,
            resolvedAt: alerts.resolvedAt,
            suppressedUntil: alerts.suppressedUntil
          })
          .from(alerts)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(alerts.triggeredAt))
          .limit(limit);

        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(alerts)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        return JSON.stringify({ alerts: results, total: Number(countResult[0]?.count ?? 0), showing: results.length });
      }

      if (action === 'get') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required for get action' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        // Get device info
        const [device] = await db
          .select({ hostname: devices.hostname, osType: devices.osType, status: devices.status })
          .from(devices)
          .where(eq(devices.id, alert.deviceId))
          .limit(1);

        return JSON.stringify({ alert, device });
      }

      if (action === 'acknowledge') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        await db
          .update(alerts)
          .set({
            status: 'acknowledged',
            acknowledgedAt: new Date(),
            acknowledgedBy: auth.user.id
          })
          .where(eq(alerts.id, input.alertId as string));

        let eventWarning: string | undefined;
        try {
          await publishEvent(
            'alert.acknowledged',
            alert.orgId,
            {
              alertId: alert.id,
              ruleId: alert.ruleId,
              deviceId: alert.deviceId,
              acknowledgedBy: auth.user.id
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish alert.acknowledged event:', error);
          eventWarning = 'Alert was acknowledged but event notification may be delayed';
        }

        return JSON.stringify({ success: true, message: `Alert "${alert.title}" acknowledged`, warning: eventWarning });
      }

      if (action === 'resolve') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        await db
          .update(alerts)
          .set({
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: auth.user.id,
            resolutionNote: (input.resolutionNote as string) ?? 'Resolved via AI assistant'
          })
          .where(eq(alerts.id, input.alertId as string));

        let resolveEventWarning: string | undefined;
        try {
          await publishEvent(
            'alert.resolved',
            alert.orgId,
            {
              alertId: alert.id,
              ruleId: alert.ruleId,
              deviceId: alert.deviceId,
              resolvedBy: auth.user.id,
              resolutionNote: (input.resolutionNote as string) ?? 'Resolved via AI assistant'
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish alert.resolved event:', error);
          resolveEventWarning = 'Alert was resolved but event notification may be delayed';
        }

        return JSON.stringify({ success: true, message: `Alert "${alert.title}" resolved`, warning: resolveEventWarning });
      }

      if (action === 'suppress') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        const durationHours = Math.min(Math.max(1, Number(input.suppressDuration) || 24), 720);
        const suppressedUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);

        await db
          .update(alerts)
          .set({
            status: 'suppressed',
            suppressedUntil,
            resolutionNote: (input.resolutionNote as string) ?? `Suppressed for ${durationHours}h via AI assistant`
          })
          .where(eq(alerts.id, input.alertId as string));

        let suppressEventWarning: string | undefined;
        try {
          await publishEvent(
            'alert.suppressed',
            alert.orgId,
            {
              alertId: alert.id,
              ruleId: alert.ruleId,
              deviceId: alert.deviceId,
              suppressedBy: auth.user.id,
              suppressedUntil: suppressedUntil.toISOString(),
              durationHours
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish alert.suppressed event:', error);
          suppressEventWarning = 'Alert was suppressed but event notification may be delayed';
        }

        return JSON.stringify({
          success: true,
          message: `Alert "${alert.title}" suppressed until ${suppressedUntil.toISOString()}`,
          suppressedUntil: suppressedUntil.toISOString(),
          durationHours,
          warning: suppressEventWarning
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });

  // ============================================
  // manage_notification_channels - Tier 1 base with action escalation
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'manage_notification_channels',
      description: 'Manage notification channels for alert delivery. List channels, test connectivity, or create/update/delete channels. Channel types: email, slack, teams, webhook, pagerduty, sms.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'test', 'create', 'update', 'delete'],
            description: 'The action to perform',
          },
          channelId: {
            type: 'string',
            description: 'Channel UUID (required for test/update/delete)',
          },
          name: {
            type: 'string',
            description: 'Channel name (required for create)',
          },
          type: {
            type: 'string',
            enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'],
            description: 'Channel type (required for create, filter for list)',
          },
          config: {
            type: 'object',
            description: 'Channel-specific config. email: { recipients: ["a@b.com"] }. slack: { webhookUrl: "https://..." }. teams: { webhookUrl: "https://..." }. webhook: { url: "https://...", headers?: {} }. pagerduty: { routingKey: "..." }. sms: { phoneNumbers: ["+1..."] }',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether channel is active (default: true)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 25, max 50)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const action = input.action as string;

      if (action === 'list') {
        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 50);

        const conditions: SQL[] = [];
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) conditions.push(orgCond);

        if (input.type) {
          conditions.push(eq(notificationChannels.type, input.type as typeof notificationChannels.type.enumValues[number]));
        }

        const channels = await db
          .select({
            id: notificationChannels.id,
            name: notificationChannels.name,
            type: notificationChannels.type,
            enabled: notificationChannels.enabled,
            createdAt: notificationChannels.createdAt,
          })
          .from(notificationChannels)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(notificationChannels.createdAt))
          .limit(limit);

        return JSON.stringify({ channels, total: channels.length });
      }

      if (action === 'test') {
        if (!input.channelId) {
          return JSON.stringify({ error: 'channelId is required for test action' });
        }

        const channelId = input.channelId as string;

        // Verify channel exists and belongs to org
        const conditions: SQL[] = [eq(notificationChannels.id, channelId)];
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) conditions.push(orgCond);

        const [channel] = await db
          .select({
            id: notificationChannels.id,
            name: notificationChannels.name,
            type: notificationChannels.type,
            enabled: notificationChannels.enabled,
          })
          .from(notificationChannels)
          .where(and(...conditions))
          .limit(1);

        if (!channel) {
          return JSON.stringify({ error: 'Notification channel not found or access denied' });
        }

        // Return channel details for testing (actual delivery is handled by the notification service)
        return JSON.stringify({
          success: true,
          message: `Channel "${channel.name}" (${channel.type}) verified — use the notification API to send a test message`,
          channel: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            enabled: channel.enabled,
          },
        });
      }

      if (action === 'create') {
        const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0];
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.type) return JSON.stringify({ error: 'type is required (email, slack, teams, webhook, pagerduty, sms)' });
        if (!input.config) return JSON.stringify({ error: 'config is required (channel-specific settings)' });

        try {
          const [channel] = await db.insert(notificationChannels).values({
            orgId,
            name: input.name as string,
            type: input.type as typeof notificationChannels.type.enumValues[number],
            config: input.config as Record<string, unknown>,
            enabled: input.enabled !== false,
          }).returning();
          if (!channel) return JSON.stringify({ error: 'Failed to create notification channel' });

          return JSON.stringify({ success: true, channelId: channel.id, name: channel.name, type: channel.type });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return JSON.stringify({ error: `Failed to create channel: ${message}` });
        }
      }

      if (action === 'update') {
        if (!input.channelId) return JSON.stringify({ error: 'channelId is required for update' });

        const conditions: SQL[] = [eq(notificationChannels.id, input.channelId as string)];
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) conditions.push(orgCond);

        const [existing] = await db.select().from(notificationChannels).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Notification channel not found or access denied' });

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.type === 'string') updates.type = input.type;
        if (input.config) updates.config = input.config;
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, existing.id));
        return JSON.stringify({ success: true, message: `Channel "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.channelId) return JSON.stringify({ error: 'channelId is required for delete' });

        const conditions: SQL[] = [eq(notificationChannels.id, input.channelId as string)];
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) conditions.push(orgCond);

        const [existing] = await db.select({ id: notificationChannels.id, name: notificationChannels.name }).from(notificationChannels).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Notification channel not found or access denied' });

        await db.delete(notificationChannels).where(eq(notificationChannels.id, existing.id));
        return JSON.stringify({ success: true, message: `Channel "${existing.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });
}
