import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { monitorConversions, monitorConversionOutputs } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { getConfigPolicy } from '../../configurationPolicy';
import { ConversionError } from './convert';
import { isRevertAvailable, findLiveTargetDependencies } from './lifecycle';
import type { ConversionLedgerEntry } from './types';
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
  return { items: page.map((r) => ({ id: r.id, sourceTable: r.sourceTable, sourceId: r.sourceId,
    sourceName: String(r.sourceState.name ?? (r.sourceState.template as { name?: string } | undefined)?.name ?? r.sourceId),
    policyId: r.policyId, convertedBy: r.convertedBy, convertedAt: r.convertedAt.toISOString(), revertedAt: r.revertedAt?.toISOString() ?? null,
    revertable: !r.revertedAt && isRevertAvailable(r.sourceTable) && canMutateOrgWideGovernance(auth)
      && (r.orgId ? auth.canAccessOrg(r.orgId) : canManagePartnerWidePolicies(auth))
      && !blockedByLiveTarget.has(r.id),
    outputs: outputs.filter((o) => o.conversionId === r.id && o.monitorId).map((o) => ({ monitorId: o.monitorId!, role: o.role, reused: o.reusedMonitor })),
  })), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
}
