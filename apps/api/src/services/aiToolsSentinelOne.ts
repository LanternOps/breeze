/**
 * AI SentinelOne Tools
 *
 * Tools for querying SentinelOne integration status, threats, and executing
 * isolation/threat actions.
 * - get_s1_status (Tier 1): EDR coverage and action backlog
 * - get_s1_threats (Tier 1): Query threats with filters
 * - s1_isolate_device (Tier 3): Isolate/unisolate devices
 * - s1_threat_action (Tier 3): Execute threat actions (kill, quarantine, rollback)
 */

import { db } from '../db';
import {
  devices,
  s1Agents,
  s1Threats,
  s1Actions,
} from '../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess, resolveWritableToolOrgId } from './aiTools';
import {
  executeS1IsolationForOrg,
  executeS1ThreatActionForOrg,
  getActiveS1IntegrationForOrg,
} from './sentinelOne/actions';
import { isThreatAction } from '../jobs/s1Sync';

type AiToolTier = 1 | 2 | 3 | 4;

export function registerSentinelOneTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_s1_status - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_s1_status',
      description: 'Get SentinelOne integration health, EDR coverage, and action backlog for an organization.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID for partner/system scope' }
        }
      }
    },
    handler: async (input, auth) => {
      const orgResolution = resolveWritableToolOrgId(auth, input.orgId as string | undefined);
      if (orgResolution.error || !orgResolution.orgId) {
        return JSON.stringify({ error: orgResolution.error ?? 'orgId is required' });
      }
      const orgId = orgResolution.orgId;

      const integration = await getActiveS1IntegrationForOrg(orgId);
      if (!integration) {
        return JSON.stringify({
          configured: false,
          orgId: orgResolution.orgId,
          message: 'No active SentinelOne integration found for this organization'
        });
      }

      const agentConditions: SQL[] = [eq(s1Agents.integrationId, integration.id)];
      const agentOrgCond = auth.orgCondition(s1Agents.orgId);
      if (agentOrgCond) agentConditions.push(agentOrgCond);

      const threatConditions: SQL[] = [eq(s1Threats.integrationId, integration.id)];
      const threatOrgCond = auth.orgCondition(s1Threats.orgId);
      if (threatOrgCond) threatConditions.push(threatOrgCond);

      const actionConditions: SQL[] = [eq(s1Actions.orgId, integration.orgId)];
      const actionOrgCond = auth.orgCondition(s1Actions.orgId);
      if (actionOrgCond) actionConditions.push(actionOrgCond);

      const [agentSummary, threatSummary, actionSummary, recentActions] = await Promise.all([
        db
          .select({
            totalAgents: sql<number>`count(*)::int`,
            mappedDevices: sql<number>`count(*) filter (where ${s1Agents.deviceId} is not null)::int`,
            infectedAgents: sql<number>`count(*) filter (where coalesce(${s1Agents.infected}, false) = true)::int`,
            reportedThreatCount: sql<number>`coalesce(sum(${s1Agents.threatCount}), 0)::int`
          })
          .from(s1Agents)
          .where(and(...agentConditions)),
        db
          .select({
            activeThreats: sql<number>`count(*) filter (where ${s1Threats.status} in ('active', 'in_progress'))::int`,
            highOrCriticalThreats: sql<number>`count(*) filter (where ${s1Threats.severity} in ('high', 'critical'))::int`
          })
          .from(s1Threats)
          .where(and(...threatConditions)),
        db
          .select({
            pendingActions: sql<number>`count(*) filter (where ${s1Actions.status} in ('queued', 'in_progress'))::int`,
            completedActions: sql<number>`count(*) filter (where ${s1Actions.status} = 'completed')::int`,
            failedActions: sql<number>`count(*) filter (where ${s1Actions.status} = 'failed')::int`
          })
          .from(s1Actions)
          .where(and(...actionConditions)),
        db
          .select({
            id: s1Actions.id,
            action: s1Actions.action,
            status: s1Actions.status,
            requestedAt: s1Actions.requestedAt,
            completedAt: s1Actions.completedAt,
            providerActionId: s1Actions.providerActionId
          })
          .from(s1Actions)
          .where(and(...actionConditions))
          .orderBy(desc(s1Actions.requestedAt))
          .limit(10)
      ]);

      return JSON.stringify({
        configured: true,
        integration,
        summary: {
          totalAgents: Number(agentSummary[0]?.totalAgents ?? 0),
          mappedDevices: Number(agentSummary[0]?.mappedDevices ?? 0),
          infectedAgents: Number(agentSummary[0]?.infectedAgents ?? 0),
          reportedThreatCount: Number(agentSummary[0]?.reportedThreatCount ?? 0),
          activeThreats: Number(threatSummary[0]?.activeThreats ?? 0),
          highOrCriticalThreats: Number(threatSummary[0]?.highOrCriticalThreats ?? 0),
          pendingActions: Number(actionSummary[0]?.pendingActions ?? 0),
          completedActions: Number(actionSummary[0]?.completedActions ?? 0),
          failedActions: Number(actionSummary[0]?.failedActions ?? 0)
        },
        recentActions
      });
    }
  });

  // ============================================
  // get_s1_threats - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_s1_threats',
      description: 'Query SentinelOne threats with filters for severity, status, device, and free-text search.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID for partner/system scope' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'unknown'] },
          status: { type: 'string', enum: ['active', 'in_progress', 'quarantined', 'resolved'] },
          deviceId: { type: 'string', description: 'Optional Breeze device UUID' },
          search: { type: 'string', description: 'Search threat name, process name, or file path' },
          limit: { type: 'number', description: 'Result limit (default 100, max 500)' }
        }
      }
    },
    handler: async (input, auth) => {
      const orgResolution = resolveWritableToolOrgId(auth, input.orgId as string | undefined);
      if (orgResolution.error || !orgResolution.orgId) {
        return JSON.stringify({ error: orgResolution.error ?? 'orgId is required' });
      }
      const orgId = orgResolution.orgId;

      const integration = await getActiveS1IntegrationForOrg(orgId);
      if (!integration) {
        return JSON.stringify({
          configured: false,
          orgId: orgResolution.orgId,
          threats: [],
          total: 0
        });
      }

      const conditions: SQL[] = [
        eq(s1Threats.orgId, orgResolution.orgId),
        eq(s1Threats.integrationId, integration.id)
      ];
      const threatOrgCond = auth.orgCondition(s1Threats.orgId);
      if (threatOrgCond) conditions.push(threatOrgCond);

      if (typeof input.severity === 'string' && input.severity.length > 0) {
        conditions.push(eq(s1Threats.severity, input.severity));
      }
      if (typeof input.status === 'string' && input.status.length > 0) {
        conditions.push(eq(s1Threats.status, input.status));
      }
      if (typeof input.deviceId === 'string' && input.deviceId.length > 0) {
        conditions.push(eq(s1Threats.deviceId, input.deviceId));
      }
      if (typeof input.search === 'string' && input.search.trim().length > 0) {
        const pattern = `%${escapeLike(input.search.trim())}%`;
        conditions.push(
          sql`(
            ${s1Threats.threatName} ilike ${pattern}
            or ${s1Threats.processName} ilike ${pattern}
            or ${s1Threats.filePath} ilike ${pattern}
          )`
        );
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);
      const where = and(...conditions);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: s1Threats.id,
            s1ThreatId: s1Threats.s1ThreatId,
            threatName: s1Threats.threatName,
            classification: s1Threats.classification,
            severity: s1Threats.severity,
            status: s1Threats.status,
            deviceId: s1Threats.deviceId,
            deviceName: devices.hostname,
            processName: s1Threats.processName,
            filePath: s1Threats.filePath,
            detectedAt: s1Threats.detectedAt,
            resolvedAt: s1Threats.resolvedAt,
            mitreTactics: s1Threats.mitreTactics
          })
          .from(s1Threats)
          .leftJoin(devices, eq(s1Threats.deviceId, devices.id))
          .where(where)
          .orderBy(desc(s1Threats.detectedAt), desc(s1Threats.updatedAt))
          .limit(limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(s1Threats)
          .where(where)
      ]);

      return JSON.stringify({
        configured: true,
        integrationId: integration.id,
        total: Number(totalRows[0]?.count ?? 0),
        threats: rows
      });
    }
  });

  // ============================================
  // s1_isolate_device - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 's1_isolate_device',
      description: 'Isolate or unisolate one or more devices via SentinelOne. This is a high-risk containment action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID for partner/system scope' },
          deviceId: { type: 'string', description: 'Single device UUID' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'One or more device UUIDs' },
          isolate: { type: 'boolean', description: 'true=isolate (default), false=unisolate' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const orgResolution = resolveWritableToolOrgId(auth, input.orgId as string | undefined);
      if (orgResolution.error || !orgResolution.orgId) {
        return JSON.stringify({ error: orgResolution.error ?? 'orgId is required' });
      }
      if (!hasSatisfiedMfa(auth)) {
        return JSON.stringify({ error: 'MFA required' });
      }
      const orgId = orgResolution.orgId;

      const integration = await getActiveS1IntegrationForOrg(orgId);
      if (!integration) {
        return JSON.stringify({ error: 'No active SentinelOne integration found for this organization' });
      }

      const requestedDeviceIds = [
        ...(typeof input.deviceId === 'string' ? [input.deviceId] : []),
        ...(Array.isArray(input.deviceIds) ? input.deviceIds.filter((value): value is string => typeof value === 'string') : [])
      ];
      if (requestedDeviceIds.length === 0) {
        return JSON.stringify({ error: 'deviceId or deviceIds is required' });
      }
      const isolate = input.isolate !== false;
      const result = await executeS1IsolationForOrg({
        orgId,
        integrationId: integration.id,
        requestedBy: auth.user.id,
        deviceIds: requestedDeviceIds,
        isolate
      });
      if (!result.ok) {
        return JSON.stringify({ error: result.error, details: result.details });
      }

      if (result.status === 502) {
        return JSON.stringify({
          success: false,
          error: result.data.warning ?? 'SentinelOne action dispatch failed',
          ...result.data
        });
      }

      return JSON.stringify({ success: true, action: isolate ? 'isolate' : 'unisolate', ...result.data });
    }
  });

  // ============================================
  // s1_threat_action - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 's1_threat_action',
      description: 'Execute a SentinelOne threat action (kill, quarantine, rollback). This is a high-risk action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID for partner/system scope' },
          action: { type: 'string', enum: ['kill', 'quarantine', 'rollback'] },
          threatIds: { type: 'array', items: { type: 'string' }, description: 'Threat IDs (Breeze UUIDs or SentinelOne IDs)' }
        },
        required: ['action', 'threatIds']
      }
    },
    handler: async (input, auth) => {
      const orgResolution = resolveWritableToolOrgId(auth, input.orgId as string | undefined);
      if (orgResolution.error || !orgResolution.orgId) {
        return JSON.stringify({ error: orgResolution.error ?? 'orgId is required' });
      }
      if (!hasSatisfiedMfa(auth)) {
        return JSON.stringify({ error: 'MFA required' });
      }
      const orgId = orgResolution.orgId;

      const integration = await getActiveS1IntegrationForOrg(orgId);
      if (!integration) {
        return JSON.stringify({ error: 'No active SentinelOne integration found for this organization' });
      }

      const action = typeof input.action === 'string' ? input.action : '';
      if (!isThreatAction(action)) {
        return JSON.stringify({ error: 'action must be one of: kill, quarantine, rollback' });
      }

      const threatIds = Array.isArray(input.threatIds)
        ? input.threatIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      if (threatIds.length === 0) {
        return JSON.stringify({ error: 'threatIds must contain at least one ID' });
      }
      const result = await executeS1ThreatActionForOrg({
        orgId,
        integrationId: integration.id,
        requestedBy: auth.user.id,
        action,
        threatIds
      });
      if (!result.ok) {
        return JSON.stringify({ error: result.error, details: result.details });
      }

      if (result.status === 502) {
        return JSON.stringify({
          success: false,
          error: result.data.warning ?? 'SentinelOne action dispatch failed',
          ...result.data
        });
      }

      return JSON.stringify({ success: true, ...result.data });
    }
  });
}
