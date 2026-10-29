import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { alertExternalRefs, alerts, psaConnections, psaTicketMappings } from '../db/schema';

export type AlertExternalTicket = {
  source: 'partner_api' | 'psa';
  partnerServicePrincipalId: string | null;
  externalId: string;
  externalUrl: string | null;
  externalNumber: string | null;
  state: string | null;
  createdAt: string;
  updatedAt: string | null;
};

/** Callers authorize the alert first. Reads retain the caller's DB/RLS context.
 * System-context enrichment supplies its event org to keep each MVCC read
 * tenant-scoped even if the alert moves between queries. */
export async function listAlertExternalTickets(
  alertId: string,
  viewerPartnerId: string | null,
  opts?: { orgId?: string },
): Promise<AlertExternalTicket[]> {
  const refs = await db.select({
    id: alertExternalRefs.id,
    partnerServicePrincipalId: alertExternalRefs.partnerServicePrincipalId,
    externalId: alertExternalRefs.externalId,
    externalUrl: alertExternalRefs.externalUrl,
    externalNumber: alertExternalRefs.externalNumber,
    createdAt: alertExternalRefs.createdAt,
    updatedAt: alertExternalRefs.updatedAt,
  }).from(alertExternalRefs)
    .where(and(
      eq(alertExternalRefs.alertId, alertId),
      opts?.orgId !== undefined ? eq(alertExternalRefs.orgId, opts.orgId) : undefined,
    ))
    .orderBy(asc(alertExternalRefs.createdAt), asc(alertExternalRefs.id));

  const mappings = await db.select({
    id: psaTicketMappings.id,
    externalId: psaTicketMappings.externalTicketId,
    externalUrl: psaTicketMappings.externalTicketUrl,
    state: psaTicketMappings.status,
    createdAt: psaTicketMappings.createdAt,
    updatedAt: psaTicketMappings.updatedAt,
  }).from(psaTicketMappings)
    .innerJoin(psaConnections, eq(psaConnections.id, psaTicketMappings.connectionId))
    .innerJoin(alerts, eq(alerts.id, psaTicketMappings.alertId))
    .where(and(
      eq(psaTicketMappings.alertId, alertId),
      opts?.orgId !== undefined ? eq(alerts.orgId, opts.orgId) : undefined,
      isNotNull(psaTicketMappings.externalTicketId),
      or(
        viewerPartnerId ? eq(psaConnections.partnerId, viewerPartnerId) : undefined,
        and(eq(psaConnections.orgId, alerts.orgId), isNull(psaConnections.partnerId)),
      ),
    ))
    .orderBy(asc(psaTicketMappings.createdAt), asc(psaTicketMappings.id));

  const records: (AlertExternalTicket & { id: string })[] = [
    ...refs.map(ref => ({
      ...ref, source: 'partner_api' as const, state: null,
      createdAt: ref.createdAt.toISOString(), updatedAt: ref.updatedAt.toISOString(),
    })),
    ...mappings.map(mapping => ({
      ...mapping, source: 'psa' as const, partnerServicePrincipalId: null,
      externalId: mapping.externalId!, externalNumber: null,
      createdAt: mapping.createdAt.toISOString(), updatedAt: mapping.updatedAt?.toISOString() ?? null,
    })),
  ];
  records.sort((a, b) => a.source.localeCompare(b.source) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return records.map(({ id: _id, ...record }) => record);
}
