import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { alerts, organizations, partners, psaConnections, psaTicketMappings } from '../../db/schema';
import { decryptCredentials } from '../psa/credentials';
import { alertTicketingCredentialState, resolveAlertTicketingConfig } from './config';
import { wakeMapping } from './queue';
import type { AdmissionAlert, AdmissionTarget } from './admission';
export const ticketingDb = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

export async function activeTargets(): Promise<AdmissionTarget[]> {
  return ticketingDb(async () => {
    const rows = await db.select({ connection: psaConnections, partner: partners }).from(psaConnections)
      .innerJoin(partners, eq(psaConnections.partnerId, partners.id));
    return rows.flatMap(({ connection, partner }) => {
      const state = resolveAlertTicketingConfig(connection, partner, alertTicketingCredentialState(connection.provider, decryptCredentials(connection.credentials)));
      return state.active && connection.alertTicketingEnabledAt
        ? [{ connectionId: connection.id, config: state.config, rev: state.rev, enabledAt: connection.alertTicketingEnabledAt }] : [];
    });
  });
}
export async function loadAdmission(id: string) {
  return ticketingDb(async () => {
    const [row] = await db.select({ alert: alerts, connection: psaConnections, partner: partners }).from(alerts)
      .innerJoin(organizations, eq(alerts.orgId, organizations.id))
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .innerJoin(psaConnections, eq(partners.serviceManagementPsaConnectionId, psaConnections.id))
      .where(eq(alerts.id, id)).limit(1);
    if (!row || row.connection.partnerId !== row.partner.id) return null;
    const resolved = resolveAlertTicketingConfig(row.connection, row.partner, alertTicketingCredentialState(row.connection.provider, decryptCredentials(row.connection.credentials)));
    if (!resolved.active) return null;
    return { alert: row.alert, target: { connectionId: row.connection.id, config: resolved.config, rev: resolved.rev,
      enabledAt: row.connection.alertTicketingEnabledAt ?? new Date() } };
  });
}
export async function insertAdmission(alert: AdmissionAlert, target: AdmissionTarget, source: 'auto' | 'manual') {
  return ticketingDb(async () => {
    // Lock binding/config through insertion: disable/rebind and deletion cannot
    // race a stale admission decision. Re-read the committed alert as well.
    const [connection] = await db.select().from(psaConnections).where(eq(psaConnections.id, target.connectionId)).for('share');
    if (!connection || connection.alertTicketingRev !== target.rev) return null;
    const [partner] = await db.select().from(partners).where(eq(partners.id, connection.partnerId!)).for('share');
    if (!partner || !resolveAlertTicketingConfig(connection, partner, alertTicketingCredentialState(connection.provider, decryptCredentials(connection.credentials))).active) return null;
    const [current] = await db.select().from(alerts).where(and(eq(alerts.id, alert.id), eq(alerts.orgId, alert.orgId))).for('share');
    const [org] = await db.select().from(organizations).where(eq(organizations.id, alert.orgId)).for('share');
    if (!current || !['active', 'acknowledged'].includes(current.status) || org?.partnerId !== connection.partnerId || org.type === 'unassigned_pool') return null;
    const [row] = await db.insert(psaTicketMappings).values({ connectionId: target.connectionId, alertId: alert.id,
      deviceId: alert.deviceId, source, configRev: target.rev, nextAttemptAt: new Date(), deadlineAt: new Date(Date.now() + 24 * 3600000) })
      .onConflictDoNothing({ target: [psaTicketMappings.connectionId, psaTicketMappings.alertId], where: sql`${psaTicketMappings.alertId} IS NOT NULL` })
      .returning({ id: psaTicketMappings.id });
    return row?.id ?? null;
  });
}
export async function wakeAlertMappings(alertId: string) {
  const rows = await ticketingDb(() => db.select({ id: psaTicketMappings.id }).from(psaTicketMappings).where(eq(psaTicketMappings.alertId, alertId)));
  for (const row of rows) await wakeMapping(row.id, 'close');
}
export async function admissionCandidates(connectionId: string, floor: Date): Promise<string[]> {
  return ticketingDb(async () => {
    const rows = await db.execute<{ id: string }>(sql`SELECT a.id FROM alerts a JOIN organizations o ON o.id=a.org_id
      JOIN psa_connections c ON c.id=${connectionId}::uuid AND c.partner_id=o.partner_id
      WHERE a.status IN ('active','acknowledged') AND a.triggered_at >= ${floor.toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM psa_ticket_mappings m WHERE m.connection_id=c.id AND m.alert_id=a.id)
      ORDER BY a.triggered_at, a.id LIMIT 500`);
    return rows.map(r => r.id);
  });
}
export async function dueMappings(now: Date): Promise<string[]> {
  return ticketingDb(async () => {
    // Re-arm only skipped rows with a company link and a still-open alert.
    await db.execute(sql`UPDATE psa_ticket_mappings m SET create_state='never_attempted', next_attempt_at=now(),
      deadline_at=now()+interval '24 hours', updated_at=now()
      FROM alerts a, psa_connections c, organizations o
      WHERE m.create_state='skipped_no_company' AND m.alert_id=a.id AND m.connection_id=c.id
      AND a.org_id=o.id AND o.partner_id=c.partner_id AND a.status IN ('active','acknowledged')
      AND EXISTS (SELECT 1 FROM organization_external_links l WHERE l.org_id=a.org_id AND l.partner_id=c.partner_id AND l.system=c.provider::text)`);
    const rows = await db.execute<{ id: string }>(sql`SELECT m.id FROM psa_ticket_mappings m
      LEFT JOIN alerts a ON a.id=m.alert_id
      WHERE (m.next_attempt_at IS NULL OR m.next_attempt_at <= ${now.toISOString()}::timestamptz)
      AND (m.lease_until IS NULL OR m.lease_until <= now())
      AND (m.create_state IN ('never_attempted','create_in_flight','create_outcome_unknown')
        OR m.close_state IN ('pending','in_flight','outcome_unknown') OR m.note_state IN ('pending','in_flight','outcome_unknown')
        OR (m.create_state='created' AND ((a.status='resolved' AND m.close_state='none') OR (a.acknowledged_at IS NOT NULL AND m.note_state='none'))))
      ORDER BY m.next_attempt_at NULLS FIRST, m.id LIMIT 500`);
    return rows.map(r => r.id);
  });
}
