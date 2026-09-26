/**
 * AI User Risk Tools
 *
 * Tools for fleet health reliability scores and user risk scoring.
 * - get_fleet_health (Tier 1): Query device reliability scores across the fleet
 * - get_user_risk_scores (Tier 1): Return ranked user risk scores
 * - get_user_risk_detail (Tier 1): Fetch a single user risk profile
 * - assign_security_training (Tier 2): Assign security awareness training
 */

import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { listReliabilityDevices, summarizeReliabilityDevices, type ReliabilityListItem } from './reliabilityScoring';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  assignSecurityTraining,
  getUserRiskDetail,
  getUserRiskOrgMembership,
  listUserRiskScores
} from './userRiskScoring';
import { sanitizeThrownToolError } from './aiToolErrors';
import { filterToDeviceScope, runFrozenDeviceIds } from './aiToolsSiteScope';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';

type AiToolTier = 1 | 2 | 3 | 4;

// #6745 (A-W05 follow-up): the largest page of realistic reliability rows that
// fits the chat budget uncompacted (aiToolsUserRisk.outputShape.test.ts).
const FLEET_HEALTH_DEFAULT_LIMIT = 15;
const FLEET_HEALTH_MAX_LIMIT = 100;

/** topIssues (a jsonb list per device) is opt-in; its size is always reported. */
function shapeReliabilityRow(row: ReliabilityListItem, includeTopIssues: boolean): Record<string, unknown> {
  const { topIssues, drivers: _drivers, enrolledAt: _enrolledAt, ...rest } = row;
  return {
    ...rest,
    topIssueCount: Array.isArray(topIssues) ? topIssues.length : 0,
    ...(includeTopIssues ? { topIssues } : {}),
  };
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
    domain: 'devices',
    searchHint: 'fleet device reliability, uptime, crashes, hangs, hardware and service failures',
    definition: {
      name: 'get_fleet_health',
      description: 'Query device reliability scores across the fleet. Returns devices ranked by reliability (worst first) with uptime, crash history, and failure metrics; the summary covers every matching device, not just the page. Per-device topIssues are opt-in (includeTopIssues).',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
          siteId: { type: 'string', description: 'Optional site UUID' },
          scoreRange: { type: 'string', enum: ['critical', 'poor', 'fair', 'good'], description: 'Score range filter' },
          trendDirection: { type: 'string', enum: ['improving', 'stable', 'degrading'], description: 'Trend direction filter' },
          issueType: { type: 'string', enum: ['crashes', 'hangs', 'hardware', 'services', 'uptime'], description: 'Issue-type filter' },
          includeTopIssues: { type: 'boolean', description: 'Include each device\'s topIssues list (default false; topIssueCount is always returned)' },
          ...pageParamSchema(FLEET_HEALTH_DEFAULT_LIMIT, FLEET_HEALTH_MAX_LIMIT),
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

        const requestedSiteId = typeof input.siteId === 'string' ? input.siteId : undefined;
        if (requestedSiteId && auth.allowedSiteIds && auth.canAccessSite && !auth.canAccessSite(requestedSiteId)) {
          return JSON.stringify({ error: 'Access denied to this site' });
        }
        const siteIds = !requestedSiteId && auth.allowedSiteIds && auth.canAccessSite
          ? auth.allowedSiteIds
          : undefined;

        const page = readPageArgs('get_fleet_health', input, { defaultLimit: FLEET_HEALTH_DEFAULT_LIMIT, maxLimit: FLEET_HEALTH_MAX_LIMIT });
        if (!page.ok) return JSON.stringify({ error: page.error, code: page.code });
        const scoreRange = (typeof input.scoreRange === 'string' && ['critical', 'poor', 'fair', 'good'].includes(input.scoreRange))
          ? input.scoreRange as 'critical' | 'poor' | 'fair' | 'good'
          : undefined;
        const trendDirection = (typeof input.trendDirection === 'string' && ['improving', 'stable', 'degrading'].includes(input.trendDirection))
          ? input.trendDirection as 'improving' | 'stable' | 'degrading'
          : undefined;
        const issueType = (typeof input.issueType === 'string' && ['crashes', 'hangs', 'hardware', 'services', 'uptime'].includes(input.issueType))
          ? input.issueType as 'crashes' | 'hangs' | 'hardware' | 'services' | 'uptime'
          : undefined;

        // Exact-device axis: pushed INTO the query (#6745), so `total`, the
        // summary and the page are all computed over the caller's own device
        // set. Before, the page was fetched fleet-wide and narrowed after the
        // LIMIT, which made paging impossible and the counts page-sized. The
        // site axis is NOT a substitute — a device-less analysis run carries
        // `allowedDeviceIds` with no `allowedSiteIds` (#6086 finding 8).
        const frozenDeviceIds = runFrozenDeviceIds(auth) ?? undefined;
        const filter = {
          orgIds,
          siteId: requestedSiteId,
          siteIds,
          scoreRange,
          trendDirection,
          issueType,
          deviceIds: frozenDeviceIds,
        };
        const [{ total, rows: fleetRows }, summary] = await Promise.all([
          listReliabilityDevices({ ...filter, limit: page.limit, offset: page.offset }),
          summarizeReliabilityDevices(filter),
        ]);

        // Defense in depth: the SQL filter above already narrows; never let a
        // sibling row through even if it did not.
        const rows = frozenDeviceIds
          ? filterToDeviceScope(auth, fleetRows, (row) => row.deviceId)
          : fleetRows;

        const { total: _summaryTotal, ...summaryCounts } = summary;
        return JSON.stringify({
          ...pageEnvelope({
            key: 'devices',
            items: rows.map((row) => shapeReliabilityRow(row, input.includeTopIssues === true)),
            limit: page.limit,
            offset: page.offset,
            fingerprint: page.fingerprint,
            total,
          }),
          summary: summaryCounts,
        });
      } catch (err) {
        const message = sanitizeThrownToolError('user-risk', err);
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
    domain: 'security',
    searchHint: 'user risk rankings, score factors and trends across organizations',
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

      const requestedSiteId = typeof input.siteId === 'string' ? input.siteId : undefined;
      if (requestedSiteId && auth.allowedSiteIds && auth.canAccessSite && !auth.canAccessSite(requestedSiteId)) {
        return JSON.stringify({ error: 'Access denied to this site' });
      }
      const siteIds = !requestedSiteId && auth.allowedSiteIds && auth.canAccessSite
        ? auth.allowedSiteIds
        : undefined;

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 200);
      const result = await listUserRiskScores({
        orgIds,
        siteId: requestedSiteId,
        siteIds,
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
    domain: 'security',
    searchHint: 'user risk profile, score factors, trend history and risk events',
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

      // A read: never answered from the device-page write default (#6675).
      const resolved = resolveWritableToolOrgId(
        auth,
        typeof input.orgId === 'string' ? input.orgId : undefined,
        { useWriteDefault: false },
      );
      if (resolved.error || !resolved.orgId) {
        return JSON.stringify({ error: resolved.error ?? 'orgId is required for this operation' });
      }

      const detail = await getUserRiskDetail(resolved.orgId, input.userId, auth.allowedSiteIds);
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
    domain: 'security',
    searchHint: 'security awareness training assignments for a user',
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
      // This tool performs the same mutation the HTTP route gates behind
      // requireMfa(); Tier 2 means it auto-executes, so the MFA and site-ceiling
      // proofs have to be re-established here or the AI/MCP path is a bypass.
      // Checked before input validation, matching the HTTP route's ordering.
      if (!hasSatisfiedMfa(auth)) {
        return JSON.stringify({ error: 'MFA required' });
      }

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

      const isMember = await getUserRiskOrgMembership(input.userId, resolved.orgId, auth.allowedSiteIds);
      if (!isMember) {
        return JSON.stringify({ error: 'User not found in this organization' });
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
          error: sanitizeThrownToolError('user-risk', error)
        });
      }
    }
  });
}
