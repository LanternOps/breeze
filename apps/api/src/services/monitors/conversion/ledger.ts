import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { monitorConversions, monitorConversionOutputs, monitorDefinitions, users } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { getConfigPolicy } from '../../configurationPolicy';
import { ConversionError } from './convert';
import { isRevertAvailable, findLiveTargetDependencies } from './lifecycle';
import type { ConversionLedgerEntry } from './types';
/**
 * The converted row's name as the writers stored it: under `source` for
 * policy rows (convert.ts, equivalence.ts), `template` for alert templates,
 * top-level `name` for retirements that recorded only a name.
 */
function storedSourceName(state: Record<string, unknown>): string | undefined {
  for (const candidate of [state.source, state.template, state]) {
    const name = (candidate as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}
export async function listConversionLedger(query: { orgId?: string; policyId?: string; cursor?: string; limit?: number }, auth: AuthContext): Promise<{ items: ConversionLedgerEntry[]; nextCursor: string | null }> {
  if (query.orgId && !auth.canAccessOrg(query.orgId)) throw new ConversionError('partner_wide_denied', 'Organization access denied');
  if (query.policyId && !await getConfigPolicy(query.policyId, auth)) throw new ConversionError('policy_not_found', 'Policy not found');
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const owner = auth.scope === 'system' ? undefined : or(
    inArray(monitorConversions.orgId, auth.accessibleOrgIds ?? []),
    auth.scope === 'partner' && auth.partnerId ? and(isNull(monitorConversions.orgId), eq(monitorConversions.partnerId, auth.partnerId)) : undefined);
  const rows = await db.select().from(monitorConversions).where(and(owner,
    query.orgId ? eq(monitorConversions.orgId, query.orgId) : undefined,
    query.cursor ? lt(monitorConversions.id, query.cursor) : undefined,
    query.policyId ? or(eq(monitorConversions.policyId, query.policyId), sql`EXISTS (SELECT 1 FROM ${monitorConversionOutputs}
      WHERE ${monitorConversionOutputs.conversionId} = ${monitorConversions.id} AND ${monitorConversionOutputs.policyId} = ${query.policyId})`) : undefined,
  )).orderBy(desc(monitorConversions.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const blockedByLiveTarget = await findLiveTargetDependencies(page, db);
  const outputs = page.length ? await db.select().from(monitorConversionOutputs).where(inArray(monitorConversionOutputs.conversionId, page.map((r) => r.id))) : [];
  // Names for display only — resolved as a batch, never on the hot query path above.
  const converterIds = [...new Set(page.map((r) => r.convertedBy).filter((id): id is string => !!id))];
  const converters = converterIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, converterIds)) : [];
  const converterNameById = new Map(converters.map((u) => [u.id, u.name]));
  const monitorIds = [...new Set(outputs.map((o) => o.monitorId).filter((id): id is string => !!id))];
  const monitors = monitorIds.length
    ? await db.select({ id: monitorDefinitions.id, name: monitorDefinitions.name }).from(monitorDefinitions).where(inArray(monitorDefinitions.id, monitorIds)) : [];
  const monitorNameById = new Map(monitors.map((m) => [m.id, m.name]));
  return { items: page.map((r) => ({ id: r.id, sourceTable: r.sourceTable, sourceId: r.sourceId,
    sourceName: storedSourceName(r.sourceState) ?? r.sourceId,
    policyId: r.policyId, convertedBy: r.convertedBy,
    convertedByName: r.convertedBy ? (converterNameById.get(r.convertedBy) ?? null) : null,
    convertedAt: r.convertedAt.toISOString(), revertedAt: r.revertedAt?.toISOString() ?? null,
    revertable: !r.revertedAt && isRevertAvailable(r.sourceTable) && canMutateOrgWideGovernance(auth)
      && (r.orgId ? auth.canAccessOrg(r.orgId) : canManagePartnerWidePolicies(auth))
      && !blockedByLiveTarget.has(r.id),
    outputs: outputs.filter((o) => o.conversionId === r.id && o.monitorId).map((o) => ({
      monitorId: o.monitorId!, monitorName: monitorNameById.get(o.monitorId!) ?? null, role: o.role, reused: o.reusedMonitor,
    })),
  })), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
}
