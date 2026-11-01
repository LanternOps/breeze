import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  alerts,
  devices,
  monitorDefinitions,
  organizationExternalLinks,
  organizations,
  partners,
  psaConnections,
  psaTicketMappings,
  sites,
} from '../../db/schema';
import { createPSAProvider, supportsAlertTicketing } from '../psa';
import { decryptCredentials } from '../psa/credentials';
import { alertTicketingCredentialState, resolveAlertTicketingConfig } from './config';
import { buildTicketDescription, buildTicketSummary } from './summary';
import { ticketingDb } from './storage';
import { wakeMapping } from './queue';
import { pauseTicketingConnection } from './pause';
import { reportTicketingFailure } from './reporting';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import type { TicketingContext, TicketingDeps, MappingChanges } from './execution';
import type { TicketMapping } from './stateMachine';
import type { CreateSnapshot } from './snapshot';
import { TICKETING_LEASE_MS } from './constants';

export async function loadTicketingContext(id: string): Promise<TicketingContext | null> {
  let inactiveReason = 'context_missing';
  const loaded = await ticketingDb(async () => {
    const [row] = await db
      .select({
        mapping: psaTicketMappings,
        alert: alerts,
        connection: psaConnections,
        org: organizations,
        partner: partners,
        hostname: devices.hostname,
        siteName: sites.name,
        monitorBoardId: monitorDefinitions.psaBoardId,
        connectionVersion: sql<string>`${psaConnections.updatedAt}::text`,
      })
      .from(psaTicketMappings)
      .innerJoin(psaConnections, eq(psaTicketMappings.connectionId, psaConnections.id))
      .innerJoin(alerts, eq(psaTicketMappings.alertId, alerts.id))
      .innerJoin(organizations, eq(alerts.orgId, organizations.id))
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .leftJoin(devices, eq(alerts.deviceId, devices.id))
      .leftJoin(sites, eq(devices.siteId, sites.id))
      .leftJoin(
        monitorDefinitions,
        and(
          eq(alerts.monitorId, monitorDefinitions.id),
          or(
            eq(monitorDefinitions.orgId, alerts.orgId),
            eq(monitorDefinitions.partnerId, partners.id)
          )
        )
      )
      .where(eq(psaTicketMappings.id, id))
      .limit(1);
    if (!row) return null;
    if (row.connection.partnerId !== row.partner.id) {
      inactiveReason = 'partner_mismatch';
      return null;
    }
    const links = await db
      .select({ externalId: organizationExternalLinks.externalId })
      .from(organizationExternalLinks)
      .where(
        and(
          eq(organizationExternalLinks.orgId, row.alert.orgId),
          eq(organizationExternalLinks.partnerId, row.partner.id),
          eq(organizationExternalLinks.system, row.connection.provider)
        )
      );
    return { ...row, companyIds: links.map((r) => r.externalId) };
  });
  if (!loaded) {
    await deferInactiveTicketing(id, inactiveReason);
    return null;
  }
  const {
    connection,
    partner,
    mapping,
    alert,
    org,
    hostname,
    siteName,
    monitorBoardId,
    companyIds,
    connectionVersion,
  } = loaded;
  const credentials = decryptCredentials(connection.credentials);
  if (!credentials) {
    await deferInactiveTicketing(id, 'credentials_unusable');
    return null;
  }
  const adapter = createPSAProvider(
    connection.provider,
    credentials,
    (connection.settings ?? {}) as Record<string, unknown>
  );
  if (!supportsAlertTicketing(adapter)) {
    await deferInactiveTicketing(id, 'unsupported_provider');
    return null;
  }
  const resolved = resolveAlertTicketingConfig(
    connection,
    partner,
    alertTicketingCredentialState(connection.provider, credentials)
  );
  const c = resolved.config;
  // Existing effects use their snapshot even if this connection is no longer enabled/bound.
  if (!mapping.createSnapshot && !c) {
    await deferInactiveTicketing(id, resolved.active ? 'config_missing' : resolved.reason);
    return null;
  }
  const snapshot: CreateSnapshot = (mapping.createState === 'never_attempted' && c
    ? null
    : mapping.createSnapshot) ?? {
    operationAttempts: mapping.createSnapshot?.operationAttempts,
    connectionRev: connection.alertTicketingRev,
    connectionUpdatedAt: connectionVersion,
    orgId: alert.orgId,
    resolvedCompanyCount: companyIds.length,
    input: {
      alertId: alert.id,
      summary: buildTicketSummary(
        { severity: alert.severity, title: alert.title, hostname },
        {
          maxCodePoints: adapter.alertTicketLimits.summaryMaxCodePoints,
          suffix: adapter.alertTicketLimits.summaryMarkerSuffix(alert.id),
        }
      ),
      description: buildTicketDescription({
        alertId: alert.id,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        deviceHostname: hostname,
        siteName,
        orgName: org.name,
        alertUrl: `${process.env.DASHBOARD_URL?.replace(/\/$/, '') ?? ''}/alerts/${alert.id}`,
        triggeredAt: alert.triggeredAt.toISOString(),
      }),
      companyId: companyIds[0] ?? '',
      boardId: monitorBoardId ?? c!.boardId!,
      statusId: c!.openStatusId!,
      priorityId: c!.priorityBySeverity[alert.severity],
      typeId: c!.typeId,
    },
    closeOnResolve: c!.closeOnResolve,
    noteOnAcknowledge: c!.noteOnAcknowledge,
    closedStatusId: c!.closedStatusId!,
    hourlyCreateCap: c!.hourlyCreateCap,
  };
  const unassignedPool = isUnassignedPoolOrgType(org.type);
  return {
    mapping,
    alert,
    connection,
    canCreate: resolved.active && !unassignedPool,
    inactiveReason: !resolved.active ? resolved.reason : unassignedPool ? 'unassigned_pool' : undefined,
    companyIds,
    snapshot,
    adapter,
  };
}
export async function claimTicketing(
  expected: TicketMapping,
  token: string,
  changes: MappingChanges,
  now: Date
) {
  return ticketingDb(async () => {
    const [row] = await db
      .update(psaTicketMappings)
      .set({
        ...changes,
        leaseToken: token,
        leaseUntil: sql`now() + ${TICKETING_LEASE_MS} * interval '1 millisecond'`,
        updatedAt: now,
      })
      .where(
        and(
          eq(psaTicketMappings.id, expected.id),
          eq(psaTicketMappings.createState, expected.createState),
          eq(psaTicketMappings.closeState, expected.closeState),
          eq(psaTicketMappings.noteState, expected.noteState),
          eq(psaTicketMappings.attempts, expected.attempts),
          expected.leaseToken
            ? eq(psaTicketMappings.leaseToken, expected.leaseToken)
            : isNull(psaTicketMappings.leaseToken),
          or(isNull(psaTicketMappings.leaseUntil), sql`${psaTicketMappings.leaseUntil} <= now()`),
          or(
            isNull(psaTicketMappings.nextAttemptAt),
            sql`${psaTicketMappings.nextAttemptAt} <= now()`
          ),
          sql`EXISTS (SELECT 1 FROM alerts a JOIN organizations o ON o.id=a.org_id JOIN psa_connections c ON c.id=${psaTicketMappings.connectionId}
        WHERE a.id=${psaTicketMappings.alertId} AND o.partner_id=c.partner_id AND c.alert_ticketing_paused_reason IS NULL
        AND (${changes.createState === 'create_in_flight'} = false OR (a.status IN ('active','acknowledged')
          AND c.alert_ticketing->>'enabled'='true'
          AND c.alert_ticketing_rev=${changes.createSnapshot?.connectionRev ?? -1}
          AND c.updated_at=${changes.createSnapshot?.connectionUpdatedAt ?? null}::timestamp
          AND a.org_id=${changes.createSnapshot?.orgId ?? null}::uuid
          AND (${changes.createSnapshot?.resolvedCompanyCount !== 1} OR
            (SELECT count(*)=1 AND min(l.external_id)=${changes.createSnapshot?.input.companyId ?? ''}
              FROM organization_external_links l WHERE l.org_id=a.org_id AND l.partner_id=c.partner_id AND l.system=c.provider::text))
          AND EXISTS (SELECT 1 FROM partners p WHERE p.id=c.partner_id
            AND p.service_management_mode='external' AND p.service_management_psa_connection_id=c.id))))`
        )
      )
      .returning({ id: psaTicketMappings.id });
    if (!row) {
      await deferInactiveTicketing(expected.id, 'claim_rejected', expected, now);
      console.warn('[psa-ticketing] claim rejected', { mappingId: expected.id,
        alertId: expected.alertId, connectionId: expected.connectionId });
    }
    return !!row;
  });
}
export async function saveTicketing(id: string, token: string, changes: MappingChanges, now: Date) {
  return ticketingDb(async () => {
    const [row] = await db
      .update(psaTicketMappings)
      .set({ ...changes, leaseToken: null, leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(psaTicketMappings.id, id),
          eq(psaTicketMappings.leaseToken, token),
          sql`${psaTicketMappings.leaseUntil} > now()`
        )
      )
      .returning({ id: psaTicketMappings.id });
    return !!row;
  });
}
export async function renewTicketingLease(id: string, token: string, now: Date) {
  return ticketingDb(async () => {
    const [row] = await db.update(psaTicketMappings)
      .set({ leaseUntil: sql`now() + ${TICKETING_LEASE_MS} * interval '1 millisecond'`, updatedAt: now })
      .where(and(eq(psaTicketMappings.id, id), eq(psaTicketMappings.leaseToken, token),
        sql`${psaTicketMappings.leaseUntil} > now()`))
      .returning({ id: psaTicketMappings.id });
    return !!row;
  });
}

/** Record recoverable configuration/claim failures without disturbing another owner. */
async function deferInactiveTicketing(id: string, reason: string, expected?: TicketMapping, now = new Date()) {
  return ticketingDb(async () => {
    const rows = await db.update(psaTicketMappings).set({
      lastError: reason === 'claim_rejected' ? reason : `connection_inactive:${reason}`,
      lastErrorClass: 'transient', nextAttemptAt: new Date(now.getTime() + 30000), updatedAt: now,
    }).where(and(eq(psaTicketMappings.id, id),
      or(isNull(psaTicketMappings.leaseUntil), sql`${psaTicketMappings.leaseUntil} <= now()`),
      expected ? and(eq(psaTicketMappings.createState, expected.createState),
        eq(psaTicketMappings.closeState, expected.closeState), eq(psaTicketMappings.noteState, expected.noteState),
        eq(psaTicketMappings.attempts, expected.attempts)) : undefined,
    )).returning({ mappingId: psaTicketMappings.id, alertId: psaTicketMappings.alertId, connectionId: psaTicketMappings.connectionId });
    for (const ids of rows) console.warn('[psa-ticketing] connection inactive', { ...ids, reason });
  });
}

export const ticketingDeps: TicketingDeps = {
  renewLease: renewTicketingLease,
  load: loadTicketingContext,
  claim: claimTicketing,
  save: saveTicketing,
  pause: (ctx) => pauseTicketingConnection(ctx.connection.id),
  wake: wakeMapping,
  report: reportTicketingFailure,
};
