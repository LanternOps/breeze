/**
 * AI DNS Security Tools
 *
 * Tools for querying DNS security data and managing DNS policies.
 * - get_dns_security (Tier 1): DNS security statistics, blocked domains, threat categories
 * - manage_dns_policy (Tier 2): Add/remove domains from DNS blocklist/allowlist
 */

import { db } from '../db';
import {
  devices,
  dnsSecurityEvents,
  dnsEventAggregations,
  dnsPolicies,
  dnsFilterIntegrations,
  dnsThreatCategoryEnum,
  type DnsPolicyDomain
} from '../db/schema';
import { eq, and, desc, sql, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { schedulePolicySync } from '../jobs/dnsSyncJob';

type AiToolTier = 1 | 2 | 3 | 4;

function normalizeDnsDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.length > 500) return null;
  return normalized;
}

function normalizeDnsCategory(category: unknown): string | null {
  if (typeof category !== 'string' || !category.trim()) return null;
  const normalized = category.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (dnsThreatCategoryEnum.enumValues.includes(normalized as typeof dnsThreatCategoryEnum.enumValues[number])) {
    return normalized;
  }
  if (normalized.includes('phish')) return 'phishing';
  if (normalized.includes('malware')) return 'malware';
  if (normalized.includes('bot')) return 'botnet';
  if (normalized.includes('ransom')) return 'ransomware';
  if (normalized.includes('crypto')) return 'cryptomining';
  if (normalized.includes('spam')) return 'spam';
  if (normalized.includes('adult')) return 'adult_content';
  if (normalized.includes('ad')) return 'adware';
  if (normalized.includes('gambl')) return 'gambling';
  if (normalized.includes('social')) return 'social_media';
  if (normalized.includes('stream')) return 'streaming';
  return 'unknown';
}

export function registerDnsTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // get_dns_security - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_dns_security',
      description: 'Get DNS security statistics including blocked domains, threat categories, and top offending devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          timeRange: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Start time (ISO 8601)' },
              end: { type: 'string', description: 'End time (ISO 8601)' }
            },
            required: ['start', 'end']
          },
          deviceId: { type: 'string', description: 'Filter by device ID' },
          integrationId: { type: 'string', description: 'Filter by integration ID' },
          action: { type: 'string', enum: ['allowed', 'blocked', 'redirected'], description: 'Filter by DNS action' },
          category: { type: 'string', description: 'Filter by threat category' },
          topN: { type: 'number', description: 'Number of top results to return (default 10, max 100)' }
        },
        required: ['timeRange']
      }
    },
    handler: async (input, auth) => {
      const AGGREGATION_MIN_DAYS = 7;
      const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);
      const shouldUseAggregations = (startDate: Date, endDate: Date): boolean => {
        const diffMs = endDate.getTime() - startDate.getTime();
        return diffMs > AGGREGATION_MIN_DAYS * 24 * 60 * 60 * 1000;
      };

      const timeRange = (input.timeRange ?? {}) as { start?: string; end?: string };
      const start = timeRange.start ? new Date(timeRange.start) : null;
      const end = timeRange.end ? new Date(timeRange.end) : null;

      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return JSON.stringify({ error: 'timeRange.start and timeRange.end must be valid ISO timestamps' });
      }
      if (start.getTime() > end.getTime()) {
        return JSON.stringify({ error: 'timeRange.start must be before or equal to timeRange.end' });
      }
      const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
      if ((end.getTime() - start.getTime()) > maxWindowMs) {
        return JSON.stringify({ error: 'timeRange cannot exceed 90 days' });
      }

      const conditions: SQL[] = [
        gte(dnsSecurityEvents.timestamp, start),
        lte(dnsSecurityEvents.timestamp, end)
      ];
      const orgCondition = auth.orgCondition(dnsSecurityEvents.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.deviceId) conditions.push(eq(dnsSecurityEvents.deviceId, input.deviceId as string));
      if (input.integrationId) conditions.push(eq(dnsSecurityEvents.integrationId, input.integrationId as string));
      if (input.action) conditions.push(eq(dnsSecurityEvents.action, input.action as typeof dnsSecurityEvents.action.enumValues[number]));
      const normalizedCategory = input.category ? normalizeDnsCategory(input.category) : null;
      if (normalizedCategory) {
        conditions.push(eq(dnsSecurityEvents.category, normalizedCategory as typeof dnsSecurityEvents.category.enumValues[number]));
      }

      const topN = Math.min(Math.max(1, Number(input.topN) || 10), 100);
      const where = and(...conditions);

      if (shouldUseAggregations(start, end)) {
        const aggConditions: SQL[] = [
          gte(dnsEventAggregations.date, toDateKey(start)),
          lte(dnsEventAggregations.date, toDateKey(end))
        ];
        const aggOrgCondition = auth.orgCondition(dnsEventAggregations.orgId);
        if (aggOrgCondition) aggConditions.push(aggOrgCondition);
        if (input.deviceId) aggConditions.push(eq(dnsEventAggregations.deviceId, input.deviceId as string));
        if (input.integrationId) aggConditions.push(eq(dnsEventAggregations.integrationId, input.integrationId as string));
        if (normalizedCategory) {
          aggConditions.push(
            eq(dnsEventAggregations.category, normalizedCategory as typeof dnsEventAggregations.category.enumValues[number])
          );
        }

        const aggWhere = and(...aggConditions);
        const [aggCountRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(dnsEventAggregations)
          .where(aggWhere);

        if (Number(aggCountRow?.count ?? 0) > 0) {
          const topCategoryCountExpr: SQL<number> = input.action === 'blocked'
            ? sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
            : input.action === 'allowed'
              ? sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
              : input.action === 'redirected'
                ? sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries} - ${dnsEventAggregations.blockedQueries} - ${dnsEventAggregations.allowedQueries}), 0)::int`
                : sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`;

          const [rawSummary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
            db
              .select({
                totalQueries: sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`,
                blockedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`,
                allowedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
              })
              .from(dnsEventAggregations)
              .where(aggWhere),
            input.action && input.action !== 'blocked'
              ? Promise.resolve([])
              : db
                .select({
                  domain: dnsEventAggregations.domain,
                  category: dnsEventAggregations.category,
                  count: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
                })
                .from(dnsEventAggregations)
                .where(and(
                  ...aggConditions,
                  sql`${dnsEventAggregations.blockedQueries} > 0`,
                  sql`${dnsEventAggregations.domain} is not null`
                ))
                .groupBy(dnsEventAggregations.domain, dnsEventAggregations.category)
                .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
                .limit(topN),
            db
              .select({
                category: dnsEventAggregations.category,
                count: topCategoryCountExpr
              })
              .from(dnsEventAggregations)
              .where(and(...aggConditions, sql`${dnsEventAggregations.category} is not null`))
              .groupBy(dnsEventAggregations.category)
              .orderBy(desc(topCategoryCountExpr))
              .limit(topN),
            input.action && input.action !== 'blocked'
              ? Promise.resolve([])
              : db
                .select({
                  deviceId: dnsEventAggregations.deviceId,
                  hostname: devices.hostname,
                  blockedCount: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
                })
                .from(dnsEventAggregations)
                .leftJoin(devices, eq(dnsEventAggregations.deviceId, devices.id))
                .where(and(...aggConditions, sql`${dnsEventAggregations.blockedQueries} > 0`))
                .groupBy(dnsEventAggregations.deviceId, devices.hostname)
                .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
                .limit(topN)
          ]);

          const summaryBase = rawSummary[0] ?? {
            totalQueries: 0,
            blockedQueries: 0,
            allowedQueries: 0
          };
          const redirectedFromTotals = Math.max(
            0,
            summaryBase.totalQueries - summaryBase.blockedQueries - summaryBase.allowedQueries
          );

          const summaryRow = input.action === 'blocked'
            ? {
              totalQueries: summaryBase.blockedQueries,
              blockedQueries: summaryBase.blockedQueries,
              allowedQueries: 0,
              redirectedQueries: 0
            }
            : input.action === 'allowed'
              ? {
                totalQueries: summaryBase.allowedQueries,
                blockedQueries: 0,
                allowedQueries: summaryBase.allowedQueries,
                redirectedQueries: 0
              }
              : input.action === 'redirected'
                ? {
                  totalQueries: redirectedFromTotals,
                  blockedQueries: 0,
                  allowedQueries: 0,
                  redirectedQueries: redirectedFromTotals
                }
                : {
                  totalQueries: summaryBase.totalQueries,
                  blockedQueries: summaryBase.blockedQueries,
                  allowedQueries: summaryBase.allowedQueries,
                  redirectedQueries: redirectedFromTotals
                };
          const blockedRate = summaryRow.totalQueries > 0
            ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
            : 0;

          return JSON.stringify({
            summary: {
              ...summaryRow,
              blockedRate,
              timeRange: { start: start.toISOString(), end: end.toISOString() }
            },
            topBlockedDomains,
            topCategories,
            topDevices,
            source: 'aggregated'
          });
        }
      }

      const [summary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
        db
          .select({
            totalQueries: sql<number>`count(*)::int`,
            blockedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'blocked' then 1 else 0 end), 0)::int`,
            allowedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'allowed' then 1 else 0 end), 0)::int`,
            redirectedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'redirected' then 1 else 0 end), 0)::int`
          })
          .from(dnsSecurityEvents)
          .where(where),
        db
          .select({
            domain: dnsSecurityEvents.domain,
            category: dnsSecurityEvents.category,
            count: sql<number>`count(*)::int`
          })
          .from(dnsSecurityEvents)
          .where(and(where, eq(dnsSecurityEvents.action, 'blocked')))
          .groupBy(dnsSecurityEvents.domain, dnsSecurityEvents.category)
          .orderBy(desc(sql`count(*)`))
          .limit(topN),
        db
          .select({
            category: dnsSecurityEvents.category,
            count: sql<number>`count(*)::int`
          })
          .from(dnsSecurityEvents)
          .where(and(where, sql`${dnsSecurityEvents.category} is not null`))
          .groupBy(dnsSecurityEvents.category)
          .orderBy(desc(sql`count(*)`))
          .limit(topN),
        db
          .select({
            deviceId: dnsSecurityEvents.deviceId,
            hostname: devices.hostname,
            blockedCount: sql<number>`count(*)::int`
          })
          .from(dnsSecurityEvents)
          .leftJoin(devices, eq(dnsSecurityEvents.deviceId, devices.id))
          .where(and(where, eq(dnsSecurityEvents.action, 'blocked')))
          .groupBy(dnsSecurityEvents.deviceId, devices.hostname)
          .orderBy(desc(sql`count(*)`))
          .limit(topN)
      ]);

      const summaryRow = summary[0] ?? {
        totalQueries: 0,
        blockedQueries: 0,
        allowedQueries: 0,
        redirectedQueries: 0
      };
      const blockedRate = summaryRow.totalQueries > 0
        ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
        : 0;

      return JSON.stringify({
        summary: {
          ...summaryRow,
          blockedRate,
          timeRange: { start: start.toISOString(), end: end.toISOString() }
        },
        topBlockedDomains,
        topCategories,
        topDevices,
        source: 'raw'
      });
    }
  });

  // ============================================
  // manage_dns_policy - Tier 2 (confirm before execute)
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'manage_dns_policy',
      description: 'Add or remove domains from DNS blocklist/allowlist and schedule provider synchronization.',
      input_schema: {
        type: 'object' as const,
        properties: {
          integrationId: { type: 'string', description: 'DNS integration UUID' },
          action: { type: 'string', enum: ['add_block', 'remove_block', 'add_allow', 'remove_allow'], description: 'Policy action' },
          domains: { type: 'array', items: { type: 'string' }, description: 'Domains to add or remove' },
          reason: { type: 'string', description: 'Optional reason for policy changes' }
        },
        required: ['integrationId', 'action', 'domains']
      }
    },
    handler: async (input, auth) => {
      const integrationId = input.integrationId as string;
      const action = input.action as 'add_block' | 'remove_block' | 'add_allow' | 'remove_allow';
      const domainsInput = Array.isArray(input.domains) ? input.domains : [];
      const reason = typeof input.reason === 'string' ? input.reason : undefined;

      const domains = domainsInput
        .map((domain) => normalizeDnsDomain(domain))
        .filter((domain): domain is string => domain !== null);
      const uniqueDomains = Array.from(new Set(domains));

      if (uniqueDomains.length === 0) {
        return JSON.stringify({ error: 'No valid domains were provided' });
      }

      const integrationConditions: SQL[] = [eq(dnsFilterIntegrations.id, integrationId)];
      const orgCondition = auth.orgCondition(dnsFilterIntegrations.orgId);
      if (orgCondition) integrationConditions.push(orgCondition);

      const [integration] = await db
        .select({
          id: dnsFilterIntegrations.id,
          orgId: dnsFilterIntegrations.orgId
        })
        .from(dnsFilterIntegrations)
        .where(and(...integrationConditions))
        .limit(1);

      if (!integration) {
        return JSON.stringify({ error: 'Integration not found or access denied' });
      }

      const policyType = action === 'add_block' || action === 'remove_block' ? 'blocklist' : 'allowlist';
      const policyName = policyType === 'blocklist' ? 'AI Managed Blocklist' : 'AI Managed Allowlist';
      const isAddAction = action === 'add_block' || action === 'add_allow';
      const isRemoveAction = action === 'remove_block' || action === 'remove_allow';

      const policyConditions: SQL[] = [
        eq(dnsPolicies.integrationId, integration.id),
        eq(dnsPolicies.type, policyType),
      ];
      const policyOrgCondition = auth.orgCondition(dnsPolicies.orgId);
      if (policyOrgCondition) policyConditions.push(policyOrgCondition);

      let [policy] = await db
        .select()
        .from(dnsPolicies)
        .where(and(...policyConditions))
        .orderBy(desc(dnsPolicies.createdAt))
        .limit(1);

      if (!policy && isRemoveAction) {
        return JSON.stringify({
          success: true,
          policyId: null,
          integrationId: integration.id,
          action,
          requested: uniqueDomains.length,
          added: 0,
          removed: 0,
          syncScheduled: false,
          warning: 'No policy exists for the requested remove action'
        });
      }

      if (!policy && isAddAction) {
        const [created] = await db
          .insert(dnsPolicies)
          .values({
            orgId: integration.orgId,
            integrationId: integration.id,
            name: policyName,
            description: 'Managed by AI assistant',
            type: policyType,
            domains: [],
            categories: [],
            syncStatus: 'pending',
            isActive: true,
            createdBy: auth.user.id
          })
          .returning();
        policy = created;
      }

      if (!policy) {
        return JSON.stringify({ error: 'Failed to create or load DNS policy' });
      }

      const existing = Array.isArray(policy.domains) ? policy.domains : [];
      const domainMap = new Map<string, DnsPolicyDomain>();

      for (const item of existing) {
        const normalized = normalizeDnsDomain(item.domain);
        if (!normalized) continue;
        domainMap.set(normalized, {
          domain: normalized,
          reason: item.reason,
          addedAt: item.addedAt,
          addedBy: item.addedBy
        });
      }

      const added: string[] = [];
      const removed: string[] = [];
      const nowIso = new Date().toISOString();

      if (action === 'add_block' || action === 'add_allow') {
        for (const domain of uniqueDomains) {
          if (domainMap.has(domain)) continue;
          domainMap.set(domain, {
            domain,
            reason,
            addedAt: nowIso,
            addedBy: auth.user.id
          });
          added.push(domain);
        }
      } else {
        for (const domain of uniqueDomains) {
          if (domainMap.delete(domain)) {
            removed.push(domain);
          }
        }
      }

      await db
        .update(dnsPolicies)
        .set({
          domains: Array.from(domainMap.values()),
          syncStatus: 'pending',
          syncError: null,
          updatedAt: new Date()
        })
        .where(eq(dnsPolicies.id, policy.id));

      let syncScheduled = false;
      let warning: string | undefined;
      if (added.length > 0 || removed.length > 0) {
        try {
          await schedulePolicySync(policy.id, { add: added, remove: removed });
          syncScheduled = true;
        } catch (error) {
          console.error('[AiTools] Failed to schedule DNS policy sync:', error);
          warning = 'Policy changes were saved, but provider sync could not be scheduled';
        }
      }

      return JSON.stringify({
        success: true,
        policyId: policy.id,
        integrationId: integration.id,
        action,
        requested: uniqueDomains.length,
        added: added.length,
        removed: removed.length,
        syncScheduled,
        warning
      });
    }
  });
}
