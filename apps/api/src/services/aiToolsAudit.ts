/**
 * AI Audit Tools
 *
 * Tools for querying audit and change logs.
 * - query_audit_log (Tier 1): Search the audit log for recent actions
 * - query_change_log (Tier 1): Search device configuration changes
 */

import { db } from '../db';
import { devices, auditLogs, deviceChangeLog } from '../db/schema';
import { eq, and, desc, sql, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

export function registerAuditTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // query_audit_log - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'query_audit_log',
      description: 'Search the audit log for recent actions. Useful for investigating what happened on devices or who made changes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', description: 'Filter by action (e.g., "agent.command.script")' },
          resourceType: { type: 'string', description: 'Filter by resource type (e.g., "device")' },
          resourceId: { type: 'string', description: 'Filter by resource UUID' },
          actorType: { type: 'string', enum: ['user', 'api_key', 'agent', 'system'], description: 'Filter by actor type' },
          hoursBack: { type: 'number', description: 'How many hours back to search (default: 24, max: 168)' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        }
      }
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(auditLogs.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.action) conditions.push(eq(auditLogs.action, input.action as string));
      if (input.resourceType) conditions.push(eq(auditLogs.resourceType, input.resourceType as string));
      if (input.resourceId) conditions.push(eq(auditLogs.resourceId, input.resourceId as string));
      if (input.actorType) conditions.push(eq(auditLogs.actorType, input.actorType as typeof auditLogs.actorType.enumValues[number]));

      const hoursBack = Math.min(Math.max(1, Number(input.hoursBack) || 24), 168);
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      conditions.push(gte(auditLogs.timestamp, since));

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      const results = await db
        .select({
          id: auditLogs.id,
          timestamp: auditLogs.timestamp,
          actorType: auditLogs.actorType,
          actorEmail: auditLogs.actorEmail,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceName: auditLogs.resourceName,
          result: auditLogs.result,
          details: auditLogs.details
        })
        .from(auditLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(auditLogs.timestamp))
        .limit(limit);

      return JSON.stringify({ entries: results, showing: results.length });
    }
  });

  // ============================================
  // query_change_log - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'query_change_log',
      description: 'Search device configuration changes such as software installs/updates, service changes, startup drift, network changes, scheduled task changes, and user account changes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Optional device UUID to scope results to a specific device' },
          startTime: { type: 'string', description: 'Optional ISO timestamp lower bound (inclusive)' },
          endTime: { type: 'string', description: 'Optional ISO timestamp upper bound (inclusive)' },
          changeType: {
            type: 'string',
            enum: ['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account'],
            description: 'Optional change category filter'
          },
          changeAction: {
            type: 'string',
            enum: ['added', 'removed', 'modified', 'updated'],
            description: 'Optional change action filter'
          },
          limit: { type: 'number', description: 'Max results to return (default 100, max 500)' }
        }
      }
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(deviceChangeLog.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.deviceId) {
        const access = await verifyDeviceAccess(input.deviceId as string, auth);
        if ('error' in access) return JSON.stringify({ error: access.error });
        conditions.push(eq(deviceChangeLog.deviceId, input.deviceId as string));
      }

      if (input.startTime) {
        conditions.push(gte(deviceChangeLog.timestamp, new Date(input.startTime as string)));
      }

      if (input.endTime) {
        conditions.push(lte(deviceChangeLog.timestamp, new Date(input.endTime as string)));
      }

      if (input.changeType) {
        conditions.push(eq(deviceChangeLog.changeType, input.changeType as any));
      }

      if (input.changeAction) {
        conditions.push(eq(deviceChangeLog.changeAction, input.changeAction as any));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

      const [changes, countResult] = await Promise.all([
        db
          .select({
            timestamp: deviceChangeLog.timestamp,
            changeType: deviceChangeLog.changeType,
            changeAction: deviceChangeLog.changeAction,
            subject: deviceChangeLog.subject,
            beforeValue: deviceChangeLog.beforeValue,
            afterValue: deviceChangeLog.afterValue,
            details: deviceChangeLog.details,
            hostname: devices.hostname,
            deviceId: deviceChangeLog.deviceId
          })
          .from(deviceChangeLog)
          .leftJoin(devices, eq(deviceChangeLog.deviceId, devices.id))
          .where(whereClause)
          .orderBy(desc(deviceChangeLog.timestamp))
          .limit(limit),
        db
          .select({ count: sql<number>`count(*)` })
          .from(deviceChangeLog)
          .where(whereClause)
      ]);

      return JSON.stringify({
        changes,
        total: Number(countResult[0]?.count ?? 0),
        showing: changes.length,
        filters: {
          deviceId: input.deviceId ?? null,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          changeType: input.changeType ?? null,
          changeAction: input.changeAction ?? null
        }
      });
    }
  });
}
