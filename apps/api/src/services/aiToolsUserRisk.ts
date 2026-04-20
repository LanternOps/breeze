/**
 * AI User Risk Tools
 *
 * Tools for fleet health reliability scores and user risk scoring.
 * - get_fleet_health (Tier 1): Query device reliability scores across the fleet
 * - get_user_risk_scores (Tier 1): Return ranked user risk scores
 * - get_user_risk_detail (Tier 1): Fetch a single user risk profile
 * - assign_security_training (Tier 2): Assign security awareness training
 */

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { listReliabilityDevices } from './reliabilityScoring';
import { assignSecurityTraining, getUserRiskDetail, listUserRiskScores } from './userRiskScoring';

type AiToolTier = 1 | 2 | 3 | 4;

function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

export function registerUserRiskTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_fleet_health - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'get_fleet_health',
      description: 'Query device reliability scores across the fleet. Returns devices ranked by reliability (worst first) with uptime, crash history, and failure metrics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
          siteId: { type: 'string', description: 'Optional site UUID' },
          scoreRange: { type: 'string', enum: ['critical', 'poor', 'fair', 'good'], description: 'Score range filter' },
          trendDirection: { type: 'string', enum: ['improving', 'stable', 'degrading'], description: 'Trend direction filter' },
          issueType: { type: 'string', enum: ['crashes', 'hangs', 'hardware', 'services', 'uptime'], description: 'Issue-type filter' },
          limit: { type: 'number', description: 'Maximum results (default 25, max 100)' },
        }
      }
    },
    handler: async (input, auth) => {
      try {
        if (typeof input.orgId === 'string' && input.orgId && !auth.canAccessOrg(input.orgId)) {
          return JSON.stringify({ error: 'Access denied to this organization' });
        }

        const orgIds = typeof input.orgId === 'string' && input.orgId
          ? [input.orgId]
          : auth.orgId
            ? [auth.orgId]
            : (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0 ? auth.accessibleOrgIds : undefined);

        if (!orgIds && auth.scope !== 'system') {
          return JSON.stringify({ error: 'Organization context required' });
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const scoreRange = (typeof input.scoreRange === 'string' && ['critical', 'poor', 'fair', 'good'].includes(input.scoreRange))
          ? input.scoreRange as 'critical' | 'poor' | 'fair' | 'good'
          : undefined;
        const trendDirection = (typeof input.trendDirection === 'string' && ['improving', 'stable', 'degrading'].includes(input.trendDirection))
          ? input.trendDirection as 'improving' | 'stable' | 'degrading'
          : undefined;
        const issueType = (typeof input.issueType === 'string' && ['crashes', 'hangs', 'hardware', 'services', 'uptime'].includes(input.issueType))
          ? input.issueType as 'crashes' | 'hangs' | 'hardware' | 'services' | 'uptime'
          : undefined;

        const { total, rows } = await listReliabilityDevices({
          orgIds,
          siteId: typeof input.siteId === 'string' ? input.siteId : undefined,
          scoreRange,
          trendDirection,
          issueType,
          limit,
          offset: 0,
        });

        const avgScore = rows.length > 0
          ? Math.round(rows.reduce((sum, row) => sum + row.reliabilityScore, 0) / rows.length)
          : 0;

        return JSON.stringify({
          devices: rows,
          total,
          summary: {
            averageScore: avgScore,
            criticalDevices: rows.filter((row) => row.reliabilityScore <= 50).length,
            poorDevices: rows.filter((row) => row.reliabilityScore >= 51 && row.reliabilityScore <= 70).length,
            fairDevices: rows.filter((row) => row.reliabilityScore >= 71 && row.reliabilityScore <= 85).length,
            goodDevices: rows.filter((row) => row.reliabilityScore >= 86).length,
            degradingDevices: rows.filter((row) => row.trendDirection === 'degrading').length,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        console.error('[fleet:get_fleet_health]', message, err);
        return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
      }
    }
  });

  // ============================================
  // get_user_risk_scores - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'get_user_risk_scores',
      description: 'Return ranked user risk scores with factor breakdowns and trend direction for accessible organizations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
          siteId: { type: 'string', description: 'Optional site UUID filter' },
          minScore: { type: 'number', description: 'Minimum score filter (0-100)' },
          maxScore: { type: 'number', description: 'Maximum score filter (0-100)' },
          trendDirection: { type: 'string', enum: ['up', 'down', 'stable'], description: 'Trend filter' },
          search: { type: 'string', description: 'Match user name/email' },
          limit: { type: 'number', description: 'Maximum rows (default 25, max 200)' }
        }
      }
    },
    handler: async (input, auth) => {
      if (typeof input.orgId === 'string' && input.orgId && !auth.canAccessOrg(input.orgId)) {
        return JSON.stringify({ error: 'Access denied to this organization' });
      }

      const orgIds = typeof input.orgId === 'string' && input.orgId
        ? [input.orgId]
        : auth.orgId
          ? [auth.orgId]
          : (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0 ? auth.accessibleOrgIds : undefined);

      if (!orgIds && auth.scope !== 'system') {
        return JSON.stringify({ error: 'Organization context required' });
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 200);
      const result = await listUserRiskScores({
        orgIds,
        siteId: typeof input.siteId === 'string' ? input.siteId : undefined,
        minScore: typeof input.minScore === 'number' ? input.minScore : undefined,
        maxScore: typeof input.maxScore === 'number' ? input.maxScore : undefined,
        trendDirection: (typeof input.trendDirection === 'string'
          && ['up', 'down', 'stable'].includes(input.trendDirection))
          ? input.trendDirection as 'up' | 'down' | 'stable'
          : undefined,
        search: typeof input.search === 'string' ? input.search : undefined,
        limit,
        offset: 0
      });

      const rows = result.rows;
      return JSON.stringify({
        total: result.total,
        users: rows,
        summary: {
          averageScore: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0,
          highRiskUsers: rows.filter((row) => row.score >= 70).length,
          criticalRiskUsers: rows.filter((row) => row.score >= 85).length
        }
      });
    }
  });

  // ============================================
  // get_user_risk_detail - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'get_user_risk_detail',
      description: 'Fetch a single user risk profile including latest score, factors, trend history, and risk-impacting events.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userId: { type: 'string', description: 'User UUID' },
          orgId: { type: 'string', description: 'Organization UUID for disambiguation' }
        },
        required: ['userId']
      }
    },
    handler: async (input, auth) => {
      if (typeof input.userId !== 'string' || !input.userId) {
        return JSON.stringify({ error: 'userId is required' });
      }

      const resolved = resolveWritableToolOrgId(
        auth,
        typeof input.orgId === 'string' ? input.orgId : undefined
      );
      if (resolved.error || !resolved.orgId) {
        return JSON.stringify({ error: resolved.error ?? 'orgId is required for this operation' });
      }

      const detail = await getUserRiskDetail(resolved.orgId, input.userId);
      if (!detail) {
        return JSON.stringify({ message: 'No user risk data available for this user' });
      }

      return JSON.stringify({ userRisk: detail });
    }
  });

  // ============================================
  // assign_security_training - Tier 2 (write)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    definition: {
      name: 'assign_security_training',
      description: 'Assign security awareness training to a user and emit auditable events.',
      input_schema: {
        type: 'object' as const,
        properties: {
          userId: { type: 'string', description: 'User UUID' },
          orgId: { type: 'string', description: 'Organization UUID (required for partner/system contexts with multiple orgs)' },
          moduleId: { type: 'string', description: 'Training module key (optional)' },
          reason: { type: 'string', description: 'Optional assignment reason' }
        },
        required: ['userId']
      }
    },
    handler: async (input, auth) => {
      if (typeof input.userId !== 'string' || !input.userId) {
        return JSON.stringify({ error: 'userId is required' });
      }

      const resolved = resolveWritableToolOrgId(
        auth,
        typeof input.orgId === 'string' ? input.orgId : undefined
      );
      if (resolved.error || !resolved.orgId) {
        return JSON.stringify({ error: resolved.error ?? 'orgId is required for this operation' });
      }

      try {
        const result = await assignSecurityTraining({
          orgId: resolved.orgId,
          userId: input.userId,
          moduleId: typeof input.moduleId === 'string' ? input.moduleId : undefined,
          reason: typeof input.reason === 'string' ? input.reason : undefined,
          assignedBy: auth.user.id
        });

        return JSON.stringify({
          success: true,
          ...result
        });
      } catch (error) {
        return JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to assign security training'
        });
      }
    }
  });
}
