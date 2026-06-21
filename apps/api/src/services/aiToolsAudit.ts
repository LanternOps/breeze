/**
 * AI Audit Tools
 *
 * Tools for querying audit and change logs.
 * - query_audit_log (Tier 1): Search the audit log for recent actions
 * - query_change_log (Tier 1): Search device configuration changes
 */

import { db } from '../db';
import { devices, auditLogs, deviceChangeLog } from '../db/schema';
import { eq, ne, or, and, not, isNull, desc, sql, gte, lte, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  resolveSiteAllowedDeviceIds,
  resolveSiteDevicePartition,
  SITE_SCOPE_EMPTY_NOTE,
} from './aiToolsSiteScope';

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
  // Site axis: deny devices outside the caller's site allowlist (no-op when unrestricted).
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) {
    return { error: 'Device not found or access denied' };
  }
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

      // Site axis (app-layer only; RLS does NOT enforce it). audit_logs is
      // org-keyed and heterogeneous — `resourceId` is a device id only when
      // `resourceType === 'device'`; other rows reference orgs/users/tickets/etc.
      // The site axis is device-centric, so:
      //   (1) narrow device-typed rows (resourceId IS the device id) to the
      //       caller's allowed device set (R3b), and
      //   (2) narrow NON-device rows that still REFERENCE a device id inside the
      //       `details` jsonb — overwhelmingly under `details.deviceId` (the
      //       dominant write convention: commands, elevation/PAM, backup,
      //       network/authenticator changes; `details.linkedDeviceId` for
      //       discovery linking). This excludes rows referencing an
      //       OUT-of-scope fleet device (R3b residual).
      // Both narrowings leave rows with no device reference governed by the org
      // axis only, and are a no-op for unrestricted partner/system callers.
      //
      // Known residual (documented, not closed here): array-valued `details.deviceIds`
      // (sparse) and free-text device hostnames in `resourceName` carry no reliable
      // single device id to key off, so those references are left to the org axis.
      if (auth.allowedSiteIds && auth.canAccessSite) {
        const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
        // One device scan yields both partitions: `allowed` (in-scope, for the
        // device-typed narrowing) and `forbidden` (out-of-site-scope org
        // devices). We key the `details` narrowing off `forbidden` (rather than
        // "any id not in allowed") so an id under `details.deviceId` that is NOT
        // a fleet device at all — e.g. an authenticator credential id — is never
        // mistaken for an out-of-scope device and over-excluded.
        const partition = orgId ? await resolveSiteDevicePartition(orgId, auth) : { allowed: [], forbidden: [] };
        if (partition !== null) {
          const allowedDeviceIds = partition.allowed;
          const forbiddenDeviceIds = partition.forbidden;
          // An explicit device-row lookup outside the allowed set is denied outright.
          if (
            input.resourceType === 'device' &&
            input.resourceId &&
            !allowedDeviceIds.includes(input.resourceId as string)
          ) {
            return JSON.stringify({ entries: [], showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
          }
          // An explicit lookup of a device id known to be out-of-scope is denied
          // outright (mirrors the device-typed short-circuit above).
          if (input.resourceId && forbiddenDeviceIds.includes(input.resourceId as string)) {
            return JSON.stringify({ entries: [], showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
          }
          // (1) Device-typed rows: only for in-scope devices.
          // Empty allowed set ⇒ exclude all device rows.
          conditions.push(
            allowedDeviceIds.length > 0
              ? or(
                  ne(auditLogs.resourceType, 'device'),
                  inArray(auditLogs.resourceId, allowedDeviceIds),
                )!
              : ne(auditLogs.resourceType, 'device'),
          );
          // (2) `details`-referenced rows: exclude any row whose
          // `details.deviceId` / `details.linkedDeviceId` is a known out-of-scope
          // fleet device. Rows where the key is absent (NULL ->> result) are
          // untouched — only a positive match against the forbidden set excludes.
          if (forbiddenDeviceIds.length > 0) {
            const deviceIdRef = sql`${auditLogs.details}->>'deviceId'`;
            const linkedDeviceIdRef = sql`${auditLogs.details}->>'linkedDeviceId'`;
            conditions.push(
              and(
                or(isNull(deviceIdRef), not(inArray(deviceIdRef, forbiddenDeviceIds)))!,
                or(isNull(linkedDeviceIdRef), not(inArray(linkedDeviceIdRef, forbiddenDeviceIds)))!,
              )!,
            );
          }
        }
      }

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
    deviceArgs: ['deviceId'],
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
      } else if (auth.allowedSiteIds && auth.canAccessSite) {
        // Site axis (app-layer only; RLS does NOT enforce it). deviceChangeLog is
        // device-keyed; when no deviceId is supplied, a site-restricted caller may
        // only see changes for devices in their allowed sites. Narrow both the rows
        // and count queries (they share `whereClause`). No-op for unrestricted callers.
        const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
        if (!orgId) {
          return JSON.stringify({ changes: [], total: 0, showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
        }
        const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);
        if (!allowed || allowed.length === 0) {
          return JSON.stringify({ changes: [], total: 0, showing: 0, scopeNote: SITE_SCOPE_EMPTY_NOTE });
        }
        conditions.push(inArray(deviceChangeLog.deviceId, allowed));
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
