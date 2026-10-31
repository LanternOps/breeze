import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { alerts, devices, monitorDefinitions, organizationExternalLinks, organizations, partners, psaConnections, psaTicketMappings, sites } from '../../db/schema';
import { createPSAProvider, supportsAlertTicketing } from '../psa';
import { decryptCredentials } from '../psa/credentials';
import { alertTicketingCredentialState, resolveAlertTicketingConfig } from './config';
import { buildTicketDescription, buildTicketSummary } from './summary';
import { ticketingDb } from './storage';
import { wakeMapping } from './queue';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import type { TicketingContext, TicketingDeps, MappingChanges } from './execution';
import type { CreateSnapshot, TicketMapping } from './stateMachine';

export async function loadTicketingContext(id: string): Promise<TicketingContext | null> {
  const loaded = await ticketingDb(async () => {
    const [row] = await db.select({ mapping: psaTicketMappings, alert: alerts, connection: psaConnections,
      org: organizations, partner: partners, hostname: devices.hostname, siteName: sites.name,
      monitorBoardId: monitorDefinitions.psaBoardId }).from(psaTicketMappings)
      .innerJoin(psaConnections, eq(psaTicketMappings.connectionId, psaConnections.id))
      .innerJoin(alerts, eq(psaTicketMappings.alertId, alerts.id))
      .innerJoin(organizations, eq(alerts.orgId, organizations.id))
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .leftJoin(devices, eq(alerts.deviceId, devices.id)).leftJoin(sites, eq(devices.siteId, sites.id))
      .leftJoin(monitorDefinitions, and(eq(alerts.monitorId, monitorDefinitions.id),
        or(eq(monitorDefinitions.orgId, alerts.orgId), eq(monitorDefinitions.partnerId, partners.id))))
      .where(eq(psaTicketMappings.id, id)).limit(1);
    if (!row || row.connection.partnerId !== row.partner.id) return null;
    const links = await db.select({ externalId: organizationExternalLinks.externalId }).from(organizationExternalLinks)
      .where(and(eq(organizationExternalLinks.orgId, row.alert.orgId), eq(organizationExternalLinks.partnerId, row.partner.id), eq(organizationExternalLinks.system, row.connection.provider)));
    return { ...row, companyIds: links.map(r => r.externalId) };
  });
  if (!loaded) return null;
  const { connection, partner, mapping, alert, org, hostname, siteName, monitorBoardId, companyIds } = loaded;
  const credentials = decryptCredentials(connection.credentials);
  if (!credentials) return null;
  const adapter = createPSAProvider(connection.provider, credentials, (connection.settings ?? {}) as Record<string, unknown>);
  if (!supportsAlertTicketing(adapter)) return null;
  const resolved = resolveAlertTicketingConfig(connection, partner, alertTicketingCredentialState(connection.provider, credentials));
  const c = resolved.config;
  // Existing effects use their snapshot even if this connection is no longer enabled/bound.
  if (!mapping.createSnapshot && (!resolved.active || !c)) return null;
  const snapshot = mapping.createSnapshot as CreateSnapshot | null ?? {
    input: {
      alertId: alert.id,
      summary: buildTicketSummary({ severity: alert.severity, title: alert.title, hostname }, {
        maxCodePoints: adapter.alertTicketLimits.summaryMaxCodePoints, suffix: adapter.alertTicketLimits.summaryMarkerSuffix(alert.id) }),
      description: buildTicketDescription({ alertId: alert.id, severity: alert.severity, title: alert.title, message: alert.message,
        deviceHostname: hostname, siteName, orgName: org.name, alertUrl: `${process.env.DASHBOARD_URL?.replace(/\/$/, '') ?? ''}/alerts/${alert.id}`, triggeredAt: alert.triggeredAt.toISOString() }),
      companyId: companyIds[0] ?? '', boardId: monitorBoardId ?? c!.boardId!, statusId: c!.openStatusId!,
      priorityId: c!.priorityBySeverity[alert.severity], typeId: c!.typeId,
    }, closeOnResolve: c!.closeOnResolve, noteOnAcknowledge: c!.noteOnAcknowledge, closedStatusId: c!.closedStatusId!, hourlyCreateCap: c!.hourlyCreateCap,
  };
  return { mapping, alert, connection, canCreate: resolved.active && !isUnassignedPoolOrgType(org.type), companyIds, snapshot, adapter };
}
export async function claimTicketing(expected: TicketMapping, token: string, changes: MappingChanges, now: Date) {
  return ticketingDb(async () => {
    const [row] = await db.update(psaTicketMappings).set({ ...changes, leaseToken: token,
      leaseUntil: new Date(now.getTime()+60000), updatedAt: now }).where(and(
      eq(psaTicketMappings.id, expected.id), eq(psaTicketMappings.createState, expected.createState),
      eq(psaTicketMappings.closeState, expected.closeState), eq(psaTicketMappings.noteState, expected.noteState),
      eq(psaTicketMappings.attempts, expected.attempts),
      expected.leaseToken ? eq(psaTicketMappings.leaseToken, expected.leaseToken) : isNull(psaTicketMappings.leaseToken),
      or(isNull(psaTicketMappings.leaseUntil), sql`${psaTicketMappings.leaseUntil} <= now()`),
      or(isNull(psaTicketMappings.nextAttemptAt), sql`${psaTicketMappings.nextAttemptAt} <= now()`),
      sql`EXISTS (SELECT 1 FROM alerts a JOIN organizations o ON o.id=a.org_id JOIN psa_connections c ON c.id=${psaTicketMappings.connectionId}
        WHERE a.id=${psaTicketMappings.alertId} AND o.partner_id=c.partner_id AND c.alert_ticketing_paused_reason IS NULL)`,
    )).returning({ id: psaTicketMappings.id });
    return !!row;
  });
}
export async function saveTicketing(id: string, token: string, changes: MappingChanges, now: Date) {
  return ticketingDb(async () => {
    const [row] = await db.update(psaTicketMappings).set({ ...changes, leaseToken: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(psaTicketMappings.id, id), eq(psaTicketMappings.leaseToken, token), sql`${psaTicketMappings.leaseUntil} > now()`))
      .returning({ id: psaTicketMappings.id });
    return !!row;
  });
}
export async function pauseTicketing(ctx: TicketingContext) {
  await ticketingDb(() => db.update(psaConnections).set({ alertTicketingPausedReason: 'auth', alertTicketingPausedAt: new Date() })
    .where(and(eq(psaConnections.id, ctx.connection.id), isNull(psaConnections.alertTicketingPausedReason))));
}
export const ticketingDeps: TicketingDeps = { load: loadTicketingContext, claim: claimTicketing, save: saveTicketing,
  pause: pauseTicketing, wake: wakeMapping, report: () => {} };
