/**
 * AI Huntress Tools
 *
 * Tools for querying Huntress integration health, incidents, and triggering manual syncs.
 * - get_huntress_status (Tier 1): Integration health, agent coverage, incident summary
 * - get_huntress_incidents (Tier 1): Query incidents with filters
 * - sync_huntress_data (Tier 2): Trigger manual Huntress sync
 */

import { db } from '../db';
import {
  devices,
  huntressIntegrations,
  huntressAgents,
  huntressIncidents,
} from '../db/schema';
import { eq, and, desc, sql, ilike, inArray, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import type { AiTool } from './aiTools';
import { resolveWritableToolOrgId } from './aiTools';
import { scheduleHuntressSync } from '../jobs/huntressSync';
import { offlineStatusSqlList, resolvedStatusSqlList } from './huntressConstants';

type AiToolTier = 1 | 2 | 3 | 4;

export function registerHuntressTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_huntress_status - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_huntress_status',
      description: 'Get Huntress integration health, agent coverage, and incident summary metrics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional organization UUID filter' },
          integrationId: { type: 'string', description: 'Optional Huntress integration UUID filter' },
        }
      }
    },
    handler: async (input, auth) => {
      const RESULT_LIMIT = 50;
      const requestedOrgId = typeof input.orgId === 'string' ? input.orgId : undefined;
      if (requestedOrgId && !auth.canAccessOrg(requestedOrgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }

      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(huntressIntegrations.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (requestedOrgId) conditions.push(eq(huntressIntegrations.orgId, requestedOrgId));
      if (typeof input.integrationId === 'string') conditions.push(eq(huntressIntegrations.id, input.integrationId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const integrations = await db
        .select({
          id: huntressIntegrations.id,
          orgId: huntressIntegrations.orgId,
          name: huntressIntegrations.name,
          isActive: huntressIntegrations.isActive,
          lastSyncAt: huntressIntegrations.lastSyncAt,
          lastSyncStatus: huntressIntegrations.lastSyncStatus,
          lastSyncError: huntressIntegrations.lastSyncError,
        })
        .from(huntressIntegrations)
        .where(where)
        .orderBy(desc(huntressIntegrations.createdAt))
        .limit(RESULT_LIMIT);

      if (integrations.length === 0) {
        return JSON.stringify({
          integrations: [],
          summary: {
            totalIntegrations: 0,
            totalAgents: 0,
            mappedAgents: 0,
            unmappedAgents: 0,
            offlineAgents: 0,
            openIncidents: 0,
          },
          pagination: {
            limit: RESULT_LIMIT,
            returned: 0,
            total: 0,
            truncated: false,
          },
        });
      }

      const integrationIds = integrations.map((integration) => integration.id);
      const [[integrationCount], [summaryAgentCounts], [summaryIncidentCounts], agentCounts, incidentCounts, severityCounts] = await Promise.all([
        db
          .select({
            count: sql<number>`count(*)::int`,
          })
          .from(huntressIntegrations)
          .where(where),
        db
          .select({
            totalAgents: sql<number>`count(*)::int`,
            mappedAgents: sql<number>`coalesce(sum(case when ${huntressAgents.deviceId} is not null then 1 else 0 end), 0)::int`,
            offlineAgents: sql<number>`coalesce(sum(case when coalesce(lower(${huntressAgents.status}), '') in (${sql.raw(offlineStatusSqlList())}) then 1 else 0 end), 0)::int`,
          })
          .from(huntressAgents)
          .innerJoin(huntressIntegrations, eq(huntressAgents.integrationId, huntressIntegrations.id))
          .where(where),
        db
          .select({
            openIncidents: sql<number>`coalesce(sum(case when coalesce(lower(${huntressIncidents.status}), '') not in (${sql.raw(resolvedStatusSqlList())}) then 1 else 0 end), 0)::int`,
          })
          .from(huntressIncidents)
          .innerJoin(huntressIntegrations, eq(huntressIncidents.integrationId, huntressIntegrations.id))
          .where(where),
        db
          .select({
            integrationId: huntressAgents.integrationId,
            totalAgents: sql<number>`count(*)::int`,
            mappedAgents: sql<number>`coalesce(sum(case when ${huntressAgents.deviceId} is not null then 1 else 0 end), 0)::int`,
            offlineAgents: sql<number>`coalesce(sum(case when coalesce(lower(${huntressAgents.status}), '') in (${sql.raw(offlineStatusSqlList())}) then 1 else 0 end), 0)::int`,
          })
          .from(huntressAgents)
          .where(inArray(huntressAgents.integrationId, integrationIds))
          .groupBy(huntressAgents.integrationId),
        db
          .select({
            integrationId: huntressIncidents.integrationId,
            openIncidents: sql<number>`coalesce(sum(case when coalesce(lower(${huntressIncidents.status}), '') not in (${sql.raw(resolvedStatusSqlList())}) then 1 else 0 end), 0)::int`,
          })
          .from(huntressIncidents)
          .where(inArray(huntressIncidents.integrationId, integrationIds))
          .groupBy(huntressIncidents.integrationId),
        db
          .select({
            integrationId: huntressIncidents.integrationId,
            severity: huntressIncidents.severity,
            count: sql<number>`count(*)::int`,
          })
          .from(huntressIncidents)
          .where(inArray(huntressIncidents.integrationId, integrationIds))
          .groupBy(huntressIncidents.integrationId, huntressIncidents.severity),
      ]);

      const agentCountByIntegration = new Map(agentCounts.map((row) => [row.integrationId, row]));
      const incidentCountByIntegration = new Map(incidentCounts.map((row) => [row.integrationId, row]));
      const severityByIntegration = new Map<string, Array<{ severity: string | null; count: number }>>();
      for (const row of severityCounts) {
        const existing = severityByIntegration.get(row.integrationId) ?? [];
        existing.push({ severity: row.severity, count: Number(row.count ?? 0) });
        severityByIntegration.set(row.integrationId, existing);
      }

      const totalIntegrations = Number(integrationCount?.count ?? 0);
      const totalAgents = Number(summaryAgentCounts?.totalAgents ?? 0);
      const mappedAgents = Number(summaryAgentCounts?.mappedAgents ?? 0);
      const offlineAgents = Number(summaryAgentCounts?.offlineAgents ?? 0);
      const openIncidents = Number(summaryIncidentCounts?.openIncidents ?? 0);

      const data = integrations.map((integration) => {
        const agentMetrics = agentCountByIntegration.get(integration.id);
        const incidentMetrics = incidentCountByIntegration.get(integration.id);
        const totalAgents = Number(agentMetrics?.totalAgents ?? 0);
        const mappedAgents = Number(agentMetrics?.mappedAgents ?? 0);
        const offlineAgents = Number(agentMetrics?.offlineAgents ?? 0);
        const openIncidents = Number(incidentMetrics?.openIncidents ?? 0);

        return {
          ...integration,
          metrics: {
            totalAgents,
            mappedAgents,
            unmappedAgents: Math.max(totalAgents - mappedAgents, 0),
            offlineAgents,
            openIncidents,
            bySeverity: severityByIntegration.get(integration.id) ?? [],
          },
        };
      });

      return JSON.stringify({
        integrations: data,
        summary: {
          totalIntegrations,
          totalAgents,
          mappedAgents,
          unmappedAgents: Math.max(totalAgents - mappedAgents, 0),
          offlineAgents,
          openIncidents,
        },
        pagination: {
          limit: RESULT_LIMIT,
          returned: data.length,
          total: totalIntegrations,
          truncated: totalIntegrations > data.length,
        },
      });
    }
  });

  // ============================================
  // get_huntress_incidents - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_huntress_incidents',
      description: 'Query Huntress incidents with filtering by status, severity, device, or integration.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional organization UUID filter' },
          integrationId: { type: 'string', description: 'Optional Huntress integration UUID filter' },
          status: { type: 'string', description: 'Optional normalized status filter' },
          severity: { type: 'string', description: 'Optional severity filter' },
          deviceId: { type: 'string', description: 'Optional device UUID filter' },
          search: { type: 'string', description: 'Optional title substring filter' },
          includeResolved: { type: 'boolean', description: 'Include resolved/closed incidents (default false)' },
          limit: { type: 'number', description: 'Maximum results (default 100, max 500)' },
          offset: { type: 'number', description: 'Offset for pagination (default 0)' },
        }
      }
    },
    handler: async (input, auth) => {
      const requestedOrgId = typeof input.orgId === 'string' ? input.orgId : undefined;
      if (requestedOrgId && !auth.canAccessOrg(requestedOrgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }

      const includeResolved = input.includeResolved === true;
      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);
      const offset = Math.max(0, Number(input.offset) || 0);

      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(huntressIncidents.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (requestedOrgId) conditions.push(eq(huntressIncidents.orgId, requestedOrgId));
      if (typeof input.integrationId === 'string') conditions.push(eq(huntressIncidents.integrationId, input.integrationId));
      if (typeof input.status === 'string') conditions.push(eq(huntressIncidents.status, input.status));
      if (typeof input.severity === 'string') conditions.push(eq(huntressIncidents.severity, input.severity));
      if (typeof input.deviceId === 'string') conditions.push(eq(huntressIncidents.deviceId, input.deviceId));
      if (typeof input.search === 'string' && input.search.trim()) {
        const searchPattern = '%' + escapeLike(input.search.trim()) + '%';
        conditions.push(ilike(huntressIncidents.title, searchPattern));
      }
      if (!includeResolved) {
        conditions.push(sql`coalesce(lower(${huntressIncidents.status}), '') not in (${sql.raw(resolvedStatusSqlList())})`);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: huntressIncidents.id,
            orgId: huntressIncidents.orgId,
            integrationId: huntressIncidents.integrationId,
            deviceId: huntressIncidents.deviceId,
            huntressIncidentId: huntressIncidents.huntressIncidentId,
            severity: huntressIncidents.severity,
            category: huntressIncidents.category,
            title: huntressIncidents.title,
            description: huntressIncidents.description,
            recommendation: huntressIncidents.recommendation,
            status: huntressIncidents.status,
            reportedAt: huntressIncidents.reportedAt,
            resolvedAt: huntressIncidents.resolvedAt,
            details: huntressIncidents.details,
            createdAt: huntressIncidents.createdAt,
            updatedAt: huntressIncidents.updatedAt,
            deviceHostname: devices.hostname,
          })
          .from(huntressIncidents)
          .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
          .where(where)
          .orderBy(desc(huntressIncidents.reportedAt), desc(huntressIncidents.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressIncidents)
          .where(where),
      ]);

      return JSON.stringify({
        incidents: rows,
        total: Number(countRow?.count ?? 0),
        limit,
        offset,
        includeResolved,
      });
    }
  });

  // ============================================
  // sync_huntress_data - Tier 2 (admin utility)
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'sync_huntress_data',
      description: 'Trigger a manual Huntress sync for an accessible integration.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional organization UUID to resolve the integration' },
          integrationId: { type: 'string', description: 'Optional integration UUID. If omitted, the org integration is used.' },
        }
      }
    },
    handler: async (input, auth) => {
      const requestedOrgId = typeof input.orgId === 'string' ? input.orgId : undefined;
      const requestedIntegrationId = typeof input.integrationId === 'string' ? input.integrationId : undefined;

      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(huntressIntegrations.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (requestedOrgId) {
        if (!auth.canAccessOrg(requestedOrgId)) {
          return JSON.stringify({ error: 'Access denied to this organization' });
        }
        conditions.push(eq(huntressIntegrations.orgId, requestedOrgId));
      } else if (!requestedIntegrationId) {
        const resolved = resolveWritableToolOrgId(auth);
        if (resolved.error) return JSON.stringify({ error: resolved.error });
        if (resolved.orgId) conditions.push(eq(huntressIntegrations.orgId, resolved.orgId));
      }
      if (requestedIntegrationId) conditions.push(eq(huntressIntegrations.id, requestedIntegrationId));

      const [integration] = await db
        .select({
          id: huntressIntegrations.id,
          orgId: huntressIntegrations.orgId,
          name: huntressIntegrations.name,
          isActive: huntressIntegrations.isActive,
        })
        .from(huntressIntegrations)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .limit(1);

      if (!integration) {
        return JSON.stringify({ error: 'Huntress integration not found or access denied' });
      }
      if (!integration.isActive) {
        return JSON.stringify({ error: 'Huntress integration is inactive' });
      }

      const jobId = await scheduleHuntressSync(integration.id);
      return JSON.stringify({
        queued: true,
        jobId,
        integrationId: integration.id,
        orgId: integration.orgId,
        name: integration.name,
      });
    }
  });
}
