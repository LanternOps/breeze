/**
 * AI Alert Tools
 *
 * Tools for managing alerts and notification channels.
 * - manage_alerts (Tier 1 base): Query, view, acknowledge, resolve, or suppress alerts
 * - manage_notification_channels (Tier 1 base): List, test, create, update, or delete notification channels
 */

import { db } from '../db';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { alerts, devices, notificationChannels } from '../db/schema';
import { eq, and, desc, sql, inArray, ne, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent } from './eventBus';
import { deviceIdSiteDenied, resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import { emitAlertStateFeedback } from './mlFeedbackEmitters';
import {
  encryptNotificationChannelConfig,
  decryptNotificationChannelConfig,
} from './notificationChannelSecrets';
import { validateNotificationChannelConfig } from '../routes/alerts/helpers';
import { sanitizeThrownToolError } from './aiToolErrors';

type AiToolTier = 1 | 2 | 3 | 4;

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

// Resolve an alert within org scope AND enforce the site axis (app-layer only;
// RLS does NOT enforce site): the alert's device must be in a site the caller
// can access. Returns null when not found or site-denied.
async function findAlertWithAccess(alertId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(alerts.id, alertId)];
  const orgCond = auth.orgCondition(alerts.orgId);
  if (orgCond) conditions.push(orgCond);
  const [alert] = await db.select().from(alerts).where(and(...conditions)).limit(1);
  if (!alert) return null;
  if (alert.deviceId && (await deviceIdSiteDenied(auth, alert.deviceId))) return null;
  return alert;
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
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_alerts',
      description: 'Query, view, acknowledge, resolve, or suppress alerts. Use action "list" to search alerts, "get" for details, "acknowledge" to mark as seen, "resolve" to close, or "suppress" to temporarily silence an alert.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'acknowledge', 'resolve', 'suppress'], description: 'The action to perform' },
          alertId: { type: 'string', description: 'Alert UUID (required for get/acknowledge/resolve/suppress)' },
          status: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed'], description: 'Filter by status (for list)' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Filter by severity (for list)' },
          deviceId: { type: 'string', description: 'Filter by device UUID (for list)' },
          limit: { type: 'number', description: 'Max results (for list, default 25)' },
          resolutionNote: { type: 'string', description: 'Note when resolving or suppressing an alert' },
          suppressDuration: { type: 'number', description: 'Hours to suppress the alert (default: 24, max: 720). Use 0 to suppress forever (indefinitely).' }
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
        if (input.status) {
          conditions.push(eq(alerts.status, input.status as typeof alerts.status.enumValues[number]));
        } else {
          // Dismissed alerts are permanently closed — hidden unless asked for by name.
          conditions.push(ne(alerts.status, 'dismissed'));
        }
        if (input.severity) conditions.push(eq(alerts.severity, input.severity as typeof alerts.severity.enumValues[number]));
        if (input.deviceId) conditions.push(eq(alerts.deviceId, input.deviceId as string));

        // Site axis: a site-restricted caller may only see alerts for devices in
        // their allowed sites (RLS does NOT enforce site). Narrow to that set.
        const listOrgId = getOrgId(auth);
        if (auth.allowedSiteIds && listOrgId) {
          const allowed = await resolveSiteAllowedDeviceIds(listOrgId, auth);
          if (!allowed || allowed.length === 0) {
            return JSON.stringify({ alerts: [], total: 0, showing: 0 });
          }
          if (input.deviceId && !allowed.includes(input.deviceId as string)) {
            return JSON.stringify({ alerts: [], total: 0, showing: 0 });
          }
          conditions.push(inArray(alerts.deviceId, allowed));
        }

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

        // Mirror POST /alerts/:id/acknowledge: only an active alert can be acked
        // (in particular, never pull a resolved/dismissed alert back to acknowledged).
        if (alert.status !== 'active') {
          return JSON.stringify({ error: `Cannot acknowledge alert with status: ${alert.status}` });
        }

        const acknowledgedAt = new Date();
        await db
          .update(alerts)
          .set({
            status: 'acknowledged',
            acknowledgedAt,
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

        await emitAlertStateFeedback({
          orgId: alert.orgId,
          alertId: alert.id,
          eventType: 'alert.acknowledged',
          outcome: 'acknowledged',
          actorUserId: auth.user.id,
          occurredAt: acknowledgedAt,
          metadata: {
            source: 'ai_tools.manage_alerts',
            previousStatus: alert.status,
          },
        });

        return JSON.stringify({ success: true, message: `Alert "${alert.title}" acknowledged`, warning: eventWarning });
      }

      if (action === 'resolve') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        // Mirror POST /alerts/:id/resolve: already-resolved is a no-op error and
        // dismissed is terminal (resolving it would let synthetic evaluators
        // re-create the alert the user permanently dismissed).
        if (alert.status === 'resolved') {
          return JSON.stringify({ error: 'Alert is already resolved' });
        }
        if (alert.status === 'dismissed') {
          return JSON.stringify({ error: 'Cannot resolve a dismissed alert' });
        }

        const resolvedAt = new Date();
        const resolutionNote = (input.resolutionNote as string) ?? 'Resolved via AI assistant';
        await db
          .update(alerts)
          .set({
            status: 'resolved',
            resolvedAt,
            resolvedBy: auth.user.id,
            resolutionNote
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
              resolutionNote
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish alert.resolved event:', error);
          resolveEventWarning = 'Alert was resolved but event notification may be delayed';
        }

        await emitAlertStateFeedback({
          orgId: alert.orgId,
          alertId: alert.id,
          eventType: 'alert.resolved',
          outcome: 'resolved',
          actorUserId: auth.user.id,
          occurredAt: resolvedAt,
          metadata: {
            source: 'ai_tools.manage_alerts',
            previousStatus: alert.status,
            hasResolutionNote: Boolean(input.resolutionNote),
          },
        });

        return JSON.stringify({ success: true, message: `Alert "${alert.title}" resolved`, warning: resolveEventWarning });
      }

      if (action === 'suppress') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required' });

        const alert = await findAlertWithAccess(input.alertId as string, auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });

        // Mirror the REST endpoints (POST /alerts/:id/suppress): a resolved or
        // dismissed alert has nothing to silence, so refuse rather than silently
        // re-open it (dismissed is terminal).
        if (alert.status === 'resolved' || alert.status === 'dismissed') {
          return JSON.stringify({ error: `Cannot suppress a ${alert.status} alert` });
        }

        // suppressDuration: 0 => indefinite ("Forever") suppression, leaving
        // suppressedUntil null (mirrors POST /alerts/:id/suppress with no `until`).
        const forever = Number(input.suppressDuration) === 0;
        const durationHours = forever
          ? null
          : Math.min(Math.max(1, Number(input.suppressDuration) || 24), 720);
        const suppressedUntil = durationHours === null
          ? null
          : new Date(Date.now() + durationHours * 60 * 60 * 1000);
        const occurredAt = new Date();
        const resolutionNote = (input.resolutionNote as string)
          ?? (forever ? 'Suppressed indefinitely via AI assistant' : `Suppressed for ${durationHours}h via AI assistant`);

        await db
          .update(alerts)
          .set({
            status: 'suppressed',
            suppressedUntil,
            resolutionNote
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
              suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
              durationHours
            },
            'ai-tools',
            { userId: auth.user.id }
          );
        } catch (error) {
          console.error('[AiTools] Failed to publish alert.suppressed event:', error);
          suppressEventWarning = 'Alert was suppressed but event notification may be delayed';
        }

        await emitAlertStateFeedback({
          orgId: alert.orgId,
          alertId: alert.id,
          eventType: 'alert.suppressed',
          dedupeKey: `suppress:${suppressedUntil ? suppressedUntil.toISOString() : 'forever'}`,
          outcome: 'suppressed',
          actorUserId: auth.user.id,
          occurredAt,
          metadata: {
            source: 'ai_tools.manage_alerts',
            previousStatus: alert.status,
            suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
            durationHours,
          },
        });

        return JSON.stringify({
          success: true,
          message: suppressedUntil
            ? `Alert "${alert.title}" suppressed until ${suppressedUntil.toISOString()}`
            : `Alert "${alert.title}" suppressed indefinitely (Forever)`,
          suppressedUntil: suppressedUntil ? suppressedUntil.toISOString() : null,
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
        // Dual-axis (#2130): org-owned channels the caller can reach OR
        // partner-wide channels (org_id NULL) owned by the caller's partner.
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) {
          conditions.push(
            auth.scope === 'partner' && auth.partnerId
              ? sql`(${orgCond} OR (${notificationChannels.orgId} IS NULL AND ${notificationChannels.partnerId} = ${auth.partnerId}))`
              : orgCond
          );
        }

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

        const channelType = input.type as typeof notificationChannels.type.enumValues[number];
        const configErrors = validateNotificationChannelConfig(channelType, input.config);
        if (configErrors.length > 0) {
          return JSON.stringify({ error: `Invalid ${channelType} channel configuration`, details: configErrors });
        }

        try {
          const [channel] = await db.insert(notificationChannels).values({
            orgId,
            name: input.name as string,
            type: channelType,
            config: encryptNotificationChannelConfig(channelType, input.config) as Record<string, unknown>,
            enabled: input.enabled !== false,
          }).returning();
          if (!channel) return JSON.stringify({ error: 'Failed to create notification channel' });

          return JSON.stringify({ success: true, channelId: channel.id, name: channel.name, type: channel.type });
        } catch (err: unknown) {
          const message = sanitizeThrownToolError('alerts', err);
          return JSON.stringify({ error: `Failed to create channel: ${message}` });
        }
      }

      if (action === 'update') {
        if (!input.channelId) return JSON.stringify({ error: 'channelId is required for update' });

        const conditions: SQL[] = [eq(notificationChannels.id, input.channelId as string)];
        // Dual-axis (#2130) — see the list action.
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) {
          conditions.push(
            auth.scope === 'partner' && auth.partnerId
              ? sql`(${orgCond} OR (${notificationChannels.orgId} IS NULL AND ${notificationChannels.partnerId} = ${auth.partnerId}))`
              : orgCond
          );
        }

        const [existing] = await db.select().from(notificationChannels).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Notification channel not found or access denied' });

        // Partner-wide channels are administrable only with the partner-wide
        // capability (same gate as the HTTP route, #2130).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide notification channel requires full partner org access (orgAccess must be "all")' });
        }

        // Channel type is immutable after creation: the config crypto + validation
        // below all run under `existing.type`, so allowing a type change here would
        // encrypt/validate the config for the OLD type and persist it under the NEW
        // type — a wrong-key/wrong-schema row. Mirror the HTTP route, which does not
        // allow type changes: reject rather than silently corrupt.
        if (typeof input.type === 'string' && input.type !== existing.type) {
          return JSON.stringify({ error: 'Channel type cannot be changed after creation; create a new channel instead' });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.config !== undefined && input.config !== null) {
          // Mirror the HTTP PUT route: merge incoming config with the existing
          // encrypted config (preserving masked/preserved secret fields), then
          // decrypt to validate the resolved config, then re-encrypt for storage.
          const mergedEncrypted = encryptNotificationChannelConfig(existing.type, input.config, existing.config);
          const configForValidation = decryptNotificationChannelConfig(existing.type, mergedEncrypted);
          const configErrors = validateNotificationChannelConfig(existing.type, configForValidation);
          if (configErrors.length > 0) {
            return JSON.stringify({ error: `Invalid ${existing.type} channel configuration`, details: configErrors });
          }
          updates.config = mergedEncrypted;
        }
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, existing.id));
        return JSON.stringify({ success: true, message: `Channel "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.channelId) return JSON.stringify({ error: 'channelId is required for delete' });

        const conditions: SQL[] = [eq(notificationChannels.id, input.channelId as string)];
        // Dual-axis (#2130) — see the list action.
        const orgCond = auth.orgCondition(notificationChannels.orgId);
        if (orgCond) {
          conditions.push(
            auth.scope === 'partner' && auth.partnerId
              ? sql`(${orgCond} OR (${notificationChannels.orgId} IS NULL AND ${notificationChannels.partnerId} = ${auth.partnerId}))`
              : orgCond
          );
        }

        const [existing] = await db.select({ id: notificationChannels.id, name: notificationChannels.name, orgId: notificationChannels.orgId }).from(notificationChannels).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Notification channel not found or access denied' });

        // Partner-wide channels are administrable only with the partner-wide
        // capability (same gate as the HTTP route, #2130).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide notification channel requires full partner org access (orgAccess must be "all")' });
        }

        await db.delete(notificationChannels).where(eq(notificationChannels.id, existing.id));
        return JSON.stringify({ success: true, message: `Channel "${existing.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });
}
