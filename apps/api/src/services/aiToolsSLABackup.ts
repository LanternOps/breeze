/**
 * AI Backup SLA Tools
 *
 * 4 backup SLA tools for listing configured SLA policies, reviewing breach
 * events, generating compliance summaries, and creating or updating configs.
 * Each tool wraps existing DB schema with org-scoped isolation.
 */

import { db } from '../db';
import {
  backupSlaConfigs,
  backupSlaEvents,
  devices,
  recoveryReadiness,
} from '../db/schema';
import {
  eq,
  and,
  desc,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  SQL,
} from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type SlaHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof eq> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: SlaHandler): SlaHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[sla:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

function clampLimit(value: unknown, fallback = 25, max = 100): number {
  return Math.min(Math.max(1, Number(value) || fallback), max);
}

// ============================================
// Register all SLA tools into the aiTools Map
// ============================================

export function registerSLABackupTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_backup_sla — List SLA configs
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_backup_sla',
      description: 'List backup SLA configurations with active breach counts and compliance state.',
      input_schema: {
        type: 'object' as const,
        properties: {
          isActive: { type: 'boolean', description: 'Filter active or inactive SLA configs' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('query_backup_sla', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, backupSlaConfigs.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.isActive === 'boolean') conditions.push(eq(backupSlaConfigs.isActive, input.isActive));

      const limit = clampLimit(input.limit);
      const configs = await db
        .select()
        .from(backupSlaConfigs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(backupSlaConfigs.createdAt))
        .limit(limit);

      if (configs.length === 0) {
        return JSON.stringify({ configs: [], showing: 0 });
      }

      const breachConditions: SQL[] = [isNull(backupSlaEvents.resolvedAt), inArray(backupSlaEvents.slaConfigId, configs.map((config) => config.id))];
      const bc = orgWhere(auth, backupSlaEvents.orgId);
      if (bc) breachConditions.push(bc);

      const breachCounts = await db
        .select({
          slaConfigId: backupSlaEvents.slaConfigId,
          count: sql<number>`count(*)::int`,
        })
        .from(backupSlaEvents)
        .where(and(...breachConditions))
        .groupBy(backupSlaEvents.slaConfigId);

      const breachMap = new Map(breachCounts.map((entry) => [entry.slaConfigId, entry.count]));
      const rows = configs.map((config) => {
        const activeBreaches = breachMap.get(config.id) ?? 0;
        return {
          ...config,
          complianceStatus: activeBreaches > 0 ? 'breach' : 'compliant',
          activeBreaches,
          targetDeviceCount: Array.isArray(config.targetDevices) ? config.targetDevices.length : 0,
          targetGroupCount: Array.isArray(config.targetGroups) ? config.targetGroups.length : 0,
        };
      });

      return JSON.stringify({ configs: rows, showing: rows.length });
    }),
  });

  // ============================================
  // 2. get_sla_breaches — List breach events
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_sla_breaches',
      description: 'List backup SLA breach events with optional filters for config, device, event type, and timeframe.',
      input_schema: {
        type: 'object' as const,
        properties: {
          configId: { type: 'string', description: 'Filter to a specific SLA config UUID' },
          deviceId: { type: 'string', description: 'Filter to a specific device UUID' },
          eventType: { type: 'string', description: 'Filter by breach event type' },
          unresolvedOnly: { type: 'boolean', description: 'Only show unresolved breach events' },
          from: { type: 'string', description: 'Filter events detected at or after this ISO datetime' },
          to: { type: 'string', description: 'Filter events detected at or before this ISO datetime' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_sla_breaches', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, backupSlaEvents.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.configId === 'string') conditions.push(eq(backupSlaEvents.slaConfigId, input.configId));
      if (typeof input.deviceId === 'string') conditions.push(eq(backupSlaEvents.deviceId, input.deviceId));
      if (typeof input.eventType === 'string') conditions.push(eq(backupSlaEvents.eventType, input.eventType));
      if (input.unresolvedOnly === true) conditions.push(isNull(backupSlaEvents.resolvedAt));

      if (typeof input.from === 'string') {
        const from = new Date(input.from);
        if (!Number.isNaN(from.getTime())) conditions.push(gte(backupSlaEvents.detectedAt, from));
      }
      if (typeof input.to === 'string') {
        const to = new Date(input.to);
        if (!Number.isNaN(to.getTime())) conditions.push(lte(backupSlaEvents.detectedAt, to));
      }

      const limit = clampLimit(input.limit);
      const breaches = await db
        .select({
          id: backupSlaEvents.id,
          slaConfigId: backupSlaEvents.slaConfigId,
          slaName: backupSlaConfigs.name,
          deviceId: backupSlaEvents.deviceId,
          hostname: devices.hostname,
          eventType: backupSlaEvents.eventType,
          details: backupSlaEvents.details,
          detectedAt: backupSlaEvents.detectedAt,
          resolvedAt: backupSlaEvents.resolvedAt,
        })
        .from(backupSlaEvents)
        .leftJoin(backupSlaConfigs, eq(backupSlaEvents.slaConfigId, backupSlaConfigs.id))
        .leftJoin(devices, eq(backupSlaEvents.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(backupSlaEvents.detectedAt))
        .limit(limit);

      return JSON.stringify({ breaches, showing: breaches.length });
    }),
  });

  // ============================================
  // 3. get_sla_compliance_report — Compliance summary
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_sla_compliance_report',
      description: 'Get a backup SLA compliance summary for the accessible organization scope.',
      input_schema: {
        type: 'object' as const,
        properties: {
          daysBack: { type: 'number', description: 'Reporting window in days for historical events (default 30)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_sla_compliance_report', async (input, auth) => {
      const daysBack = Math.min(Math.max(1, Number(input.daysBack) || 30), 365);
      const windowStart = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      const configConditions: SQL[] = [eq(backupSlaConfigs.isActive, true)];
      const cc = orgWhere(auth, backupSlaConfigs.orgId);
      if (cc) configConditions.push(cc);

      const activeEventConditions: SQL[] = [isNull(backupSlaEvents.resolvedAt)];
      const aec = orgWhere(auth, backupSlaEvents.orgId);
      if (aec) activeEventConditions.push(aec);

      const historyConditions: SQL[] = [gte(backupSlaEvents.detectedAt, windowStart)];
      const hc = orgWhere(auth, backupSlaEvents.orgId);
      if (hc) historyConditions.push(hc);

      const readinessConditions: SQL[] = [];
      const rc = orgWhere(auth, recoveryReadiness.orgId);
      if (rc) readinessConditions.push(rc);

      const [activeConfigs, activeBreaches, totalEvents, readiness, configsWithBreaches] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(backupSlaConfigs)
          .where(and(...configConditions))
          .then((rows) => rows[0]?.count ?? 0),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(backupSlaEvents)
          .where(and(...activeEventConditions))
          .then((rows) => rows[0]?.count ?? 0),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(backupSlaEvents)
          .where(and(...historyConditions))
          .then((rows) => rows[0]?.count ?? 0),
        db
          .select({
            avgRpo: sql<number>`coalesce(avg(${recoveryReadiness.estimatedRpoMinutes}), 0)::int`,
            avgRto: sql<number>`coalesce(avg(${recoveryReadiness.estimatedRtoMinutes}), 0)::int`,
          })
          .from(recoveryReadiness)
          .where(readinessConditions.length > 0 ? and(...readinessConditions) : undefined)
          .then((rows) => rows[0] ?? { avgRpo: 0, avgRto: 0 }),
        db
          .select({ count: sql<number>`count(distinct ${backupSlaEvents.slaConfigId})::int` })
          .from(backupSlaEvents)
          .where(and(...activeEventConditions))
          .then((rows) => rows[0]?.count ?? 0),
      ]);

      const compliantConfigs = Math.max(0, activeConfigs - configsWithBreaches);
      const compliancePercent = activeConfigs > 0
        ? Math.round((compliantConfigs / activeConfigs) * 100)
        : 100;

      return JSON.stringify({
        reportWindowDays: daysBack,
        activeConfigs,
        compliantConfigs,
        activeBreaches,
        configsWithBreaches,
        compliancePercent,
        totalEventsInWindow: totalEvents,
        avgEstimatedRpoMinutes: readiness.avgRpo,
        avgEstimatedRtoMinutes: readiness.avgRto,
      });
    }),
  });

  // ============================================
  // 4. configure_backup_sla — Create or update SLA config
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'configure_backup_sla',
      description: 'Create or update a backup SLA configuration.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update'],
            description: 'The SLA configuration action to perform',
          },
          configId: { type: 'string', description: 'SLA config UUID for updates' },
          name: { type: 'string', description: 'SLA config name' },
          rpoTargetMinutes: { type: 'number', description: 'Recovery point objective target in minutes' },
          rtoTargetMinutes: { type: 'number', description: 'Recovery time objective target in minutes' },
          targetDevices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device UUIDs in scope for the SLA',
          },
          targetGroups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Group UUIDs in scope for the SLA',
          },
          alertOnBreach: { type: 'boolean', description: 'Whether to alert when a breach is detected' },
          isActive: { type: 'boolean', description: 'Whether the SLA config is active' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('configure_backup_sla', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create') {
        const orgId = getOrgId(auth);
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          return JSON.stringify({ error: 'name is required for create' });
        }
        if (input.rpoTargetMinutes === undefined || input.rtoTargetMinutes === undefined) {
          return JSON.stringify({ error: 'rpoTargetMinutes and rtoTargetMinutes are required for create' });
        }

        const now = new Date();
        const [config] = await db
          .insert(backupSlaConfigs)
          .values({
            orgId,
            name: input.name.trim(),
            rpoTargetMinutes: Number(input.rpoTargetMinutes),
            rtoTargetMinutes: Number(input.rtoTargetMinutes),
            targetDevices: Array.isArray(input.targetDevices) ? input.targetDevices : [],
            targetGroups: Array.isArray(input.targetGroups) ? input.targetGroups : [],
            alertOnBreach: typeof input.alertOnBreach === 'boolean' ? input.alertOnBreach : true,
            isActive: typeof input.isActive === 'boolean' ? input.isActive : true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return JSON.stringify({ success: true, config });
      }

      if (action === 'update') {
        const configId = input.configId as string;
        if (!configId) return JSON.stringify({ error: 'configId is required for update' });

        const configConditions: SQL[] = [eq(backupSlaConfigs.id, configId)];
        const cc = orgWhere(auth, backupSlaConfigs.orgId);
        if (cc) configConditions.push(cc);
        const [existing] = await db
          .select({ id: backupSlaConfigs.id })
          .from(backupSlaConfigs)
          .where(and(...configConditions))
          .limit(1);

        if (!existing) return JSON.stringify({ error: 'SLA config not found or access denied' });

        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updateData.name = input.name.trim();
        if (input.rpoTargetMinutes !== undefined) updateData.rpoTargetMinutes = Number(input.rpoTargetMinutes);
        if (input.rtoTargetMinutes !== undefined) updateData.rtoTargetMinutes = Number(input.rtoTargetMinutes);
        if (Array.isArray(input.targetDevices)) updateData.targetDevices = input.targetDevices;
        if (Array.isArray(input.targetGroups)) updateData.targetGroups = input.targetGroups;
        if (typeof input.alertOnBreach === 'boolean') updateData.alertOnBreach = input.alertOnBreach;
        if (typeof input.isActive === 'boolean') updateData.isActive = input.isActive;

        const [config] = await db
          .update(backupSlaConfigs)
          .set(updateData)
          .where(eq(backupSlaConfigs.id, configId))
          .returning();

        return JSON.stringify({ success: true, config });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
