// services/delivery/inheritedRails.ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies, sites } from '../../db/schema';
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Context = { orgId: string; partnerId: string; allowedSiteIds?: string[] };
type Conditions = { severities?: string[]; monitorKinds?: string[]; siteIds?: string[] };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export async function readInheritedRails(rail: 'channels' | 'routing' | 'escalation', context: Context, executor: DbExecutor = db) {
  const { orgId, partnerId, allowedSiteIds } = context;
  if (rail === 'channels') {
    const c = notificationChannels;
    const rows = await executor.select({ id: c.id, name: c.name, type: c.type, enabled: c.enabled })
      .from(c).where(and(isNull(c.orgId), eq(c.partnerId, partnerId))).orderBy(asc(c.name));
    return rows.map(({ id, name, type, enabled }) => ({ id, name, type, enabled, inherited: true as const }));
  }
  if (rail === 'escalation') {
    const p = escalationPolicies;
    const rows = await executor.select({ id: p.id, name: p.name,
      stepCount: sql<number>`CASE WHEN jsonb_typeof(${p.steps}) = 'array' THEN jsonb_array_length(${p.steps}) ELSE 0 END`.mapWith(Number) })
      .from(p).where(and(isNull(p.orgId), eq(p.partnerId, partnerId))).orderBy(asc(p.name));
    return rows.map(({ id, name, stepCount }) => ({ id, name, stepCount, inherited: true as const }));
  }
  const r = notificationRoutingRules;
  const rows = await executor.select({ id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
    isDefault: r.isDefault, channelIds: r.channelIds, escalationPolicyId: r.escalationPolicyId,
    conditions: sql<Conditions>`jsonb_build_object('severities', ${r.conditions}->'severities',
      'monitorKinds', ${r.conditions}->'monitorKinds', 'siteIds', ${r.conditions}->'siteIds')` })
    .from(r).where(and(isNull(r.orgId), eq(r.partnerId, partnerId))).orderBy(asc(r.isDefault), asc(r.priority));
  const orgSites = await executor.select({ id: sites.id }).from(sites).where(eq(sites.orgId, orgId));
  const visibleSites = new Set(orgSites.filter(site => allowedSiteIds === undefined || allowedSiteIds.includes(site.id)).map(site => site.id));
  return rows.flatMap(({ id, name, priority, enabled, isDefault, conditions, channelIds, escalationPolicyId }) => {
    const targetedSites = strings(conditions.siteIds);
    const siteIds = targetedSites.filter(siteId => visibleSites.has(siteId));
    if ((targetedSites.length > 0 && siteIds.length === 0) || (targetedSites.length === 0 && allowedSiteIds !== undefined)) return [];
    return [{ id, name, priority, enabled, isDefault,
      conditions: { severities: strings(conditions.severities), monitorKinds: strings(conditions.monitorKinds), siteIds },
      channelIds, escalationPolicyId, inherited: true as const }];
  });
}
